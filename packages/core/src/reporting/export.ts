import { writeAudit, type TenantClient } from '@hrms/db';
// Through the employee module's front door rather than into it — the boundary
// enforced by `eslint-plugin-boundaries`.
import { revealPii } from '../employee/index.ts';

/**
 * Cross-module Excel export (document 02 §9).
 *
 * The employee module has had its export since Phase 2; attendance, leave, and
 * payroll did not. That absence is not a small gap in the target market: in
 * Indonesia every report ends up in Excel — the attendance recap to reconcile
 * against the old attendance machine, the leave recap for the monthly meeting,
 * the payroll recap for finance and for the bank's bulk transfer upload. HR who
 * cannot download it will copy it off the screen by hand, and a hand copy is
 * where numbers change without anyone knowing.
 *
 * ## Three rules that apply to every export
 *
 * **Audited.** An export moves personal data out of the system. Its audit row
 * records who, when, which filters, and how many rows — so "where did this file
 * come from" has an answer when it turns up somewhere it should not be.
 *
 * **It does not bypass masking.** A masked value stays masked for anyone
 * without permission to unmask it. An export that ignored that would collapse
 * all of the PII encryption work into screen decoration: anyone who can open a
 * list would only have to press "Export".
 *
 * **Bounded, and it admits truncation.** The limit is stated in the response
 * headers rather than left unsaid. A silently truncated file looks exactly like
 * a complete one — and whoever reads it concludes the rest simply does not
 * exist.
 */

/** The upper bound of one export file, the same for every module. */
export const MAX_EXPORT_ROWS = 20_000;

export interface ExportResult {
  /** Rows ready to write: the first is the header, the rest are data. */
  rows: string[][];
  rowCount: number;
  truncated: boolean;
}

export interface ExportActor {
  actorUserId: string;
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
  correlationId?: string | null | undefined;
}

async function auditExport(
  tx: TenantClient,
  tenantId: string,
  kind: string,
  filters: Record<string, unknown>,
  result: ExportResult,
  actor: ExportActor,
): Promise<void> {
  await writeAudit(tx, tenantId, {
    action: `${kind}.exported`,
    entityType: kind,
    actorUserId: actor.actorUserId,
    ip: actor.ip ?? undefined,
    userAgent: actor.userAgent ?? undefined,
    correlationId: actor.correlationId ?? undefined,
    after: { ...filters, rowCount: result.rowCount, truncated: result.truncated },
  });
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export interface AttendanceExportOptions {
  from: Date;
  to: Date;
  employeeId?: string | undefined;
}

export const ATTENDANCE_HEADERS = [
  'Tanggal',
  'Nomor Karyawan',
  'Nama',
  'Status',
  'Jam Masuk',
  'Jam Pulang',
  'Terlambat (menit)',
  'Pulang Cepat (menit)',
  'Menit Kerja',
  'Lembur (menit)',
  'Terkunci',
] as const;

export async function buildAttendanceExport(
  tx: TenantClient,
  tenantId: string,
  options: AttendanceExportOptions,
  actor: ExportActor,
): Promise<ExportResult> {
  const days = await tx.attendanceDay.findMany({
    where: {
      tenantId,
      workDate: { gte: options.from, lte: options.to },
      ...(options.employeeId ? { employeeId: options.employeeId } : {}),
    },
    orderBy: [{ workDate: 'asc' }],
    take: MAX_EXPORT_ROWS,
    select: {
      employeeId: true,
      workDate: true,
      status: true,
      checkIn: true,
      checkOut: true,
      lateMinutes: true,
      earlyMinutes: true,
      workMinutes: true,
      overtimeMinutes: true,
      isLocked: true,
    },
  });

  const employees = await tx.employee.findMany({
    where: { tenantId, id: { in: [...new Set(days.map((d) => d.employeeId))] } },
    select: { id: true, employeeNumber: true, fullName: true },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  const rows: string[][] = [[...ATTENDANCE_HEADERS]];
  for (const day of days) {
    const employee = byId.get(day.employeeId);
    rows.push([
      day.workDate.toISOString().slice(0, 10),
      employee?.employeeNumber ?? '',
      employee?.fullName ?? '(karyawan terhapus)',
      day.status,
      // Times are written as HH:MM, not ISO. Excel treats an ISO string as text
      // and displays it thirty characters long, and whoever reads it is the
      // person comparing it against the attendance machine.
      clock(day.checkIn),
      clock(day.checkOut),
      String(day.lateMinutes),
      String(day.earlyMinutes),
      String(day.workMinutes),
      String(day.overtimeMinutes),
      day.isLocked ? 'ya' : '',
    ]);
  }

  const result: ExportResult = {
    rows,
    rowCount: days.length,
    truncated: days.length === MAX_EXPORT_ROWS,
  };

  await auditExport(
    tx,
    tenantId,
    'attendance.record',
    {
      from: options.from.toISOString().slice(0, 10),
      to: options.to.toISOString().slice(0, 10),
      employeeId: options.employeeId ?? null,
    },
    result,
    actor,
  );

  return result;
}

/**
 * The local time of an instant.
 *
 * Deliberately uses its UTC parts: a `checkIn` value is already stored as an
 * instant, and the tenant's timezone is only used when deciding the working
 * date. Writing the time in the server's zone would give a figure different
 * from the one the employee saw on their punch screen — and this file exists
 * precisely to compare the two.
 */
function clock(value: Date | null): string {
  if (!value) return '';
  return value.toISOString().slice(11, 16);
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export interface LeaveExportOptions {
  year: number;
  status?: string | undefined;
}

export const LEAVE_HEADERS = [
  'Nomor Pengajuan',
  'Nomor Karyawan',
  'Nama',
  'Jenis Cuti',
  'Mulai',
  'Selesai',
  'Jumlah Hari',
  'Status',
  'Alasan',
  'Diputuskan Oleh',
  'Tanggal Keputusan',
  'Catatan Keputusan',
] as const;

export async function buildLeaveExport(
  tx: TenantClient,
  tenantId: string,
  options: LeaveExportOptions,
  actor: ExportActor,
): Promise<ExportResult> {
  const requests = await tx.leaveRequest.findMany({
    where: {
      tenantId,
      startDate: {
        gte: new Date(Date.UTC(options.year, 0, 1)),
        lte: new Date(Date.UTC(options.year, 11, 31)),
      },
      ...(options.status ? { status: options.status as never } : {}),
    },
    orderBy: [{ startDate: 'asc' }],
    take: MAX_EXPORT_ROWS,
    select: {
      requestNumber: true,
      employeeId: true,
      leaveTypeId: true,
      startDate: true,
      endDate: true,
      totalDays: true,
      status: true,
      reason: true,
      decidedAt: true,
      // The decider and their note live on the approval step, not on the request.
      // That shape is prepared for a tiered flow; what runs today is a single
      // step, so what is taken is the last step decided.
      approvals: {
        where: { decision: { not: null } },
        orderBy: { stepOrder: 'desc' },
        take: 1,
        select: { approverId: true, decision: true, comment: true },
      },
    },
  });

  const leaveTypes = await tx.leaveType.findMany({
    where: { tenantId, id: { in: [...new Set(requests.map((r) => r.leaveTypeId))] } },
    select: { id: true, name: true },
  });
  const typeById = new Map(leaveTypes.map((t) => [t.id, t.name]));

  const employees = await tx.employee.findMany({
    where: { tenantId, id: { in: [...new Set(requests.map((r) => r.employeeId))] } },
    select: { id: true, employeeNumber: true, fullName: true },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  const deciders = await tx.user.findMany({
    where: {
      tenantId,
      id: {
        in: [
          ...new Set(
            requests
              .map((r) => r.approvals[0]?.approverId)
              .filter((v): v is string => !!v),
          ),
        ],
      },
    },
    select: { id: true, fullName: true },
  });
  const deciderById = new Map(deciders.map((u) => [u.id, u.fullName]));

  const rows: string[][] = [[...LEAVE_HEADERS]];
  for (const request of requests) {
    const employee = byId.get(request.employeeId);
    const decision = request.approvals[0];
    rows.push([
      request.requestNumber,
      employee?.employeeNumber ?? '',
      employee?.fullName ?? '(karyawan terhapus)',
      typeById.get(request.leaveTypeId) ?? '(jenis terhapus)',
      request.startDate.toISOString().slice(0, 10),
      request.endDate.toISOString().slice(0, 10),
      String(Number(request.totalDays)),
      request.status,
      request.reason,
      decision ? (deciderById.get(decision.approverId) ?? '(pengguna terhapus)') : '',
      request.decidedAt?.toISOString().slice(0, 10) ?? '',
      decision?.comment ?? '',
    ]);
  }

  const result: ExportResult = {
    rows,
    rowCount: requests.length,
    truncated: requests.length === MAX_EXPORT_ROWS,
  };

  await auditExport(
    tx,
    tenantId,
    'leave.request',
    { year: options.year, status: options.status ?? null },
    result,
    actor,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

export interface PayrollExportOptions {
  runId: string;
  /**
   * Unmasking the bank account number.
   *
   * The payroll recap is the file people most want to open, and the bank account
   * numbers in it are the main reason — a bank's bulk transfer upload needs them
   * in full. So its permission is checked exactly as in the employee export:
   * without `employee.pii.unmask` what comes out is the masked value, and that
   * file is still useful for everything except the transfer.
   */
  canUnmask: boolean;
}

export const PAYROLL_HEADERS = [
  'Nomor Karyawan',
  'Nama',
  'Bank',
  'Nomor Rekening',
  'Atas Nama',
  'Pendapatan Kotor',
  'Potongan',
  'Diterima',
] as const;

export async function buildPayrollExport(
  tx: TenantClient,
  tenantId: string,
  options: PayrollExportOptions,
  actor: ExportActor,
): Promise<ExportResult & { runNumber: string }> {
  const run = await tx.payrollRun.findFirst({
    where: { id: options.runId, tenantId },
    select: { id: true, runNumber: true, status: true },
  });
  if (!run) throw new Error('Run tidak ditemukan');

  const payslips = await tx.payslip.findMany({
    where: { tenantId, runId: run.id },
    orderBy: { createdAt: 'asc' },
    take: MAX_EXPORT_ROWS,
    select: { employeeId: true, gross: true, deduction: true, net: true },
  });

  const employees = await tx.employee.findMany({
    where: { tenantId, id: { in: [...new Set(payslips.map((p) => p.employeeId))] } },
    select: {
      id: true,
      employeeNumber: true,
      fullName: true,
      bankName: true,
      bankAccountHolder: true,
      bankAccountMasked: true,
      bankAccountEncrypted: true,
    },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  const rows: string[][] = [[...PAYROLL_HEADERS]];
  for (const slip of payslips) {
    const employee = byId.get(slip.employeeId);
    rows.push([
      employee?.employeeNumber ?? '',
      employee?.fullName ?? '(karyawan terhapus)',
      employee?.bankName ?? '',
      // Masked or unmasked, decided by permission — not decided by this file
      // being "for finance".
      bankAccountFor(employee, options.canUnmask),
      employee?.bankAccountHolder ?? '',
      String(Number(slip.gross)),
      String(Number(slip.deduction)),
      String(Number(slip.net)),
    ]);
  }

  const result: ExportResult = {
    rows,
    rowCount: payslips.length,
    truncated: payslips.length === MAX_EXPORT_ROWS,
  };

  await auditExport(
    tx,
    tenantId,
    'payroll.payslip',
    { runId: run.id, runNumber: run.runNumber, unmasked: options.canUnmask },
    result,
    actor,
  );

  return { ...result, runNumber: run.runNumber };
}

/**
 * A bank account number, masked or unmasked according to permission.
 *
 * A decryption failure on one row must not bring down the whole file: a
 * thousand-person payroll recap that fails because of one corrupt bank account
 * number is a recap that cannot be used to pay the other 999 people.
 *
 * A failure comes out as its **masked value**, not as an empty column. An empty
 * column in a transfer file reads like an employee who has not filled in their
 * account details; a masked value cannot be misread that way, and the bank will
 * refuse it — visible, and fixable.
 */
function bankAccountFor(
  employee:
    | {
        bankAccountMasked: string | null;
        bankAccountEncrypted: string | null;
      }
    | undefined,
  canUnmask: boolean,
): string {
  if (!employee) return '';

  try {
    return (
      revealPii(
        {
          nationalIdEncrypted: null,
          nationalIdMasked: null,
          taxIdEncrypted: null,
          taxIdMasked: null,
          bankAccountEncrypted: employee.bankAccountEncrypted,
          bankAccountMasked: employee.bankAccountMasked,
        },
        canUnmask,
      ).bankAccount ?? ''
    );
  } catch {
    return employee.bankAccountMasked ?? '';
  }
}
