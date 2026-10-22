import type { TenantClient } from '@hrms/db';
import { applyPrecedence } from './resolve-access.ts';
import { IamError } from './errors.ts';

/**
 * The permission ceiling (P6-13, ADR-035, `MEMORY/specs/P6-13-permission-ceiling.md`).
 *
 * **Nobody but `TENANT_OWNER` confers access they do not hold, or touches the
 * owner's access.**
 *
 * Without it, delegating IAM was handing over ownership: a custom role holding
 * `iam.role.manage` could add `payroll.run.execute` to itself, and a holder of
 * `iam.grant.manage` could DENY the owner's `iam.role.manage` and lock the owner
 * out of their own tenant (`docs/SECURITY/02` §5(a), risk F12).
 *
 * "Held" is steps 1–3 of `docs/PLAN/05` §4 — **before** the subscription
 * filter. Subscription is entitlement, not authority: a delegate whose role
 * carries `payroll.payslip.read.own` while payroll is unsubscribed must still be
 * able to invite employees into the role that carries it. Conferring a
 * permission of an unsubscribed module confers nothing until the module is
 * enabled — and the actor's own copy comes back at the same moment.
 *
 * This is checked in the domain, below every route, so any future route reusing
 * these functions inherits it rather than having to remember it.
 */

export const OWNER_ROLE_CODE = 'TENANT_OWNER';

interface Authority {
  isOwner: boolean;
  held: Set<string>;
}

async function authorityOf(tx: TenantClient, tenantId: string, userId: string): Promise<Authority> {
  const now = new Date();
  const [userRoles, grants] = await Promise.all([
    tx.userRole.findMany({
      where: { tenantId, userId },
      select: { role: { select: { code: true, permissions: { select: { permissionCode: true } } } } },
    }),
    tx.userPermissionGrant.findMany({
      where: { tenantId, userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { permissionCode: true, effect: true },
    }),
  ]);

  return {
    isOwner: userRoles.some(({ role }) => role.code === OWNER_ROLE_CODE),
    held: applyPrecedence(userRoles, grants),
  };
}

async function holdsOwnerRole(tx: TenantClient, tenantId: string, userId: string): Promise<boolean> {
  const count = await tx.userRole.count({
    where: { tenantId, userId, role: { code: OWNER_ROLE_CODE } },
  });
  return count > 0;
}

/**
 * Refuses with `IamError('ceiling')` unless the actor may confer `permissions`.
 *
 * - `permissions` — what the change would confer. Only additions: removing
 *   access is never capped, and a permission already on a role is not
 *   re-checked, so a delegate can still save a matrix row they did not build.
 * - `roleCode` — the role being edited or assigned; `TENANT_OWNER` is owner-only.
 * - `targetUserId` — the user whose grants change; an owner's grants are owner-only,
 *   whatever the effect, because a DENY is how a lockout would be done.
 *
 * The owner check comes first so the refusal names the real reason: a delegate
 * emptying the owner role adds nothing and would otherwise pass the ceiling.
 */
export async function assertCanConfer(
  tx: TenantClient,
  tenantId: string,
  actorUserId: string,
  change: { permissions: readonly string[]; roleCode?: string | undefined; targetUserId?: string | undefined },
): Promise<void> {
  const actor = await authorityOf(tx, tenantId, actorUserId);
  if (actor.isOwner) return;

  const touchesOwner =
    change.roleCode === OWNER_ROLE_CODE ||
    (change.targetUserId !== undefined && (await holdsOwnerRole(tx, tenantId, change.targetUserId)));
  if (touchesOwner) {
    throw new IamError('Only the tenant owner may change the owner role or an owner\'s access', 'ceiling', {
      role: [OWNER_ROLE_CODE],
    });
  }

  const lacking = [...new Set(change.permissions)].filter((code) => !actor.held.has(code)).sort();
  if (lacking.length > 0) {
    throw new IamError(`Cannot confer permissions you do not hold: ${lacking.join(', ')}`, 'ceiling', {
      permissions: lacking,
    });
  }
}
