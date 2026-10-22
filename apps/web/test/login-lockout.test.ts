import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import { disconnectAll } from '@hrms/db';
import { disconnectRedis, redis, redisReady } from '@hrms/cache';
import { hashPassword, login } from '@hrms/core/auth';
import { POST } from '../src/app/api/auth/login/route.ts';

/**
 * Account lockout and login timing (P6-20, `docs/SECURITY/02` §2(b), §12).
 *
 * The lockout once looked complete in review and did nothing: the counter was
 * written inside the transaction that then threw, so ten wrong passwords left
 * `failed_login_attempts = 0` (`login.ts`, top comment). Only a test against a
 * real commit can tell a lock from the appearance of one.
 *
 * Lockout goes through the real route handler, so the 423 and `Retry-After` a
 * client sees are what is asserted. The clock is faked — `Date` only, so
 * PostgreSQL and argon2 run for real — rather than slept for 15 minutes.
 *
 * Timing is measured on `login()` directly: the defence lives there, and the
 * handler's per-address rate limit (20 per 5 minutes, one shared "unknown"
 * bucket without a trusted proxy) would refuse the repetitions a measurement
 * needs before it measured anything.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

const TENANT = randomUUID();
const suffix = TENANT.slice(0, 8);
const TENANT_CODE = `t-lock-${suffix}`;
const PASSWORD = 'Correct-Horse-9';
const LOCKED_USER = randomUUID();
const TIMING_USER = randomUUID();
const email = (name: string): string => `${name}-${suffix}@lockout.test`;

/** The limit in `login.ts`. Restated on purpose: raising it there must fail here. */
const MAX_FAILED_ATTEMPTS = 8;
const LOCK_MINUTES = 15;

/** The login route's rate-limit key without a trusted proxy (`define-route.ts`). */
const RATE_LIMIT_KEY = 'rl:POST /api/auth/login:unknown';

async function attempt(password: string): Promise<Response> {
  return POST(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantCode: TENANT_CODE, email: email('locked'), password }),
    }),
    { params: Promise.resolve({}) },
  );
}

async function code(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { code: string } }).error?.code;
}

beforeAll(async () => {
  await owner.plan.upsert({
    where: { code: 'lockout-test-plan' },
    create: { code: 'lockout-test-plan', name: 'Lockout Test' },
    update: {},
  });
  await owner.tenant.create({
    data: { id: TENANT, code: TENANT_CODE, name: 'Lockout Test', status: 'ACTIVE', planCode: 'lockout-test-plan' },
  });
  const passwordHash = await hashPassword(PASSWORD);
  for (const [id, name] of [[LOCKED_USER, 'locked'], [TIMING_USER, 'timing']] as const) {
    await owner.user.create({
      data: { id, tenantId: TENANT, email: email(name), fullName: name, passwordHash, status: 'ACTIVE' },
    });
  }
});

beforeEach(async () => {
  // Earlier runs in the same five minutes share this bucket; without clearing it
  // the suite would test the rate limiter instead of the lock.
  if (await redisReady()) await redis()!.del(RATE_LIMIT_KEY);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  if (await redisReady()) await redis()!.del(RATE_LIMIT_KEY);
  await owner.tenant.deleteMany({ where: { id: TENANT } });
  await owner.$disconnect();
  await disconnectAll();
  await disconnectRedis();
});

describe('account lockout (§2(b))', () => {
  it(`locks after ${MAX_FAILED_ATTEMPTS} failures, refuses the right password while locked, and unlocks after ${LOCK_MINUTES} minutes`, async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-01-04T08:00:00Z') });

    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      const res = await attempt('wrong-password');
      expect(res.status).toBe(401);
      expect(await code(res)).toBe('INVALID_CREDENTIALS');
    }

    // The attempt that reaches the limit is itself still an ordinary failure:
    // it must not reveal that it was the one that locked the account.
    const last = await attempt('wrong-password');
    expect(last.status).toBe(401);

    const row = await owner.user.findUniqueOrThrow({
      where: { id: LOCKED_USER },
      select: { failedLoginAttempts: true, lockedUntil: true },
    });
    expect(row.failedLoginAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(row.lockedUntil).not.toBeNull();

    const locked = await attempt(PASSWORD);
    expect(locked.status).toBe(423);
    expect(await code(locked)).toBe('ACCOUNT_LOCKED');
    expect(Number(locked.headers.get('retry-after'))).toBe(LOCK_MINUTES * 60);

    // One second before expiry: still locked.
    vi.setSystemTime(new Date(Date.now() + LOCK_MINUTES * 60_000 - 1000));
    expect((await attempt(PASSWORD)).status).toBe(423);

    // After expiry the right password succeeds and clears the counter.
    vi.setSystemTime(new Date(Date.now() + 2000));
    const after = await attempt(PASSWORD);
    expect(after.status).toBe(200);
    const cleared = await owner.user.findUniqueOrThrow({
      where: { id: LOCKED_USER },
      select: { failedLoginAttempts: true, lockedUntil: true },
    });
    expect(cleared).toEqual({ failedLoginAttempts: 0, lockedUntil: null });
  });
});

/**
 * Timing (§12). An unknown tenant, an unknown email, and a wrong password must
 * cost about the same, or latency enumerates tenants and then addresses.
 *
 * The tolerance: each refusal's median within 15% of the wrong-password
 * median. Measured before the failure floor (ADR-036): wrong password 40 ms,
 * unknown email 26 ms, unknown tenant 20 ms — and with the argon2 burn removed,
 * an unknown tenant answered in 1.6 ms. Both fail this bound. With the floor,
 * all three end at ~250 ms and differ by scheduler noise.
 */
describe('login timing (§12)', () => {
  const RUNS = 9;

  async function median(input: { tenantCode: string; email: string; password: string }): Promise<number> {
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      // The timing user must never lock: a locked account answers early, and
      // the measurement would be of the lock instead.
      await owner.user.update({ where: { id: TIMING_USER }, data: { failedLoginAttempts: 0, lockedUntil: null } });
      const start = performance.now();
      await expect(login(input)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(RUNS / 2)]!;
  }

  it('costs an unknown tenant and an unknown email about as much as a wrong password', async () => {
    // Warm-up: the first argon2 call and the first query pay one-off costs.
    await median({ tenantCode: TENANT_CODE, email: email('timing'), password: 'warm-up-guess' });

    const wrongPassword = await median({ tenantCode: TENANT_CODE, email: email('timing'), password: 'wrong-guess' });
    const unknownTenant = await median({ tenantCode: `no-such-${suffix}`, email: email('timing'), password: 'wrong-guess' });
    const unknownEmail = await median({ tenantCode: TENANT_CODE, email: email('nobody'), password: 'wrong-guess' });

    expect(Math.abs(unknownTenant - wrongPassword)).toBeLessThan(wrongPassword * 0.15);
    expect(Math.abs(unknownEmail - wrongPassword)).toBeLessThan(wrongPassword * 0.15);
  }, 60_000);
});
