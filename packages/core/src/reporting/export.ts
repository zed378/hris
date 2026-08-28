import { writeAudit, type TenantClient } from '@hrms/db';
// Lewat pintu depan modul karyawan, bukan ke dalamnya — batas yang ditegakkan
// `eslint-plugin-boundaries`.
import { revealPii } from '../employee/index.ts';

/**
 * Ekspor lintas modul ke Excel (dokumen 02 §9).
 *
 * Modul karyawan sudah punya ekspornya sejak Fase 2; presensi, cuti, dan
 * payroll tidak. Ketiadaan itu bukan kekurangan kecil pada pasar yang dituju:
 * di Indonesia setiap laporan berakhir di Excel — rekap presensi untuk
 * disandingkan dengan mesin absensi lama, rekap cuti untuk rapat bulanan,
 * rekap gaji untuk bagian keuangan dan untuk unggahan transfer massal bank.
 * HR yang tidak dapat mengunduhnya akan menyalinnya dari layar dengan tangan,
 * dan salinan tangan adalah tempat angka berubah tanpa ada yang tahu.
 *
 * ## Tiga aturan yang berlaku untuk seluruh ekspor
 *
 * **Diaudit.** Ekspor adalah pemindahan data pribadi keluar dari sistem. Baris
 * auditnya mencatat siapa, kapan, penyaring apa, dan berapa baris — sehingga
 * "dari mana berkas ini berasal" punya jawaban ketika ia ditemukan di tempat
 * yang tidak seharusnya.
 *
 * **Tidak melewati masking.** Nilai tersamar tetap tersamar bagi yang tidak
 * berizin membukanya. Ekspor yang mengabaikannya membuat seluruh kerja enkripsi
 * PII runtuh menjadi hiasan layar: siapa pun yang dapat membuka daftar cukup
 * menekan "Ekspor".
 *
 * **Berbatas, dan mengaku terpotong.** Batasnya dinyatakan pada header respons,
 * bukan didiamkan. Berkas yang terpotong diam-diam terlihat persis seperti
 * berkas yang lengkap — dan yang membacanya menyimpulkan sisanya memang tidak
 * ada.
 */

/** Batas atas satu berkas ekspor, sama untuk seluruh modul. */
export const MAX_EXPORT_ROWS = 20_000;

export interface ExportResult {
  /** Baris siap tulis: baris pertama judul, sisanya data. */
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
// Presensi
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
      // Jam ditulis sebagai HH:MM, bukan ISO. Excel memperlakukan string ISO
      // sebagai teks dan menampilkannya sepanjang tiga puluh karakter, dan yang
      // membacanya adalah orang yang membandingkannya dengan mesin absensi.
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
 * Jam lokal dari sebuah instan.
 *
 * Sengaja memakai bagian UTC-nya: nilai `checkIn` sudah disimpan sebagai instan,
 * dan zona waktu tenant hanya dipakai saat menentukan tanggal kerja. Menuliskan
 * jam dalam zona server akan menghasilkan angka yang berbeda dari yang dilihat
 * karyawan di layar presensinya — dan berkas ini justru dipakai untuk
 * membandingkan keduanya.
 */
function clock(value: Date | null): string {
  if (!value) return '';
  return value.toISOString().slice(11, 16);
}

// ---------------------------------------------------------------------------
// Cuti
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
      // Pemutus dan catatannya ada di langkah persetujuan, bukan di pengajuan.
      // Bentuk itu disiapkan untuk alur berjenjang; yang berjalan sekarang satu
      // langkah, sehingga yang diambil adalah langkah terakhir yang diputuskan.
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
   * Membuka samaran nomor rekening.
   *
   * Rekap gaji adalah berkas yang paling ingin dibuka orang, dan nomor rekening
   * di dalamnya adalah alasan utamanya — unggahan transfer massal bank
   * membutuhkannya lengkap. Karena itu izinnya diperiksa persis seperti pada
   * ekspor karyawan: tanpa `employee.pii.unmask`, yang keluar adalah nilai
   * tersamar, dan berkas itu tetap berguna untuk segala hal kecuali transfer.
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
      // Tersamar atau terbuka, ditentukan izin — bukan ditentukan bahwa berkas
      // ini "untuk keuangan".
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
 * Nomor rekening, tersamar atau terbuka menurut izin.
 *
 * Kegagalan dekripsi satu baris tidak boleh menjatuhkan seluruh berkas: rekap
 * gaji seribu orang yang gagal karena satu nomor rekening rusak adalah rekap
 * yang tidak dapat dipakai membayar 999 orang lainnya.
 *
 * Yang gagal keluar sebagai **nilai tersamarnya**, bukan sebagai kolom kosong.
 * Kolom kosong pada berkas transfer terbaca seperti karyawan yang memang belum
 * mengisi rekeningnya; nilai tersamar tidak dapat disalahpahami begitu, dan
 * bank akan menolaknya — terlihat, dan dapat diperbaiki.
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
