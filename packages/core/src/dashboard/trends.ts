import type { TenantClient } from '@hrms/db';

/**
 * Month-over-month trends (PLAN/13, "there are no charts or trends").
 *
 * The dashboard shows one month at a glance, and one month cannot answer the
 * only question these numbers are for: **is it getting worse?** A flagged ratio
 * of 9% is fine; 9% after three months of 4% is a different fact entirely, and
 * the screen showed them identically.
 *
 * ## What is included, and what is deliberately not
 *
 * The dashboard's rule (see `summary.ts`) is that a number earns its place by
 * being actionable — "7 leave requests waiting" is useful because there is a
 * page for it, "143 employees" is useful once. A trend has to clear the same bar,
 * and most do not: a chart of total headcount is decoration for a company of
 * forty people who know all forty.
 *
 * Three series clear it:
 *
 *   - **The flagged ratio**, which `PLAN/12` §11 names as the metric that decides
 *     whether the trust score is doing anything. Above 12% HR stops reviewing and
 *     the score becomes theatre. The threshold is explicitly **not calibrated**,
 *     and it cannot be calibrated from one month — this series is what makes that
 *     calibration possible at all.
 *   - **Absence**, because a rising absence rate is a management problem that
 *     shows up nowhere else until payroll.
 *   - **Leave days taken**, because leave is seasonal and a manager approving
 *     December requests needs to know what December usually looks like.
 *
 * ## One query per series, not one per month
 *
 * A loop over months would issue `months × series` queries for a screen. These
 * group in SQL and return one row per month, which keeps a six-month view at
 * three queries regardless of the range.
 *
 * ## Why raw SQL
 *
 * `date_trunc` and `FILTER (WHERE …)` do in one pass what Prisma would need
 * several round trips and a reduce to express. The work belongs in the database,
 * and the shape of these queries — count these rows, bucketed by month — is
 * exactly what it is good at.
 */

export interface AttendanceTrendPoint {
  /** `YYYY-MM`. */
  month: string;
  punches: number;
  flagged: number;
  /** `flagged / punches`, or null for a month with no punches at all. */
  flaggedRatio: number | null;
  absentDays: number;
  lateDays: number;
  presentDays: number;
}

export interface LeaveTrendPoint {
  month: string;
  /** Days actually taken, counted against approved requests. */
  days: number;
  requests: number;
}

export interface DashboardTrends {
  /** Oldest first, so a chart can render the array in order. */
  months: string[];
  attendance: AttendanceTrendPoint[] | null;
  leave: LeaveTrendPoint[] | null;
}

/** How far back a caller may ask. */
export const MAX_TREND_MONTHS = 24;
const DEFAULT_MONTHS = 6;

export interface TrendScope {
  modules: ReadonlySet<string>;
  /** Trends are tenant-wide figures, so they need the tenant-wide permission. */
  canViewTenant: boolean;
}

/**
 * The months to report, oldest first.
 *
 * Generated in JavaScript rather than by the database so that a month with **no
 * rows at all** still appears. Left to a `GROUP BY`, an empty month simply does
 * not come back — and a chart drawn from that silently joins the month before it
 * to the month after, which reads as continuity where there was a gap.
 */
function monthKeys(months: number, now: Date): string[] {
  const keys: string[] = [];

  for (let back = months - 1; back >= 0; back -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    keys.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`);
  }

  return keys;
}

export async function buildTrends(
  tx: TenantClient,
  tenantId: string,
  scope: TrendScope,
  options: { months?: number; now?: Date } = {},
): Promise<DashboardTrends> {
  const now = options.now ?? new Date();
  const months = Math.min(Math.max(options.months ?? DEFAULT_MONTHS, 1), MAX_TREND_MONTHS);
  const keys = monthKeys(months, now);

  // The first day of the earliest month, in UTC. Work dates are stored as plain
  // dates at UTC midnight, so the comparison needs no timezone conversion.
  const since = new Date(`${keys[0]}-01T00:00:00.000Z`);

  const trends: DashboardTrends = { months: keys, attendance: null, leave: null };

  // Nothing is computed for a caller who may not see tenant-wide figures. The
  // gateway has already checked the permission; this is the second layer, and it
  // is here because a trend is a different question from a summary and could
  // otherwise be reached through a route that only checked the latter.
  if (!scope.canViewTenant) return trends;

  if (scope.modules.has('attendance')) {
    const rows = await tx.$queryRaw<
      Array<{
        month: string;
        punches: bigint;
        flagged: bigint;
        absent: bigint;
        late: bigint;
        present: bigint;
      }>
    >`
      WITH punches AS (
        SELECT to_char(work_date, 'YYYY-MM') AS month,
               count(*)                                        AS punches,
               count(*) FILTER (WHERE review = 'NEEDS_REVIEW')  AS flagged
        FROM attendance.punch_logs
        WHERE tenant_id = ${tenantId}::uuid AND work_date >= ${since}
        GROUP BY 1
      ),
      days AS (
        SELECT to_char(work_date, 'YYYY-MM') AS month,
               count(*) FILTER (WHERE status = 'ABSENT')  AS absent,
               count(*) FILTER (WHERE status = 'LATE')    AS late,
               count(*) FILTER (WHERE status = 'PRESENT') AS present
        FROM attendance.attendance_days
        WHERE tenant_id = ${tenantId}::uuid AND work_date >= ${since}
        GROUP BY 1
      )
      SELECT COALESCE(p.month, d.month)     AS month,
             COALESCE(p.punches, 0)         AS punches,
             COALESCE(p.flagged, 0)         AS flagged,
             COALESCE(d.absent, 0)          AS absent,
             COALESCE(d.late, 0)            AS late,
             COALESCE(d.present, 0)         AS present
      FROM punches p
      FULL OUTER JOIN days d ON d.month = p.month
    `;

    const byMonth = new Map(rows.map((row) => [row.month, row]));

    trends.attendance = keys.map((month) => {
      const row = byMonth.get(month);
      const punches = Number(row?.punches ?? 0);
      const flagged = Number(row?.flagged ?? 0);

      return {
        month,
        punches,
        flagged,
        // `null`, not zero, for a month with no punches. Zero would draw a point
        // on the chart at 0% and read as "nothing was flagged", which is a claim
        // about a month in which nothing happened at all.
        flaggedRatio: punches === 0 ? null : flagged / punches,
        absentDays: Number(row?.absent ?? 0),
        lateDays: Number(row?.late ?? 0),
        presentDays: Number(row?.present ?? 0),
      };
    });
  }

  if (scope.modules.has('leave')) {
    const rows = await tx.$queryRaw<Array<{ month: string; days: number; requests: bigint }>>`
      SELECT to_char(start_date, 'YYYY-MM') AS month,
             COALESCE(sum(total_days), 0)   AS days,
             count(*)                       AS requests
      FROM leave.leave_requests
      WHERE tenant_id = ${tenantId}::uuid
        AND start_date >= ${since}
        -- Approved only. A pending request is not leave taken, and a rejected one
        -- never was; counting either makes the series answer a different question
        -- from the one its label promises.
        AND status = 'APPROVED'
      GROUP BY 1
    `;

    const byMonth = new Map(rows.map((row) => [row.month, row]));

    trends.leave = keys.map((month) => {
      const row = byMonth.get(month);
      return {
        month,
        days: Number(row?.days ?? 0),
        requests: Number(row?.requests ?? 0),
      };
    });
  }

  return trends;
}
