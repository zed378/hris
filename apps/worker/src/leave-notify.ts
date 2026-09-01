import { log } from '@hrms/observability';
import { withTenant, workerClient } from '@hrms/db';
import { sendPush } from '@hrms/core/notification';

/**
 * Notifies an employee that their leave has been decided.
 *
 * This is the most awaited notification in the whole system: someone applies
 * for leave, then checks the screen repeatedly until there is an answer. Before
 * this, both topics were drained — recorded then discarded — so the answer was
 * visible only to whoever opened the app themselves.
 *
 * ## Content is deliberately thin
 *
 * Title and one line: the decision, the leave type, the dates. **No reason for
 * the request, no approver comment.** The notification appears on a locked
 * screen that anyone nearby can see, and push encryption does nothing there —
 * "your sick leave was rejected because the doctor's note was invalid" is a
 * sentence that should not be readable by others on public transport.
 *
 * ## Push is supplementary, not a replacement
 *
 * Web Push does not work on iOS unless a PWA is installed on the Home Screen
 * (document 04 §R52), and most users do not install it. So a failure here is
 * **not treated as a notification failure** — the leave screen still shows the
 * decision, and that is the guaranteed channel.
 */

export interface LeaveNotifyPayload {
  requestId?: string;
  requestNumber?: string;
  employeeId?: string;
  startDate?: string;
  endDate?: string;
  totalDays?: number;
}

export async function notifyLeaveDecision(
  tenantId: string,
  payload: LeaveNotifyPayload,
  approved: boolean,
): Promise<{ sent: number; pruned: number }> {
  const employeeId = payload.employeeId;
  if (!employeeId) return { sent: 0, pruned: 0 };

  return withTenant(
    tenantId,
    async (tx) => {
      // Employee → user via email, the same link used by attendance (PLAN/01 §4.2).
      // An employee without an account does not receive push, and that is normal —
      // they see the decision when HR tells them, as before this system existed.
      const employee = await tx.employee.findFirst({
        where: { id: employeeId, tenantId },
        select: { email: true },
      });
      if (!employee?.email) return { sent: 0, pruned: 0 };

      const user = await tx.user.findFirst({
        where: { tenantId, email: employee.email, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!user) return { sent: 0, pruned: 0 };

      const dateRange =
        payload.startDate === payload.endDate
          ? payload.startDate
          : `${payload.startDate} to ${payload.endDate}`;

      const result = await sendPush(tx, tenantId, user.id, {
        title: approved ? 'Your leave has been approved' : 'Your leave has been rejected',
        body: `${dateRange} · ${payload.totalDays ?? 0} days`,
        // Tagged by request: a second attempt for the SAME decision overrides
        // the first notification instead of stacking above it.
        tag: `leave:${payload.requestId ?? 'x'}`,
        url: '/leave/me',
      });

      return { sent: result.sent, pruned: result.pruned };
    },
    { client: workerClient() },
  ).catch((error: unknown) => {
    // Push failure is not a notification failure. Logged, then forgotten.
    log.warn({ scope: 'leave-notify', tenantId, employeeId, error });
    return { sent: 0, pruned: 0 };
  });
}
