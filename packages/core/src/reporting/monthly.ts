import { writeAudit, type TenantClient } from '@hrms/db';

/**
 * The monthly per-employee attendance recap (document 02 §9).
 *
 * This is the report that actually gets printed, signed, and filed every month
 * in an Indonesian company — one row per employee, holding the counts of days
 * present, late, absent, and on leave. It is also what finance uses to check
 * deductions before payroll runs.
 *
 * Before this, all that existed was a **list of days** — one row per employee
 * per date. For 100 employees over a month that is 3,000 rows, and HR needing
 * 100 figures summed them in Excel themselves. Summing by hand is where numbers
 * change without anyone knowing, and a number that changes here becomes a salary
 * deduction.
 *
 * ## What is counted, and what deliberately is not
 *
 * **A day with no row counts as nothing.** An attendance recap is created when
 * it is computed, not automatically every night, so a month not yet recomputed
 * has fewer rows than it has days. The `daysRecorded` figure is returned so that
 * difference is visible — a report showing "0 absences" for a month that has not
 * been computed reads like a perfect month.
 */

export interface MonthlyAttendanceRow {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  hadir: number;
  terlambat: number;
  alfa: number;
  cuti: number;
  libur: number;
  liburMingguan: number;
  /** Days that have a recap row. Fewer than the day count means it is not fully computed. */
  hariTercatat: number;
  menitTerlambat: number;
  menitLembur: number;
  jamKerja: number;
}

export interface MonthlyAttendanceReport {
  periodYear: number;
  periodMonth: number;
  /** The number of calendar days in that month. */
  hariKalender: number;
  rows: MonthlyAttendanceRow[];
  totals: {
    karyawan: number;
    hadir: number;
    terlambat: number;
    alfa: number;
    cuti: number;
    menitTerlambat: number;
    menitLembur: number;
  };
  /**
   * Employees with no recap row at all that month.
   *
   * Reported separately rather than shown as a zero row. A zero from "there is no
   * data" and a zero from "they genuinely were not there" are very different
   * things, and showing them identically makes the first read as the second.
   */
  tanpaData: Array<{ employeeId: string; employeeNumber: string; fullName: string }>;
}

export async function buildMonthlyAttendance(
  tx: TenantClient,
  tenantId: string,
  periodYear: number,
  periodMonth: number,
  actor?: { actorUserId: string; correlationId?: string | null | undefined },
): Promise<MonthlyAttendanceReport> {
  const from = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  const to = new Date(Date.UTC(periodYear, periodMonth, 0));
  const hariKalender = to.getUTCDate();

  const employees = await tx.employee.findMany({
    where: { tenantId, status: { in: ['ACTIVE', 'PROBATION'] } },
    orderBy: { employeeNumber: 'asc' },
    select: { id: true, employeeNumber: true, fullName: true },
  });

  // The aggregation happens in the DATABASE, not by pulling 3,000 rows into
  // process memory and summing them. For 100 employees over a month the
  // difference is not yet felt; for 1,000 employees over a year it becomes the
  // difference between a report that opens and a request that times out.
  const agregat = await tx.$queryRaw<
    Array<{
      employee_id: string;
      status: string;
      jumlah: bigint;
      menit_terlambat: bigint;
      menit_lembur: bigint;
      menit_kerja: bigint;
    }>
  >`
    SELECT employee_id, status,
           count(*) AS jumlah,
           coalesce(sum(late_minutes), 0) AS menit_terlambat,
           coalesce(sum(overtime_minutes), 0) AS menit_lembur,
           coalesce(sum(work_minutes), 0) AS menit_kerja
    FROM attendance.attendance_days
    WHERE tenant_id = ${tenantId}::uuid
      AND work_date BETWEEN ${from} AND ${to}
    GROUP BY employee_id, status
  `;

  const perEmployee = new Map<string, MonthlyAttendanceRow>();
  for (const employee of employees) {
    perEmployee.set(employee.id, {
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      fullName: employee.fullName,
      hadir: 0,
      terlambat: 0,
      alfa: 0,
      cuti: 0,
      libur: 0,
      liburMingguan: 0,
      hariTercatat: 0,
      menitTerlambat: 0,
      menitLembur: 0,
      jamKerja: 0,
    });
  }

  for (const baris of agregat) {
    const row = perEmployee.get(baris.employee_id);
    // Rows belonging to an employee who is no longer active are skipped rather
    // than failing the report. An employee who resigned mid-month still has a
    // recap, and the current month's report is about those still working.
    if (!row) continue;

    const jumlah = Number(baris.jumlah);
    row.hariTercatat += jumlah;
    row.menitTerlambat += Number(baris.menit_terlambat);
    row.menitLembur += Number(baris.menit_lembur);
    row.jamKerja += Number(baris.menit_kerja) / 60;

    switch (baris.status) {
      case 'PRESENT':
        row.hadir += jumlah;
        break;
      case 'LATE':
        // Late STILL counts as present. Counting it separately from present would
        // make "present + late + absent" fail to equal the working days, and
        // whoever reads it would think a day had gone missing.
        row.hadir += jumlah;
        row.terlambat += jumlah;
        break;
      case 'ABSENT':
        row.alfa += jumlah;
        break;
      case 'LEAVE':
        row.cuti += jumlah;
        break;
      case 'HOLIDAY':
        row.libur += jumlah;
        break;
      case 'DAY_OFF':
        row.liburMingguan += jumlah;
        break;
    }
  }

  const rows = [...perEmployee.values()].map((row) => ({
    ...row,
    jamKerja: Math.round(row.jamKerja * 10) / 10,
  }));

  const tanpaData = rows
    .filter((row) => row.hariTercatat === 0)
    .map((row) => ({
      employeeId: row.employeeId,
      employeeNumber: row.employeeNumber,
      fullName: row.fullName,
    }));

  const totals = rows.reduce(
    (sum, row) => ({
      karyawan: sum.karyawan + 1,
      hadir: sum.hadir + row.hadir,
      terlambat: sum.terlambat + row.terlambat,
      alfa: sum.alfa + row.alfa,
      cuti: sum.cuti + row.cuti,
      menitTerlambat: sum.menitTerlambat + row.menitTerlambat,
      menitLembur: sum.menitLembur + row.menitLembur,
    }),
    { karyawan: 0, hadir: 0, terlambat: 0, alfa: 0, cuti: 0, menitTerlambat: 0, menitLembur: 0 },
  );

  if (actor) {
    // This report holds the attendance data of every employee. Reading it moves
    // personal data off the screen, and its trail answers "where did this file
    // come from" when it turns up somewhere it should not be.
    await writeAudit(tx, tenantId, {
      action: 'report.attendance_monthly.read',
      entityType: 'report',
      actorUserId: actor.actorUserId,
      correlationId: actor.correlationId ?? undefined,
      after: { periodYear, periodMonth, karyawan: totals.karyawan, tanpaData: tanpaData.length },
    });
  }

  return { periodYear, periodMonth, hariKalender, rows, totals, tanpaData };
}

export const MONTHLY_ATTENDANCE_HEADERS = [
  'Nomor Karyawan',
  'Nama',
  'Hadir',
  'Terlambat',
  'Alfa',
  'Cuti',
  'Libur Nasional',
  'Libur Mingguan',
  'Hari Tercatat',
  'Menit Terlambat',
  'Menit Lembur',
  'Jam Kerja',
] as const;

/** The row shape for the .xlsx export. */
export function monthlyAttendanceRows(report: MonthlyAttendanceReport): string[][] {
  return [
    [...MONTHLY_ATTENDANCE_HEADERS],
    ...report.rows.map((row) => [
      row.employeeNumber,
      row.fullName,
      String(row.hadir),
      String(row.terlambat),
      String(row.alfa),
      String(row.cuti),
      String(row.libur),
      String(row.liburMingguan),
      String(row.hariTercatat),
      String(row.menitTerlambat),
      String(row.menitLembur),
      String(row.jamKerja),
    ]),
  ];
}
