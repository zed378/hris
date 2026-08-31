import { Prisma, writeAudit, type TenantClient } from '@hrms/db';
import { LeaveError, ensureBalance, writeLedger } from './balance.ts';

/**
 * Joint leave: deducting from the annual leave allowance (document 03 §4.2).
 *
 * `holidays.is_joint_leave` has existed since the attendance module was built,
 * with a comment stating its purpose exactly: *"Joint leave deducts the annual
 * leave allowance; a national holiday does not."* No code path ever read it.
 *
 * The consequence favours employees, and so would never have been reported: a
 * company with four joint leave days gave **four extra paid days off per
 * employee per year** beyond the 12-day allowance. For a hundred employees that
 * is four hundred working days missing from anyone's calculation.
 *
 * Its basis is the joint ministerial decree, which each year establishes joint
 * leave as a **deduction** from the annual leave allowance — unlike a national
 * holiday, which is not.
 *
 * ## What has to be right, and why
 *
 * **Idempotent through the ledger, not through a flag.** Every deduction leaves
 * a ledger row with `referenceType: 'holiday'` and the holiday date as its
 * `referenceId`. A re-run reads that row and skips it. A separate flag — a
 * `deducted_at` column on the holiday table — would be right only until someone
 * added a new employee after the deduction ran.
 *
 * **Never creates a negative balance.** An employee whose allowance is used up
 * still takes the day off — their office is closed — and only what remains can
 * be deducted. The shortfall is reported rather than forced:
 * `chk_no_negative_balance` would refuse it, and that refusal would surface as a
 * failure for the next employee requesting leave, not on the action that caused
 * it.
 */

export interface JointLeaveResult {
  /** The joint leave dates processed. */
  holidays: number;
  /** The employees whose balance was reduced. */
  employees: number;
  /** Total days deducted. */
  days: number;
  /**
   * Employees whose balance was insufficient, with their shortfall.
   *
   * Reported rather than passed over in silence. A shortfall means someone is
   * off without an allowance — a situation HR has to decide on (unpaid,
   * borrowed from next year, or let go), and that decision cannot be taken if
   * nobody knows.
   */
  shortfalls: Array<{ employeeId: string; days: number }>;
}

/**
 * Deducts the annual leave allowance for every joint leave day in a year.
 *
 * The leave type deducted is the only one that both has `deductFromBalance` and
 * a quota-based accrual. If a tenant has more than one, the one with the largest
 * default allowance is chosen — the main annual allowance, not some additional
 * leave that happens to deduct from a balance too.
 */
export async function applyJointLeave(
  tx: TenantClient,
  tenantId: string,
  periodYear: number,
  actorUserId?: string,
): Promise<JointLeaveResult> {
  const holidays = await tx.holiday.findMany({
    where: {
      tenantId,
      isJointLeave: true,
      date: {
        gte: new Date(Date.UTC(periodYear, 0, 1)),
        lte: new Date(Date.UTC(periodYear, 11, 31)),
      },
    },
    orderBy: { date: 'asc' },
    select: { id: true, date: true, name: true },
  });

  const result: JointLeaveResult = {
    holidays: holidays.length,
    employees: 0,
    days: 0,
    shortfalls: [],
  };
  if (holidays.length === 0) return result;

  const leaveType = await tx.leaveType.findFirst({
    where: {
      tenantId,
      isActive: true,
      deductFromBalance: true,
      accrualMethod: { in: ['ANNUAL_GRANT', 'MONTHLY_ACCRUAL', 'ANNIVERSARY'] },
    },
    orderBy: { defaultQuotaDays: 'desc' },
    select: { id: true, name: true },
  });
  if (!leaveType) {
    throw new LeaveError(
      'Tidak ada jenis cuti berbasis kuota yang dapat dipotong cuti bersama',
      'not_found',
    );
  }

  const employees = await tx.employee.findMany({
    where: { tenantId, status: { in: ['ACTIVE', 'PROBATION'] } },
    select: { id: true },
    orderBy: { employeeNumber: 'asc' },
  });

  const shortfallByEmployee = new Map<string, number>();
  const touched = new Set<string>();

  for (const holiday of holidays) {
    // The ledger rows that already exist for this date. This is the key to its
    // idempotency — read once per date, not once per employee.
    const already = await tx.$queryRaw<Array<{ employee_id: string }>>`
      SELECT b.employee_id
      FROM "leave".balance_ledger l
      JOIN "leave".leave_balances b ON b.id = l.balance_id
      WHERE l.tenant_id = ${tenantId}::uuid
        AND l.reference_type = 'holiday'
        AND l.reference_id = ${holiday.id}::uuid
    `;
    const done = new Set(already.map((row) => row.employee_id));

    for (const employee of employees) {
      if (done.has(employee.id)) continue;

      const balance = await ensureBalance(
        tx,
        tenantId,
        employee.id,
        leaveType.id,
        periodYear,
        actorUserId,
      );

      // Whatever remains, at most one day. An employee whose allowance is used
      // up still takes the day off; only what is available can be deducted.
      const deductible = Math.min(1, Math.max(0, balance.availableDays));

      if (deductible < 1) {
        shortfallByEmployee.set(
          employee.id,
          (shortfallByEmployee.get(employee.id) ?? 0) + (1 - deductible),
        );
      }
      if (deductible <= 0) continue;

      await tx.leaveBalance.update({
        where: { id: balance.id },
        data: {
          usedDays: { increment: new Prisma.Decimal(deductible) },
          version: { increment: 1 },
        },
      });

      await writeLedger(tx, tenantId, {
        balanceId: balance.id,
        entryType: 'CONSUME',
        days: -deductible,
        referenceType: 'holiday',
        referenceId: holiday.id,
        note: `Cuti bersama ${holiday.date.toISOString().slice(0, 10)} — ${holiday.name}`,
        ...(actorUserId ? { actorUserId } : {}),
      });

      touched.add(employee.id);
      result.days += deductible;
    }
  }

  result.employees = touched.size;
  result.shortfalls = [...shortfallByEmployee].map(([employeeId, days]) => ({
    employeeId,
    days,
  }));

  if (result.days > 0 || result.shortfalls.length > 0) {
    await writeAudit(tx, tenantId, {
      action: 'leave.joint_leave.applied',
      entityType: 'leave_balance',
      ...(actorUserId ? { actorUserId } : {}),
      after: {
        periodYear,
        leaveType: leaveType.name,
        holidays: result.holidays,
        employees: result.employees,
        days: result.days,
        shortfalls: result.shortfalls.length,
      },
    });
  }

  return result;
}

/**
 * Returns the allowance a joint leave date deducted.
 *
 * Called when the date is deleted, or when its flag is changed to an ordinary
 * national holiday. Without it, an HR correction only works in one direction:
 * mistakenly flagging one date deducts a hundred employees' allowance, and
 * undoing it returns nothing. What is lost is not a number on a screen — it is a
 * day off somebody can no longer take.
 *
 * The government does revise joint leave dates mid-year, so this is not an
 * invented edge case.
 */
export async function revertJointLeave(
  tx: TenantClient,
  tenantId: string,
  holidayId: string,
  actorUserId?: string,
): Promise<{ employees: number; days: number }> {
  const entries = await tx.$queryRaw<
    Array<{ ledger_id: string; balance_id: string; days: Prisma.Decimal }>
  >`
    SELECT l.id AS ledger_id, l.balance_id, l.days
    FROM "leave".balance_ledger l
    WHERE l.tenant_id = ${tenantId}::uuid
      AND l.reference_type = 'holiday'
      AND l.reference_id = ${holidayId}::uuid
      AND l.entry_type = 'CONSUME'
  `;

  let days = 0;

  for (const entry of entries) {
    // `days` on a CONSUME row is negative; what is returned is its magnitude.
    // besarannya.
    const amount = entry.days.abs();

    await tx.leaveBalance.update({
      where: { id: entry.balance_id },
      data: { usedDays: { decrement: amount }, version: { increment: 1 } },
    });

    // The original CONSUME row is NOT deleted, and the return is written as a new
    // row. A ledger whose rows can disappear is not a ledger — and the question
    // "why did my allowance drop and then come back" has to have an answer that
    // can be shown.
    await writeLedger(tx, tenantId, {
      balanceId: entry.balance_id,
      entryType: 'ADJUST',
      days: Number(amount),
      referenceType: 'holiday_reverted',
      referenceId: holidayId,
      note: 'Pengembalian potongan cuti bersama — tanggalnya dihapus atau tidak lagi ditandai cuti bersama',
      ...(actorUserId ? { actorUserId } : {}),
    });

    days += Number(amount);
  }

  if (entries.length > 0) {
    await writeAudit(tx, tenantId, {
      action: 'leave.joint_leave.reverted',
      entityType: 'leave_balance',
      entityId: holidayId,
      ...(actorUserId ? { actorUserId } : {}),
      after: { employees: entries.length, days },
    });
  }

  return { employees: entries.length, days };
}
