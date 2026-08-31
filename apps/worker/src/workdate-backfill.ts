import { withTenant, workerClient } from '@hrms/db';
import { log } from '@hrms/observability';
import { resolveWorkDate, recalculateEmployeeDate } from '@hrms/core/attendance';

/**
 * Repairs `punch_logs.work_date` for rows written before the timezone fix.
 *
 * ## What went wrong, and why nothing complained
 *
 * The first version of `resolveWorkDate` used `getUTCHours()`. For WIB (UTC+7)
 * that puts every punch between 06:00 and 10:59 local on **yesterday's** date —
 * which is not an edge case, it is almost everyone's arrival window. The stored
 * effect is a working day holding a clock-out with no clock-in, counted ABSENT,
 * with the missing clock-in filed against the previous day, which then holds two.
 *
 * Every figure derived from it — the monthly recap, the salary deduction, the
 * absence letter — is wrong, and none of it raises anything. `work_date` is a
 * plain date column: a wrong date is as valid as a right one.
 *
 * The fix landed in `resolveWorkDate`, so nothing NEW is wrong. Rows already
 * written keep their wrong date forever, because nothing recomputes a punch that
 * was already accepted.
 *
 * ## Recomputed, not adjusted
 *
 * The obvious repair — "add a day to punches between 00:00 and 03:59 UTC" —
 * would be wrong twice over. It assumes UTC+7 for every tenant, and tenants now
 * carry their own timezone; and it assumes the old bug's exact shape, so running
 * it twice would corrupt data that was already correct.
 *
 * Instead each punch is passed through the CURRENT `resolveWorkDate` with its
 * tenant's zone, and rewritten only where the answer differs. That makes the job
 * idempotent — a second run finds nothing to change — and correct for a row
 * written under any past version of the bug, including none.
 *
 * ## The daily recap must follow
 *
 * Moving a punch to a different date leaves `attendance_days` describing the
 * world as it was: the day it left still counts it, the day it joined does not.
 * So every date touched — the one it left AND the one it arrived at — is
 * recomputed through `recalculateEmployeeDate`, the same function a manual
 * correction uses.
 *
 * `recalculateEmployeeDate` returns `{ saved: false }` for a day inside a closed
 * attendance period, and that answer is carried out to the summary rather than
 * swallowed. A closed period is payroll's frozen input: silently rewriting it
 * would change figures that have already been paid, and silently skipping it
 * would leave a recap nobody knows disagrees with its punches. It has to be
 * counted and reported so a human decides.
 */

const BATCH_SIZE = 500;

export interface BackfillSummary {
  tenants: number;
  scanned: number;
  /** Punches whose work date was wrong and has been corrected. */
  corrected: number;
  /** Distinct (employee, date) pairs recomputed. */
  daysRecalculated: number;
  /**
   * Days that could not be recomputed because their period is closed.
   *
   * Not a failure and not a success. The punch has been corrected; the recap
   * that payroll already used has not, and the difference needs a person.
   */
  daysLocked: number;
  failed: number;
}

export async function backfillWorkDates(dryRun = false): Promise<BackfillSummary> {
  // Every tenant, including churned ones — the same reasoning as the PII
  // rotation. A wrong attendance record for a departed tenant is still a wrong
  // record they may ask about, or dispute.
  const tenants = await workerClient().$queryRaw<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM public.all_tenant_ids()
  `;

  const summary: BackfillSummary = {
    tenants: tenants.length,
    scanned: 0,
    corrected: 0,
    daysRecalculated: 0,
    daysLocked: 0,
    failed: 0,
  };

  for (const { tenant_id: tenantId } of tenants) {
    const tenant = await withTenant(
      tenantId,
      (tx) => tx.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } }),
      { client: workerClient() },
    );

    const timeZone = tenant?.timezone ?? 'Asia/Jakarta';

    // (employeeId, ISO date) pairs whose recap needs recomputing afterwards.
    const touched = new Set<string>();
    let cursor: string | null = null;

    for (;;) {
      const batch: Array<{ id: string; employeeId: string; punchedAt: Date; workDate: Date }> =
        await withTenant(
          tenantId,
          (tx) =>
            tx.punchLog.findMany({
              // Keyset pagination on the primary key rather than skip/take. The
              // rows being read are the rows being written, and an offset window
              // shifts underneath a job that edits what it is paging through.
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
              orderBy: { id: 'asc' },
              take: BATCH_SIZE,
              select: { id: true, employeeId: true, punchedAt: true, workDate: true },
            }),
          { client: workerClient() },
        );

      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.id;
      summary.scanned += batch.length;

      for (const punch of batch) {
        try {
          const correct = resolveWorkDate(punch.punchedAt, timeZone);
          if (correct.getTime() === punch.workDate.getTime()) continue;

          summary.corrected += 1;
          touched.add(`${punch.employeeId}|${punch.workDate.toISOString().slice(0, 10)}`);
          touched.add(`${punch.employeeId}|${correct.toISOString().slice(0, 10)}`);

          if (dryRun) continue;

          await withTenant(
            tenantId,
            (tx) => tx.punchLog.update({ where: { id: punch.id }, data: { workDate: correct } }),
            { client: workerClient() },
          );
        } catch (error) {
          summary.failed += 1;
          log.error({ scope: 'workdate-backfill', tenantId, punchId: punch.id, error });
        }
      }

      if (batch.length < BATCH_SIZE) break;
    }

    if (dryRun) {
      summary.daysRecalculated += touched.size;
      continue;
    }

    for (const key of touched) {
      const [employeeId, date] = key.split('|');
      try {
        const result = await withTenant(
          tenantId,
          (tx) =>
            recalculateEmployeeDate(tx, tenantId, employeeId!, new Date(`${date}T00:00:00.000Z`)),
          { client: workerClient() },
        );

        if (result.saved) summary.daysRecalculated += 1;
        else summary.daysLocked += 1;
      } catch (error) {
        summary.failed += 1;
        log.error({ scope: 'workdate-backfill', tenantId, employeeId, date, error });
      }
    }
  }

  log.info({ scope: 'workdate-backfill', dryRun, ...summary });
  return summary;
}
