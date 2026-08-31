import { platformClient } from '@hrms/db';

/**
 * Control plane operational capabilities (PLAN/07 §4.5).
 *
 * The rule binding this whole file: **metadata and aggregates only, never
 * personal data.** A superuser may know a tenant has 250 users; they must not
 * know one of their names, emails, or salaries.
 *
 * That line is more than an intention. In the distributed design `platform_db`
 * has no credentials to a domain database at all; here its equivalent is the
 * scope of this file plus the schema grant separation. If someone later adds a
 * read of personal data here, that has to be a change plainly visible at review
 * — which is why this file is short and exports nothing generic.
 */

export interface TenantSummary {
  id: string;
  code: string;
  name: string;
  status: string;
  planCode: string;
  trialEndsAt: string | null;
  createdAt: string;
  moduleCount: number;
  userCount: number;
}

/**
 * The tenant list for the global dashboard.
 *
 * The user count comes from `platform.tenant_user_counts()`, not from `_count`
 * on the `users` relation. The difference is not style: the relation would
 * require SELECT on `auth.users`, and that right hands over the whole table's
 * contents. The function returns a number, and only a number.
 *
 * It was tried the wrong way first, and PostgreSQL refused it because
 * `hrms_platform` genuinely holds no such grant — a separation that refuses
 * itself when violated is far more useful than a comment reminding someone.
 */
export async function listTenants(options: {
  limit?: number;
  offset?: number;
  status?: string;
}): Promise<{ tenants: TenantSummary[]; total: number }> {
  const db = platformClient();
  const where = options.status ? { status: options.status as never } : {};

  const [rows, total] = await Promise.all([
    db.tenant.findMany({
      where,
      take: Math.min(options.limit ?? 50, 200),
      skip: options.offset ?? 0,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        planCode: true,
        trialEndsAt: true,
        createdAt: true,
        _count: { select: { modules: true } },
      },
    }),
    db.tenant.count({ where }),
  ]);

  const counts = new Map(
    (
      await db.$queryRaw<Array<{ tenant_id: string; user_count: bigint }>>`
        SELECT * FROM platform.tenant_user_counts()
      `
    ).map((r) => [r.tenant_id, Number(r.user_count)]),
  );

  return {
    total,
    tenants: rows.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      status: t.status,
      planCode: t.planCode,
      trialEndsAt: t.trialEndsAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      moduleCount: t._count.modules,
      userCount: counts.get(t.id) ?? 0,
    })),
  };
}

/**
 * The platform summary.
 *
 * The anonymity threshold is not relevant here because every figure is
 * cross-tenant. It becomes relevant the moment there is a per-tenant aggregate
 * derived from employee data — and at that point the 5-subject threshold
 * (PLAN/07 §4.4) has to be fitted before the widget ships, not after.
 */
export async function platformOverview(): Promise<{
  tenants: Record<string, number>;
  totalTenants: number;
  totalUsers: number;
  modulesInUse: Array<{ moduleCode: string; tenants: number }>;
}> {
  const db = platformClient();

  const [byStatus, userCounts, byModule] = await Promise.all([
    db.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
    db.$queryRaw<Array<{ user_count: bigint }>>`SELECT user_count FROM platform.tenant_user_counts()`,
    db.tenantModule.groupBy({
      by: ['moduleCode'],
      where: { status: 'ENABLED' },
      _count: { _all: true },
    }),
  ]);

  const tenants: Record<string, number> = {};
  let totalTenants = 0;
  for (const row of byStatus) {
    tenants[row.status] = row._count._all;
    totalTenants += row._count._all;
  }

  return {
    tenants,
    totalTenants,
    totalUsers: userCounts.reduce((sum, r) => sum + Number(r.user_count), 0),
    modulesInUse: byModule
      .map((m) => ({ moduleCode: m.moduleCode, tenants: m._count._all }))
      .sort((a, b) => b.tenants - a.tenants),
  };
}

export class ModuleToggleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleToggleError';
  }
}

/**
 * Enables or disables one module for one tenant.
 *
 * Disabling writes a `DISABLED` status — the row is never deleted. That module's
 * menu disappears and its endpoints refuse with 402, but all of its data stays
 * intact and returns exactly as it was when it is enabled again.
 *
 * This is a Phase 6 DoD item, but the mechanism is fitted now because changing
 * it later means changing the meaning of a column that already holds data.
 */
export async function setTenantModule(input: {
  tenantId: string;
  moduleCode: string;
  enabled: boolean;
  actorSuperuserId: string;
}): Promise<{ moduleCode: string; status: string }> {
  const db = platformClient();

  const mod = await db.module.findUnique({
    where: { code: input.moduleCode },
    select: { isCore: true },
  });
  if (!mod) throw new ModuleToggleError(`Modul "${input.moduleCode}" tidak dikenal`);
  if (mod.isCore && !input.enabled) {
    throw new ModuleToggleError(`Modul inti "${input.moduleCode}" tidak dapat dinonaktifkan`);
  }

  const now = new Date();
  const row = await db.tenantModule.upsert({
    where: { tenantId_moduleCode: { tenantId: input.tenantId, moduleCode: input.moduleCode } },
    create: {
      tenantId: input.tenantId,
      moduleCode: input.moduleCode,
      status: input.enabled ? 'ENABLED' : 'DISABLED',
      enabledAt: input.enabled ? now : null,
      disabledAt: input.enabled ? null : now,
    },
    // Only the relevant timestamp is touched. Writing `null` to the other side
    // would erase history: when this module was previously active is a question
    // that gets asked during a billing dispute.
    update: input.enabled
      ? { status: 'ENABLED' as const, enabledAt: now }
      : { status: 'DISABLED' as const, disabledAt: now },
    select: { moduleCode: true, status: true },
  });

  // A superuser action is recorded in the platform trail, not the tenant audit:
  // its actor is not a tenant user, and mixing them would fill the tenant's audit
  // with actors they cannot recognise.
  await db.$executeRaw`
    INSERT INTO platform.platform_audit_logs (superuser_id, action, target_type, target_id, detail)
    VALUES (${input.actorSuperuserId}::uuid, ${'tenant.module.' + (input.enabled ? 'enabled' : 'disabled')},
            'tenant', ${input.tenantId}, ${JSON.stringify({ moduleCode: input.moduleCode })}::jsonb)
  `;

  return row;
}

export class TenantStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantStatusError';
  }
}

export type TenantLifecycleStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CHURNED';

/**
 * Changes one tenant's lifecycle status.
 *
 * `SUSPENDED` and `CHURNED` have been **checked from the start** on login, token
 * refresh, and password reset requests — all of it fail-closed and correct. What
 * was missing was **any path that produces those statuses.** Both were enum
 * values with no producer, the same pattern as `LEAVE`, `MANUAL`, `DISCARDED`,
 * and the leave accrual methods.
 *
 * The consequence lands directly on the commercial side: a customer who stops
 * paying **cannot be deactivated**. The entire subscription machinery — plans,
 * entitlement, the 14-day trial, the per-module 402 — works, but there is no
 * final switch stopping access when the bill goes unpaid. The same for a
 * customer requesting termination: `CHURNED` was unreachable, so the request
 * could only be met by deleting data — an irreversible act, and not the one
 * that was asked for.
 *
 * ## What is deliberately NOT done
 *
 * **Nothing is deleted.** Suspension is a state, not a deletion. A customer who
 * pays their arrears on the third day must find all of their data intact — and a
 * customer who never returns still has a right to their portability export.
 * portabilitasnya.
 *
 * **Sessions already running are not force-revoked.** An access token already
 * issued stays valid until it expires; login and refresh are refused from this
 * second on. The window is as wide as an access token's lifetime, and that is
 * accepted: forced revocation demands a revocation list read on every request,
 * and that cost is borne by every customer who is never suspended.
 */
export async function setTenantStatus(input: {
  tenantId: string;
  status: TenantLifecycleStatus;
  /** The reason is mandatory. A suspension with no reason cannot be explained to the customer who calls. */
  reason: string;
  actorSuperuserId: string;
}): Promise<{ tenantId: string; status: string; previousStatus: string }> {
  const db = platformClient();

  const tenant = await db.tenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true, code: true, status: true },
  });
  if (!tenant) throw new TenantStatusError('Tenant tidak ditemukan');

  if (tenant.status === input.status) {
    throw new TenantStatusError(`Tenant sudah berstatus ${input.status}`);
  }

  const now = new Date();

  // A timestamp is only ever SET, never cleared.
  //
  // "When was this tenant suspended" is a question that gets asked during a
  // billing dispute, and reactivating is no reason to delete the answer.
  const stamps =
    input.status === 'SUSPENDED'
      ? { suspendedAt: now }
      : input.status === 'CHURNED'
        ? { churnedAt: now }
        : {};

  await db.tenant.update({
    where: { id: tenant.id },
    data: { status: input.status, ...stamps },
  });

  await db.$executeRaw`
    INSERT INTO platform.platform_audit_logs (superuser_id, action, target_type, target_id, detail)
    VALUES (${input.actorSuperuserId}::uuid, ${'tenant.status.' + input.status.toLowerCase()},
            'tenant', ${tenant.id},
            ${JSON.stringify({
              from: tenant.status,
              to: input.status,
              reason: input.reason,
              tenantCode: tenant.code,
            })}::jsonb)
  `;

  return { tenantId: tenant.id, status: input.status, previousStatus: tenant.status };
}

export interface TenantDetail extends TenantSummary {
  suspendedAt: string | null;
  churnedAt: string | null;
  /** Every catalogue module, with its state for this tenant. */
  modules: Array<{
    code: string;
    name: string;
    tier: string;
    isCore: boolean;
    /** Included in the plan this tenant subscribes to. */
    inPlan: boolean;
    /** Enabled by the tenant. Core modules are always enabled. */
    enabled: boolean;
  }>;
}

/**
 * One tenant with the state of all of its modules.
 *
 * What is returned is the **full catalogue**, not only the enabled modules. A
 * screen that receives only enabled modules cannot offer the ones that are not
 * — and enabling a module is the only reason that screen is ever opened.
 *
 * `inPlan` and `enabled` are separated because they genuinely differ, and the
 * difference decides what the tenant sees: entitlement is the **intersection**
 * of the two (see `resolveEffectiveAccess`). A module that is enabled but
 * outside the plan refuses with 402, and without this separation a superuser
 * seeing "enabled" would not understand why their customer is still refused.
 */
export async function tenantDetail(tenantId: string): Promise<TenantDetail | null> {
  const db = platformClient();

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      planCode: true,
      trialEndsAt: true,
      createdAt: true,
      suspendedAt: true,
      churnedAt: true,
      modules: { select: { moduleCode: true, status: true } },
    },
  });
  if (!tenant) return null;

  const [catalogModules, plan, counts] = await Promise.all([
    db.module.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { code: true, name: true, tier: true, isCore: true },
    }),
    db.plan.findUnique({
      where: { code: tenant.planCode },
      select: { modules: { select: { moduleCode: true } } },
    }),
    db.$queryRaw<Array<{ tenant_id: string; user_count: bigint }>>`
      SELECT * FROM platform.tenant_user_counts()
    `,
  ]);

  const enabled = new Set(
    tenant.modules.filter((m) => m.status === 'ENABLED').map((m) => m.moduleCode),
  );
  const inPlan = new Set(plan?.modules.map((m) => m.moduleCode) ?? []);
  const userCount = Number(counts.find((c) => c.tenant_id === tenant.id)?.user_count ?? 0);

  return {
    id: tenant.id,
    code: tenant.code,
    name: tenant.name,
    status: tenant.status,
    planCode: tenant.planCode,
    trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null,
    createdAt: tenant.createdAt.toISOString(),
    suspendedAt: tenant.suspendedAt?.toISOString() ?? null,
    churnedAt: tenant.churnedAt?.toISOString() ?? null,
    moduleCount: enabled.size,
    userCount,
    modules: catalogModules.map((module) => ({
      code: module.code,
      name: module.name,
      tier: module.tier,
      isCore: module.isCore,
      inPlan: module.isCore || inPlan.has(module.code),
      enabled: module.isCore || enabled.has(module.code),
    })),
  };
}
