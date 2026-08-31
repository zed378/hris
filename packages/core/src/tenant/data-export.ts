import { writeAudit, type TenantClient } from '@hrms/db';
import { revealPii } from '../employee/index.ts';

/**
 * Exporting all of a tenant's data (PLAN/12 P6 DoD, Personal Data Protection Act No. 27/2022).
 *
 * Not a convenience feature. The Act guarantees a right to data portability: the
 * data subject — and in this context the company representing its employees — is
 * entitled to receive its data in a machine-readable format that can be moved to
 * another system.
 *
 * What decides whether this export fulfils that right or merely appears to:
 *
 * **Complete, not partial — including modules NOT currently subscribed.**
 *
 * The first version exported only enabled modules, and that is wrong in
 * precisely the case that matters most: a customer who downgrades and then wants
 * to move systems would not receive their payroll data. The data is still there
 * — a disabled module deletes nothing — but they cannot retrieve it.
 *
 * That is lock-in dressed as compliance, and it contradicts the very right this
 * export exists to fulfil. Data portability is a statutory right; it does not
 * depend on what someone is paying for this month.
 *
 * The table list is written out explicitly so a new module that is forgotten
 * shows up as a missing key in the file rather than quietly not being included.
 *
 * **PII in its original form, and that is a conscious decision.** A masked export
 * cannot be used to move data — a national ID of "3201********9012" is useless to
 * any system. So the endpoint calling it demands the `employee.pii.unmask`
 * permission, and every call is audited.
 *
 * **JSON, not Excel.** Portability demands a format another machine can read;
 * Excel with merged cells and locale date formats is not that. The per-module
 * Excel export stays for everyday use.
 */

export interface TenantExport {
  meta: {
    tenantCode: string;
    tenantName: string;
    exportedAt: string;
    /** The file shape version. Raised when the structure changes incompatibly. */
    formatVersion: 1;
    /** The modules whose data is included. */
    modules: string[];
  };
  employees: unknown[];
  departments: unknown[];
  positions: unknown[];
  employments: unknown[];
  contracts: unknown[];
  documents: unknown[];
  workSites: unknown[];
  shifts: unknown[];
  schedules: unknown[];
  holidays: unknown[];
  punchLogs: unknown[];
  attendanceDays: unknown[];
  attendancePeriods: unknown[];
  attendanceConsents: unknown[];
  leaveTypes: unknown[];
  leaveBalances: unknown[];
  leaveRequests: unknown[];
  balanceLedger: unknown[];
  payrollComponents: unknown[];
  salaryStructures: unknown[];
  payrollRuns: unknown[];
  payslips: unknown[];
  payslipLines: unknown[];
  users: unknown[];
  roles: unknown[];
}

/**
 * The row limit per table.
 *
 * An export that exhausts process memory would bring the application down for
 * every tenant, and that is too high a price for one portability request. If a
 * tenant crosses this limit, a per-date-range export is the answer — and the
 * truncation is STATED in the file rather than done silently.
 * dilakukan diam-diam.
 */
const MAX_ROWS_PER_TABLE = 100_000;

export interface ExportOptions {
  /** Include PII in its original form. Demands the unmask permission in the caller. */
  includePii: boolean;
  /**
   * The modules currently enabled. Recorded in `meta`, NOT used to filter contents.
   *
   * See the explanation at the head of this file: a disabled module's data is
   * still included, because portability does not depend on a running subscription.
   */
  modules: ReadonlySet<string>;
}

/**
 * Makes every value JSON-serialisable.
 *
 * `BigInt` has no JSON representation — `JSON.stringify` throws "Do not know how
 * to serialize a BigInt", and that error brings down the WHOLE export, not one
 * column of it.
 *
 * What uses it are the keys on the high-volume tables: the leave balance ledger
 * and the access trail. Both are exactly what most needs carrying along when a
 * customer moves systems — the ledger is the only explanation of why someone's
 * leave balance is what it is.
 *
 * Converted to a string, not a number: a `BIGSERIAL` id can exceed
 * `Number.MAX_SAFE_INTEGER`, and a number silently rounded in a portability
 * export would produce two different rows with the same id in the destination
 * system.
 */
function serializable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializable);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    // Prisma.Decimal has a `toJSON` of its own and must not be unpacked into its
    // internal properties.
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        serializable(item),
      ]),
    );
  }
  return value;
}

export async function exportTenantData(
  tx: TenantClient,
  tenantId: string,
  options: ExportOptions,
  actorUserId: string,
): Promise<TenantExport & { truncated: string[] }> {
  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: { code: true, name: true },
  });

  const take = MAX_ROWS_PER_TABLE;
  const truncated: string[] = [];

  /** Runs the query and records when its result was truncated by the limit. */
  const collect = async <T>(name: string, run: () => Promise<T[]>): Promise<T[]> => {
    const rows = await run();
    if (rows.length >= take) truncated.push(name);
    return rows;
  };

  const [
    employees,
    departments,
    positions,
    employments,
    contracts,
    documents,
    workSites,
    shifts,
    schedules,
    holidays,
    punchLogs,
    attendanceDays,
    attendancePeriods,
    attendanceConsents,
    leaveTypes,
    leaveBalances,
    leaveRequests,
    balanceLedger,
    payrollComponents,
    salaryStructures,
    payrollRuns,
    payslips,
    payslipLines,
    users,
    roles,
  ] = await Promise.all([
    collect('employees', () => tx.employee.findMany({ where: { tenantId }, take })),
    collect('departments', () => tx.department.findMany({ where: { tenantId }, take })),
    collect('positions', () => tx.position.findMany({ where: { tenantId }, take })),
    collect('employments', () => tx.employment.findMany({ where: { tenantId }, take })),
    collect('contracts', () => tx.employeeContract.findMany({ where: { tenantId }, take })),
    collect('documents', () =>
          tx.employeeDocument.findMany({
            where: { tenantId },
            take,
            // `storageKey` is DROPPED. The physical file is not part of the JSON,
            // and a storage key with no file only leaks the object naming pattern
            // while giving its recipient nothing.
            select: {
              id: true,
              employeeId: true,
              kind: true,
              title: true,
              fileName: true,
              mimeType: true,
              sizeBytes: true,
              expiresAt: true,
              createdAt: true,
              archivedAt: true,
            },
          }),
        ),

    collect('workSites', () => tx.workSite.findMany({ where: { tenantId }, take })),
    collect('shifts', () => tx.shift.findMany({ where: { tenantId }, take })),
    collect('schedules', () => tx.schedule.findMany({ where: { tenantId }, take })),
    collect('holidays', () => tx.holiday.findMany({ where: { tenantId }, take })),
    collect('punchLogs', () =>
          tx.punchLog.findMany({
            where: { tenantId },
            take,
            orderBy: { punchedAt: 'desc' },
          }),
        ),
    collect('attendanceDays', () => tx.attendanceDay.findMany({ where: { tenantId }, take })),
    collect('attendancePeriods', () =>
          tx.attendancePeriod.findMany({ where: { tenantId }, take }),
        ),
    collect('attendanceConsents', () =>
          tx.attendanceConsent.findMany({ where: { tenantId }, take }),
        ),

    collect('leaveTypes', () => tx.leaveType.findMany({ where: { tenantId }, take })),
    collect('leaveBalances', () => tx.leaveBalance.findMany({ where: { tenantId }, take })),
    collect('leaveRequests', () => tx.leaveRequest.findMany({ where: { tenantId }, take })),
    collect('balanceLedger', () => tx.balanceLedger.findMany({ where: { tenantId }, take })),

    collect('payrollComponents', () =>
          tx.payrollComponent.findMany({ where: { tenantId }, take }),
        ),
    collect('salaryStructures', () =>
          tx.salaryStructure.findMany({ where: { tenantId }, take }),
        ),
    collect('payrollRuns', () => tx.payrollRun.findMany({ where: { tenantId }, take })),
    collect('payslips', () => tx.payslip.findMany({ where: { tenantId }, take })),
    collect('payslipLines', () => tx.payslipLine.findMany({ where: { tenantId }, take })),

    // Users and roles are always included: without both, employee data cannot be
    // connected back to who may see it in the destination system.
    collect('users', () =>
      tx.user.findMany({
        where: { tenantId },
        take,
        // Password hashes are NOT exported. They are useless in another system, and
        // an export file containing them becomes a far more valuable target.
        select: {
          id: true,
          email: true,
          fullName: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
        },
      }),
    ),
    collect('roles', () => tx.role.findMany({ where: { tenantId }, take })),
  ]);

  /**
   * PII is unmasked or left masked according to the caller's permission.
   *
   * `revealPii` reads the stored masked column when there is no permission — on
   * that path it never touches the encryption key.
   */
  const employeesOut = (employees as Array<Record<string, unknown>>).map((row) => {
    const rest: Record<string, unknown> = { ...row };
    // The ciphertext is dropped from the output. Another system cannot read it,
    // and an export file containing it becomes a far more valuable target while
    // giving its recipient nothing.
    for (const column of [
      'nationalIdEncrypted',
      'nationalIdIndex',
      'taxIdEncrypted',
      'taxIdIndex',
      'bankAccountEncrypted',
    ]) {
      delete rest[column];
    }
    return { ...rest, pii: revealPii(row as never, options.includePii) };
  });

  await writeAudit(tx, tenantId, {
    action: 'tenant.data.exported',
    entityType: 'tenant',
    entityId: tenantId,
    actorUserId,
    after: {
      includePii: options.includePii,
      employeeCount: employees.length,
      punchCount: punchLogs.length,
      truncated,
    },
  });

  const payload = {
    meta: {
      tenantCode: tenant?.code ?? '',
      tenantName: tenant?.name ?? '',
      exportedAt: new Date().toISOString(),
      formatVersion: 1,
      modules: [...options.modules].sort(),
    },
    employees: employeesOut,
    departments,
    positions,
    employments,
    contracts,
    documents,
    workSites,
    shifts,
    schedules,
    holidays,
    punchLogs,
    attendanceDays,
    attendancePeriods,
    attendanceConsents,
    leaveTypes,
    leaveBalances,
    leaveRequests,
    balanceLedger,
    payrollComponents,
    salaryStructures,
    payrollRuns,
    payslips,
    payslipLines,
    users,
    roles,
    truncated,
  };

  return serializable(payload) as TenantExport & { truncated: string[] };
}
