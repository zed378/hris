import { EventTopic } from '@hrms/contracts';
import { publishEvent, writeAudit, type TenantClient } from '@hrms/db';

/**
 * Self-service module activation and deactivation (PLAN/12 P6).
 *
 * The property carrying the whole weight of the Phase 6 DoD:
 *
 *   **Disabling a module hides its menu and refuses its API, but the DATA STAYS
 *   INTACT and returns when it is enabled again.**
 *
 * So disabling writes a `DISABLED` status rather than deleting the row — and it
 * never touches one of that module's tables. This is rule M4 of document 09 (no
 * data deletion in production) applied to the case easiest to get wrong: a
 * customer who stops subscribing to attendance for three months and then comes
 * back must find their entire attendance history still there.
 *
 * The opposite failure — deleting data when a module is disabled — cannot be
 * undone, is invisible until the customer returns, and almost certainly ends the
 * relationship with that customer.
 */

export class SubscriptionError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'core_module' | 'not_in_plan' | 'has_dependents',
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

export interface ModuleState {
  code: string;
  name: string;
  description: string | null;
  tier: string;
  isCore: boolean;
  sortOrder: number;
  /** Enabled for this tenant right now. */
  enabled: boolean;
  /** Included in the subscribed plan. */
  inPlan: boolean;
  /** Was enabled before — its data is still there if it is enabled again. */
  hasData: boolean;
  disabledAt: string | null;
}

/**
 * Inter-module dependencies.
 *
 * Payroll reads the attendance and unpaid leave recaps. Disabling attendance
 * while payroll is still enabled would produce payslips counting zero days
 * present for everyone — a figure that looks like a decision, and one only
 * discovered after the salaries have been paid.
 */
const REQUIRES: Record<string, string[]> = {
  payroll: ['attendance'],
};

export async function listModules(
  tx: TenantClient,
  tenantId: string,
): Promise<ModuleState[]> {
  const [modules, subscribed, tenant] = await Promise.all([
    tx.module.findMany({ orderBy: { sortOrder: 'asc' } }),
    tx.tenantModule.findMany({ where: { tenantId } }),
    tx.tenant.findFirst({
      where: { id: tenantId },
      select: {
        planCode: true,
        plan: { select: { modules: { select: { moduleCode: true } } } },
      },
    }),
  ]);

  const byCode = new Map(subscribed.map((row) => [row.moduleCode, row]));
  const planModules = new Set((tenant?.plan?.modules ?? []).map((m) => m.moduleCode));

  return modules.map((module) => {
    const row = byCode.get(module.code);
    return {
      code: module.code,
      name: module.name,
      description: module.description,
      tier: module.tier,
      isCore: module.isCore,
      sortOrder: module.sortOrder,
      // `enabled` is the EFFECTIVE state: enabled by the tenant AND included in
      // the plan. A module whose row is ENABLED but is outside the plan is shown
      // as disabled, because that is what its users experience — and the
      // `inPlan: false` beside it explains why.
      enabled:
        module.isCore || (row?.status === 'ENABLED' && planModules.has(module.code)),
      inPlan: module.isCore || planModules.has(module.code),
      // An existing row means that module was once enabled, and its data is still
      // in place. Shown so whoever re-enables it knows they will find their data
      // rather than starting from nothing.
      hasData: row !== undefined,
      disabledAt: row?.disabledAt?.toISOString() ?? null,
    };
  });
}

export interface ToggleResult {
  code: string;
  enabled: boolean;
  /** True when previous data was found and restored. */
  dataRestored: boolean;
}

export async function setModuleEnabled(
  tx: TenantClient,
  tenantId: string,
  moduleCode: string,
  enabled: boolean,
  actorUserId: string,
): Promise<ToggleResult> {
  const module = await tx.module.findUnique({ where: { code: moduleCode } });
  if (!module) {
    throw new SubscriptionError(`Modul "${moduleCode}" tidak dikenal.`, 'not_found');
  }

  if (module.isCore) {
    throw new SubscriptionError(
      `Modul "${module.name}" adalah bagian inti sistem dan tidak dapat dinonaktifkan.`,
      'core_module',
    );
  }

  const existing = await tx.tenantModule.findUnique({
    where: { tenantId_moduleCode: { tenantId, moduleCode } },
  });

  if (enabled) {
    const tenant = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: { plan: { select: { modules: { select: { moduleCode: true } } } } },
    });
    const planModules = new Set((tenant?.plan?.modules ?? []).map((m) => m.moduleCode));

    if (!planModules.has(moduleCode)) {
      throw new SubscriptionError(
        `Modul "${module.name}" tidak termasuk paket langganan Anda. ` +
          'Naikkan paket terlebih dahulu.',
        'not_in_plan',
      );
    }

    // A prerequisite is enabled first rather than refused. Someone enabling
    // payroll wants payroll; making them guess that attendance has to be turned
    // on first adds a step without adding clarity.
    for (const required of REQUIRES[moduleCode] ?? []) {
      const requiredRow = await tx.tenantModule.findUnique({
        where: { tenantId_moduleCode: { tenantId, moduleCode: required } },
      });
      if (requiredRow?.status !== 'ENABLED' && planModules.has(required)) {
        await tx.tenantModule.upsert({
          where: { tenantId_moduleCode: { tenantId, moduleCode: required } },
          create: { tenantId, moduleCode: required, status: 'ENABLED' },
          update: { status: 'ENABLED', disabledAt: null },
        });
      }
    }

    await tx.tenantModule.upsert({
      where: { tenantId_moduleCode: { tenantId, moduleCode } },
      create: { tenantId, moduleCode, status: 'ENABLED' },
      update: { status: 'ENABLED', disabledAt: null },
    });
  } else {
    // Other modules depending on it are disabled with it, and that is said in an
    // error rather than done silently. Quietly switching off attendance while
    // payroll is still enabled would produce payslips counting zero days present
    // for everyone.
    const dependents = Object.entries(REQUIRES)
      .filter(([, requires]) => requires.includes(moduleCode))
      .map(([code]) => code);

    // What is checked is the EFFECTIVE state, not the row's status.
    //
    // A module whose row is ENABLED but is outside the plan already does nothing.
    // Letting it block the disabling of another module means the tenant is held
    // up by something they cannot even use — and the error message would tell
    // them to disable a module their screen already shows as disabled.
    // tertulis nonaktif.
    const tenantForDeps = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: { plan: { select: { modules: { select: { moduleCode: true } } } } },
    });
    const dependentInPlan = new Set(
      (tenantForDeps?.plan?.modules ?? []).map((m) => m.moduleCode),
    );

    for (const dependent of dependents) {
      const row = await tx.tenantModule.findUnique({
        where: { tenantId_moduleCode: { tenantId, moduleCode: dependent } },
        select: { status: true },
      });
      if (row?.status === 'ENABLED' && dependentInPlan.has(dependent)) {
        const dependentModule = await tx.module.findUnique({
          where: { code: dependent },
          select: { name: true },
        });
        throw new SubscriptionError(
          `Modul "${dependentModule?.name ?? dependent}" membutuhkan "${module.name}". ` +
            `Nonaktifkan "${dependentModule?.name ?? dependent}" terlebih dahulu.`,
          'has_dependents',
        );
      }
    }

    // A DISABLED status, not a deleted row. Its data is not touched at all.
    await tx.tenantModule.upsert({
      where: { tenantId_moduleCode: { tenantId, moduleCode } },
      create: { tenantId, moduleCode, status: 'DISABLED', disabledAt: new Date() },
      update: { status: 'DISABLED', disabledAt: new Date() },
    });
  }

  await writeAudit(tx, tenantId, {
    action: enabled ? 'tenant.module.enabled' : 'tenant.module.disabled',
    entityType: 'tenant_module',
    entityId: tenantId,
    actorUserId,
    before: { status: existing?.status ?? 'NONE' },
    after: { moduleCode, status: enabled ? 'ENABLED' : 'DISABLED' },
  });

  await publishEvent(tx, tenantId, {
    topic: enabled ? EventTopic.TENANT_MODULE_ENABLED : EventTopic.TENANT_MODULE_DISABLED,
    payload: { tenantId, moduleCode, enabled },
  });

  return {
    code: moduleCode,
    enabled,
    // A row that already existed means this module was once enabled, so
    // re-enabling it restores the data rather than starting from nothing.
    dataRestored: enabled && existing !== null && existing.status === 'DISABLED',
  };
}
