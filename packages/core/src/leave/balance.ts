import { Prisma, writeAudit, type TenantClient } from '@hrms/db';
import { accruesOverTime, entitlementAsOf, type AccrualMethod } from './accrual.ts';

/**
 * Leave balances and their movements (document 02 §8, document 03 §4.1).
 *
 * This whole file turns on one sentence in the Phase 4 DoD:
 *
 *   "50 simultaneous approvals against a 2-day balance → exactly 1 succeeds"
 *
 * What guarantees that is three layers holding each other up:
 *
 *   1. `SELECT … FOR UPDATE` on the balance row — the second transaction WAITS
 *      here rather than reading a stale value and deciding on it.
 *   2. Validation that reads the value AFTER the lock is held.
 *   3. `chk_no_negative_balance` in the database — the last safety net.
 *
 * The third layer stays even though the first two are correct, and that is not
 * excessive caution: it is what survives when someone adds a new write path six
 * months from now and forgets to take the lock.
 *
 * What is NOT used: an optimistic check based on `version`. For a balance,
 * losing the race means asking the user to try again — and during a bulk leave
 * approval at month end, "try again" means a manager pressing the same button
 * five times without knowing why.
 */

export class LeaveError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'not_found'
      | 'insufficient_balance'
      | 'overlap'
      | 'invalid_state'
      | 'not_entitled'
      | 'forbidden',
  ) {
    super(message);
    this.name = 'LeaveError';
  }
}

export type LedgerEntryType =
  | 'GRANT'
  | 'ACCRUAL'
  | 'HOLD'
  | 'RELEASE'
  | 'CONSUME'
  | 'EXPIRE'
  | 'ADJUST';

export interface BalanceView {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  periodYear: number;
  entitledDays: number;
  carriedOverDays: number;
  adjustmentDays: number;
  usedDays: number;
  pendingDays: number;
  expiredDays: number;
  /** Read from the GENERATED column, never recomputed here. */
  availableDays: number;
}

interface BalanceRow {
  id: string;
  employee_id: string;
  leave_type_id: string;
  code: string;
  name: string;
  period_year: number;
  entitled_days: Prisma.Decimal;
  carried_over_days: Prisma.Decimal;
  adjustment_days: Prisma.Decimal;
  used_days: Prisma.Decimal;
  pending_days: Prisma.Decimal;
  expired_days: Prisma.Decimal;
  available_days: Prisma.Decimal;
}

function toView(row: BalanceRow): BalanceView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    leaveTypeId: row.leave_type_id,
    leaveTypeCode: row.code,
    leaveTypeName: row.name,
    periodYear: row.period_year,
    entitledDays: Number(row.entitled_days),
    carriedOverDays: Number(row.carried_over_days),
    adjustmentDays: Number(row.adjustment_days),
    usedDays: Number(row.used_days),
    pendingDays: Number(row.pending_days),
    expiredDays: Number(row.expired_days),
    availableDays: Number(row.available_days),
  };
}

/**
 * Reads a balance, including the `available_days` column the database computes.
 *
 * A raw query rather than Prisma purely because a GENERATED column cannot be
 * declared in a Prisma model. Recomputing its formula in TypeScript would give
 * two sources of truth that are certain to differ the day someone adds a new
 * kind of movement.
 */
export async function readBalances(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  periodYear: number,
  /** The accrual evaluation date for types that have no row yet. */
  asOf: Date = new Date(),
): Promise<BalanceView[]> {
  const rows = await tx.$queryRaw<BalanceRow[]>`
    SELECT b.id, b.employee_id, b.leave_type_id, t.code, t.name, b.period_year,
           b.entitled_days, b.carried_over_days, b.adjustment_days,
           b.used_days, b.pending_days, b.expired_days, b.available_days
    FROM "leave".leave_balances b
    JOIN "leave".leave_types t ON t.id = b.leave_type_id
    WHERE b.tenant_id = ${tenantId}::uuid
      AND b.employee_id = ${employeeId}::uuid
      AND b.period_year = ${periodYear}
    ORDER BY t.code
  `;

  const existing = rows.map(toView);
  const withRow = new Set(existing.map((balance) => balance.leaveTypeId));

  /**
   * Leave types with no row yet are shown too, with the allowance that SHOULD
   * already have been earned.
   *
   * Found by walking the pilot flow. Balance rows are created when needed
   * (`ensureBalance`), and what needs them is a leave request — not a read. So
   * an employee who has never requested leave opens the "My Leave" screen and
   * sees an **empty list.**
   *
   * Empty does not read as "no movements yet". It reads as "I have no leave
   * entitlement" — and someone who concludes that will not request leave, and
   * their allowance then expires at year end never having been used.
   *
   * Rows are NOT created here, and that is deliberate: this is a read path, and
   * a GET that writes fails on a read replica while also turning opening a page
   * into an action that changes data. The figure is computed by the same
   * function `ensureBalance` uses when it eventually stores it, so what is seen
   * now is exactly what will be stored later.
   */
  const employee = await tx.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { joinDate: true },
  });
  if (!employee) return existing;

  const types = await tx.leaveType.findMany({
    where: { tenantId, isActive: true, deductFromBalance: true },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, defaultQuotaDays: true, accrualMethod: true },
  });

  const withoutRow: BalanceView[] = [];
  for (const type of types) {
    if (withRow.has(type.id)) continue;

    const entitled = entitlementAsOf({
      method: type.accrualMethod as AccrualMethod,
      quotaDays: type.defaultQuotaDays,
      joinDate: employee.joinDate,
      periodYear,
      asOf,
    });

    withoutRow.push({
      // No row yet, so no id. An empty string is chosen over a fake id: a caller
      // that uses it to move a balance fails immediately rather than writing
      // into somebody else's row.
      id: '',
      employeeId,
      leaveTypeId: type.id,
      leaveTypeCode: type.code,
      leaveTypeName: type.name,
      periodYear,
      entitledDays: Number(entitled),
      carriedOverDays: 0,
      adjustmentDays: 0,
      usedDays: 0,
      pendingDays: 0,
      expiredDays: 0,
      availableDays: Number(entitled),
    });
  }

  return [...existing, ...withoutRow].sort((a, b) => a.leaveTypeCode.localeCompare(b.leaveTypeCode));
}

/**
 * Locks the balance row and returns its state once locked.
 *
 * This `FOR UPDATE` is the first layer. A second transaction asking for the
 * same row stops here until the first finishes, then reads a value that ALREADY
 * accounts for the first transaction's change.
 *
 * Without it, two transactions both read "2 days available", both conclude that
 * is enough, and both write — producing a negative balance held back only by the
 * constraint, and held back as a database error that cannot be explained to the
 * user.
 */
export async function lockBalance(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  periodYear: number,
): Promise<BalanceView | null> {
  // Two steps because `FOR UPDATE` cannot be used with a JOIN in some query
  // shapes; what needs locking is only the balance row.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "leave".leave_balances
    WHERE tenant_id = ${tenantId}::uuid
      AND employee_id = ${employeeId}::uuid
      AND leave_type_id = ${leaveTypeId}::uuid
      AND period_year = ${periodYear}
    FOR UPDATE
  `;
  if (locked.length === 0) return null;

  const rows = await tx.$queryRaw<BalanceRow[]>`
    SELECT b.id, b.employee_id, b.leave_type_id, t.code, t.name, b.period_year,
           b.entitled_days, b.carried_over_days, b.adjustment_days,
           b.used_days, b.pending_days, b.expired_days, b.available_days
    FROM "leave".leave_balances b
    JOIN "leave".leave_types t ON t.id = b.leave_type_id
    WHERE b.id = ${locked[0]!.id}::uuid
  `;
  return rows[0] ? toView(rows[0]) : null;
}

export interface LedgerEntry {
  balanceId: string;
  entryType: LedgerEntryType;
  /** Positive adds to the available balance, negative subtracts from it. */
  days: number;
  referenceType?: string | undefined;
  referenceId?: string | undefined;
  note?: string | undefined;
  actorUserId?: string | undefined;
}

/**
 * Writes one ledger row.
 *
 * Called on EVERY balance change, without exception. A function that changes a
 * balance column without calling this is a bug even when its figure is right —
 * because a correct balance with no history cannot be defended in a dispute.
 */
export async function writeLedger(
  tx: TenantClient,
  tenantId: string,
  entry: LedgerEntry,
): Promise<void> {
  await tx.balanceLedger.create({
    data: {
      tenantId,
      balanceId: entry.balanceId,
      entryType: entry.entryType,
      days: new Prisma.Decimal(entry.days),
      referenceType: entry.referenceType ?? null,
      referenceId: entry.referenceId ?? null,
      note: entry.note ?? null,
      createdBy: entry.actorUserId ?? null,
    },
  });
}

/**
 * Ensures a balance row exists for an employee-type-year combination.
 *
 * Created on demand rather than by a bulk job at the start of the year. A bulk
 * job for every employee × every leave type produces thousands of rows most of
 * which are never used, and still misses the employee who joins in March.
 */
export async function ensureBalance(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  periodYear: number,
  actorUserId?: string,
  /** The accrual evaluation date. Injected so it can be tested. */
  asOf: Date = new Date(),
): Promise<BalanceView> {
  const type = await tx.leaveType.findFirst({
    where: { id: leaveTypeId, tenantId },
    select: { defaultQuotaDays: true, accrualMethod: true },
  });
  if (!type)     throw new LeaveError('Leave type not found', 'not_found');

  const employee = await tx.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { joinDate: true },
  });
  if (!employee) throw new LeaveError('Employee not found', 'not_found');

  const method = type.accrualMethod as AccrualMethod;
  const target = entitlementAsOf({
    method,
    quotaDays: type.defaultQuotaDays,
    joinDate: employee.joinDate,
    periodYear,
    asOf,
  });

  const existing = await lockBalance(tx, tenantId, employeeId, leaveTypeId, periodYear);

  // An existing row IS RECONCILED, not returned as it stands.
  //
  // Without this, monthly accrual is only right on the day the row was created.
  // An employee whose row was born in March would see March's allowance forever,
  // because no path touches it again — and the periodic job cannot cover that
  // alone, since a job that has not run yet leaves a stale figure exactly when
  // someone requests leave.
  if (existing) return reconcileEntitlement(tx, tenantId, existing, method, target, actorUserId);

  const created = await tx.leaveBalance.create({
    data: { tenantId, employeeId, leaveTypeId, periodYear, entitledDays: target },
    select: { id: true },
  });

  if (!target.isZero()) {
    await writeLedger(tx, tenantId, {
      balanceId: created.id,
      entryType: method === 'ANNUAL_GRANT' ? 'GRANT' : 'ACCRUAL',
      days: Number(target),
      referenceType: 'leave_type',
      referenceId: leaveTypeId,
      note: grantNote(method, periodYear, Number(target)),
      ...(actorUserId ? { actorUserId } : {}),
    });
  }

  const balance = await lockBalance(tx, tenantId, employeeId, leaveTypeId, periodYear);
  if (!balance) throw new LeaveError('Balance creation failed', 'not_found');
  return balance;
}

function grantNote(method: AccrualMethod, periodYear: number, days: number): string {
  switch (method) {
    case 'MONTHLY_ACCRUAL':
      return `Monthly accrual ${periodYear} — ${days} days earned`;
    case 'ANNIVERSARY':
      return `Service anniversary allowance ${periodYear}`;
    default:
      return `Annual allowance ${periodYear}`;
  }
}

/**
 * Raises `entitled_days` to the accrual target, when it needs raising.
 *
 * **Never lowers it.** An allowance already granted may already have been used,
 * and pulling it back produces a negative balance refused by
 * `chk_no_negative_balance` — a failure that appears for the next person to
 * request leave, not on the change that caused it. A reduced quota or a join
 * date corrected backwards is an HR decision, and its path is `adjustBalance`,
 * which asks for a reason and leaves an audit trail.
 */
async function reconcileEntitlement(
  tx: TenantClient,
  tenantId: string,
  balance: BalanceView,
  method: AccrualMethod,
  target: Prisma.Decimal,
  actorUserId?: string,
): Promise<BalanceView> {
  if (!accruesOverTime(method)) return balance;

  const delta = target.minus(balance.entitledDays);
  if (delta.lessThanOrEqualTo(0)) return balance;

  await tx.leaveBalance.update({
    where: { id: balance.id },
    data: {
      entitledDays: { increment: delta },
      version: { increment: 1 },
    },
  });

  await writeLedger(tx, tenantId, {
    balanceId: balance.id,
    entryType: 'ACCRUAL',
    days: Number(delta),
    note:
      method === 'ANNIVERSARY'
        ? `Anniversary entitlement — ${Number(target)} days`
        : `Monthly accrual — increased by ${Number(delta)} days, total ${Number(target)}`,
    ...(actorUserId ? { actorUserId } : {}),
  });

  return { ...balance, entitledDays: Number(target), availableDays: balance.availableDays + Number(delta) };
}

export interface AdjustInput {
  employeeId: string;
  leaveTypeId: string;
  periodYear: number;
  days: number;
  reason: string;
}

/** A manual balance adjustment by HR. Always audited and always ledgered. */
export async function adjustBalance(
  tx: TenantClient,
  tenantId: string,
  input: AdjustInput,
  actorUserId: string,
): Promise<BalanceView> {
  const balance = await ensureBalance(
    tx,
    tenantId,
    input.employeeId,
    input.leaveTypeId,
    input.periodYear,
    actorUserId,
  );

  if (balance.availableDays + input.days < 0) {
    throw new LeaveError(
      `Adjustment of ${input.days} days would make the balance negative. Available: ${balance.availableDays} days.`,
      'insufficient_balance',
    );
  }

  await tx.leaveBalance.update({
    where: { id: balance.id },
    data: {
      adjustmentDays: { increment: new Prisma.Decimal(input.days) },
      version: { increment: 1 },
    },
  });

  await writeLedger(tx, tenantId, {
    balanceId: balance.id,
    entryType: 'ADJUST',
    days: input.days,
    note: input.reason,
    actorUserId,
  });

  await writeAudit(tx, tenantId, {
    action: 'leave.balance.adjusted',
    entityType: 'leave_balance',
    entityId: balance.id,
    actorUserId,
    before: { availableDays: balance.availableDays },
    after: { days: input.days, reason: input.reason },
  });

  const updated = await lockBalance(
    tx,
    tenantId,
    input.employeeId,
    input.leaveTypeId,
    input.periodYear,
  );
  return updated!;
}

/** The movement history of one balance, newest first. */
export async function readLedger(
  tx: TenantClient,
  tenantId: string,
  balanceId: string,
  limit = 100,
): Promise<
  Array<{
    id: string;
    entryType: string;
    days: number;
    note: string | null;
    referenceId: string | null;
    createdAt: string;
  }>
> {
  const rows = await tx.balanceLedger.findMany({
    where: { tenantId, balanceId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return rows.map((row) => ({
    // `BigInt` cannot be serialised to JSON. Converted here, at the module
    // boundary, rather than left for every caller to remember.
    id: String(row.id),
    entryType: row.entryType,
    days: Number(row.days),
    note: row.note,
    referenceId: row.referenceId,
    createdAt: row.createdAt.toISOString(),
  }));
}

export interface CarryOverResult {
  employees: number;
  carriedOver: number;
  expired: number;
}

/**
 * Closes the year: carries the remaining balance into the next one, the rest expires.
 *
 * Two movements, not one. 10 days left with a carry-over cap of 6 produces
 * `carried_over_days = 6` in the new year AND `expired_days = 4` in the old
 * one — not merely a 6 appearing from nowhere.
 *
 * The difference matters when an employee asks where those four days went. A
 * balance that disappears without a ledger row cannot be explained by anyone,
 * and that question always comes in January.
 *
 * Idempotent: running it twice duplicates nothing, because an `expired_days`
 * that is already filled marks that year as closed.
 */
export async function runCarryOver(
  tx: TenantClient,
  tenantId: string,
  fromYear: number,
  actorUserId?: string,
): Promise<CarryOverResult> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      employee_id: string;
      leave_type_id: string;
      available_days: Prisma.Decimal;
      expired_days: Prisma.Decimal;
      max_carry_over_days: Prisma.Decimal;
    }>
  >`
    SELECT b.id, b.employee_id, b.leave_type_id, b.available_days, b.expired_days,
           t.max_carry_over_days
    FROM "leave".leave_balances b
    JOIN "leave".leave_types t ON t.id = b.leave_type_id
    WHERE b.tenant_id = ${tenantId}::uuid
      AND b.period_year = ${fromYear}
      AND t.deduct_from_balance = true
  `;

  const result: CarryOverResult = { employees: 0, carriedOver: 0, expired: 0 };

  for (const row of rows) {
    // A year already closed is skipped. Without this guard, running the job
    // twice would carry the same remainder into the next year a second time.
    if (!row.expired_days.isZero()) continue;

    const available = Number(row.available_days);
    if (available <= 0) continue;

    const maxCarry = Number(row.max_carry_over_days);
    const carried = Math.min(available, maxCarry);
    const expired = available - carried;

    result.employees += 1;

    if (expired > 0) {
      await tx.leaveBalance.update({
        where: { id: row.id },
        data: {
          expiredDays: { increment: new Prisma.Decimal(expired) },
          version: { increment: 1 },
        },
      });
      await writeLedger(tx, tenantId, {
        balanceId: row.id,
        entryType: 'EXPIRE',
        days: -expired,
        note: `Expired on year close ${fromYear} (default carry limit ${maxCarry} days)`,
        ...(actorUserId ? { actorUserId } : {}),
      });
      result.expired += expired;
    }

    if (carried > 0) {
      const next = await ensureBalance(
        tx,
        tenantId,
        row.employee_id,
        row.leave_type_id,
        fromYear + 1,
        actorUserId,
      );

      await tx.leaveBalance.update({
        where: { id: next.id },
        data: {
          carriedOverDays: { increment: new Prisma.Decimal(carried) },
          version: { increment: 1 },
        },
      });
      await writeLedger(tx, tenantId, {
        balanceId: next.id,
        entryType: 'GRANT',
        days: carried,
        note: `Leave balance carried over from ${fromYear} to ${fromYear + 1}`,
        ...(actorUserId ? { actorUserId } : {}),
      });

      // The old year's side is marked too, so its column totals stay consistent
      // and that year counts as closed.
      await tx.leaveBalance.update({
        where: { id: row.id },
        data: {
          expiredDays: { increment: new Prisma.Decimal(carried) },
          version: { increment: 1 },
        },
      });
      await writeLedger(tx, tenantId, {
        balanceId: row.id,
        entryType: 'EXPIRE',
        days: -carried,
        note: `Dipindahkan ke tahun ${fromYear + 1}`,
        ...(actorUserId ? { actorUserId } : {}),
      });

      result.carriedOver += carried;
    }
  }

  return result;
}

export interface AccrualResult {
  /** The balance rows examined. */
  reviewed: number;
  /** The rows whose allowance grew. */
  accrued: number;
  /** Total days added. */
  days: number;
}

/**
 * Re-examines every running-year balance whose allowance grows over time.
 *
 * Run periodically by the worker. What it does is exactly what `ensureBalance`
 * does when someone requests leave — the only difference is reach: this job
 * touches everyone, so the figure on the balance screen is already right before
 * anyone requests anything.
 *
 * Idempotent because it compares against a TARGET rather than adding an
 * allowance. Running it twice in a day gives a difference of zero on the second
 * round; a job dead for three months catches up entirely in one round.
 *
 * Touches EXISTING rows only. Creating a row for every employee × every leave
 * type would produce thousands of rows most of which are never used — and
 * `ensureBalance` already computes correctly for a row born later, whatever
 * month it is born in.
 */
export async function runAccrual(
  tx: TenantClient,
  tenantId: string,
  asOf: Date,
  actorUserId?: string,
): Promise<AccrualResult> {
  const periodYear = asOf.getUTCFullYear();

  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      employee_id: string;
      leave_type_id: string;
      entitled_days: Prisma.Decimal;
      default_quota_days: Prisma.Decimal;
      accrual_method: string;
      join_date: Date;
    }>
  >`
    SELECT b.id, b.employee_id, b.leave_type_id, b.entitled_days,
           t.default_quota_days, t.accrual_method, e.join_date
    FROM "leave".leave_balances b
    JOIN "leave".leave_types t ON t.id = b.leave_type_id
    JOIN employee.employees e ON e.id = b.employee_id
    WHERE b.tenant_id = ${tenantId}::uuid
      AND b.period_year = ${periodYear}
      AND t.accrual_method IN ('MONTHLY_ACCRUAL', 'ANNIVERSARY')
      AND t.is_active = true
      -- An employee who has left stops accruing. Without this filter, someone
      -- who resigned in March keeps earning through December, and the figure
      -- resurfaces in their severance calculation.
      AND e.status = 'ACTIVE'
  `;

  const result: AccrualResult = { reviewed: rows.length, accrued: 0, days: 0 };

  for (const row of rows) {
    const target = entitlementAsOf({
      method: row.accrual_method as AccrualMethod,
      quotaDays: row.default_quota_days,
      joinDate: row.join_date,
      periodYear,
      asOf,
    });

    const delta = target.minus(row.entitled_days);
    if (delta.lessThanOrEqualTo(0)) continue;

    await tx.leaveBalance.update({
      where: { id: row.id },
      data: { entitledDays: { increment: delta }, version: { increment: 1 } },
    });
    await writeLedger(tx, tenantId, {
      balanceId: row.id,
      entryType: 'ACCRUAL',
      days: Number(delta),
      note:
        row.accrual_method === 'ANNIVERSARY'
          ? `Anniversary entitlement — ${Number(target)} days`
          : `Monthly accrual — increased by ${Number(delta)} days, total ${Number(target)}`,
      ...(actorUserId ? { actorUserId } : {}),
    });

    result.accrued += 1;
    result.days += Number(delta);
  }

  return result;
}
