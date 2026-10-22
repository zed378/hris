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
 * P2-08: an unmasked PII read must leave a trace.
 *
 * The abuse case (`docs/SECURITY/02` §8(e)): an HR insider with
 * `employee.pii.unmask` opens the employee list or detail and reads every
 * national ID. Before this fix only EXPORTS were audited — "no export" read
 * as "nothing happened" while every NIK was on screen.
 *
 * Against real PostgreSQL under real RLS, through the same domain functions
 * the route handlers call (`listEmployees`, `getEmployee`) — not a stub. The
 * audit row records the actor, tenant, employee ids, field names, IP, and
 * correlation id, and must never contain a PII value.
 *
 * The audit table is append-only (a trigger rejects UPDATE and DELETE even
 * for the table owner), so the rows cannot be cleared between tests. Each test
 * therefore measures the rows it caused rather than the rows in the table.
 */

const NIK = '3201123456789012';
const NPWP = '091234567890000';
const REK = '123456789012';

const TENANT = randomUUID();
const suffix = TENANT.slice(0, 8);

const ADMIN_USER = randomUUID();
const STAFF_USER = randomUUID();
const EMP_ID = randomUUID();

const ACTOR_CTX = {
    actorUserId: ADMIN_USER,
    ip: '10.0.0.1',
    userAgent: 'pii-audit-test',
    correlationId: 'corr-unmask',
} as const;

const STAFF_CTX = {
    actorUserId: STAFF_USER,
    ip: '10.0.0.2',
    userAgent: 'pii-audit-test',
    correlationId: 'corr-masked',
} as const;

const owner = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

beforeAll(async () => {
    await owner.tenant.create({
        data: {
            id: TENANT,
            code: `t-pii-${suffix}`,
            name: 'PII Audit Test',
            status: 'ACTIVE',
            planCode: 'basic',
        },
    });

    await owner.tenantModule.create({
        data: { tenantId: TENANT, moduleCode: 'employee', status: 'ENABLED' },
    });

    await owner.user.createMany({
        data: [
            {
                id: ADMIN_USER,
                tenantId: TENANT,
                email: `admin-${suffix}@pii-audit.test`,
                fullName: 'Admin PII',
                passwordHash: 'x',
                status: 'ACTIVE',
            },
            {
                id: STAFF_USER,
                tenantId: TENANT,
                email: `staff-${suffix}@pii-audit.test`,
                fullName: 'Staf PII',
                passwordHash: 'x',
                status: 'ACTIVE',
            },
        ],
    });

    await owner.employee.create({
        data: {
            id: EMP_ID,
            tenantId: TENANT,
            employeeNumber: `E1-${suffix}`,
            fullName: 'Budi Setiawan',
            email: `budi-${suffix}@pii-audit.test`,
            joinDate: new Date('2024-01-01'),
            nationalIdEncrypted: encryptPii(NIK),
            nationalIdMasked: '3201********9012',
            taxIdEncrypted: encryptPii(NPWP),
            taxIdMasked: '*************000',
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
    // Every query above ran outside a tenant context; a pooled connection that
    // kept one would make RLS hide rows from the next test.
    await disconnectAll();
});

/** The unmasked-read audit rows, read through the tenant context as a reader would. */
const unmaskRows = () =>
    withTenant(TENANT, (tx) =>
        tx.auditLog.findMany({
            where: { tenantId: TENANT, action: 'employee.pii.unmasked' },
            orderBy: { id: 'asc' },
        }),
    );

/** How many unmasked-read rows exist right now — the baseline for one test. */
const baseline = async (): Promise<number> => (await unmaskRows()).length;

describe('listEmployees — jejak audit saat membaca PII tanpa masking', () => {
    it('mencatat satu baris jejak ketika canUnmask true', async () => {
        const before = await baseline();

        await withTenant(TENANT, (tx) =>
            listEmployees(tx, TENANT, { canUnmask: true, ctx: ACTOR_CTX }),
        );

        const rows = await unmaskRows();
        expect(rows).toHaveLength(before + 1);

        const row = rows[before]!;
        expect(row.tenantId).toBe(TENANT);
        expect(row.actorUserId).toBe(ADMIN_USER);
        expect(row.entityType).toBe('employee');
        expect(row.after).toEqual(
            expect.objectContaining({
                employeeIds: [EMP_ID],
                fields: ['nationalId', 'taxId', 'bankAccount'],
            }),
        );
        expect(row.ip).toBe('10.0.0.1');
        expect(row.correlationId).toBe('corr-unmask');
    });

    it('TIDAK mencatat apa pun ketika data tersamar (canUnmask false)', async () => {
        const before = await baseline();

        await withTenant(TENANT, (tx) =>
            listEmployees(tx, TENANT, { canUnmask: false, ctx: STAFF_CTX }),
        );

        expect((await unmaskRows()).length).toBe(before);
    });
});

describe('getEmployee — jejak audit saat membaca PII tanpa masking', () => {
    it('mencatat satu baris jejak dengan id karyawan ketika canUnmask true', async () => {
        const before = await baseline();

        await withTenant(TENANT, (tx) =>
            getEmployee(tx, TENANT, EMP_ID, true, ACTOR_CTX),
        );

        const rows = await unmaskRows();
        expect(rows).toHaveLength(before + 1);

        const row = rows[before]!;
        expect(row.actorUserId).toBe(ADMIN_USER);
        expect(row.entityId).toBe(EMP_ID);
        expect(row.after).toEqual(
            expect.objectContaining({
                employeeIds: [EMP_ID],
                fields: ['nationalId', 'taxId', 'bankAccount'],
            }),
        );
        expect(row.ip).toBe('10.0.0.1');
        expect(row.correlationId).toBe('corr-unmask');
    });

    it('TIDAK mencatat apa pun ketika data tersamar (canUnmask false)', async () => {
        const before = await baseline();

        await withTenant(TENANT, (tx) =>
            getEmployee(tx, TENANT, EMP_ID, false, STAFF_CTX),
        );

        expect((await unmaskRows()).length).toBe(before);
    });
});

describe('isi baris jejak', () => {
    it('tidak memuat satu pun nilai PII', async () => {
        const before = await baseline();

        await withTenant(TENANT, (tx) =>
            listEmployees(tx, TENANT, { canUnmask: true, ctx: ACTOR_CTX }),
        );

        const rows = await unmaskRows();
        const json = JSON.stringify(rows.slice(before), (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
        );

        // The row must say THAT a read happened, WHICH fields, and BY WHOM —
        // never WHAT was read. A 16-digit NIK in the audit table would put the
        // value in the one place kept for seven years and read by the widest
        // set of roles.
        for (const value of [NIK, NPWP, REK]) {
            expect(json.includes(value), `${value} bocor ke jejak audit`).toBe(false);
        }
    });
});
