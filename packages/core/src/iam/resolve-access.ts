import type { TenantClient } from '@hrms/db';
import type { MenuNode } from '@hrms/contracts';

export interface EffectiveAccess {
  /** Modul yang aktif untuk tenant, termasuk modul CORE yang selalu aktif. */
  modules: string[];
  /** Permission setelah seluruh presedensi diterapkan dan disaring langganan. */
  permissions: string[];
  accessVersion: number;
}

/**
 * Menghitung akses efektif satu pengguna (PLAN/05 §4).
 *
 * Presedensinya, berurutan — dan urutannya menentukan hasil:
 *
 *   1. Gabungan permission dari seluruh peran yang dimiliki pengguna.
 *   2. Ditambah GRANT per pengguna yang belum kedaluwarsa.
 *   3. Dikurangi DENY per pengguna. **DENY selalu menang** — atas peran maupun
 *      atas GRANT. Bila tidak demikian, mencabut akses satu orang mengharuskan
 *      penelusuran seluruh perannya, dan pencabutan darurat menjadi tidak andal.
 *   4. Disaring langganan: permission milik modul yang tidak aktif gugur.
 *
 * Langkah 4 adalah P8 — "langganan mengalahkan peran". Konsekuensinya penting:
 * saat tenant berhenti melanggan payroll, tidak ada peran yang perlu diubah dan
 * tidak ada yang perlu diingat untuk dicabut. Izinnya gugur dengan sendirinya,
 * dan pulih utuh saat modulnya diaktifkan kembali.
 *
 * Grant kedaluwarsa diabaikan di sini, bukan dihapus. Barisnya tetap ada agar
 * access review dapat menjawab "siapa pernah punya akses apa, dan mengapa".
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
      // Modul yang termasuk paket yang dilanggan tenant SAAT INI.
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
   * Entitlement adalah IRISAN antara "diaktifkan tenant" dan "termasuk paket".
   *
   * Membaca `TenantModule.status` saja tidak cukup, dan celahnya bernilai uang:
   * tenant yang menurunkan paketnya dari Basic ke Starter tetap memegang baris
   * `payroll` berstatus ENABLED dari masa langganan sebelumnya, sehingga ia
   * terus memakai penggajian tanpa membayarnya. Tidak ada galat yang muncul —
   * satu-satunya yang berubah adalah tagihannya.
   *
   * Perpotongan ini membuat penurunan paket berlaku seketika tanpa perlu ada
   * proses rekonsiliasi yang harus diingat orang untuk dijalankan.
   *
   * Modul CORE selalu masuk, apa pun paketnya: tanpa `core` dan `iam`, tenant
   * tidak dapat masuk ke sistemnya sendiri untuk memperbaiki langganannya.
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

  // 3 — DENY menang, diterapkan setelah semua penambahan.
  for (const grant of grants) {
    if (grant.effect === 'DENY') granted.delete(grant.permissionCode);
  }

  // 4 — saring langganan. Permission milik modul tak dikenal ikut gugur:
  // itu keadaan yang seharusnya mustahil, dan gagal-tertutup adalah pilihan aman.
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
 * Merakit pohon menu yang terlihat pengguna.
 *
 * Aturannya dua, dan yang kedua sering terlupa:
 *   - Item dengan `permissionCode` tampil hanya bila pengguna memegangnya.
 *   - Item grup (tanpa permission dan tanpa path) tampil hanya bila ada anaknya
 *     yang tampil. Tanpa aturan ini, sidebar dipenuhi grup kosong yang saat
 *     diklik tidak membuka apa pun.
 *
 * Ini kenyamanan, bukan otorisasi. Gateway memeriksa permission yang sama secara
 * mandiri — menyembunyikan menu tanpa menolak endpoint-nya bukan keamanan (P9).
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
 * Menaikkan versi akses pengguna, **dalam transaksi yang sama** dengan perubahan
 * peran atau grant yang memicunya.
 *
 * Bila dipisah, ada jendela di mana akses sudah berubah tetapi cache masih
 * menyajikan yang lama — dan jendela itu paling mungkin terbuka justru saat
 * seseorang sedang mencabut akses dengan tergesa (PLAN/05 §5.3).
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
