import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { generateSecret, generateSync } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import { disconnectAll } from '@hrms/db';
import { disconnectRedis, redis, redisReady } from '@hrms/cache';
import { hashPassword } from '@hrms/core/auth';
import { readTotpSecret, sealTotpSecrets, superuserLogin } from '@hrms/core/platform';
import { POST } from '../src/app/admin/api/auth/login/route.ts';

/**
 * Superuser TOTP secrets at rest, and the superuser login trail (P6-14, risk
 * F13, `docs/SECURITY/02` §9(c)).
 *
 * The secret is the second factor: whoever reads it mints valid codes forever.
 * The column is read here as `hrms_owner` — what a backup or a replica holds —
 * and must not contain it. Superusers created before the change, with plaintext
 * secrets, must still log in; the seed creates exactly such a superuser.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

const suffix = randomUUID().slice(0, 8);
const PASSWORD = 'Admin-Correct-9';
const RATE_LIMIT_KEY = 'rl:admin:POST /admin/api/auth/login:unknown';

type Superuser = { id: string; email: string; secret: string };
const LOGS_IN = { id: randomUUID(), email: `su-login-${suffix}@platform.test`, secret: generateSecret() };
const SWEPT = { id: randomUUID(), email: `su-swept-${suffix}@platform.test`, secret: generateSecret() };

async function login(su: { email: string; secret?: string }, password = PASSWORD, totp?: string): Promise<Response> {
  return POST(
    new Request('http://localhost/admin/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: su.email,
        password,
        totp: totp ?? generateSync({ secret: su.secret!, strategy: 'totp' }),
      }),
    }),
  );
}

async function storedSecret(su: Superuser): Promise<string> {
  const row = await owner.superuser.findUniqueOrThrow({ where: { id: su.id }, select: { totpSecret: true } });
  return row.totpSecret!;
}

async function lastAudit(where: { superuserId: string | null; since: Date }) {
  return owner.platformAuditLog.findFirst({
    where: { superuserId: where.superuserId, createdAt: { gte: where.since }, action: { startsWith: 'superuser.login.' } },
    orderBy: { id: 'desc' },
  });
}

beforeAll(async () => {
  const passwordHash = await hashPassword(PASSWORD);
  for (const su of [LOGS_IN, SWEPT]) {
    // Written the way every superuser was before P6-14: the secret in plaintext.
    await owner.superuser.create({
      data: { id: su.id, email: su.email, fullName: 'Probe', passwordHash, totpSecret: su.secret, isActive: true },
    });
  }
});

beforeEach(async () => {
  if (await redisReady()) await redis()!.del(RATE_LIMIT_KEY);
});

afterAll(async () => {
  await owner.superuser.deleteMany({ where: { id: { in: [LOGS_IN.id, SWEPT.id] } } });
  if (await redisReady()) await redis()!.del(RATE_LIMIT_KEY);
  await owner.$disconnect();
  await disconnectAll();
  await disconnectRedis();
});

describe('TOTP secrets at rest', () => {
  it('lets a superuser with a plaintext secret log in, and seals it on the way', async () => {
    expect(await storedSecret(LOGS_IN)).toBe(LOGS_IN.secret);

    const res = await login(LOGS_IN);
    expect(res.status).toBe(200);

    const stored = await storedSecret(LOGS_IN);
    expect(stored).not.toContain(LOGS_IN.secret);
    expect(stored).toMatch(/^v1\./);
    expect(readTotpSecret(stored)).toBe(LOGS_IN.secret);

    // And the sealed secret still works.
    expect((await login(LOGS_IN)).status).toBe(200);
  });

  it('seals superusers who never log in, and a second run changes nothing', async () => {
    const first = await sealTotpSecrets();
    expect(first.sealed).toBeGreaterThanOrEqual(1);

    const stored = await storedSecret(SWEPT);
    expect(stored).not.toContain(SWEPT.secret);
    expect(readTotpSecret(stored)).toBe(SWEPT.secret);

    const second = await sealTotpSecrets();
    expect(second.sealed).toBe(0);
    expect(await storedSecret(SWEPT)).toBe(stored);

    expect((await login(SWEPT)).status).toBe(200);
  });
});

describe('the superuser login trail', () => {
  it('records a success', async () => {
    const since = new Date();
    expect((await login(LOGS_IN)).status).toBe(200);
    expect(await lastAudit({ superuserId: LOGS_IN.id, since })).toMatchObject({ action: 'superuser.login.succeeded' });
  });

  it.each([
    ['a wrong password', () => login(LOGS_IN, 'wrong-password'), 'password'],
    ['a wrong TOTP code', () => login(LOGS_IN, PASSWORD, '000000'), 'totp'],
  ])('records %s with its reason, while answering one indistinguishable 401', async (_case, attempt, reason) => {
    const since = new Date();
    const res = await attempt();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
    expect(await lastAudit({ superuserId: LOGS_IN.id, since })).toMatchObject({
      action: 'superuser.login.failed',
      detail: { reason },
    });
  });

  it('records an unknown email without the address typed', async () => {
    const since = new Date();
    const typed = `nobody-${suffix}@platform.test`;
    expect((await login({ email: typed, secret: LOGS_IN.secret })).status).toBe(401);

    const row = await lastAudit({ superuserId: null, since });
    expect(row).toMatchObject({ action: 'superuser.login.failed', detail: { reason: 'unknown_email' } });
    expect(JSON.stringify(row?.detail)).not.toContain(typed);
  });
});

/**
 * An unknown email used to skip argon2 entirely and answer in a few
 * milliseconds, which told a guesser which superuser addresses exist. Measured
 * on the domain function: the admin login allows 10 attempts per 15 minutes per
 * address, too few to measure through the handler.
 */
describe('superuser login timing', () => {
  it('costs an unknown email at least half what a wrong password costs', async () => {
    async function median(email: string): Promise<number> {
      const samples: number[] = [];
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        await superuserLogin({ email, password: 'wrong-guess', totp: '000000' }).catch(() => undefined);
        samples.push(performance.now() - start);
      }
      return samples.sort((a, b) => a - b)[3]!;
    }

    await median(LOGS_IN.email); // warm-up
    const known = await median(LOGS_IN.email);
    const unknown = await median(`nobody-${suffix}@platform.test`);
    expect(unknown).toBeGreaterThan(known * 0.5);
  }, 60_000);
});
