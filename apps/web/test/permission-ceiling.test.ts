import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import { disconnectAll } from '@hrms/db';
import { resetAccessCache, disconnectRedis } from '@hrms/cache';
import { issueAccessToken } from '@hrms/core/auth';
import { PUT as putRolePermissions } from '../src/app/api/roles/[id]/permissions/route.ts';
import { PUT as putGrant, DELETE as deleteGrant } from '../src/app/api/users/[id]/grants/route.ts';
import { POST as inviteUser } from '../src/app/api/users/route.ts';
import { POST as inviteFromEmployees } from '../src/app/api/users/from-employees/route.ts';

/**
 * The permission ceiling (P6-13, `docs/SECURITY/02` §5(a), risk F12).
 *
 * A tenant delegates IAM to a custom role. Before the ceiling, that delegate
 * could add `payroll.run.execute` to their own role, grant it to themselves, or
 * DENY the owner's `iam.role.manage` and lock the owner out — delegation was
 * ownership by another name.
 *
 * Every case drives the real route module with a real signed token against real
 * rows under RLS. The ceiling lives in `packages/core`, but the refusal a user
 * meets is the route's status and code, and the route's `IamError` mapping is
 * exactly where a correct domain refusal could have turned into a 404 or a 500.
 *
 * `payroll` is deliberately NOT in the test plan: the ceiling compares against
 * permissions held before the subscription filter (spec §13), and the STAFF
 * invite case proves an unsubscribed permission does not block a legitimate
 * invitation.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

const TENANT = randomUUID();
const suffix = TENANT.slice(0, 8);
const TENANT_CODE = `t-ceil-${suffix}`;

const OWNER_USER = randomUUID();
const DELEGATE_USER = randomUUID();
const OTHER_USER = randomUUID();

const OWNER_ROLE = randomUUID();
const DELEGATE_ROLE = randomUUID();
const TARGET_ROLE = randomUUID();
const RICH_ROLE = randomUUID();

const STAFF_ROLE_CODE = `ceil-staff-${suffix}`;
const RICH_ROLE_CODE = `ceil-rich-${suffix}`;

const email = (name: string): string => `${name}-${suffix}@ceiling.test`;

/** Held by the delegate. */
const DELEGATE_PERMISSIONS = [
  'iam.role.manage',
  'iam.role.read',
  'iam.grant.manage',
  'iam.user.create',
  'iam.user.read',
  'payroll.payslip.read.own',
];

/** Not held by the delegate. The permission the attack wants. */
const PRIZE = 'payroll.run.execute';

async function tokenFor(userId: string): Promise<string> {
  const row = await owner.accessVersion.findUnique({ where: { userId }, select: { version: true } });
  const user = await owner.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  return issueAccessToken({
    userId,
    tenantId: TENANT,
    tenantCode: TENANT_CODE,
    email: user.email,
    accessVersion: row?.version ?? 0,
  });
}

async function call(
  handler: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
  as: string,
  method: string,
  body: unknown,
  params: Record<string, string> = {},
): Promise<{ status: number; body: { error?: { code: string; details?: Record<string, string[]> } } }> {
  const response = await handler(
    new Request('http://localhost/api/test', {
      method,
      headers: { authorization: `Bearer ${await tokenFor(as)}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );
  return { status: response.status, body: await response.json() };
}

async function rolePermissions(roleId: string): Promise<string[]> {
  const rows = await owner.rolePermission.findMany({ where: { roleId }, select: { permissionCode: true } });
  return rows.map((r) => r.permissionCode).sort();
}

async function grantOf(userId: string, permissionCode: string): Promise<string | null> {
  const row = await owner.userPermissionGrant.findFirst({
    where: { userId, permissionCode },
    select: { effect: true },
  });
  return row?.effect ?? null;
}

const roleRow = (id: string, code: string, permissions: string[]) => ({
  id,
  tenantId: TENANT,
  code,
  name: code,
  permissions: { create: permissions.map((permissionCode) => ({ tenantId: TENANT, permissionCode })) },
});

beforeAll(async () => {
  await owner.plan.upsert({
    where: { code: 'ceiling-test-plan' },
    create: { code: 'ceiling-test-plan', name: 'Ceiling Test' },
    update: {},
  });
  await owner.tenant.create({
    data: { id: TENANT, code: TENANT_CODE, name: 'Ceiling Test', status: 'ACTIVE', planCode: 'ceiling-test-plan' },
  });

  const all = await owner.permission.findMany({ select: { code: true } });
  await owner.role.create({ data: { ...roleRow(OWNER_ROLE, 'TENANT_OWNER', all.map((p) => p.code)), isSystem: true } });
  await owner.role.create({ data: roleRow(DELEGATE_ROLE, `ceil-del-${suffix}`, DELEGATE_PERMISSIONS) });
  await owner.role.create({ data: roleRow(TARGET_ROLE, `ceil-tgt-${suffix}`, ['iam.user.read']) });
  await owner.role.create({ data: roleRow(RICH_ROLE, RICH_ROLE_CODE, [PRIZE]) });
  await owner.role.create({ data: roleRow(randomUUID(), STAFF_ROLE_CODE, ['payroll.payslip.read.own']) });

  for (const [id, name, roleId] of [
    [OWNER_USER, 'owner', OWNER_ROLE],
    [DELEGATE_USER, 'delegate', DELEGATE_ROLE],
    [OTHER_USER, 'other', TARGET_ROLE],
  ] as const) {
    await owner.user.create({
      data: { id, tenantId: TENANT, email: email(name), fullName: name, passwordHash: 'x', status: 'ACTIVE' },
    });
    await owner.userRole.create({ data: { tenantId: TENANT, userId: id, roleId } });
    await owner.accessVersion.create({ data: { tenantId: TENANT, userId: id, version: 1 } });
  }
});

beforeEach(async () => {
  for (const user of [OWNER_USER, DELEGATE_USER, OTHER_USER]) await resetAccessCache(TENANT, user);
});

afterAll(async () => {
  await owner.tenant.deleteMany({ where: { id: TENANT } });
  await owner.$disconnect();
  await disconnectAll();
  await disconnectRedis();
});

describe('roles — a delegate cannot confer what they do not hold', () => {
  it('refuses adding the prize to their own role', async () => {
    const before = await rolePermissions(DELEGATE_ROLE);
    const res = await call(putRolePermissions, DELEGATE_USER, 'PUT', { permissions: [...before, PRIZE] }, { id: DELEGATE_ROLE });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'PERMISSION_CEILING', details: { permissions: [PRIZE] } });
    expect(await rolePermissions(DELEGATE_ROLE)).toEqual(before);
  });

  it('refuses adding the prize to another role', async () => {
    const res = await call(putRolePermissions, DELEGATE_USER, 'PUT', { permissions: ['iam.user.read', PRIZE] }, { id: TARGET_ROLE });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('PERMISSION_CEILING');
    expect(await rolePermissions(TARGET_ROLE)).toEqual(['iam.user.read']);
  });

  it('allows adding a permission they hold', async () => {
    const res = await call(putRolePermissions, DELEGATE_USER, 'PUT', { permissions: ['iam.user.read', 'iam.role.read'] }, { id: TARGET_ROLE });

    expect(res.status).toBe(200);
    expect(await rolePermissions(TARGET_ROLE)).toEqual(['iam.role.read', 'iam.user.read']);
  });

  it('allows saving a role that already holds the prize, and removing it', async () => {
    const keep = await call(putRolePermissions, DELEGATE_USER, 'PUT', { permissions: [PRIZE, 'iam.user.read'] }, { id: RICH_ROLE });
    expect(keep.status).toBe(200);

    const remove = await call(putRolePermissions, DELEGATE_USER, 'PUT', { permissions: ['iam.user.read'] }, { id: RICH_ROLE });
    expect(remove.status).toBe(200);
    expect(await rolePermissions(RICH_ROLE)).toEqual(['iam.user.read']);

    // Restore for the invite cases below.
    await owner.rolePermission.create({ data: { tenantId: TENANT, roleId: RICH_ROLE, permissionCode: PRIZE } });
  });

  it('refuses emptying the TENANT_OWNER role', async () => {
    const before = await rolePermissions(OWNER_ROLE);
    const res = await call(putRolePermissions, DELEGATE_USER, 'PUT', { permissions: [] }, { id: OWNER_ROLE });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'PERMISSION_CEILING', details: { role: ['TENANT_OWNER'] } });
    expect(await rolePermissions(OWNER_ROLE)).toEqual(before);
  });
});

describe('grants — a delegate cannot confer what they do not hold', () => {
  const grant = (permissionCode: string, effect: 'GRANT' | 'DENY') => ({
    permissionCode,
    effect,
    reason: 'ceiling abuse-case test',
  });

  it('refuses granting the prize to themselves', async () => {
    const res = await call(putGrant, DELEGATE_USER, 'PUT', grant(PRIZE, 'GRANT'), { id: DELEGATE_USER });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'PERMISSION_CEILING', details: { permissions: [PRIZE] } });
    expect(await grantOf(DELEGATE_USER, PRIZE)).toBeNull();
  });

  it('refuses granting the prize to someone else', async () => {
    const res = await call(putGrant, DELEGATE_USER, 'PUT', grant(PRIZE, 'GRANT'), { id: OTHER_USER });

    expect(res.status).toBe(403);
    expect(await grantOf(OTHER_USER, PRIZE)).toBeNull();
  });

  it('allows a DENY — removing access stays possible', async () => {
    const res = await call(putGrant, DELEGATE_USER, 'PUT', grant(PRIZE, 'DENY'), { id: OTHER_USER });

    expect(res.status).toBe(200);
    expect(await grantOf(OTHER_USER, PRIZE)).toBe('DENY');
  });

  it('refuses lifting a DENY on a permission they lack', async () => {
    const res = await call(deleteGrant, DELEGATE_USER, 'DELETE', { permissionCode: PRIZE }, { id: OTHER_USER });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('PERMISSION_CEILING');
    expect(await grantOf(OTHER_USER, PRIZE)).toBe('DENY');
  });

  it('refuses a DENY against the owner', async () => {
    const res = await call(putGrant, DELEGATE_USER, 'PUT', grant('iam.role.manage', 'DENY'), { id: OWNER_USER });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'PERMISSION_CEILING', details: { role: ['TENANT_OWNER'] } });
    expect(await grantOf(OWNER_USER, 'iam.role.manage')).toBeNull();
  });

  it('allows granting a permission they hold', async () => {
    const res = await call(putGrant, DELEGATE_USER, 'PUT', grant('iam.role.read', 'GRANT'), { id: OTHER_USER });

    expect(res.status).toBe(200);
    expect(await grantOf(OTHER_USER, 'iam.role.read')).toBe('GRANT');
  });
});

describe('invitations — the assigned role is within the ceiling', () => {
  const invite = (name: string, roleCode: string) => ({ email: email(name), fullName: name, roleCode });

  it('refuses inviting into TENANT_OWNER', async () => {
    const res = await call(inviteUser, DELEGATE_USER, 'POST', invite('new-owner', 'TENANT_OWNER'));

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'PERMISSION_CEILING', details: { role: ['TENANT_OWNER'] } });
    expect(await owner.user.count({ where: { email: email('new-owner') } })).toBe(0);
  });

  it('refuses inviting into a role holding the prize', async () => {
    const res = await call(inviteUser, DELEGATE_USER, 'POST', invite('rich', RICH_ROLE_CODE));

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'PERMISSION_CEILING', details: { permissions: [PRIZE] } });
    expect(await owner.user.count({ where: { email: email('rich') } })).toBe(0);
  });

  it('refuses a bulk invitation into a role holding the prize', async () => {
    const res = await call(inviteFromEmployees, DELEGATE_USER, 'POST', { roleCode: RICH_ROLE_CODE });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('PERMISSION_CEILING');
  });

  it('allows inviting into a role whose only permission belongs to an unsubscribed module they hold', async () => {
    const res = await call(inviteUser, DELEGATE_USER, 'POST', invite('staff', STAFF_ROLE_CODE));

    expect(res.status).toBe(201);
  });
});

describe('the owner is not capped', () => {
  it('may add the prize to any role and grant it directly', async () => {
    const role = await call(putRolePermissions, OWNER_USER, 'PUT', { permissions: ['iam.user.read', PRIZE] }, { id: TARGET_ROLE });
    expect(role.status).toBe(200);

    const grant = await call(
      putGrant,
      OWNER_USER,
      'PUT',
      { permissionCode: PRIZE, effect: 'GRANT', reason: 'owner grants deliberately' },
      { id: DELEGATE_USER },
    );
    expect(grant.status).toBe(200);
    expect(await grantOf(DELEGATE_USER, PRIZE)).toBe('GRANT');
  });
});
