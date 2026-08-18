import type { TenantClient } from '@hrms/db';

/**
 * Modul yang aktif untuk tenant, termasuk modul CORE yang tidak dapat
 * dinonaktifkan siapa pun.
 */
export async function listTenantModules(
  tx: TenantClient,
  tenantId: string,
): Promise<string[]> {
  const [enabled, core] = await Promise.all([
    tx.tenantModule.findMany({
      where: { tenantId, status: 'ENABLED' },
      select: { moduleCode: true },
    }),
    tx.module.findMany({ where: { isCore: true }, select: { code: true } }),
  ]);

  return [...new Set([...core.map((m) => m.code), ...enabled.map((m) => m.moduleCode)])].sort();
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

  const row = await tx.tenantModule.findUnique({
    where: { tenantId_moduleCode: { tenantId, moduleCode } },
    select: { status: true },
  });
  return row?.status === 'ENABLED';
}
