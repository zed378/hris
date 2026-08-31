import { Prisma } from '@hrms/db';

/**
 * Leave entitlement by accrual method (document 03 §4.1).
 *
 * This file closes a bug of a class that has recurred in this project: **an
 * enum value that is declared but never produced by anyone.**
 *
 * `AccrualMethod` has had five values since the leave module's first migration,
 * and the leave type screen lets HR pick all five. But `ensureBalance` granted
 * the FULL `defaultQuotaDays` whatever the method. So a tenant choosing:
 *
 *   - `MONTHLY_ACCRUAL` — an employee joining on 10 March immediately received
 *     12 days on their first day rather than accruing one a month. They could
 *     take all of it in April and resign in May, and the company would have
 *     paid for leave that was never earned.
 *   - `ANNIVERSARY` — the allowance should be born on the service anniversary,
 *     per Article 79(3) of the Labour Law: the right to annual leave arises
 *     after 12 continuous months of work. What happened instead was that the
 *     allowance existed from 1 January for someone who had worked a month.
 *
 * Neither produced an error. The number was simply wrong, and wrong in the
 * employee's favour — so nobody would ever report it.
 *
 * ## The shape of the fix: a target, not an increment
 *
 * `entitlementAsOf` answers one question: **how many days this person SHOULD
 * have earned by this date.** It is a pure function of the join date, not an
 * accumulation of previous calls.
 *
 * The consequence matters for the periodic job: reconciliation becomes
 * idempotent and self-correcting. Running it twice in a day duplicates nothing,
 * and a job that was dead for three months catches up in a single round. An
 * accrual that adds "one month" on every call has two failure modes at once:
 * running twice means twice the allowance, and missing once means an allowance
 * lost forever with no trace.
 */

export type AccrualMethod =
  | 'ANNUAL_GRANT'
  | 'MONTHLY_ACCRUAL'
  | 'ANNIVERSARY'
  | 'UNLIMITED'
  | 'NONE';

const MONTHS_PER_YEAR = 12;

export interface EntitlementInput {
  method: AccrualMethod;
  /** A full year's allowance for this leave type. */
  quotaDays: Prisma.Decimal;
  /** The join date. The basis of every length-of-service calculation. */
  joinDate: Date;
  /** The calendar year of the balance row. */
  periodYear: number;
  /** The evaluation date — usually today. */
  asOf: Date;
}

/**
 * How many days of allowance have been earned as of `asOf`.
 *
 * Always computed in UTC. A timezone difference shifts things by at most one
 * day at a month boundary, and for an annual leave allowance that changes
 * nothing — unlike an attendance working-day boundary, which shifts every day
 * for every person and therefore does use the tenant's timezone.
 */
export function entitlementAsOf(input: EntitlementInput): Prisma.Decimal {
  const { method, quotaDays, joinDate, periodYear, asOf } = input;

  // Not quota-based. The row still exists so its movements have somewhere to go.
  if (method === 'UNLIMITED' || method === 'NONE') return new Prisma.Decimal(0);

  const periodStart = Date.UTC(periodYear, 0, 1);
  const periodEnd = Date.UTC(periodYear, 11, 31);
  const join = utcMidnight(joinDate);
  const now = utcMidnight(asOf);

  // Had not joined yet by the time that year ended.
  if (join > periodEnd) return new Prisma.Decimal(0);

  // The full allowance for the whole period year, **independent of `asOf`**.
  // This is the behaviour that has existed from the start and is deliberately
  // NOT changed to proration: changing it would cut the allowance of people
  // whose balances already exist, and mid-year proration is a tenant policy,
  // not a bug fix.
  //
  // That independence from `asOf` matters, and it was nearly lost while this
  // file was being written. `runCarryOver` creates the NEXT year's rows, and if
  // it runs on 31 December then `asOf` still sits before the start of the new
  // period. A "the year has not started" guard applying to every method would
  // make that row be born with a zero allowance — and because `ANNUAL_GRANT`
  // does not grow over time, no path would ever fix it afterwards. The whole
  // company would begin the year with no leave allowance, with not one error,
  // purely because the year-end close ran a day earlier than imagined.
  if (method === 'ANNUAL_GRANT') return quotaDays;

  // The year has not started — there is nothing to accrue.
  if (now < periodStart) return new Prisma.Decimal(0);

  // Evaluation never runs past the end of the period year. Without this bound,
  // opening a 2026 balance in 2028 would show two years' allowance.
  const evaluated = Math.min(now, periodEnd);

  switch (method) {

    case 'MONTHLY_ACCRUAL': {
      // One twelfth of the allowance for every WHOLE month of service that has
      // elapsed within this year.
      //
      // What is counted is the monthiversary of the join date, not the end of a
      // calendar month. An employee joining on 10 March earns their first
      // instalment on 10 April, not 31 March — so someone joining on the 28th
      // does not get almost a whole month for free.
      const months = monthiversariesBetween(join, Math.max(periodStart, join), evaluated);

      // The twelve-month cap. With `from` clamped to the start of the year and
      // `to` clamped to its end above, this cap is NEVER reached today — and
      // that is stated here rather than left looking like a guard that works.
      // Mutation testing confirms it: removing `Math.min` fails not one test.
      // It stays because what guards this is the clamping in two other places,
      // and that clamping is what the next person adding a non-calendar period
      // will loosen.
      const capped = Math.min(months, MONTHS_PER_YEAR);
      return quotaDays.mul(capped).div(MONTHS_PER_YEAR);
    }

    case 'ANNIVERSARY': {
      // The full allowance is born on the service anniversary, and not a second
      // before. A first-year employee earns ZERO — exactly what Article 79(3)
      // of the Labour Law means.
      const anniversary = anniversaryIn(join, periodYear);
      if (anniversary === null) return new Prisma.Decimal(0);
      return evaluated >= anniversary ? quotaDays : new Prisma.Decimal(0);
    }
  }
}

function utcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * How many monthiversaries of the join date fall within [from, to].
 *
 * The lower bound is INCLUSIVE, and that is not a detail: for a long-serving
 * employee, 1 January is a valid monthiversary if they joined on the 1st.
 * Excluding it would make every employee with a join date of the 1st lose a
 * month every year — a one-day discrepancy nobody could ever explain.
 *
 * The join date itself is NOT a monthiversary: the first day of work has earned
 * nothing yet.
 *
 * The 31st in a shorter month falls to that month's last day — joining on 31
 * January has its monthiversary on 28 (or 29) February. The alternative,
 * jumping to 1 March, would mean somebody's February never counted in a given
 * year.
 */
function monthiversariesBetween(join: number, from: number, to: number): number {
  const joinDay = new Date(join).getUTCDate();
  const start = new Date(from);

  let cursor = clampedMonthiversary(start.getUTCFullYear(), start.getUTCMonth(), joinDay);

  // Step back a month when this month's monthiversary falls before `from`, so
  // the next iteration does not skip it.
  while (cursor < from) {
    const c = new Date(cursor);
    cursor = clampedMonthiversary(c.getUTCFullYear(), c.getUTCMonth() + 1, joinDay);
  }

  let count = 0;
  while (cursor <= to) {
    // The first day of work is not a monthiversary.
    if (cursor > join) count += 1;
    const c = new Date(cursor);
    cursor = clampedMonthiversary(c.getUTCFullYear(), c.getUTCMonth() + 1, joinDay);
  }

  return count;
}

function clampedMonthiversary(year: number, month: number, day: number): number {
  // `month` may be 12 or more; Date.UTC rolls it into the next year.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(day, lastDay));
}

/**
 * The service anniversary falling within a given calendar year.
 *
 * `null` when the employee has not completed a full year by then — a zeroth
 * anniversary is not an anniversary.
 */
function anniversaryIn(join: number, periodYear: number): number | null {
  const joinDate = new Date(join);
  if (joinDate.getUTCFullYear() >= periodYear) return null;
  return clampedMonthiversary(periodYear, joinDate.getUTCMonth(), joinDate.getUTCDate());
}

/**
 * Whether the method grows over time within a running year.
 *
 * Used by the periodic job to filter the rows that need re-examining.
 * `ANNUAL_GRANT` is excluded: its allowance is full from the moment the row is
 * created, and scanning it daily only produces a difference of zero.
 */
export function accruesOverTime(method: AccrualMethod): boolean {
  return method === 'MONTHLY_ACCRUAL' || method === 'ANNIVERSARY';
}
