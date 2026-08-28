import type { TenantClient } from '@hrms/db';
import { resolveWorkDate, tenantTimeZone } from '../attendance/index.ts';

/**
 * Ringkasan dasbor (dokumen 07 §5, PLAN/12 F6).
 *
 * Tiga cakupan, ditentukan izin — bukan parameter:
 *
 *   `own`    beranda karyawan: presensi hari ini, saldo cuti, slip terakhir
 *   `team`   atasan: siapa hadir hari ini, apa yang menunggu keputusannya
 *   `tenant` HR: seluruh perusahaan
 *
 * Dua sifat yang menentukan apakah dasbor ini berguna atau justru merugikan:
 *
 * **Modul yang mati tidak menghasilkan widget kosong.** Tenant yang belum
 * berlangganan presensi tidak boleh melihat kartu "Hadir hari ini: 0" — angka
 * itu bukan informasi, ia salah paham yang menunggu terjadi.
 *
 * **Angka yang ditampilkan harus dapat ditindaklanjuti.** "Presensi ditandai:
 * 7" berguna karena ada halaman untuk menanganinya. "Total karyawan: 143" hanya
 * berguna sekali, saat pertama dilihat.
 */

export interface OwnSummary {
  /** Ketukan presensi hari ini, bila modulnya aktif. */
  todayPunches: Array<{ type: string; punchedAt: string }> | null;
  leaveBalances: Array<{ code: string; name: string; available: number }> | null;
  pendingLeaveRequests: number | null;
  latestPayslip: { periodYear: number; periodMonth: number; net: number } | null;
}

export interface TeamSummary {
  pendingLeaveApprovals: number | null;
}

export interface TenantSummary {
  activeEmployees: number;
  /** Hadir hari ini menurut ketukan, bukan menurut rekap yang mungkin belum dihitung. */
  presentToday: number | null;
  flaggedPunches: number | null;
  /** Rasio bertanda. Di atas 12% berarti ambang kepercayaan salah setel. */
  flaggedRatio: number | null;
  pendingLeaveRequests: number | null;
  employeesOnLeaveToday: number | null;
  expiringContracts: number | null;
  /** Run penggajian yang menunggu persetujuan. */
  payrollRunsPendingApproval: number | null;
}

export interface DashboardSummary {
  workDate: string;
  own: OwnSummary | null;
  team: TeamSummary | null;
  tenant: TenantSummary | null;
}

export interface SummaryScope {
  /** Karyawan yang terhubung ke akun ini. Null bila belum terhubung. */
  employeeId: string | null;
  userId: string;
  modules: ReadonlySet<string>;
  canViewOwn: boolean;
  canViewTeam: boolean;
  canViewTenant: boolean;
}

export async function buildDashboard(
  tx: TenantClient,
  tenantId: string,
  scope: SummaryScope,
): Promise<DashboardSummary> {
  const timeZone = await tenantTimeZone(tx, tenantId);
  const workDate = resolveWorkDate(new Date(), timeZone);
  const workDateIso = workDate.toISOString().slice(0, 10);

  const hasAttendance = scope.modules.has('attendance');
  const hasLeave = scope.modules.has('leave');
  const hasPayroll = scope.modules.has('payroll');
  const hasEmployee = scope.modules.has('employee');

  const own = scope.canViewOwn ? await buildOwn(tx, tenantId, scope, workDate) : null;
  const team = scope.canViewTeam ? await buildTeam(tx, tenantId, scope) : null;
  const tenant = scope.canViewTenant
    ? await buildTenant(tx, tenantId, workDate, {
        hasAttendance,
        hasLeave,
        hasPayroll,
        hasEmployee,
      })
    : null;

  return { workDate: workDateIso, own, team, tenant };
}

async function buildOwn(
  tx: TenantClient,
  tenantId: string,
  scope: SummaryScope,
  workDate: Date,
): Promise<OwnSummary> {
  // Akun yang belum terhubung ke data karyawan tidak punya presensi maupun
  // cuti. Mengembalikan nol akan terbaca sebagai "Anda belum absen hari ini",
  // yang menyesatkan orang yang memang bukan karyawan — misalnya konsultan IT
  // yang diberi akun admin.
  if (!scope.employeeId) {
    return {
      todayPunches: null,
      leaveBalances: null,
      pendingLeaveRequests: null,
      latestPayslip: null,
    };
  }

  const employeeId = scope.employeeId;
  const year = workDate.getUTCFullYear();

  const [punches, balances, pendingLeave, payslip] = await Promise.all([
    scope.modules.has('attendance')
      ? tx.punchLog.findMany({
          where: { tenantId, employeeId, workDate },
          orderBy: { punchedAt: 'asc' },
          select: { type: true, punchedAt: true },
        })
      : null,

    scope.modules.has('leave')
      ? tx.$queryRaw<Array<{ code: string; name: string; available: unknown }>>`
          SELECT t.code, t.name, b.available_days AS available
          FROM "leave".leave_balances b
          JOIN "leave".leave_types t ON t.id = b.leave_type_id
          WHERE b.tenant_id = ${tenantId}::uuid
            AND b.employee_id = ${employeeId}::uuid
            AND b.period_year = ${year}
            AND t.deduct_from_balance = true
          ORDER BY t.code
        `
      : null,

    scope.modules.has('leave')
      ? tx.leaveRequest.count({ where: { tenantId, employeeId, status: 'PENDING' } })
      : null,

    scope.modules.has('payroll')
      ? tx.payslip.findFirst({
          where: {
            tenantId,
            employeeId,
            // Hanya run yang sudah disetujui. Slip yang angkanya masih dapat
            // berubah tidak boleh muncul di beranda seseorang.
            run: { status: { in: ['APPROVED', 'PAID'] } },
          },
          orderBy: { createdAt: 'desc' },
          select: { net: true, run: { select: { periodYear: true, periodMonth: true } } },
        })
      : null,
  ]);

  return {
    todayPunches:
      punches?.map((punch) => ({
        type: punch.type,
        punchedAt: punch.punchedAt.toISOString(),
      })) ?? null,
    leaveBalances:
      balances?.map((row) => ({
        code: row.code,
        name: row.name,
        available: Number(row.available),
      })) ?? null,
    pendingLeaveRequests: pendingLeave,
    latestPayslip: payslip
      ? {
          periodYear: payslip.run.periodYear,
          periodMonth: payslip.run.periodMonth,
          net: Number(payslip.net),
        }
      : null,
  };
}

async function buildTeam(
  tx: TenantClient,
  tenantId: string,
  scope: SummaryScope,
): Promise<TeamSummary> {
  return {
    pendingLeaveApprovals: scope.modules.has('leave')
      ? await tx.leaveRequest.count({
          where: { tenantId, status: 'PENDING', currentApproverId: scope.userId },
        })
      : null,
  };
}

async function buildTenant(
  tx: TenantClient,
  tenantId: string,
  workDate: Date,
  modules: {
    hasAttendance: boolean;
    hasLeave: boolean;
    hasPayroll: boolean;
    hasEmployee: boolean;
  },
): Promise<TenantSummary> {
  const soon = new Date();
  soon.setUTCDate(soon.getUTCDate() + 90);

  const [
    activeEmployees,
    presentToday,
    flagged,
    totalPunches,
    pendingLeave,
    onLeaveToday,
    expiringContracts,
    payrollPending,
  ] = await Promise.all([
    modules.hasEmployee
      ? tx.employee.count({ where: { tenantId, status: { in: ['ACTIVE', 'PROBATION'] } } })
      : Promise.resolve(0),

    // Dihitung dari ketukan, bukan dari `attendance_days`. Rekap harian baru ada
    // setelah dihitung, sehingga dasbor yang membacanya akan menampilkan nol
    // sepanjang hari kerja berjalan — persis ketika angkanya paling dibutuhkan.
    modules.hasAttendance
      ? tx.punchLog
          .findMany({
            where: { tenantId, workDate, type: 'IN' },
            select: { employeeId: true },
            distinct: ['employeeId'],
          })
          .then((rows) => rows.length)
      : Promise.resolve(null),

    modules.hasAttendance
      ? tx.punchLog.count({ where: { tenantId, review: 'NEEDS_REVIEW' } })
      : Promise.resolve(null),

    modules.hasAttendance
      ? tx.punchLog.count({ where: { tenantId } })
      : Promise.resolve(null),

    modules.hasLeave
      ? tx.leaveRequest.count({ where: { tenantId, status: 'PENDING' } })
      : Promise.resolve(null),

    modules.hasLeave
      ? tx.leaveRequest.count({
          where: {
            tenantId,
            status: { in: ['APPROVED', 'TAKEN'] },
            startDate: { lte: workDate },
            endDate: { gte: workDate },
          },
        })
      : Promise.resolve(null),

    modules.hasEmployee
      ? tx.employeeContract.count({
          where: { tenantId, endDate: { not: null, lte: soon, gte: new Date() } },
        })
      : Promise.resolve(null),

    modules.hasPayroll
      ? tx.payrollRun.count({ where: { tenantId, status: 'CALCULATED' } })
      : Promise.resolve(null),
  ]);

  return {
    activeEmployees,
    presentToday,
    flaggedPunches: flagged,
    // Rasio inilah yang memberi tahu apakah ambang kepercayaan salah setel
    // (PLAN/12 §11). Ditampilkan di dasbor supaya tidak perlu ada yang membuka
    // antrean tinjauan hanya untuk mengetahuinya.
    flaggedRatio:
      flagged !== null && totalPunches !== null && totalPunches > 0
        ? Number((flagged / totalPunches).toFixed(4))
        : null,
    pendingLeaveRequests: pendingLeave,
    employeesOnLeaveToday: onLeaveToday,
    expiringContracts,
    payrollRunsPendingApproval: payrollPending,
  };
}
