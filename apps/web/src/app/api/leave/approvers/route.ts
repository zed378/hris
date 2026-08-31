import { NextResponse } from 'next/server';
import { findPermissionHolders, findManagerUserId } from '@hrms/core/iam';
import { defineRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who may be nominated to approve this user's leave.
 *
 * The leave screen previously built its approver dropdown from
 * `GET /api/users?limit=200` — **every user in the tenant**. Nominating someone
 * without `leave.request.approve` was accepted at every layer: the request was
 * created, it recorded an approver, and it appeared in nobody's inbox. It stayed
 * PENDING until a human noticed the leave had never been decided.
 *
 * That is precisely the freeze document 13 warns automatic routing to an
 * undesignated manager would cause — arriving instead through the manual picker
 * that was supposed to be the safe option.
 *
 * ## The manager is a default, never a requirement
 *
 * `Employment.managerId` has existed since the org module was built and nothing
 * has read it (document 13, "Leave — what is missing"). It is read here, and only
 * as far as it can safely be: the designated manager is **marked and sorted
 * first** so the screen can preselect them, and the requester may still choose
 * anyone else on the list.
 *
 * Making it mandatory would freeze every request in a tenant that never filled
 * the column in, which is most of them — and a manager who has left, or who has
 * no user account, would freeze one team indefinitely. Both cases return no
 * manager here and the list simply behaves as it did before.
 *
 * A manager who is designated but does NOT hold the approval permission is
 * likewise not marked: they are absent from the list entirely, because offering
 * them is the bug this endpoint exists to close.
 *
 * ## Why this is readable by anyone who can request leave
 *
 * The list is `leave.request.create.own` rather than an administrative
 * permission, because everybody who can ask for leave has to be able to see who
 * can grant it. What it discloses is a name and an email of colleagues in the
 * same tenant, which the org chart already shows.
 */
export const GET = defineRoute('GET /api/leave/approvers', async (_req, ctx) => {
  const holders = await findPermissionHolders(ctx.tx, ctx.tenantId, 'leave.request.approve');

  // The employee record behind the session, by the same soft email mapping the
  // punch route uses. Absent for an account not linked to an employee — an HR
  // administrator who is not themselves on the payroll — and that is not an
  // error, it simply means there is no manager to prefer.
  const me = await ctx.tx.employee.findFirst({
    where: { tenantId: ctx.tenantId, email: ctx.email },
    select: { id: true },
  });

  const managerUserId = me
    ? await findManagerUserId(ctx.tx, ctx.tenantId, me.id)
    : null;

  const approvers = holders
    // A requester can never approve their own leave (control failure 39), so
    // offering themselves would only produce a refusal one screen later.
    .filter((holder) => holder.userId !== ctx.userId)
    .map((holder) => ({
      id: holder.userId,
      label: holder.fullName ?? holder.email,
      email: holder.email,
      isManager: holder.userId === managerUserId,
    }));

  approvers.sort((a, b) =>
    a.isManager === b.isManager ? a.label.localeCompare(b.label) : a.isManager ? -1 : 1,
  );

  /**
   * `managerDesignated` distinguishes two states the list cannot show.
   *
   * "No manager is marked" means either that nobody was designated, or that the
   * designated manager cannot approve. The screen says something different in
   * each case, and without this flag it would have to guess — which is how a
   * setting that quietly does nothing gets introduced.
   */
  return NextResponse.json({
    approvers,
    managerDesignated: managerUserId !== null,
  });
});
