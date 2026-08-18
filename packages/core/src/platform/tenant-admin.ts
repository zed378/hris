import { platformClient } from '@hrms/db';

/**
 * Kemampuan operasional control plane (PLAN/07 §4.5).
 *
 * Aturan yang mengikat seluruh berkas ini: **hanya metadata dan agregat, tidak
 * pernah data pribadi.** Superuser boleh tahu sebuah tenant punya 250 pengguna;
 * ia tidak boleh tahu satu pun nama, email, atau gaji mereka.
 *
 * Garis itu bukan sekadar niat. `platform_db` pada rancangan terdistribusi tidak
 * punya kredensial ke basis data domain sama sekali; di sini padanannya adalah
 * cakupan berkas ini ditambah pemisahan hak akses schema. Bila kelak ada yang
 * menambahkan pembacaan data pribadi ke sini, itu perubahan yang harus terlihat
 * jelas saat review — dan itulah sebabnya berkas ini pendek dan tidak mengekspor
 * apa pun yang generik.
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
 * Daftar tenant untuk dashboard global.
 *
 * Jumlah pengguna diambil lewat `platform.tenant_user_counts()`, bukan dengan
 * meng-`_count` relasi `users`. Selisihnya bukan gaya: relasi akan menuntut
 * SELECT pada `auth.users`, dan hak itu memberi seluruh isi tabelnya sekaligus.
 * Fungsi tersebut mengembalikan angka, dan hanya angka.
 *
 * Dicoba lebih dulu dengan cara yang keliru, lalu ditolak PostgreSQL karena
 * `hrms_platform` memang tidak memiliki hibahnya — pemisahan yang menolak dirinya
 * sendiri saat dilanggar jauh lebih berguna daripada komentar yang mengingatkan.
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
 * Ringkasan platform.
 *
 * Ambang anonimitas belum relevan di sini karena seluruh angkanya lintas tenant.
 * Ia akan menjadi relevan begitu ada agregat per tenant yang berasal dari data
 * karyawan — dan pada saat itu ambang 5 subjek (PLAN/07 §4.4) harus dipasang
 * sebelum widget-nya dirilis, bukan sesudah.
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
 * Mengaktifkan atau menonaktifkan satu modul untuk satu tenant.
 *
 * Menonaktifkan menulis status `DISABLED` — barisnya tidak pernah dihapus.
 * Akibatnya menu modul itu menghilang dan endpoint-nya menolak dengan 402,
 * tetapi seluruh datanya tetap utuh dan kembali persis saat diaktifkan lagi.
 *
 * Ini butir DoD Fase 6, tetapi mekanismenya dipasang sekarang karena mengubahnya
 * belakangan berarti mengubah arti kolom yang sudah berisi data.
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
    // Hanya stempel waktu yang relevan yang disentuh. Menulis `null` ke sisi
    // lain akan menghapus riwayat: kapan modul ini pernah aktif sebelumnya
    // adalah pertanyaan yang akan ditanyakan saat ada sengketa tagihan.
    update: input.enabled
      ? { status: 'ENABLED' as const, enabledAt: now }
      : { status: 'DISABLED' as const, disabledAt: now },
    select: { moduleCode: true, status: true },
  });

  // Aksi superuser dicatat di jejak platform, bukan di audit tenant: pelakunya
  // bukan pengguna tenant, dan mencampurnya akan membuat audit tenant memuat
  // aktor yang tidak dapat mereka kenali.
  await db.$executeRaw`
    INSERT INTO platform.platform_audit_logs (superuser_id, action, target_type, target_id, detail)
    VALUES (${input.actorSuperuserId}::uuid, ${'tenant.module.' + (input.enabled ? 'enabled' : 'disabled')},
            'tenant', ${input.tenantId}, ${JSON.stringify({ moduleCode: input.moduleCode })}::jsonb)
  `;

  return row;
}
