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
import { POST as submit } from '../src/app/api/leave/requests/route.ts';
import { POST as decide } from '../src/app/api/leave/requests/[id]/decision/route.ts';

/**
 * The leave approval controls (P4-08, `docs/SECURITY/02` §5(b)(c),
 * `docs/PLAN/13` §5 "Two control failures").
 *
 * Both controls were added after the build, when someone tried the attack
 * and it worked: a manager approving their own leave, and a request addressed
 * to someone who cannot approve it, which then sat PENDING in nobody's inbox.
 * Neither had a test. These go through the real submit and decision handlers
 * with real tokens against real rows, so removing either check in
 * `packages/core/src/leave/requests.ts` fails here.
 *
 * Self-approval is refused "without exception", so it is tried as a manager,
 * as an HR administrator, and as `TENANT_OWNER`, who holds every permission.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

const TENANT = randomUUID();
const suffix = TENANT.slice(0, 8);
const TENANT_CODE = `t-lv-${suffix}`;
const LEAVE_TYPE = randomUUID();

/** One Monday, far enough ahead that every fixture employee is entitled. */
const DAY = '2027-03-01';

type Person = { user: string; employee: string; email: string };
const person = (name: string): Person => ({
  user: randomUUID(),
  employee: randomUUID(),
  email: `${name}-${suffix}@leave-controls.test`,
});
const MANAGER = person('manager');
const HR = person('hr');
const OWNER = person('owner');
const STAFF = person('staff');

const APPROVE = ['leave.request.create.own', 'leave.request.read.own', 'leave.balance.read.own', 'leave.request.approve'];

async function tokenFor(p: Person): Promise<string> {
  const row = await owner.accessVersion.findUnique({ where: { userId: p.user }, select: { version: true } });
  return issueAccessToken({
    userId: p.user,
    tenantId: TENANT,
    tenantCode: TENANT_CODE,
    email: p.email,
    accessVersion: row?.version ?? 0,
  });
}

async function call(
  handler: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
  as: Person,
  body: unknown,
  params: Record<string, string> = {},
): Promise<{ status: number; body: { id?: string; status?: string; error?: { code: string } } }> {
  const response = await handler(
    new Request('http://localhost/api/leave/requests', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(as)}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );
  return { status: response.status, body: await response.json() };
}

/** Submits a one-day request as `requester`, addressed to `approver`. */
async function request(requester: Person, approver: Person) {
  return call(submit, requester, {
    leaveTypeId: LEAVE_TYPE,
    startDate: DAY,
    endDate: DAY,
    reason: 'leave controls test',
    approverId: approver.user,
  });
}

async function balanceOf(p: Person): Promise<{ used: number; pending: number }> {
  const row = await owner.leaveBalance.findFirstOrThrow({
    where: { tenantId: TENANT, employeeId: p.employee, leaveTypeId: LEAVE_TYPE },
    select: { usedDays: true, pendingDays: true },
  });
  return { used: Number(row.usedDays), pending: Number(row.pendingDays) };
}

async function decisionAudits(requestId: string): Promise<number> {
  return owner.auditLog.count({
    where: { tenantId: TENANT, entityId: requestId, action: { in: ['leave.request.approved', 'leave.request.rejected'] } },
  });
}

beforeAll(async () => {
  await owner.plan.upsert({
    where: { code: 'leave-controls-test-plan' },
    create: { code: 'leave-controls-test-plan', name: 'Leave Controls Test', modules: { create: [{ moduleCode: 'leave' }] } },
    update: {},
  });
  await owner.tenant.create({
    data: { id: TENANT, code: TENANT_CODE, name: 'Leave Controls', status: 'ACTIVE', planCode: 'leave-controls-test-plan' },
  });
  await owner.tenantModule.create({ data: { tenantId: TENANT, moduleCode: 'leave', status: 'ENABLED' } });
  await owner.leaveType.create({
    data: { id: LEAVE_TYPE, tenantId: TENANT, code: `ANNUAL-${suffix}`, name: 'Cuti Tahunan', minServiceMonths: 0 },
  });

  const all = await owner.permission.findMany({ select: { code: true } });
  const roles: Array<[Person, string, string[]]> = [
    [MANAGER, `lv-mgr-${suffix}`, APPROVE],
    [HR, `lv-hr-${suffix}`, [...APPROVE, 'leave.request.read.all']],
    [OWNER, 'TENANT_OWNER', all.map((p) => p.code)],
    [STAFF, `lv-staff-${suffix}`, ['leave.request.create.own', 'leave.request.read.own', 'leave.balance.read.own']],
  ];

  for (const [p, code, permissions] of roles) {
    const role = await owner.role.create({
      data: {
        tenantId: TENANT,
        code,
        name: code,
        permissions: { create: permissions.map((permissionCode) => ({ tenantId: TENANT, permissionCode })) },
      },
    });
    await owner.user.create({
      data: { id: p.user, tenantId: TENANT, email: p.email, fullName: code, passwordHash: 'x', status: 'ACTIVE' },
    });
    await owner.userRole.create({ data: { tenantId: TENANT, userId: p.user, roleId: role.id } });
    await owner.accessVersion.create({ data: { tenantId: TENANT, userId: p.user, version: 1 } });
    // The decision route finds the actor's employee row by email — the join the
    // self-approval check depends on.
    await owner.employee.create({
      data: {
        id: p.employee, tenantId: TENANT, employeeNumber: `E-${code}`, fullName: code,
        email: p.email, joinDate: new Date('2020-01-01'),
      },
    });
  }
});

beforeEach(async () => {
  for (const p of [MANAGER, HR, OWNER, STAFF]) await resetAccessCache(TENANT, p.user);
  // Each case starts with no request outstanding, so balances are comparable.
  await owner.leaveRequest.deleteMany({ where: { tenantId: TENANT } });
  await owner.leaveBalance.deleteMany({ where: { tenantId: TENANT } });
});

afterAll(async () => {
  await owner.tenant.deleteMany({ where: { id: TENANT } });
  await owner.$disconnect();
  await disconnectAll();
  await disconnectRedis();
});

describe('self-approval is refused without exception (§5(b))', () => {
  it.each([
    ['a manager', MANAGER],
    ['an HR administrator', HR],
    ['the tenant owner', OWNER],
  ])('refuses %s approving their own leave', async (_who, p) => {
    // Addressed to themselves: the most direct form of the attack. The request
    // itself is accepted — they do hold the approval permission.
    const created = await request(p, p);
    expect(created.status).toBe(201);
    const id = created.body.id!;
    const before = await balanceOf(p);

    const res = await call(decide, p, { approve: true, comment: 'approving my own' }, { id });

    expect(res.status).toBe(403);
    expect(await balanceOf(p)).toEqual(before);
    expect(await decisionAudits(id)).toBe(0);
    const row = await owner.leaveRequest.findUniqueOrThrow({ where: { id }, select: { status: true } });
    expect(row.status).toBe('PENDING');
  });

  it('refuses self-approval even when the request names someone else', async () => {
    const created = await request(MANAGER, HR);
    const res = await call(decide, MANAGER, { approve: true, comment: 'approving my own' }, { id: created.body.id! });

    expect(res.status).toBe(403);
    expect(await decisionAudits(created.body.id!)).toBe(0);
  });
});

describe('the approver must hold the approval permission (§5(c))', () => {
  it('refuses a request addressed to someone who cannot approve', async () => {
    const res = await request(MANAGER, STAFF);

    expect(res.status).toBe(409);
    expect(await owner.leaveRequest.count({ where: { tenantId: TENANT } })).toBe(0);
  });
});

describe('legitimate decisions still work', () => {
  it('lets the named approver decide', async () => {
    const created = await request(STAFF, MANAGER);
    const res = await call(decide, MANAGER, { approve: true, comment: 'approved, enjoy' }, { id: created.body.id! });

    expect(res.status).toBe(200);
    expect(await balanceOf(STAFF)).toEqual({ used: 1, pending: 0 });
    expect(await decisionAudits(created.body.id!)).toBe(1);
  });

  it('lets another holder of the permission stand in (HR for an absent manager)', async () => {
    const created = await request(STAFF, MANAGER);
    const res = await call(decide, HR, { approve: false, comment: 'rejected by HR' }, { id: created.body.id! });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');
    expect(await balanceOf(STAFF)).toEqual({ used: 0, pending: 0 });
  });
});
