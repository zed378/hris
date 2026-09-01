import { EventTopic } from '@hrms/contracts';
import { writeAudit, publishEvent, type TenantClient } from '@hrms/db';
import {
  blindIndexCandidates,
  maskBankAccount,
  maskNationalId,
  maskTaxId,
  preparePii,
  revealPii,
  type PiiFields,
} from './pii.ts';

/**
 * The employee module (PLAN/12 Phase 2).
 *
 * Two things shape this whole file:
 *
 * 1. **PII is never decrypted without a reason.** Every function takes
 *    `canUnmask` explicitly rather than reading it from a global context. A
 *    parameter that has to be filled in forces its caller to decide; a value
 *    from context would be silently right in one place and silently wrong in the
 *    next.
 *
 * 2. **Assignment history is never overwritten** (P13). A transfer closes the
 *    current period and opens a new row, so "who headed this department last
 *    March" is still answerable next year.
 */

export class EmployeeError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'conflict' | 'stale',
  ) {
    super(message);
    this.name = 'EmployeeError';
  }
}

export interface ActorContext {
  actorUserId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
  correlationId?: string | undefined;
}

/**
 * The employee data input.
 *
 * Every optional field includes `| undefined` explicitly because
 * `exactOptionalPropertyTypes` is on. That distinguishes "the field was not
 * sent" from "the field was deliberately cleared" — and on employee data the two
 * mean different things: the first changes nothing, the second deletes.
 */
export interface EmployeeInput {
  employeeNumber: string;
  fullName: string;
  nationalId?: string | null | undefined;
  taxId?: string | null | undefined;
  bankAccount?: string | null | undefined;
  bankName?: string | null | undefined;
  bankAccountHolder?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  birthDate?: Date | null | undefined;
  birthPlace?: string | null | undefined;
  gender?: 'MALE' | 'FEMALE' | null | undefined;
  address?: string | null | undefined;
  joinDate: Date;
  status?: 'PROBATION' | 'ACTIVE' | 'RESIGNED' | 'TERMINATED' | undefined;
}

/**
 * A partial change to employee data.
 *
 * Not `Partial<EmployeeInput>`: with `exactOptionalPropertyTypes`, `Partial`
 * only marks a property as possibly absent, while an object parsed by Zod
 * carries properties that are present but `undefined`. This type accepts both.
 */
export type EmployeeUpdate = {
  [K in keyof EmployeeInput]?: EmployeeInput[K] | undefined;
};

export interface EmployeeSummary {
  id: string;
  employeeNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  joinDate: string;
  department: string | null;
  position: string | null;
  version: number;
  pii: PiiFields;
}

const PII_SELECT = {
  nationalIdEncrypted: true,
  nationalIdMasked: true,
  taxIdEncrypted: true,
  taxIdMasked: true,
  bankAccountEncrypted: true,
  bankAccountMasked: true,
} as const;

/**
 * The employee list.
 *
 * `canUnmask` is almost always `false` here, and that is the right path: the
 * list is the screen opened most often and the one least often needing a full
 * identity number. With the masked columns stored, this path does not touch the
 * encryption key at all.
 */
export async function listEmployees(
  tx: TenantClient,
  tenantId: string,
  options: {
    limit?: number;
    offset?: number;
    search?: string | undefined;
    status?: string | undefined;
    departmentId?: string | undefined;
    canUnmask?: boolean;
  } = {},
): Promise<{ employees: EmployeeSummary[]; total: number }> {
  const where = {
    tenantId,
    ...(options.status ? { status: options.status as never } : {}),
    ...(options.search
      ? {
          OR: [
            { fullName: { contains: options.search, mode: 'insensitive' as const } },
            { employeeNumber: { contains: options.search, mode: 'insensitive' as const } },
            { email: { contains: options.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(options.departmentId
      ? { employments: { some: { departmentId: options.departmentId, effectiveTo: null } } }
      : {}),
  };

  const [rows, total] = await Promise.all([
    tx.employee.findMany({
      where,
      take: Math.min(options.limit ?? 50, 500),
      skip: options.offset ?? 0,
      orderBy: [{ fullName: 'asc' }],
      select: {
        id: true,
        employeeNumber: true,
        fullName: true,
        email: true,
        phone: true,
        status: true,
        joinDate: true,
        version: true,
        ...PII_SELECT,
        // Only the currently running assignment. A partial unique index guarantees
        // there is at most one, so the `[0]` below is safe.
        employments: {
          where: { effectiveTo: null },
          select: {
            department: { select: { name: true } },
            position: { select: { name: true } },
          },
          take: 1,
        },
      },
    }),
    tx.employee.count({ where }),
  ]);

  return {
    total,
    employees: rows.map((row) => ({
      id: row.id,
      employeeNumber: row.employeeNumber,
      fullName: row.fullName,
      email: row.email,
      phone: row.phone,
      status: row.status,
      joinDate: row.joinDate.toISOString().slice(0, 10),
      department: row.employments[0]?.department.name ?? null,
      position: row.employments[0]?.position.name ?? null,
      version: row.version,
      pii: revealPii(row, options.canUnmask ?? false),
    })),
  };
}

export async function getEmployee(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  canUnmask: boolean,
): Promise<EmployeeSummary & { bankName: string | null; address: string | null }> {
  const row = await tx.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: {
      id: true,
      employeeNumber: true,
      fullName: true,
      email: true,
      phone: true,
      status: true,
      joinDate: true,
      version: true,
      bankName: true,
      address: true,
      ...PII_SELECT,
      employments: {
        where: { effectiveTo: null },
        select: {
          department: { select: { name: true } },
          position: { select: { name: true } },
        },
        take: 1,
      },
    },
  });

  if (!row) throw new EmployeeError('Employee not found', 'not_found');

  return {
    id: row.id,
    employeeNumber: row.employeeNumber,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    status: row.status,
    joinDate: row.joinDate.toISOString().slice(0, 10),
    department: row.employments[0]?.department.name ?? null,
    position: row.employments[0]?.position.name ?? null,
    version: row.version,
    bankName: row.bankName,
    address: row.address,
    pii: revealPii(row, canUnmask),
  };
}

/** Builds the stored columns from the raw input. */
function piiColumns(input: EmployeeInput) {
  const nationalId = preparePii(input.nationalId, maskNationalId, 'NIK');
  const taxId = preparePii(input.taxId, maskTaxId, 'NPWP');
  const bankAccount = preparePii(input.bankAccount, maskBankAccount, 'bank account number');

  return {
    nationalIdEncrypted: nationalId.encrypted,
    nationalIdIndex: nationalId.index,
    nationalIdMasked: nationalId.masked,
    taxIdEncrypted: taxId.encrypted,
    taxIdIndex: taxId.index,
    taxIdMasked: taxId.masked,
    bankAccountEncrypted: bankAccount.encrypted,
    bankAccountMasked: bankAccount.masked,
  };
}

export async function createEmployee(
  tx: TenantClient,
  tenantId: string,
  input: EmployeeInput,
  ctx: ActorContext,
): Promise<{ id: string }> {
  const employee = await tx.employee.create({
    data: {
      tenantId,
      employeeNumber: input.employeeNumber.trim(),
      fullName: input.fullName.trim(),
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      birthDate: input.birthDate ?? null,
      birthPlace: input.birthPlace?.trim() || null,
      gender: input.gender ?? null,
      address: input.address?.trim() || null,
      bankName: input.bankName?.trim() || null,
      bankAccountHolder: input.bankAccountHolder?.trim() || null,
      joinDate: input.joinDate,
      status: input.status ?? 'ACTIVE',
      ...piiColumns(input),
    },
    select: { id: true },
  });

  // The audit trail deliberately holds NO PII value, not even a masked one. The
  // audit table is kept for seven years and read by a broader set of roles than
  // may see employee data; copying PII there voids all of the work in pii.ts.
  await writeAudit(tx, tenantId, {
    action: 'employee.created',
    entityType: 'employee',
    entityId: employee.id,
    actorUserId: ctx.actorUserId,
    after: { employeeNumber: input.employeeNumber, fullName: input.fullName },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });

  await publishEvent(tx, tenantId, {
    topic: EventTopic.EMPLOYEE_CREATED,
    payload: { tenantId, employeeId: employee.id, employeeNumber: input.employeeNumber },
    correlationId: ctx.correlationId,
  });

  return employee;
}

/**
 * Updates an employee with optimistic locking.
 *
 * `expectedVersion` comes from the data the client read. A mismatch means
 * somebody saved first — and overwriting them means their change disappears
 * without anyone knowing (doc. 03 §4.6). The Excel-like grid makes this no rare
 * case: two HR staff editing the same list is an ordinary working day.
 */
export async function updateEmployee(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  expectedVersion: number,
  input: EmployeeUpdate,
  ctx: ActorContext,
): Promise<{ version: number }> {
  const before = await tx.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { version: true, employeeNumber: true, fullName: true, status: true },
  });
  if (!before) throw new EmployeeError('Employee not found', 'not_found');

  const piiTouched =
    input.nationalId !== undefined ||
    input.taxId !== undefined ||
    input.bankAccount !== undefined;

  const updated = await tx.employee.updateMany({
    where: { id: employeeId, tenantId, version: expectedVersion },
    data: {
      ...(input.employeeNumber !== undefined ? { employeeNumber: input.employeeNumber.trim() } : {}),
      ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
      ...(input.email !== undefined ? { email: input.email?.trim() || null } : {}),
      ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
      ...(input.address !== undefined ? { address: input.address?.trim() || null } : {}),
      ...(input.bankName !== undefined ? { bankName: input.bankName?.trim() || null } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(piiTouched ? piiColumns(input as EmployeeInput) : {}),
      version: { increment: 1 },
    },
  });

  if (updated.count === 0) {
    throw new EmployeeError(
      'This data has been modified by someone else. Reload before saving.',
      'stale',
    );
  }

  await writeAudit(tx, tenantId, {
    action: 'employee.updated',
    entityType: 'employee',
    entityId: employeeId,
    actorUserId: ctx.actorUserId,
    before: { fullName: before.fullName, status: before.status },
    // Only the PII column names are recorded, not their values — enough to answer
    // "who changed whose account and when" without storing the number.
    after: {
      fullName: input.fullName ?? before.fullName,
      status: input.status ?? before.status,
      ...(piiTouched ? { piiChanged: true } : {}),
    },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
  });

  return { version: expectedVersion + 1 };
}

/**
 * Finds an employee by national ID without decrypting anything.
 *
 * This is what the blind index is for: the search runs over an HMAC, and the
 * database never sees the national ID in a readable form.
 */
export async function findByNationalId(
  tx: TenantClient,
  tenantId: string,
  nationalId: string,
): Promise<{ id: string; employeeNumber: string; fullName: string } | null> {
  // Every candidate index, not just the current one. During a `PII_INDEX_KEY`
  // rotation an existing employee's stored index was computed with the previous
  // key, and matching only the new one would answer "not registered" for someone
  // who is — which the importer reads as permission to create them again.
  return tx.employee.findFirst({
    where: { tenantId, nationalIdIndex: { in: blindIndexCandidates(nationalId) } },
    select: { id: true, employeeNumber: true, fullName: true },
  });
}
