import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import { disconnectAll } from '@hrms/db';
import { issueAccessToken } from '@hrms/core/auth';
import { defineRoute } from '../src/lib/define-route.ts';

/**
 * The authorization gateway, exercised against a real database.
 *
 * Every decision here has been verified before only by driving a running server
 * with curl. That proves the behaviour once, on one machine, and proves nothing
 * on the next change — which is how P7, P8, and P9 end up as documented
 * intentions rather than enforced ones.
 *
 * The route handler is invoked directly with a real `Request` and a real signed
 * token, against real rows under real RLS. Nothing is stubbed: a stubbed
 * `resolveEffectiveAccess` would test that the stub agrees with the assertion,
 * while the interesting failures live in the interaction — a subscription that
 * silently keeps a permission alive, an access version that nothing compares.
 *
 * `defineRoute` reads `ROUTE_MANIFEST`, so the tests borrow real route ids
 * rather than inventing ones. An invented id is refused at construction (P7),
 * which is itself worth a test.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

const TENANT = randomUUID();
const USER = randomUUID();
const suffix = TENANT.slice(0, 8);

/** A route requiring a leave permission. */
const GUARDED = 'GET /api/leave/balances' as const;

async function tokenFor(accessVersion: number): Promise<string> {
  return issueAccessToken({
    userId: USER,
    tenantId: TENANT,
    tenantCode: `t-gw-${suffix}`,
    email: `gw-${suffix}@gateway.test`,
    accessVersion,
  });
}

function request(token: string | null, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/leave/balances', {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

/** The handler under test: it records that it ran, and returns 200. */
let reached = false;
const handler = defineRoute(GUARDED, async () => {
  reached = true;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

async function currentVersion(): Promise<number> {
  const row = await owner.accessVersion.findUnique({
    where: { userId: USER },
    select: { version: true },
  });
  return row?.version ?? 0;
}

beforeAll(async () => {
  await owner.plan.upsert({
    where: { code: 'gateway-test-plan' },
    create: {
      code: 'gateway-test-plan',
      name: 'Gateway Test',
      modules: { create: [{ moduleCode: 'leave' }] },
    },
    update: {},
  });

  await owner.tenant.create({
    data: {
      id: TENANT,
      code: `t-gw-${suffix}`,
      name: 'Gateway Test',
      status: 'ACTIVE',
      planCode: 'gateway-test-plan',
    },
  });

  await owner.tenantModule.create({
    data: { tenantId: TENANT, moduleCode: 'leave', status: 'ENABLED' },
  });

  await owner.user.create({
    data: {
      id: USER,
      tenantId: TENANT,
      email: `gw-${suffix}@gateway.test`,
      fullName: 'Gateway Probe',
      passwordHash: 'x',
      status: 'ACTIVE',
    },
  });

  const role = await owner.role.create({
    data: {
      tenantId: TENANT,
      code: `gw-${suffix}`,
      name: 'Penyetuju',
      permissions: {
        create: [
          { tenantId: TENANT, permissionCode: 'leave.request.read.own' },
          { tenantId: TENANT, permissionCode: 'leave.balance.read.own' },
        ],
      },
    },
  });

  await owner.userRole.create({ data: { tenantId: TENANT, userId: USER, roleId: role.id } });
});

afterAll(async () => {
  await owner.tenant.deleteMany({ where: { id: TENANT } });
  await owner.$disconnect();
  await disconnectAll();
});

describe('the gateway chain', () => {
  it('lets a properly entitled request through', async () => {
    reached = false;
    const response = await handler(request(await tokenFor(await currentVersion())));

    expect(response.status).toBe(200);
    expect(reached).toBe(true);
  });

  it('refuses a request with no token', async () => {
    reached = false;
    const response = await handler(request(null));

    expect(response.status).toBe(401);
    expect(reached).toBe(false);
  });

  it('refuses a token this system did not sign', async () => {
    reached = false;
    const response = await handler(request('not.a.token'));

    expect(response.status).toBe(401);
    expect(reached).toBe(false);
  });

  /**
   * Risk R15. Accepting a tenant header that disagrees with the token — even
   * once, on one path — is how a cross-tenant leak usually happens. The header
   * confirms; it is never the source.
   */
  it('refuses an X-Tenant-ID that disagrees with the token', async () => {
    reached = false;
    const token = await tokenFor(await currentVersion());
    const response = await handler(request(token, { 'x-tenant-id': randomUUID() }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'TENANT_MISMATCH' } });
    expect(reached).toBe(false);
  });

  it('accepts an X-Tenant-ID that agrees with it', async () => {
    reached = false;
    const token = await tokenFor(await currentVersion());
    const response = await handler(request(token, { 'x-tenant-id': TENANT }));

    expect(response.status).toBe(200);
    expect(reached).toBe(true);
  });
});

describe('P8 — a subscription beats a role', () => {
  /**
   * 402 before 403, and the order is deliberate: "your plan does not include
   * this module" is something a customer can act on, and "access denied" is not.
   *
   * The role is untouched throughout. That is the property worth having — when a
   * tenant stops paying for a module, nothing has to remember to revoke
   * anything, and enabling it again restores exactly what was there.
   */
  it('answers 402 when the module is disabled, though the role still grants it', async () => {
    await owner.tenantModule.update({
      where: { tenantId_moduleCode: { tenantId: TENANT, moduleCode: 'leave' } },
      data: { status: 'DISABLED' },
    });

    try {
      reached = false;
      const response = await handler(request(await tokenFor(await currentVersion())));

      expect(response.status).toBe(402);
      expect(await response.json()).toMatchObject({
        error: { code: 'MODULE_NOT_SUBSCRIBED' },
      });
      expect(reached).toBe(false);
    } finally {
      await owner.tenantModule.update({
        where: { tenantId_moduleCode: { tenantId: TENANT, moduleCode: 'leave' } },
        data: { status: 'ENABLED' },
      });
    }
  });

  /**
   * The downgrade case, which costs money rather than safety.
   *
   * A tenant moving to a cheaper plan keeps an ENABLED `tenant_modules` row from
   * the previous subscription. Reading that row alone would let them go on using
   * a module they no longer pay for, and the only thing that would change is
   * their invoice. Entitlement is the INTERSECTION of "enabled by the tenant"
   * and "included in the plan".
   */
  it('answers 402 when the plan no longer includes the module', async () => {
    await owner.plan.upsert({
      where: { code: 'gateway-test-plan-lite' },
      create: { code: 'gateway-test-plan-lite', name: 'Gateway Lite' },
      update: {},
    });
    await owner.tenant.update({
      where: { id: TENANT },
      data: { planCode: 'gateway-test-plan-lite' },
    });

    try {
      reached = false;
      const response = await handler(request(await tokenFor(await currentVersion())));

      expect(response.status).toBe(402);
      expect(reached).toBe(false);
    } finally {
      await owner.tenant.update({ where: { id: TENANT }, data: { planCode: 'gateway-test-plan' } });
    }
  });
});

describe('P9 — the server refuses what the screen hides', () => {
  it('answers 403 when the role does not carry the permission', async () => {
    const role = await owner.role.findFirst({
      where: { tenantId: TENANT },
      select: { id: true },
    });

    await owner.rolePermission.deleteMany({
      where: { roleId: role!.id, permissionCode: 'leave.balance.read.own' },
    });

    try {
      reached = false;
      const response = await handler(request(await tokenFor(await currentVersion())));

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
      expect(reached).toBe(false);
    } finally {
      await owner.rolePermission.create({
        data: { tenantId: TENANT, roleId: role!.id, permissionCode: 'leave.balance.read.own' },
      });
    }
  });

  /**
   * A DENY grant beats the role that allows it.
   *
   * The precedence matters most in an emergency: revoking one person's access
   * has to be one action, not a trace through every role they hold.
   */
  it('honours a per-user DENY over the role', async () => {
    await owner.userPermissionGrant.create({
      data: {
        tenantId: TENANT,
        userId: USER,
        permissionCode: 'leave.balance.read.own',
        effect: 'DENY',
        // Both required by the schema, deliberately: a grant with no stated
        // reason cannot be reviewed six months later.
        reason: 'uji gerbang: DENY mengalahkan peran',
        grantedBy: USER,
      },
    });

    try {
      reached = false;
      const response = await handler(request(await tokenFor(await currentVersion())));

      expect(response.status).toBe(403);
      expect(reached).toBe(false);
    } finally {
      await owner.userPermissionGrant.deleteMany({ where: { tenantId: TENANT, userId: USER } });
    }
  });
});

describe('the access version (PLAN/14 stage 2)', () => {
  /**
   * `av` was minted into every token from the beginning, documented as the
   * mechanism that invalidates stale permissions, and **compared by nothing**.
   *
   * It was harmless while access is read from the database on every request:
   * permissions were always current, so there was nothing for a version to
   * invalidate. It stops being harmless the moment a permission cache exists —
   * PLAN/14 §5 option C, which is what makes the auth split affordable — because
   * then this comparison is the only thing making a cached permission safe to
   * trust.
   *
   * Enforced now, and tested now, so it is not first exercised on the day it
   * becomes load-bearing.
   */
  it('refuses a token whose access version is behind the record', async () => {
    // The record is moved forward first, because `av` is a non-negative claim:
    // "one behind zero" is not a token this system can mint, so it cannot stand
    // in for a stale one.
    const base = (await currentVersion()) + 1;
    await owner.accessVersion.upsert({
      where: { userId: USER },
      create: { userId: USER, tenantId: TENANT, version: base },
      update: { version: base },
    });

    reached = false;
    const response = await handler(request(await tokenFor(base - 1)));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'TOKEN_STALE' } });
    expect(reached).toBe(false);
  });

  /**
   * Ahead of the record is refused too, and that is not symmetry for its own
   * sake. A version higher than the stored one should be impossible; when it
   * happens the record has moved BACKWARDS — a restored backup, a botched
   * migration — and the honest reading is that we no longer know what this user
   * is entitled to.
   */
  it('refuses a token whose access version is ahead of the record', async () => {
    reached = false;
    const response = await handler(request(await tokenFor((await currentVersion()) + 50)));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'TOKEN_STALE' } });
    expect(reached).toBe(false);
  });

  /**
   * The whole point: a permission change makes existing tokens stale, and a
   * freshly issued one works immediately. This is what a cache will rely on.
   */
  it('invalidates outstanding tokens when the version is bumped, and the next one works', async () => {
    const before = await currentVersion();
    const oldToken = await tokenFor(before);

    expect((await handler(request(oldToken))).status).toBe(200);

    await owner.accessVersion.upsert({
      where: { userId: USER },
      create: { userId: USER, tenantId: TENANT, version: before + 1 },
      update: { version: before + 1 },
    });

    expect((await handler(request(oldToken))).status).toBe(401);
    expect((await handler(request(await tokenFor(before + 1)))).status).toBe(200);
  });
});

describe('P7 — no route without an explicit decision', () => {
  it('refuses to construct a handler for an unregistered route', () => {
    expect(() =>
      // @ts-expect-error — deliberately not a member of the manifest.
      defineRoute('GET /api/not/in/the/manifest', async () => new Response(null)),
    ).toThrow(/ROUTE_MANIFEST/);
  });

  /**
   * The manifest and the handler must agree about being public, and the
   * disagreement has to fail at module load rather than at the first request.
   *
   * `POST /api/auth/login` really is public. Declaring it with `defineRoute`
   * instead of `definePublicRoute` would make every login require the token it
   * exists to issue — noticed instantly. The dangerous direction is the other
   * one, and it is caught by the same check.
   */
  it('refuses a handler whose public flag disagrees with the manifest', () => {
    expect(() => defineRoute('POST /api/auth/login', async () => new Response(null))).toThrow(
      /public/,
    );
  });
});
