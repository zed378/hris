import { type TenantClient } from '@hrms/db';
import { inviteUser, IamError, type ActorContext } from './administration.ts';

/**
 * Inviting employees to become users, in bulk.
 *
 * Found by walking the pilot flow, and by not one test.
 *
 * The user → employee mapping in this system is a **soft reference through
 * email** (PLAN/01 §4.2): the attendance module looks for an `employee.email`
 * matching the email of the user logged in. That design is right and deliberate
 * — it is what keeps the attendance module from holding a foreign key into the
 * employee table, so the two can be split later.
 *
 * What was missing is the bridge. HR imports 100 employees, and **not one of
 * them has an account.** They cannot log in, cannot punch in, cannot request
 * leave, and cannot see their payslip. The only route was inviting them one at a
 * time through a form asking for the email and name already in their employee
 * row.
 *
 * For 100 people that is 100 form submissions with data the system already has —
 * and that is exactly what the three Gate A pilots would have to do after
 * successfully importing their employees.
 *
 * ## What is reported rather than left unsaid
 *
 * **An employee with no email cannot be invited**, and their count is returned.
 * Email is the only bridge to an account; without one there is nobody to send an
 * invitation to, and nothing will match when they punch in. What HR needs to do
 * — fill in the email column — they can only do if they know how many are empty.
 *
 * **Those who already have an account are skipped**, not failed. A bulk
 * invitation that stops at the first person already registered would never
 * finish at a company that adds employees every month.
 */

export interface BulkInviteInput {
  /** Empty means every active employee without an account. */
  employeeIds?: readonly string[] | undefined;
  roleCode: string;
}

export interface BulkInviteResult {
  invited: Array<{ employeeId: string; userId: string; email: string }>;
  /** Already has an account with the same email. */
  alreadyHasAccount: number;
  /** Has no email — cannot be invited, and will not match when punching in. */
  withoutEmail: Array<{ employeeId: string; employeeNumber: string; fullName: string }>;
  failed: Array<{ employeeId: string; reason: string }>;
}

/** The limit for one call. A larger company invites department by department. */
const MAX_PER_CALL = 500;

export async function inviteEmployeesAsUsers(
  tx: TenantClient,
  tenantId: string,
  input: BulkInviteInput,
  ctx: ActorContext,
): Promise<BulkInviteResult> {
  const role = await tx.role.findUnique({
    where: { tenantId_code: { tenantId, code: input.roleCode } },
    select: { id: true },
  });
  if (!role) throw new IamError(`Peran "${input.roleCode}" tidak ditemukan`, 'not_found');

  const employees = await tx.employee.findMany({
    where: {
      tenantId,
      status: { in: ['ACTIVE', 'PROBATION'] },
      ...(input.employeeIds && input.employeeIds.length > 0
        ? { id: { in: [...input.employeeIds] } }
        : {}),
    },
    orderBy: { employeeNumber: 'asc' },
    take: MAX_PER_CALL,
    select: { id: true, employeeNumber: true, fullName: true, email: true },
  });

  const result: BulkInviteResult = {
    invited: [],
    alreadyHasAccount: 0,
    withoutEmail: [],
    failed: [],
  };

  // Existing accounts are read once, not once per employee. 500 employees means
  // 500 queries if checked one at a time — all of it inside one request
  // transaction capped at fifteen seconds.
  const emails = employees
    .map((employee) => employee.email?.trim().toLowerCase())
    .filter((email): email is string => !!email);

  const existing = await tx.user.findMany({
    where: { tenantId, email: { in: emails } },
    select: { email: true },
  });
  const taken = new Set(existing.map((user) => user.email.toLowerCase()));

  for (const employee of employees) {
    const email = employee.email?.trim().toLowerCase();

    if (!email) {
      result.withoutEmail.push({
        employeeId: employee.id,
        employeeNumber: employee.employeeNumber,
        fullName: employee.fullName,
      });
      continue;
    }

    if (taken.has(email)) {
      result.alreadyHasAccount += 1;
      continue;
    }

    try {
      const { userId } = await inviteUser(
        tx,
        tenantId,
        { email, fullName: employee.fullName, roleCode: input.roleCode },
        ctx,
      );
      result.invited.push({ employeeId: employee.id, userId, email });
      // Marked so that two employee rows with the same email — which happens with
      // a married couple sharing an address — do not produce a second invitation
      // that is certain to fail.
      taken.add(email);
    } catch (error) {
      result.failed.push({
        employeeId: employee.id,
        reason: error instanceof Error ? error.message : 'Undangan gagal',
      });
    }
  }

  return result;
}
