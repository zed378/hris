import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import { withTenant, disconnectAll } from '@hrms/db';
import { resetAccessCache, disconnectRedis } from '@hrms/cache';
import { decideAccess } from '../src/iam/authorize.ts';

/**
 * The authorization decision, against a real database (PLAN/14 stage 4).
 *
 * This function is the seam. When authorization becomes a call to the auth
 * service (PLAN/14 §5), its implementation is replaced by an HTTP request and
 * everything around it stays put — so what has to be pinned down is the
 * CONTRACT: which denial each situation produces, and in which order the
 * situations are judged when more than one applies.
 *
 * The order is the part most likely to be lost in a rewrite, because any single
 * check looks correct on its own. It is tested here by constructing states where
 * two things are wrong at once and asserting which one is reported.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

const TENANT = randomUUID();
const USER = randomUUID();
const suffix = TENANT.slice(0, 8);

const MODULE = 'leave';
const PERMISSION = 'leave.request.read.own';
const UNHELD = 'leave.request.approve';

let roleId: string;

async function version(): Promise<number> {
  const row = await owner.accessVersion.findUnique({
    where: { userId: USER },
    select: { version: true },
  });
  return row?.version ?? 0;
}

/** The decision, taken through a real tenant transaction under RLS. */
async function decide(overrides: Partial<Parameters<typeof decideAccess>[1]> = {}) {
  // Resolved before the transaction opens: reading it inside would hold a
  // connection while doing work that has nothing to do with the decision.
  const tokenAccessVersion = overrides.tokenAccessVersion ?? (await version());

  return withTenant(TENANT, (tx) =>
    decideAccess(tx, {
      tenantId: TENANT,
      userId: USER,
      tokenAccessVersion,
      module: overrides.module ?? MODULE,
      permission: overrides.permission === undefined ? PERMISSION : overrides.permission,
    }),
  );
}

beforeAll(async () => {
  await owner.plan.upsert({
    where: { code: 'authz-test-plan' },
    create: {
      code: 'authz-test-plan',
      name: 'Authz Test',
      modules: { create: [{ moduleCode: MODULE }] },
    },
    update: {},
  });

  await owner.tenant.create({
    data: {
      id: TENANT,
      code: `t-authz-${suffix}`,
      name: 'Authz Test',
      status: 'ACTIVE',
      planCode: 'authz-test-plan',
    },
  });

  await owner.tenantModule.create({
    data: { tenantId: TENANT, moduleCode: MODULE, status: 'ENABLED' },
  });

  await owner.user.create({
    data: {
      id: USER,
      tenantId: TENANT,
      email: `authz-${suffix}@authz.test`,
      fullName: 'Authz Probe',
      passwordHash: 'x',
      status: 'ACTIVE',
    },
  });

  const role = await owner.role.create({
    data: {
      tenantId: TENANT,
      code: `authz-${suffix}`,
      name: 'Probe',
      permissions: { create: [{ tenantId: TENANT, permissionCode: PERMISSION }] },
    },
  });
  roleId = role.id;

  await owner.userRole.create({ data: { tenantId: TENANT, userId: USER, roleId } });
});

/**
 * Every case starts from a cold cache.
 *
 * These tests change roles, grants, and subscriptions by writing to the database
 * directly — which is the right way to test the RESOLUTION, and is not how the
 * application changes them. The application goes through `bumpAccessVersion` and
 * `bumpTenantGeneration`, and those are what invalidate the cache; a direct write
 * invalidates nothing, so without this the suite would be asserting against
 * decisions cached before the change.
 *
 * The invalidation paths themselves are covered separately, in
 * `packages/cache/test/access-cache.test.ts`. Mixing the two here would leave
 * both half-tested.
 */
beforeEach(async () => {
  await resetAccessCache(TENANT, USER);
});

afterAll(async () => {
  await owner.tenant.deleteMany({ where: { id: TENANT } });
  await owner.$disconnect();
  await disconnectAll();
  await disconnectRedis();
});

describe('decideAccess', () => {
  it('allows a subscribed module and a held permission', async () => {
    const decision = await decide();

    expect(decision.allowed).toBe(true);
    expect(decision.access.permissions).toContain(PERMISSION);
  });

  it('allows a route that requires no permission at all', async () => {
    const decision = await decide({ permission: null });
    expect(decision.allowed).toBe(true);
  });

  it('denies with `permission` when the user does not hold it', async () => {
    const decision = await decide({ permission: UNHELD });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('permission');
  });

  it('denies with `module` when the tenant does not subscribe', async () => {
    const decision = await decide({ module: 'payroll', permission: null });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('module');
  });

  it('denies with `stale` when the token version disagrees with the record', async () => {
    const decision = await decide({ tokenAccessVersion: (await version()) + 1 });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('stale');
  });
});

describe('the order of the checks', () => {
  /**
   * Staleness outranks everything.
   *
   * A token whose access version disagrees with the record describes permissions
   * that are no longer true. Judging a module or a permission against it means
   * answering with information already known to be out of date — and sometimes
   * answering 403 to a user who, one refresh later, is perfectly entitled.
   */
  it('reports `stale` even when the permission is also missing', async () => {
    const decision = await decide({
      tokenAccessVersion: (await version()) + 1,
      permission: UNHELD,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('stale');
  });

  it('reports `stale` even when the module is also unsubscribed', async () => {
    const decision = await decide({
      tokenAccessVersion: (await version()) + 1,
      module: 'payroll',
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('stale');
  });

  /**
   * P8 — module before permission.
   *
   * "Your plan does not include this module" is something a customer can act on.
   * "Access denied" is not: it sends them to an administrator who cannot grant
   * a permission for a module the company has not bought. Reporting the wrong
   * one of these costs a support conversation that ends in the wrong place.
   */
  it('reports `module` rather than `permission` when both apply', async () => {
    const decision = await decide({ module: 'payroll', permission: UNHELD });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('module');
  });
});

describe('the decision follows the data, not the role', () => {
  /**
   * Disabling a module must deny without touching any role — that is what makes
   * a downgrade take effect immediately, with no reconciliation anyone has to
   * remember to run, and makes re-enabling restore exactly what was there.
   */
  it('denies a permission whose module the tenant has disabled', async () => {
    await owner.tenantModule.update({
      where: { tenantId_moduleCode: { tenantId: TENANT, moduleCode: MODULE } },
      data: { status: 'DISABLED' },
    });

    try {
      const decision = await decide();
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('module');

      // The permission is gone from the resolved set as well, not merely
      // refused at the gate — which is what makes P8 hold for anything else
      // reading `access.permissions`.
      expect(decision.access.permissions).not.toContain(PERMISSION);
    } finally {
      await owner.tenantModule.update({
        where: { tenantId_moduleCode: { tenantId: TENANT, moduleCode: MODULE } },
        data: { status: 'ENABLED' },
      });
    }
  });

  it('honours a DENY grant over the role that allows it', async () => {
    await owner.userPermissionGrant.create({
      data: {
        tenantId: TENANT,
        userId: USER,
        permissionCode: PERMISSION,
        effect: 'DENY',
        reason: 'uji: DENY mengalahkan peran',
        grantedBy: USER,
      },
    });

    try {
      const decision = await decide();
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('permission');
    } finally {
      await owner.userPermissionGrant.deleteMany({ where: { tenantId: TENANT, userId: USER } });
    }
  });

  it('honours a GRANT for a permission no role carries', async () => {
    await owner.userPermissionGrant.create({
      data: {
        tenantId: TENANT,
        userId: USER,
        permissionCode: UNHELD,
        effect: 'GRANT',
        reason: 'uji: GRANT tanpa peran',
        grantedBy: USER,
      },
    });

    try {
      const decision = await decide({ permission: UNHELD });
      expect(decision.allowed).toBe(true);
    } finally {
      await owner.userPermissionGrant.deleteMany({ where: { tenantId: TENANT, userId: USER } });
    }
  });

  /**
   * An expired grant is ignored rather than deleted: its row stays so an access
   * review can answer "who once had what, and why".
   */
  it('ignores a grant that has expired', async () => {
    await owner.userPermissionGrant.create({
      data: {
        tenantId: TENANT,
        userId: USER,
        permissionCode: UNHELD,
        effect: 'GRANT',
        reason: 'uji: GRANT kedaluwarsa',
        grantedBy: USER,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    try {
      const decision = await decide({ permission: UNHELD });
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('permission');
    } finally {
      await owner.userPermissionGrant.deleteMany({ where: { tenantId: TENANT, userId: USER } });
    }
  });
});
