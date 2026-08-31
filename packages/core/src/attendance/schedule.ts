import { type TenantClient } from '@hrms/db';

/**
 * The work schedule generator (document 10 §5).
 *
 * The `attendance.schedules` table has been read by two modules from the start —
 * attendance uses it to decide `DAY_OFF` status, and leave to count working
 * days — but **nothing ever filled it.** So both modules fell back to the
 * Monday–Friday assumption, and that assumption is wrong for most of the tenants
 * this product targets: a six-day factory, a shop that closes on Mondays,
 * three-shift security guards whose days off rotate.
 *
 * This file is what fills it, from a weekly pattern.
 *
 * ## Three things deliberately NOT done
 *
 * **It does not overwrite an existing row unless asked.** An existing schedule
 * may be the result of a hand adjustment — a shift swap between employees, an
 * agreed substitute day off. Regenerating a month and silently deleting those
 * agreements is how trust in a scheduling feature is lost in a single use.
 * dalam satu kali pakai.
 *
 * **It does not schedule outside employment.** An employee who resigned in March
 * but has a schedule through December would be recorded ABSENT every day until
 * the end of the year, and the whole company's attendance figures break with them.
 *
 * **It does not mark a national holiday as a weekly day off.** Attendance checks
 * `holidays` before the schedule, and that order is deliberate: someone who comes
 * in on a national holiday is not "late", they are working overtime. Writing it
 * as `is_day_off` would swap the HOLIDAY status for DAY_OFF, and holiday overtime
 * would become invisible.
 */

/** 0 = Sunday, 6 = Saturday — the same as `Date#getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly kind: 'range_too_long' | 'invalid_range' | 'all_days_off' | 'not_found',
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

/**
 * The range limit for one generation.
 *
 * A year, not five. 500 employees × 5 years is 900 thousand rows in one
 * transaction — and a pattern mistake in a generation that size is far more
 * expensive to undo than to prevent.
 */
export const MAX_RANGE_DAYS = 366;

export interface GenerateInput {
  employeeIds: string[];
  startDate: Date;
  endDate: Date;
  /** The shift for a working day. `null` means no fixed shift. */
  shiftId: string | null;
  /** The weekly days off. An ordinary Monday–Friday = [0, 6]. */
  dayOffWeekdays: readonly Weekday[];
  /** Overwrite existing rows. Default: skip and report. */
  overwrite?: boolean;
}

export interface GenerateResult {
  created: number;
  updated: number;
  /** Rows that already existed and were NOT overwritten. */
  skipped: number;
  /** Dates outside the employee's employment, left unscheduled. */
  outsideEmployment: number;
  employees: number;
}

export async function generateSchedules(
  tx: TenantClient,
  tenantId: string,
  input: GenerateInput,
): Promise<GenerateResult> {
  const start = utcDate(input.startDate);
  const end = utcDate(input.endDate);

  if (end < start) {
    throw new ScheduleError('Tanggal selesai mendahului tanggal mulai', 'invalid_range');
  }

  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new ScheduleError(
      `Rentang ${days} hari melampaui batas ${MAX_RANGE_DAYS} hari sekali bangkit.`,
      'range_too_long',
    );
  }

  const dayOff = new Set<number>(input.dayOffWeekdays);
  if (dayOff.size >= 7) {
    // Seven days off is not a schedule; it is a way of marking that someone does
    // not work at all, and its path is deactivating the employee, not scheduling.
    throw new ScheduleError('Seluruh hari ditandai libur — tidak ada hari kerja', 'all_days_off');
  }

  if (input.shiftId) {
    const shift = await tx.shift.findFirst({
      where: { id: input.shiftId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!shift) throw new ScheduleError('Shift tidak ditemukan atau tidak aktif', 'not_found');
  }

  const employees = await tx.employee.findMany({
    where: { id: { in: input.employeeIds }, tenantId },
    select: { id: true, joinDate: true, resignDate: true },
  });
  if (employees.length === 0) {
    throw new ScheduleError('Tidak ada karyawan yang cocok', 'not_found');
  }

  const result: GenerateResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    outsideEmployment: 0,
    employees: employees.length,
  };

  // Existing rows are read once for the whole range, not once per date. 500
  // employees × 366 days is 183 thousand queries if checked one at a time — all
  // of it inside one transaction holding a lock.
  const existing = await tx.schedule.findMany({
    where: {
      tenantId,
      employeeId: { in: employees.map((e) => e.id) },
      workDate: { gte: start, lte: end },
    },
    select: { id: true, employeeId: true, workDate: true },
  });
  const existingByKey = new Map(
    existing.map((s) => [`${s.employeeId}:${s.workDate.toISOString().slice(0, 10)}`, s.id]),
  );

  const toCreate: Array<{
    tenantId: string;
    employeeId: string;
    workDate: Date;
    shiftId: string | null;
    isDayOff: boolean;
  }> = [];

  for (const employee of employees) {
    const joined = utcDate(employee.joinDate);
    const resigned = employee.resignDate ? utcDate(employee.resignDate) : null;

    for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
      const date = new Date(t);

      if (date < joined || (resigned && date > resigned)) {
        result.outsideEmployment += 1;
        continue;
      }

      const isDayOff = dayOff.has(date.getUTCDay());
      const key = `${employee.id}:${date.toISOString().slice(0, 10)}`;
      const existingId = existingByKey.get(key);

      if (existingId) {
        if (!input.overwrite) {
          result.skipped += 1;
          continue;
        }
        await tx.schedule.update({
          where: { id: existingId },
          data: { shiftId: isDayOff ? null : input.shiftId, isDayOff },
        });
        result.updated += 1;
        continue;
      }

      toCreate.push({
        tenantId,
        employeeId: employee.id,
        workDate: date,
        // A day off carries no shift. A shift on a day off is a state that cannot
        // be explained, and `daily.ts` reads it to compute lateness on a day with
        // no start time.
        shiftId: isDayOff ? null : input.shiftId,
        isDayOff,
      });
    }
  }

  if (toCreate.length > 0) {
    const inserted = await tx.schedule.createMany({ data: toCreate, skipDuplicates: true });
    result.created = inserted.count;
  }

  return result;
}

function utcDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
