import { writeAudit, type TenantClient } from '@hrms/db';
import { localMinutesToInstant, tenantTimeZone } from './workdate.ts';
import { leaveOnDate } from '../leave/index.ts';

/**
 * The daily attendance calculation.
 *
 * Derived from `punch_logs` and always recomputable. Its result is stored for
 * two reasons: a monthly recap over millions of punches is too expensive to
 * compute every time a screen opens, and payroll needs figures that stop
 * changing once a period is closed.
 *
 * The property maintained: **recomputing the same day must give the same
 * figure.** Without it, two people opening the same recap at different times
 * would see different salaries.
 */

export type DayStatus = 'PRESENT' | 'LATE' | 'ABSENT' | 'LEAVE' | 'HOLIDAY' | 'DAY_OFF';

export interface DailyResult {
  workDate: string;
  status: DayStatus;
  checkIn: string | null;
  checkOut: string | null;
  lateMinutes: number;
  earlyMinutes: number;
  workMinutes: number;
  overtimeMinutes: number;
}

/**
 * Computes one day for one employee.
 *
 * Punches REFUSED by a reviewer are excluded; those still awaiting review are
 * still counted. That is a conscious choice: holding the calculation until HR
 * finds time to review means an empty recap on the busiest days, and someone who
 * genuinely attended looks absent until somebody presses a button.
 */
export async function calculateDay(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  workDate: Date,
): Promise<DailyResult> {
  const dateOnly = new Date(
    Date.UTC(workDate.getUTCFullYear(), workDate.getUTCMonth(), workDate.getUTCDate()),
  );

  const timeZone = await tenantTimeZone(tx, tenantId);

  const [punches, schedule, holiday, leave] = await Promise.all([
    tx.punchLog.findMany({
      where: {
        tenantId,
        employeeId,
        workDate: dateOnly,
        review: { not: 'REJECTED' },
      },
      orderBy: { punchedAt: 'asc' },
      select: { type: true, punchedAt: true },
    }),
    tx.schedule.findUnique({
      where: { employeeId_workDate: { employeeId, workDate: dateOnly } },
      select: {
        isDayOff: true,
        shiftId: true,
        shift: {
          select: { startMinute: true, endMinute: true, graceMinutes: true, breakMinutes: true },
        },
      },
    }),
    tx.holiday.findUnique({
      where: { tenantId_date: { tenantId, date: dateOnly } },
      select: { name: true },
    }),
    // Leave is read through the leave module's front door rather than by querying
    // its tables directly: attendance must not know the shape of the leave tables.
    leaveOnDate(tx, tenantId, employeeId, dateOnly),
  ]);

  const checkIn = punches.find((p) => p.type === 'IN')?.punchedAt ?? null;
  // The LAST clock-out, not the first. Someone who leaves for lunch and comes
  // back produces two OUT punches, and what decides their leaving time is the
  // last one.
  const outs = punches.filter((p) => p.type === 'OUT');
  const checkOut = outs.length > 0 ? outs[outs.length - 1]!.punchedAt : null;

  const base = {
    workDate: dateOnly.toISOString().slice(0, 10),
    checkIn: checkIn?.toISOString() ?? null,
    checkOut: checkOut?.toISOString() ?? null,
    lateMinutes: 0,
    earlyMinutes: 0,
    workMinutes: 0,
    overtimeMinutes: 0,
  };

  // The order of checks decides the result. A holiday is checked before the
  // schedule: someone who comes in on a national holiday is not "late", they are
  // working overtime.
  if (holiday && !checkIn) return { ...base, status: 'HOLIDAY' };
  if (schedule?.isDayOff && !checkIn) return { ...base, status: 'DAY_OFF' };

  /**
   * With no schedule row, a weekend is still a weekend.
   *
   * The leave module's `countWorkingDays` uses the same assumption, and that
   * sameness is not tidiness: before this the two disagreed about which days are
   * working days. Leave treated Saturday and Sunday as non-working; attendance
   * assumed nothing, so **every Sunday was recorded ABSENT** for a tenant who had
   * scheduled nobody.
   *
   * The consequence did not stop at the recap screen. `buildSnapshot` computes
   * `hariAlfa` from the ABSENT status, and the salary formula deducts from that
   * figure — so weekends became salary deductions. The failure produced no error
   * at all; it appeared as a payslip smaller than it should be, for someone with
   * no way of proving it.
   *
   * A schedule still wins where one exists — a six-day factory scheduling
   * Saturdays on is unaffected by this assumption, because its schedule row
   * answers first above.
   */
  if (!schedule && !checkIn) {
    const weekday = dateOnly.getUTCDay();
    if (weekday === 0 || weekday === 6) return { ...base, status: 'DAY_OFF' };
  }

  /**
   * Approved leave is checked BEFORE absence.
   *
   * Without this check, the `LEAVE` status present in the type is never produced
   * by anyone, and an employee whose leave their manager approved is still
   * recorded ABSENT — and then docked pay as absent. The failure produces no
   * error at all; it appears as a wrong payslip.
   *
   * Placed after the holiday check because leave falling on a holiday is not
   * leave — its allowance genuinely is not deducted for that day.
   */
  if (leave && !checkIn) return { ...base, status: 'LEAVE' };

  if (!checkIn) return { ...base, status: 'ABSENT' };

  const workMinutes =
    checkOut !== null
      ? Math.max(0, Math.round((checkOut.getTime() - checkIn.getTime()) / 60_000))
      : 0;

  const shift = schedule?.shift;

  if (!shift) {
    // With no schedule there is no reference for judging lateness or overtime.
    // All that can be said is: this person was present for so many minutes.
    return { ...base, status: 'PRESENT', workMinutes };
  }

  // Schedule minutes are LOCAL minutes. Adding them to UTC midnight would shift
  // the whole shift by the zone offset — for WIB, the morning shift becomes
  // 15:00, and nobody is ever recorded late.
  const scheduledStart = localMinutesToInstant(dateOnly, shift.startMinute, timeZone);
  const scheduledEnd = localMinutesToInstant(dateOnly, shift.endMinute, timeZone);

  const lateMinutes = Math.max(
    0,
    Math.round((checkIn.getTime() - scheduledStart.getTime()) / 60_000) - shift.graceMinutes,
  );

  const earlyMinutes =
    checkOut !== null
      ? Math.max(0, Math.round((scheduledEnd.getTime() - checkOut.getTime()) / 60_000))
      : 0;

  const scheduledMinutes = shift.endMinute - shift.startMinute - shift.breakMinutes;
  const overtimeMinutes =
    checkOut !== null
      ? Math.max(0, Math.round((checkOut.getTime() - scheduledEnd.getTime()) / 60_000))
      : 0;

  return {
    ...base,
    status: lateMinutes > 0 ? 'LATE' : 'PRESENT',
    lateMinutes,
    earlyMinutes,
    workMinutes: Math.max(0, workMinutes - (workMinutes > scheduledMinutes ? shift.breakMinutes : 0)),
    overtimeMinutes,
  };
}

/** Stores the calculation, unless that day is already locked by a period close. */
export async function persistDay(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  result: DailyResult,
  shiftId: string | null,
): Promise<{ saved: boolean }> {
  const workDate = new Date(`${result.workDate}T00:00:00.000Z`);

  const existing = await tx.attendanceDay.findUnique({
    where: { employeeId_workDate: { employeeId, workDate } },
    select: { id: true, isLocked: true },
  });

  // A locked day is not recomputed. Once a period is closed its figures have
  // entered a payslip — changing them means the issued payslip and the stored
  // data no longer agree.
  if (existing?.isLocked) return { saved: false };

  const data = {
    tenantId,
    employeeId,
    workDate,
    shiftId,
    checkIn: result.checkIn ? new Date(result.checkIn) : null,
    checkOut: result.checkOut ? new Date(result.checkOut) : null,
    status: result.status,
    lateMinutes: result.lateMinutes,
    earlyMinutes: result.earlyMinutes,
    workMinutes: result.workMinutes,
    overtimeMinutes: result.overtimeMinutes,
  };

  await tx.attendanceDay.upsert({
    where: { employeeId_workDate: { employeeId, workDate } },
    create: data,
    update: data,
  });

  return { saved: true };
}

/** Recomputes every employee for one date. */
export async function recalculateDate(
  tx: TenantClient,
  tenantId: string,
  workDate: Date,
): Promise<{ processed: number; skipped: number }> {
  const employees = await tx.employee.findMany({
    where: { tenantId, status: { in: ['ACTIVE', 'PROBATION'] } },
    select: { id: true },
  });

  let processed = 0;
  let skipped = 0;

  for (const employee of employees) {
    const saved = await recalculateEmployeeDate(tx, tenantId, employee.id, workDate);
    if (saved.saved) processed += 1;
    else skipped += 1;
  }

  return { processed, skipped };
}

/**
 * Recomputes one employee on one date.
 *
 * Separated because a manual correction touches exactly one person on exactly
 * one day, while `recalculateDate` sweeps every employee. Running the full sweep
 * after HR fixes one punch means recomputing thousands of days that did not
 * change — and doing it inside a request somebody is waiting on.
 * orang.
 * Returns `{ saved: false }` when the day is locked by a period close. That value
 * must be passed on to the caller: a correction that does not change the recap
 * must not be reported as a success.
 */
export async function recalculateEmployeeDate(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  workDate: Date,
): Promise<{ saved: boolean }> {
  const result = await calculateDay(tx, tenantId, employeeId, workDate);
  const schedule = await tx.schedule.findUnique({
    where: {
      employeeId_workDate: {
        employeeId,
        workDate: new Date(`${result.workDate}T00:00:00.000Z`),
      },
    },
    select: { shiftId: true },
  });

  return persistDay(tx, tenantId, employeeId, result, schedule?.shiftId ?? null);
}

/**
 * Closing an attendance period.
 *
 * Locks every day in the range and stores its summary. After this, an incoming
 * attendance correction no longer changes the figures payroll uses — and that is
 * the point: a payslip already issued must not change because someone corrected
 * last month's attendance.
 */
export async function closePeriod(
  tx: TenantClient,
  tenantId: string,
  year: number,
  month: number,
  actorUserId: string,
): Promise<{ employees: number; days: number }> {
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 0));

  const days = await tx.attendanceDay.findMany({
    where: { tenantId, workDate: { gte: startDate, lte: endDate } },
    select: {
      employeeId: true,
      status: true,
      lateMinutes: true,
      workMinutes: true,
      overtimeMinutes: true,
    },
  });

  const summary = new Map<
    string,
    { present: number; late: number; absent: number; lateMinutes: number; overtimeMinutes: number }
  >();

  for (const day of days) {
    const row = summary.get(day.employeeId) ?? {
      present: 0,
      late: 0,
      absent: 0,
      lateMinutes: 0,
      overtimeMinutes: 0,
    };
    if (day.status === 'PRESENT' || day.status === 'LATE') row.present += 1;
    if (day.status === 'LATE') row.late += 1;
    if (day.status === 'ABSENT') row.absent += 1;
    row.lateMinutes += day.lateMinutes;
    row.overtimeMinutes += day.overtimeMinutes;
    summary.set(day.employeeId, row);
  }

  await tx.attendanceDay.updateMany({
    where: { tenantId, workDate: { gte: startDate, lte: endDate } },
    data: { isLocked: true },
  });

  await tx.attendancePeriod.upsert({
    where: { tenantId_year_month: { tenantId, year, month } },
    create: {
      tenantId,
      year,
      month,
      startDate,
      endDate,
      closedAt: new Date(),
      closedBy: actorUserId,
      snapshot: Object.fromEntries(summary) as never,
    },
    update: {
      closedAt: new Date(),
      closedBy: actorUserId,
      snapshot: Object.fromEntries(summary) as never,
    },
  });

  await writeAudit(tx, tenantId, {
    action: 'attendance.period.closed',
    entityType: 'attendance_period',
    entityId: `${year}-${String(month).padStart(2, '0')}`,
    actorUserId,
    after: { employees: summary.size, days: days.length },
  });

  return { employees: summary.size, days: days.length };
}

