import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { config as loadEnv } from 'dotenv';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { disconnectAll } from '@hrms/db';
import { disconnectRedis, resetAccessCache } from '@hrms/cache';
import { issueAccessToken } from '@hrms/core/auth';
import { createAuthServer } from '../src/server.ts';

/**
 * The auth service, over real HTTP, against a real database (PLAN/14 stage 6).
 *
 * The server is started on an ephemeral port and driven with `fetch`. Nothing is
 * stubbed and no handler is called directly, because most of what could go wrong
 * here lives in the layers a direct call would skip: the route table, the
 * internal-secret guard, the rate limiter, cookie serialisation, and the shape of
 * the error envelope. A test that called handlers directly would pass while the
 * service refused every request.
 *
 * These are the endpoints that hold credentials and issue tokens. If any of them
 * is wrong, nothing else in the system matters.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

const TENANT = randomUUID();
const USER = randomUUID();
const suffix = TENANT.slice(0, 8);
const CODE = `t-svc-${suffix}`;
const EMAIL = `svc-${suffix}@service.test`;
const PASSWORD = 'ServiceTestPassword123';
const SECRET = 'test-internal-secret-test-internal-secret';

let server: Server;
let base: string;

/**
 * Every request in this suite claims a fresh client address.
 *
 * Rate-limit counters live in Redis now (PLAN/14 stage 3), keyed by route and
 * address, and they OUTLIVE the test run — `password/forgot` allows five per
 * fifteen minutes. Running the suite twice inside that window exhausted the
 * budget and the second run failed with 429 on a test asserting 204, which reads
 * as a broken endpoint rather than as a shared counter doing its job.
 *
 * A random address per run isolates the suite without reaching into Redis to
 * delete keys, and it exercises the real path: the limiter keys by
 * `x-forwarded-for`, so this also proves it does.
 */
const CLIENT_IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.1`;

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-forwarded-for': CLIENT_IP },
  });
}

async function currentVersion(): Promise<number> {
  const row = await owner.accessVersion.findUnique({
    where: { userId: USER },
    select: { version: true },
  });
  return row?.version ?? 0;
}

beforeAll(async () => {
  process.env['AUTH_INTERNAL_SECRET'] = SECRET;
  // Plain HTTP on localhost: a `Secure` cookie would be discarded and every
  // session assertion below would fail for a reason unrelated to the code.
  process.env['COOKIE_SECURE'] = 'false';

  await owner.plan.upsert({
    where: { code: 'auth-svc-plan' },
    create: {
      code: 'auth-svc-plan',
      name: 'Auth Service Test',
      modules: { create: [{ moduleCode: 'leave' }] },
    },
    update: {},
  });

  await owner.tenant.create({
    data: { id: TENANT, code: CODE, name: 'Auth Service Test', status: 'ACTIVE', planCode: 'auth-svc-plan' },
  });
  await owner.tenantModule.create({
    data: { tenantId: TENANT, moduleCode: 'leave', status: 'ENABLED' },
  });

  await owner.user.create({
    data: {
      id: USER,
      tenantId: TENANT,
      email: EMAIL,
      fullName: 'Service Probe',
      // A real argon2 hash: login verifies it, so a placeholder would fail for
      // the wrong reason and prove nothing about the endpoint.
      passwordHash: await hash(PASSWORD),
      status: 'ACTIVE',
    },
  });

  const role = await owner.role.create({
    data: {
      tenantId: TENANT,
      code: `svc-${suffix}`,
      name: 'Probe',
      permissions: { create: [{ tenantId: TENANT, permissionCode: 'leave.request.read.own' }] },
    },
  });
  await owner.userRole.create({ data: { tenantId: TENANT, userId: USER, roleId: role.id } });

  server = createAuthServer();
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetAccessCache(TENANT, USER);
});

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
  await owner.tenant.deleteMany({ where: { id: TENANT } });
  await owner.$disconnect();
  await disconnectAll();
  await disconnectRedis();
});

describe('routing', () => {
  it('answers health and readiness', async () => {
    expect((await call('/health')).status).toBe(200);

    const ready = await call('/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready' });
  });

  it('answers 404 for an unregistered path', async () => {
    expect((await call('/nope')).status).toBe(404);
  });

  /**
   * A known path with the wrong method is a 404, not a 405.
   *
   * A 405 confirms the path exists, which is exactly what someone mapping the
   * service wants to learn, and nothing legitimate needs the difference.
   */
  it('answers 404 for a known path with the wrong method', async () => {
    expect((await call('/api/auth/login')).status).toBe(404);
  });

  it('serves the public key set', async () => {
    const response = await call('/api/.well-known/jwks.json');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { keys: Array<Record<string, unknown>> };
    expect(Array.isArray(body.keys)).toBe(true);
    // Whatever else is true, a private component must never appear here.
    for (const jwk of body.keys) expect(jwk).not.toHaveProperty('d');
  });

  it('echoes the correlation id it was given', async () => {
    const id = randomUUID();
    const response = await call('/health', { headers: { 'x-correlation-id': id } });

    // This is what makes one request one story across two services, instead of
    // two log streams matched by timestamp.
    expect(response.headers.get('x-correlation-id')).toBe(id);
  });
});

describe('login', () => {
  it('issues a token and sets the refresh cookie', async () => {
    const response = await call('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantCode: CODE, email: EMAIL, password: PASSWORD }),
    });

    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body['accessToken']).toBe('string');

    /**
     * The refresh token must NOT be in the body.
     *
     * It exists only as an httpOnly cookie, so page JavaScript never holds it
     * and therefore cannot put it anywhere durable (PLAN/11 §5.3). Asserted
     * rather than assumed, because "also return it, for convenience" is the
     * single most natural change anybody would make to this endpoint.
     */
    expect(body).not.toHaveProperty('refreshToken');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('hrms_rt=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    // Scoped to the auth path: a request to /api/employees never carries it, and
    // what is never sent cannot leak.
    expect(cookie).toContain('Path=/api/auth');
  });

  it('refuses a wrong password without saying which field was wrong', async () => {
    const response = await call('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantCode: CODE, email: EMAIL, password: 'WrongPassword12345' }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
    expect(body.error.message).not.toMatch(/email|sandi salah/i);
  });

  it('refuses a malformed body with the same envelope as the backend', async () => {
    const response = await call('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', correlationId: expect.any(String) },
    });
  });
});

describe('the session lifecycle', () => {
  it('refreshes with the cookie and rotates it', async () => {
    const login = await call('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantCode: CODE, email: EMAIL, password: PASSWORD }),
    });

    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;

    const refreshed = await call('/api/auth/refresh', { method: 'POST', headers: { cookie } });
    expect(refreshed.status).toBe(200);

    const rotated = (refreshed.headers.get('set-cookie') ?? '').split(';')[0]!;
    // Rotation is what makes reuse detectable: the same token twice is evidence
    // of theft rather than an ordinary refresh.
    expect(rotated).not.toBe(cookie);
  });

  it('refuses a refresh with no cookie', async () => {
    expect((await call('/api/auth/refresh', { method: 'POST' })).status).toBe(401);
  });

  it('logs out, and the cookie stops working', async () => {
    const login = await call('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantCode: CODE, email: EMAIL, password: PASSWORD }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;

    const out = await call('/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');

    expect((await call('/api/auth/refresh', { method: 'POST', headers: { cookie } })).status).toBe(401);
  });

  it('logs out an unknown session without saying it was unknown', async () => {
    // Logout is not a place to tell a caller whether a session ever existed.
    const out = await call('/api/auth/logout', { method: 'POST', headers: { cookie: 'hrms_rt=nope' } });
    expect(out.status).toBe(204);
  });
});

describe('password reset', () => {
  /**
   * Always 204, whatever happened.
   *
   * A reply distinguishing "registered" from "not registered" turns this into a
   * tool for enumerating a company's employee email addresses — and that list is
   * exactly what is most useful to an attacker.
   */
  it('says nothing about whether the address exists', async () => {
    const forKnown = await call('/api/auth/password/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantCode: CODE, email: EMAIL }),
    });

    const forUnknown = await call('/api/auth/password/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantCode: CODE, email: `nobody-${suffix}@service.test` }),
    });

    expect(forKnown.status).toBe(204);
    expect(forUnknown.status).toBe(forKnown.status);
  });

  it('refuses a fabricated reset token', async () => {
    const response = await call('/api/auth/password/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'x'.repeat(48), newPassword: 'BrandNewPassword123' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'TOKEN_INVALID' } });
  });
});

describe('the authorize RPC', () => {
  const token = async (): Promise<string> =>
    issueAccessToken({
      userId: USER,
      tenantId: TENANT,
      tenantCode: CODE,
      email: EMAIL,
      accessVersion: await currentVersion(),
    });

  const authorize = async (body: unknown, secret: string | null = SECRET): Promise<Response> =>
    call('/internal/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-internal-secret': secret } : {}),
      },
      body: JSON.stringify(body),
    });

  /**
   * The guard that holds when the proxy does not.
   *
   * `/internal/*` is supposed to be off the public origin (§7). A misconfigured
   * proxy is a likelier failure than a stolen secret, and one line of routing
   * configuration must not be the only thing between the internet and the
   * authorization endpoint.
   */
  it('is invisible without the internal secret', async () => {
    const response = await authorize({ token: 'x', module: 'leave', permission: null }, null);
    // 404, not 403: a 403 confirms the endpoint exists.
    expect(response.status).toBe(404);
  });

  it('is invisible with the wrong internal secret', async () => {
    const response = await authorize({ token: 'x', module: 'leave', permission: null }, 'wrong');
    expect(response.status).toBe(404);
  });

  it('allows a held permission and returns the identity with it', async () => {
    const response = await authorize({
      token: await token(),
      module: 'leave',
      permission: 'leave.request.read.own',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      allowed: true,
      reason: null,
      tenantId: TENANT,
      userId: USER,
      email: EMAIL,
    });
  });

  it('denies a permission the user does not hold', async () => {
    const response = await authorize({
      token: await token(),
      module: 'leave',
      permission: 'leave.request.approve',
    });

    expect(await response.json()).toMatchObject({ allowed: false, reason: 'permission' });
  });

  it('denies an unsubscribed module, and says so distinctly', async () => {
    const response = await authorize({ token: await token(), module: 'payroll', permission: null });

    // `module`, not `permission`: the customer can act on the first and not on
    // the second, and telling them the wrong one sends them to the wrong person.
    expect(await response.json()).toMatchObject({ allowed: false, reason: 'module' });
  });

  it('reports a stale access version', async () => {
    const stale = await issueAccessToken({
      userId: USER,
      tenantId: TENANT,
      tenantCode: CODE,
      email: EMAIL,
      accessVersion: (await currentVersion()) + 5,
    });

    const response = await authorize({ token: stale, module: 'leave', permission: null });
    expect(await response.json()).toMatchObject({ allowed: false, reason: 'stale' });
  });

  /**
   * A malformed token is 401, not 400.
   *
   * Measured before this was fixed: a short token failed the request schema, the
   * backend read the resulting 400 as "auth is unwell", and answered **503** —
   * reporting its own outage for what was plainly a bad credential. Deciding
   * whether a token is valid is this endpoint's entire job.
   */
  it('answers 401 for a malformed token, never 400', async () => {
    for (const bad of ['x', 'not.a.token', 'a'.repeat(40)]) {
      const response = await authorize({ token: bad, module: 'leave', permission: null });
      expect(response.status, bad).toBe(401);
    }
  });

  /**
   * The token is verified here; a caller may not name the user.
   *
   * Accepting a `userId` would let anything able to reach this endpoint —
   * including a compromised backend — authorize itself as any user of any
   * tenant. The body carries a token and nothing that identifies a person.
   */
  it('ignores an attempt to name the user directly', async () => {
    const response = await authorize({
      token: await token(),
      module: 'leave',
      permission: 'leave.request.read.own',
      userId: randomUUID(),
      tenantId: randomUUID(),
    });

    expect(await response.json()).toMatchObject({ tenantId: TENANT, userId: USER });
  });
});
