import { EventTopic } from '@hrms/contracts';
import { publishEvent, writeAudit, type TenantClient } from '@hrms/db';

/**
 * Aktivasi dan penonaktifan modul secara mandiri (PLAN/12 F6).
 *
 * Sifat yang menanggung seluruh beban DoD Fase 6:
 *
 *   **Menonaktifkan modul menyembunyikan menu dan menolak API-nya, tetapi DATA
 *   TETAP UTUH dan pulih saat diaktifkan kembali.**
 *
 * Karena itu penonaktifan menulis status `DISABLED`, bukan menghapus baris —
 * dan tidak pernah menyentuh satu pun tabel modulnya. Ini penerapan aturan M4
 * dokumen 09 (tidak ada penghapusan data di produksi) pada kasus yang paling
 * mudah salah: pelanggan yang berhenti berlangganan presensi selama tiga bulan
 * lalu kembali harus menemukan seluruh riwayat presensinya masih ada.
 *
 * Kegagalan sebaliknya — menghapus data saat modul dinonaktifkan — tidak dapat
 * dipulihkan, tidak terlihat sampai pelanggan kembali, dan hampir pasti
 * mengakhiri hubungan dengan pelanggan itu.
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
  /** Aktif untuk tenant ini saat ini. */
  enabled: boolean;
  /** Termasuk dalam paket yang dilanggan. */
  inPlan: boolean;
  /** Pernah aktif sebelumnya — datanya masih ada bila diaktifkan kembali. */
  hasData: boolean;
  disabledAt: string | null;
}

/**
 * Ketergantungan antarmodul.
 *
 * Penggajian membaca rekap presensi dan cuti tanpa gaji. Menonaktifkan presensi
 * sementara penggajian masih aktif akan menghasilkan slip yang menghitung nol
 * hari hadir untuk semua orang — angka yang terlihat seperti keputusan, dan
 * yang baru ketahuan setelah gaji dibayarkan.
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
      // `enabled` adalah keadaan EFEKTIF: diaktifkan tenant DAN termasuk paket.
      // Modul yang barisnya ENABLED tetapi di luar paket ditampilkan nonaktif,
      // karena memang itulah yang dialami penggunanya — dan `inPlan: false` di
      // sebelahnya menjelaskan mengapa.
      enabled:
        module.isCore || (row?.status === 'ENABLED' && planModules.has(module.code)),
      inPlan: module.isCore || planModules.has(module.code),
      // Baris yang pernah ada berarti modul itu pernah aktif, dan datanya masih
      // di tempatnya. Ditampilkan supaya orang yang mengaktifkan kembali tahu
      // ia akan menemukan datanya, bukan memulai dari kosong.
      hasData: row !== undefined,
      disabledAt: row?.disabledAt?.toISOString() ?? null,
    };
  });
}

export interface ToggleResult {
  code: string;
  enabled: boolean;
  /** True bila data sebelumnya ditemukan dan dipulihkan. */
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

    // Prasyarat diaktifkan lebih dulu, bukan ditolak. Orang yang mengaktifkan
    // penggajian menginginkan penggajian; memaksanya menebak bahwa presensi
    // harus dinyalakan dulu hanya menambah langkah tanpa menambah kejelasan.
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
    // Modul lain yang bergantung padanya ikut dinonaktifkan, dan itu dikatakan
    // lewat galat alih-alih dilakukan diam-diam. Mematikan presensi diam-diam
    // ketika penggajian masih aktif akan menghasilkan slip yang menghitung nol
    // hari hadir untuk semua orang.
    const dependents = Object.entries(REQUIRES)
      .filter(([, requires]) => requires.includes(moduleCode))
      .map(([code]) => code);

    // Yang diperiksa keadaan EFEKTIF, bukan status baris.
    //
    // Modul yang barisnya ENABLED tetapi di luar paket sudah tidak berfungsi
    // apa pun. Membiarkannya memblokir penonaktifan modul lain berarti tenant
    // terhalang oleh sesuatu yang bahkan tidak dapat ia pakai — dan pesan
    // galatnya akan menyuruh ia menonaktifkan modul yang di layarnya sudah
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

    // Status DISABLED, bukan baris dihapus. Datanya tidak disentuh sama sekali.
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
    // Baris yang sudah ada sebelumnya berarti modul ini pernah aktif, sehingga
    // mengaktifkannya kembali memulihkan data — bukan memulai dari kosong.
    dataRestored: enabled && existing !== null && existing.status === 'DISABLED',
  };
}
