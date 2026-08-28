import type { TenantClient } from '@hrms/db';

/**
 * Modul yang aktif untuk tenant, termasuk modul CORE yang tidak dapat
 * dinonaktifkan siapa pun.
 */
export async function listTenantModules(
  tx: TenantClient,
  tenantId: string,
): Promise<string[]> {
  const [enabled, core, tenant] = await Promise.all([
    tx.tenantModule.findMany({
      where: { tenantId, status: 'ENABLED' },
      select: { moduleCode: true },
    }),
    tx.module.findMany({ where: { isCore: true }, select: { code: true } }),
    tx.tenant.findFirst({
      where: { id: tenantId },
      select: { plan: { select: { modules: { select: { moduleCode: true } } } } },
    }),
  ]);

  // Irisan paket dan status aktif. Lihat penjelasan lengkapnya di
  // `resolve-access.ts`: membaca status saja membuat penurunan paket tidak
  // mencabut apa pun.
  const inPlan = new Set(tenant?.plan?.modules.map((m) => m.moduleCode) ?? []);

  return [
    ...new Set([
      ...core.map((m) => m.code),
      ...enabled.map((m) => m.moduleCode).filter((code) => inPlan.has(code)),
    ]),
  ].sort();
}

export async function isModuleEnabled(
  tx: TenantClient,
  tenantId: string,
  moduleCode: string,
): Promise<boolean> {
  const mod = await tx.module.findUnique({
    where: { code: moduleCode },
    select: { isCore: true },
  });
  if (!mod) return false;
  if (mod.isCore) return true;

  const [row, tenant] = await Promise.all([
    tx.tenantModule.findUnique({
      where: { tenantId_moduleCode: { tenantId, moduleCode } },
      select: { status: true },
    }),
    tx.tenant.findFirst({
      where: { id: tenantId },
      select: { plan: { select: { modules: { select: { moduleCode: true } } } } },
    }),
  ]);

  const inPlan = (tenant?.plan?.modules ?? []).some((m) => m.moduleCode === moduleCode);
  return row?.status === 'ENABLED' && inPlan;
}
