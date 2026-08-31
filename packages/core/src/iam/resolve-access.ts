import type { TenantClient } from '@hrms/db';
import type { MenuNode } from '@hrms/contracts';

export interface EffectiveAccess {
  /** The modules enabled for the tenant, CORE modules included as always enabled. */
  modules: string[];
  /** Permissions after every precedence rule and the subscription filter. */
  permissions: string[];
  accessVersion: number;
}

/**
 * Computes one user's effective access (PLAN/05 §4).
 *
 * Its precedence, in order — and the order decides the result:
 *
 *   1. The union of permissions from every role the user holds.
 *   2. Plus per-user GRANTs that have not expired.
 *   3. Minus per-user DENYs. **DENY always wins** — over roles and over GRANTs.
 *      Otherwise, revoking one person's access would require tracing every one
 *      of their roles, and an emergency revocation would be unreliable.
 *   4. Filtered by subscription: a permission belonging to a disabled module falls away.
 *
 * Step 4 is P8 — "a subscription beats a role". Its consequence matters: when a
 * tenant stops subscribing to payroll, no role needs changing and nothing needs
 * remembering to revoke. The permissions fall away by themselves, and return
 * intact when the module is enabled again.
 *
 * An expired grant is ignored here rather than deleted. Its row stays so an
 * access review can answer "who once had what access, and why".
 */
export async function resolveEffectiveAccess(
  tx: TenantClient,
  tenantId: string,
  userId: string,
): Promise<EffectiveAccess> {
  const now = new Date();

  const [enabledTenantModules, coreModules, planModules, userRoles, grants, accessVersion] =
    await Promise.all([
      tx.tenantModule.findMany({
        where: { tenantId, status: 'ENABLED' },
        select: { moduleCode: true },
      }),
      tx.module.findMany({ where: { isCore: true }, select: { code: true } }),
      // The modules included in the plan the tenant subscribes to RIGHT NOW.
      tx.tenant.findFirst({
        where: { id: tenantId },
        select: { plan: { select: { modules: { select: { moduleCode: true } } } } },
      }),
      tx.userRole.findMany({
        where: { userId },
        select: { role: { select: { permissions: { select: { permissionCode: true } } } } },
      }),
      tx.userPermissionGrant.findMany({
        where: {
          userId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { permissionCode: true, effect: true },
      }),
      tx.accessVersion.findUnique({ where: { userId }, select: { version: true } }),
    ]);

  /**
   * Entitlement is the INTERSECTION of "enabled by the tenant" and "included in the plan".
   *
   * Reading `TenantModule.status` alone is not enough, and the gap is worth
   * money: a tenant downgrading from Basic to Starter still holds an ENABLED
   * `payroll` row from their previous subscription, so they keep using payroll
   * without paying for it. No error appears — the only thing that changes is
   * their invoice.
   *
   * This intersection makes a downgrade take effect immediately, with no
   * reconciliation process anyone has to remember to run.
   *
   * CORE modules are always included, whatever the plan: without `core` and
   * `iam`, a tenant could not log into their own system to fix their
   */
  const inPlan = new Set(planModules?.plan?.modules.map((m) => m.moduleCode) ?? []);
  const modules = new Set<string>([
    ...coreModules.map((m) => m.code),
    ...enabledTenantModules.map((m) => m.moduleCode).filter((code) => inPlan.has(code)),
  ]);

  // 1 + 2
  const granted = new Set<string>();
  for (const { role } of userRoles) {
    for (const { permissionCode } of role.permissions) granted.add(permissionCode);
  }
  for (const grant of grants) {
    if (grant.effect === 'GRANT') granted.add(grant.permissionCode);
  }

  // 3 — DENY wins, applied after every addition.
  for (const grant of grants) {
    if (grant.effect === 'DENY') granted.delete(grant.permissionCode);
  }

  // 4 — filter by subscription. A permission belonging to an unknown module falls
  // away too: that state should be impossible, and failing closed is the safe choice.
  const owners = await tx.permission.findMany({
    where: { code: { in: [...granted] } },
    select: { code: true, moduleCode: true },
  });

  const permissions = owners
    .filter((p) => modules.has(p.moduleCode))
    .map((p) => p.code)
    .sort();

  return {
    modules: [...modules].sort(),
    permissions,
    accessVersion: accessVersion?.version ?? 0,
  };
}

/**
 * Assembles the menu tree the user sees.
 *
 * Two rules, and the second is often forgotten:
 *   - An item with a `permissionCode` appears only when the user holds it.
 *   - A group item (no permission and no path) appears only when one of its
 *     children appears. Without this rule the sidebar fills with empty groups
 *     that open nothing when clicked.
 *
 * This is convenience, not authorisation. The gateway checks the same permission
 * independently — hiding a menu without refusing its endpoint is not security (P9).
 */
export async function buildMenuTree(
  tx: TenantClient,
  access: EffectiveAccess,
): Promise<MenuNode[]> {
  const rows = await tx.menu.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    select: {
      id: true,
      code: true,
      label: true,
      parentId: true,
      moduleCode: true,
      permissionCode: true,
      path: true,
      icon: true,
    },
  });

  const permissions = new Set(access.permissions);
  const modules = new Set(access.modules);
  const childrenOf = new Map<string | null, typeof rows>();
  for (const row of rows) {
    const bucket = childrenOf.get(row.parentId) ?? [];
    bucket.push(row);
    childrenOf.set(row.parentId, bucket);
  }

  function build(parentId: string | null): MenuNode[] {
    const out: MenuNode[] = [];
    for (const row of childrenOf.get(parentId) ?? []) {
      if (!modules.has(row.moduleCode)) continue;
      if (row.permissionCode !== null && !permissions.has(row.permissionCode)) continue;

      const children = build(row.id);
      const isGroup = row.permissionCode === null && row.path === null;
      if (isGroup && children.length === 0) continue;

      out.push({
        code: row.code,
        label: row.label,
        path: row.path,
        icon: row.icon,
        moduleCode: row.moduleCode,
        children,
      });
    }
    return out;
  }

  return build(null);
}

/**
 * Raises a user's access version, **in the same transaction** as the role or
 * grant change that triggered it.
 *
 * Separated, there would be a window where access has changed but the cache
 * still serves the old value — and that window is most likely to open precisely
 * when somebody is revoking access in a hurry (PLAN/05 §5.3).
 */
export async function bumpAccessVersion(
  tx: TenantClient,
  tenantId: string,
  userId: string,
): Promise<number> {
  const row = await tx.accessVersion.upsert({
    where: { userId },
    create: { tenantId, userId, version: 1 },
    update: { version: { increment: 1 } },
    select: { version: true },
  });
  return row.version;
}
