import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import { withTenant, disconnectAll } from '@hrms/db';
import { findManagerUserId, findPermissionHolders } from '../src/iam/resolve-access.ts';

/**
 * Resolving a line manager, and who may approve leave.
 *
 * Against a real PostgreSQL, with real rows, under real RLS. That is not
 * ceremony: what is being tested is a chain of three lookups whose interesting
 * behaviour is what happens when a row is ABSENT, and a hand-written fake would
 * only prove that the fake returns what it was told to. It cannot tell us that
 * `effectiveTo: null` selects the open employment period, that the employee →
 * user join by email actually matches, or that a tenant's rows stay invisible to
 * another tenant's query.
 *
 * `Employment.managerId` sat unread from the day the org module was built. It is
 * now the DEFAULT approver for a person's leave, so every way the chain can come
 * up empty matters — each one is silent, and each produces the same visible
 * result as "no manager was ever designated":
 *
 *     employment (open period) → managerId → employee → email → user
 *
 * The employee → user hop is a join by EMAIL, not by key: the employee module
 * holds no foreign key into `auth.users` because the two are meant to be
 * separable (PLAN/01 §4.2). That makes it the hop most likely to break quietly.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

const TENANT = randomUUID();
const suffix = TENANT.slice(0, 8);

// Employees
const STAFF = randomUUID();
const MANAGER = randomUUID();
const MANAGER_NO_USER = randomUUID();
const MANAGER_NO_EMAIL = randomUUID();

// Users
const STAFF_USER = randomUUID();
const MANAGER_USER = randomUUID();
const INACTIVE_USER = randomUUID();

const DEPARTMENT = randomUUID();
const POSITION = randomUUID();

const email = (name: string): string => `${name}-${suffix}@approver.test`;

beforeAll(async () => {
  await owner.plan.upsert({
    where: { code: 'approver-test-plan' },
    create: {
      code: 'approver-test-plan',
      name: 'Approver Test',
      modules: { create: [{ moduleCode: 'leave' }] },
    },
    update: {},
  });

  await owner.tenant.create({
    data: {
      id: TENANT,
      code: `t-appr-${suffix}`,
      name: 'Approver Test',
      status: 'ACTIVE',
      planCode: 'approver-test-plan',
    },
  });

  // The leave module has to be enabled: `resolveEffectiveAccess` filters
  // permissions by subscription (P8), so a holder of `leave.request.approve` in
  // a tenant without the leave module correctly holds nothing.
  await owner.tenantModule.create({
    data: { tenantId: TENANT, moduleCode: 'leave', status: 'ENABLED' },
  });

  await owner.department.create({
    data: { id: DEPARTMENT, tenantId: TENANT, code: `d-${suffix}`, name: 'Ops', path: `d-${suffix}` },
  });
  await owner.position.create({
    data: { id: POSITION, tenantId: TENANT, code: `p-${suffix}`, name: 'Staff' },
  });

  await owner.employee.createMany({
    data: [
      {
        id: STAFF, tenantId: TENANT, employeeNumber: `E1-${suffix}`,
        fullName: 'Andi Staf', email: email('staff'), joinDate: new Date('2024-01-01'),
      },
      {
        id: MANAGER, tenantId: TENANT, employeeNumber: `E2-${suffix}`,
        fullName: 'Sari Manajer', email: email('manager'), joinDate: new Date('2023-01-01'),
      },
      {
        id: MANAGER_NO_USER, tenantId: TENANT, employeeNumber: `E3-${suffix}`,
        fullName: 'Tanpa Akun', email: email('nouser'), joinDate: new Date('2023-01-01'),
      },
      {
        // A supervisor imported from a spreadsheet who was never invited. Common
        // enough on a factory floor, and it breaks the join by email.
        id: MANAGER_NO_EMAIL, tenantId: TENANT, employeeNumber: `E4-${suffix}`,
        fullName: 'Tanpa Surel', email: null, joinDate: new Date('2023-01-01'),
      },
    ],
  });

  await owner.user.createMany({
    data: [
      {
        id: STAFF_USER, tenantId: TENANT, email: email('staff'),
        fullName: 'Andi Staf', passwordHash: 'x', status: 'ACTIVE',
      },
      {
        id: MANAGER_USER, tenantId: TENANT, email: email('manager'),
        fullName: 'Sari Manajer', passwordHash: 'x', status: 'ACTIVE',
      },
      {
        id: INACTIVE_USER, tenantId: TENANT, email: email('gone'),
        fullName: 'Sudah Keluar', passwordHash: 'x', status: 'SUSPENDED',
      },
    ],
  });

  const role = await owner.role.create({
    data: {
      tenantId: TENANT,
      code: `approver-${suffix}`,
      name: 'Penyetuju',
      permissions: { create: [{ tenantId: TENANT, permissionCode: 'leave.request.approve' }] },
    },
  });

  // The manager can approve. The staff member cannot. The disabled account can,
  // on paper — which is exactly why it must not appear in the list.
  await owner.userRole.createMany({
    data: [
      { tenantId: TENANT, userId: MANAGER_USER, roleId: role.id },
      { tenantId: TENANT, userId: INACTIVE_USER, roleId: role.id },
    ],
  });
});

afterAll(async () => {
  await owner.tenant.deleteMany({ where: { id: TENANT } });
  await owner.$disconnect();
  await disconnectAll();
});

/** Points the open employment period at a manager, or at nobody. */
async function designate(employeeId: string, managerId: string | null): Promise<void> {
  await owner.employment.deleteMany({ where: { tenantId: TENANT, employeeId } });
  await owner.employment.create({
    data: {
      tenantId: TENANT,
      employeeId,
      departmentId: DEPARTMENT,
      positionId: POSITION,
      type: 'PKWTT',
      effectiveFrom: new Date('2024-01-01'),
      managerId,
    },
  });
}

describe('findManagerUserId', () => {
  it('resolves the whole chain when every hop exists', async () => {
    await designate(STAFF, MANAGER);
    const found = await withTenant(TENANT, (tx) => findManagerUserId(tx, TENANT, STAFF));
    expect(found).toBe(MANAGER_USER);
  });

  /**
   * The common case, and the reason the manager is a default rather than a
   * requirement. Most tenants never fill this column in; requiring it would
   * freeze every leave request they ever submit.
   */
  it('returns null when no manager has been designated', async () => {
    await designate(STAFF, null);
    expect(await withTenant(TENANT, (tx) => findManagerUserId(tx, TENANT, STAFF))).toBeNull();
  });

  it('returns null when the employee has no open employment period', async () => {
    await owner.employment.deleteMany({ where: { tenantId: TENANT, employeeId: STAFF } });
    expect(await withTenant(TENANT, (tx) => findManagerUserId(tx, TENANT, STAFF))).toBeNull();
  });

  /**
   * A dangling soft reference. There is no foreign key on `managerId`, so an id
   * pointing at nothing is a state the database genuinely permits — which is why
   * this test can create it.
   */
  it('returns null when the manager employee row does not exist', async () => {
    await designate(STAFF, randomUUID());
    expect(await withTenant(TENANT, (tx) => findManagerUserId(tx, TENANT, STAFF))).toBeNull();
  });

  it('returns null when the manager has no email to join on', async () => {
    await designate(STAFF, MANAGER_NO_EMAIL);
    expect(await withTenant(TENANT, (tx) => findManagerUserId(tx, TENANT, STAFF))).toBeNull();
  });

  it('returns null when the manager has no user account', async () => {
    await designate(STAFF, MANAGER_NO_USER);
    expect(await withTenant(TENANT, (tx) => findManagerUserId(tx, TENANT, STAFF))).toBeNull();
  });

  /**
   * The closed employment period must not answer.
   *
   * A person who transferred last year has an old row naming their previous
   * manager. Reading it would route leave to somebody who no longer supervises
   * them — and the request would land in a real inbox, so nothing would look
   * broken.
   */
  it('ignores a closed employment period', async () => {
    await owner.employment.deleteMany({ where: { tenantId: TENANT, employeeId: STAFF } });
    await owner.employment.create({
      data: {
        tenantId: TENANT, employeeId: STAFF, departmentId: DEPARTMENT, positionId: POSITION,
        type: 'PKWTT', effectiveFrom: new Date('2023-01-01'),
        effectiveTo: new Date('2023-12-31'), managerId: MANAGER,
      },
    });

    expect(await withTenant(TENANT, (tx) => findManagerUserId(tx, TENANT, STAFF))).toBeNull();
  });
});

describe('findPermissionHolders', () => {
  it('returns only the users who effectively hold the permission', async () => {
    const holders = await withTenant(TENANT, (tx) =>
      findPermissionHolders(tx, TENANT, 'leave.request.approve'),
    );

    expect(holders.map((h) => h.userId)).toEqual([MANAGER_USER]);
  });

  /**
   * A suspended account holds the role and must still not be offered.
   *
   * Routing an approval to an account that cannot log in produces exactly the
   * silent stall this function exists to remove — and a departed manager is the
   * most likely way to reach that state.
   */
  it('excludes a suspended account that still holds the role', async () => {
    const holders = await withTenant(TENANT, (tx) =>
      findPermissionHolders(tx, TENANT, 'leave.request.approve'),
    );

    expect(holders.map((h) => h.userId)).not.toContain(INACTIVE_USER);
  });

  it('returns nobody for a permission no role grants', async () => {
    const holders = await withTenant(TENANT, (tx) =>
      findPermissionHolders(tx, TENANT, 'payroll.run.approve'),
    );

    expect(holders).toEqual([]);
  });

  /**
   * P8 — a subscription beats a role. Disabling the leave module must remove the
   * permission from everyone holding it, without any role changing.
   *
   * Verified here rather than assumed, because this list is what a screen offers:
   * if it disagreed with the gateway, it would offer an approver whose approval
   * is then refused.
   */
  it('drops every holder when the tenant stops subscribing to the module', async () => {
    await owner.tenantModule.update({
      where: { tenantId_moduleCode: { tenantId: TENANT, moduleCode: 'leave' } },
      data: { status: 'DISABLED' },
    });

    try {
      const holders = await withTenant(TENANT, (tx) =>
        findPermissionHolders(tx, TENANT, 'leave.request.approve'),
      );
      expect(holders).toEqual([]);
    } finally {
      await owner.tenantModule.update({
        where: { tenantId_moduleCode: { tenantId: TENANT, moduleCode: 'leave' } },
        data: { status: 'ENABLED' },
      });
    }
  });
});
