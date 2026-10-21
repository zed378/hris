import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true });

import { withTenant, disconnectAll } from '@hrms/db';
import { listEmployees, getEmployee } from '../src/employee/employees.ts';
import { encryptPii } from '../src/employee/pii.ts';

/**
 * Regression test for P2-08: unmasked PII reads must be audited.
 *
 * The abuse case (SECURITY/02 §8(e)): an HR insider opens the employee list
 * or detail with `employee.pii.unmask` and reads every national ID. Before
 * this fix, only exports were audited; screen reads left no trace.
 *
 * These tests run against real PostgreSQL under real RLS. The audit row must
 * contain the actor, tenant, employee ids, field names, IP, and correlation
 * id — never a PII value.
 */

const NIK = '3201123456789012';
const NPWP = '091234567890000';
const REK = '123456789012';

const TENANT = randomUUID();
const suffix = TENANT.slice(0, 8);

const ADMIN_USER = `user-admin-${suffix}`;
const STAFF_USER = `user-staff-${suffix}`;
const EMP_ID = `emp-${suffix}`;

const owner = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

beforeAll(async () => {
    await owner.plan.upsert({
        where: { code: 'core' },
        create: { code: 'core', name: 'Core', sortOrder: 0 },
        update: {},
    });

    await owner.tenant.create({
        data: {
            id: TENANT,
            code: `t-pii-${suffix}`,
            name: 'PII Audit Test',
            status: 'ACTIVE',
            planCode: 'core',
        },
    });

    await owner.tenantModule.create({
        data: { tenantId: TENANT, moduleCode: 'employee', status: 'ENABLED' },
    });

    const adminRole = await owner.role.create({
        data: {
            tenantId: TENANT,
            code: `role-admin-${suffix}`,
            name: 'Admin',
            permissions: {
                create: [{ tenantId: TENANT, permissionCode: 'employee.pii.unmask' }],
            },
        },
    });

    await owner.user.createMany({
        data: [
            {
                id: ADMIN_USER,
                tenantId: TENANT,
                email: `admin-${suffix}@test.local`,
                fullName: 'Admin User',
                passwordHash: 'x',
                status: 'ACTIVE',
            },
            {
                id: STAFF_USER,
                tenantId: TENANT,
                email: `staff-${suffix}@test.local`,
                fullName: 'Staff User',
                passwordHash: 'x',
                status: 'ACTIVE',
            },
        ],
    });

    await owner.userRole.createMany({
        data: [
            { tenantId: TENANT, userId: ADMIN_USER, roleId: adminRole.id },
            { tenantId: TENANT, userId: STAFF_USER, roleId: adminRole.id },
        ],
    });

    await owner.employee.create({
        data: {
            id: EMP_ID,
            tenantId: TENANT,
            employeeNumber: `E1-${suffix}`,
            fullName: 'Budi Setiawan',
            email: `budi-${suffix}@test.local`,
            joinDate: new Date('2024-01-01'),
            nationalIdEncrypted: encryptPii(NIK),
            nationalIdMasked: '3201********9012',
            nationalIdIndex: 'x',
            taxIdEncrypted: encryptPii(NPWP),
            taxIdMasked: '***********000',
            taxIdIndex: 'x',
            bankAccountEncrypted: encryptPii(REK),
            bankAccountMasked: '******9012',
        },
    });
});

afterAll(async () => {
    await owner.tenant.deleteMany({ where: { id: TENANT } });
    await owner.$disconnect();
    await disconnectAll();
});

beforeEach(async () => {
    await disconnectAll();
});

describe('listEmployees', () => {
    it('records an audit row when canUnmask is true', async () => {
        await withTenant(TENANT, (tx) =>
            listEmployees(tx, TENANT, {
                canUnmask: true,
                ctx: {
                    actorUserId: ADMIN_USER,
                    ip: '10.0.0.1',
                    userAgent: 'test-agent',
                    correlationId: 'corr-list-unmask',
                },
            }),
        );

        const audit = await owner.auditLog.findFirst({
            where: { tenantId: TENANT, action: 'employee.pii.unmasked' },
            orderBy: { createdAt: 'desc' },
        });

        expect(audit).toBeDefined();
        expect(audit!.actorUserId).toBe(ADMIN_USER);
        expect(audit!.entityType).toBe('employee');
        expect(audit!.after).toEqual(
            expect.objectContaining({
                employeeIds: [EMP_ID],
                fields: expect.arrayContaining(['nationalId', 'taxId', 'bankAccount']),
            }),
        );
        expect(audit!.ip).toBe('10.0.0.1');
        expect(audit!.correlationId).toBe('corr-list-unmask');
    });

    it('does NOT record an audit row when canUnmask is false', async () => {
        await withTenant(TENANT, (tx) =>
            listEmployees(tx, TENANT, {
                canUnmask: false,
                ctx: {
                    actorUserId: STAFF_USER,
                    ip: '10.0.0.2',
                    userAgent: 'test-agent',
                    correlationId: 'corr-list-masked',
                },
            }),
        );

        const count = await owner.auditLog.count({
            where: { tenantId: TENANT, action: 'employee.pii.unmasked' },
        });

        expect(count).toBe(0);
    });
});

describe('getEmployee', () => {
    it('records an audit row when canUnmask is true', async () => {
        await withTenant(TENANT, (tx) =>
            getEmployee(tx, TENANT, EMP_ID, true, {
                actorUserId: ADMIN_USER,
                ip: '10.0.0.1',
                userAgent: 'test-agent',
                correlationId: 'corr-detail-unmask',
            }),
        );

        const audit = await owner.auditLog.findFirst({
            where: { tenantId: TENANT, action: 'employee.pii.unmasked', entityId: EMP_ID },
            orderBy: { createdAt: 'desc' },
        });

        expect(audit).toBeDefined();
        expect(audit!.actorUserId).toBe(ADMIN_USER);
        expect(audit!.entityId).toBe(EMP_ID);
        expect(audit!.after).toEqual(
            expect.objectContaining({
                employeeIds: [EMP_ID],
                fields: expect.arrayContaining(['nationalId', 'taxId', 'bankAccount']),
            }),
        );
        expect(audit!.ip).toBe('10.0.0.1');
        expect(audit!.correlationId).toBe('corr-detail-unmask');
    });

    it('does NOT record an audit row when canUnmask is false', async () => {
        await withTenant(TENANT, (tx) =>
            getEmployee(tx, TENANT, EMP_ID, false, {
                actorUserId: STAFF_USER,
                ip: '10.0.0.2',
                userAgent: 'test-agent',
                correlationId: 'corr-detail-masked',
            }),
        );

        const count = await owner.auditLog.count({
            where: { tenantId: TENANT, action: 'employee.pii.unmasked' },
        });

        expect(count).toBe(0);
    });
});

describe('audit row content', () => {
    it('contains no PII values', async () => {
        await withTenant(TENANT, (tx) =>
            listEmployees(tx, TENANT, {
                canUnmask: true,
                ctx: {
                    actorUserId: ADMIN_USER,
                    ip: '10.0.0.1',
                    userAgent: 'test-agent',
                    correlationId: 'corr-no-pii',
                },
            }),
        );

        const audit = await owner.auditLog.findFirst({
            where: { tenantId: TENANT, action: 'employee.pii.unmasked' },
            orderBy: { createdAt: 'desc' },
        });

        expect(audit).toBeDefined();
        const json = JSON.stringify(audit);
        expect(json).not.toContain(NIK);
        expect(json).not.toContain(NPWP);
        expect(json).not.toContain(REK);
    });
});
