import { randomUUID } from 'node:crypto';
import { withTenant, catalog, writeAudit, publishEvent, Prisma } from '@hrms/db';
import { DEFAULT_LEAVE_TYPES, DEFAULT_PAYROLL_COMPONENTS, EventTopic } from '@hrms/contracts';

/**
 * Provisioning tenant baru.
 *
 * Pada arsitektur microservices ini adalah saga lintas empat service dengan
 * kompensasi di setiap langkah (PLAN/06 §4.1): tenant-service membuat tenant,
 * auth-service membuat pengguna, iam-service membuat peran — dan bila langkah
 * ketiga gagal, dua langkah pertama harus dibatalkan lewat event kompensasi yang
 * ditulis, diuji, dan dipantau.
 *
 * Di sini ia satu transaksi ACID. Bila apa pun gagal, semuanya batal, dan tidak
 * ada tenant separuh jadi yang perlu dibersihkan manual.
 *
 * Ini keuntungan monolit yang paling nyata dan paling jarang dihitung: bukan
 * kode saga yang tidak perlu ditulis, melainkan kategori kegagalan yang tidak
 * perlu dipantau seumur produk (PLAN/12 §10.1, R12).
 *
 * Satu detail yang membuatnya benar-benar satu transaksi: **id tenant
 * dibangkitkan di aplikasi, bukan oleh basis data.** Kebijakan RLS pada
 * `tenant.tenants` berbunyi `id = app_current_tenant()`, sehingga baris tenant
 * baru tidak dapat disisipkan tanpa konteks — dan konteksnya tidak dapat dipasang
 * sebelum barisnya ada. Membangkitkan id lebih dulu memutus lingkaran itu: kita
 * pasang konteks ke id yang belum ada, lalu menyisipkan baris yang tepat
 * memenuhi kebijakannya.
 *
 * Versi pertama memecahnya dengan menyisipkan baris tenant di luar transaksi
 * lalu menghapusnya kembali bila langkah berikutnya gagal — satu langkah
 * kompensasi, persis jenis kode yang seharusnya tidak perlu ada pada monolit.
 */

/**
 * Peran sistem yang dibuat untuk setiap tenant baru.
 *
 * Definisinya sengaja hidup di sini, bukan di seed: seed adalah data
 * pengembangan, sedangkan ini adalah bagian dari produk. Tenant yang mendaftar
 * pukul tiga pagi harus mendapat peran yang sama persis dengan tenant demo.
 */
const SYSTEM_ROLES = [
  { code: 'TENANT_OWNER', name: 'Pemilik Akun', scope: 'all' as const },
  { code: 'HR_ADMIN', name: 'Admin HR', scope: 'hr' as const },
  { code: 'DEPT_HEAD', name: 'Kepala Departemen', scope: 'team' as const },
  { code: 'LINE_MANAGER', name: 'Manajer Lini', scope: 'team' as const },
  { code: 'EMPLOYEE', name: 'Karyawan', scope: 'self' as const },
];

/** Permission yang dipegang tiap cakupan peran, sebagai pola atas kode permission. */
const SCOPE_MATCHERS: Record<string, (code: string) => boolean> = {
  all: () => true,
  hr: (code) =>
    !code.startsWith('iam.role.manage') &&
    !code.startsWith('iam.grant.manage') &&
    !code.endsWith('.read.team') &&
    !code.startsWith('payroll.run.approve') &&
    !code.startsWith('payroll.statutory'),
  team: (code) =>
    code.endsWith('.own') ||
    code.endsWith('.team') ||
    code === 'leave.request.approve' ||
    code === 'core.dashboard.view.team',
  self: (code) => code.endsWith('.own'),
};

export class TenantCodeTakenError extends Error {
  constructor(code: string) {
    super(`Kode perusahaan "${code}" sudah dipakai`);
    this.name = 'TenantCodeTakenError';
  }
}

export interface ProvisionInput {
  tenantCode: string;
  companyName: string;
  ownerEmail: string;
  ownerFullName: string;
  /**
   * Sudah di-hash oleh pemanggil, bukan kata sandi mentah.
   *
   * Dua alasan. Pertama, `auth` sudah mengimpor `tenant` untuk resolusi kode saat
   * login; bila `tenant` mengimpor `auth` untuk hashing, keduanya menjadi siklus —
   * dapat berjalan di ESM, tetapi rapuh, dan pada saat pemecahan nanti berarti dua
   * service yang saling memanggil. Lapisan aplikasi adalah composition root, dan
   * di situlah keduanya seharusnya bertemu.
   *
   * Kedua, dan lebih penting: fungsi ini karenanya tidak pernah memegang kata
   * sandi mentah sama sekali.
   */
  ownerPasswordHash: string;
  planCode?: string;
}

export interface ProvisionResult {
  tenantId: string;
  tenantCode: string;
  ownerUserId: string;
  modules: string[];
  trialEndsAt: Date | null;
}

const TRIAL_DAYS = 14;

export async function provisionTenant(
  input: ProvisionInput,
  ctx: { ip?: string | undefined; correlationId?: string | undefined } = {},
): Promise<ProvisionResult> {
  const planCode = input.planCode ?? 'trial';
  const db = catalog();

  // Katalog dibaca di luar konteks tenant: tabel-tabel ini global dan tidak ber-RLS.
  const [plan, permissions] = await Promise.all([
    db.plan.findUnique({
      where: { code: planCode },
      select: { code: true, isActive: true, modules: { select: { moduleCode: true } } },
    }),
    db.permission.findMany({ select: { code: true } }),
  ]);

  if (!plan?.isActive) throw new Error(`Paket "${planCode}" tidak tersedia`);

  const trialEndsAt = planCode === 'trial' ? new Date(Date.now() + TRIAL_DAYS * 86_400_000) : null;
  const tenantId = randomUUID();

  // Keunikan kode tenant tidak diperiksa lebih dulu dengan SELECT, dan itu
  // disengaja. Pemeriksaan semacam itu tidak dapat melihat menembus RLS, dan
  // seandainya bisa pun ia tetap menyisakan celah balapan antara pemeriksaan dan
  // penyisipan. Constraint unique adalah satu-satunya pemeriksaan yang benar;
  // yang perlu kita lakukan adalah menerjemahkan galatnya.
  try {
    return await withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          id: tenantId,
          code: input.tenantCode,
          name: input.companyName,
          planCode,
          status: 'TRIAL',
          trialEndsAt,
        },
        select: { id: true, code: true },
      });

      const modules = plan.modules.map((m) => m.moduleCode);

      await tx.tenantModule.createMany({
        data: modules.map((moduleCode) => ({
          tenantId: tenant.id,
          moduleCode,
          status: 'ENABLED' as const,
          enabledAt: new Date(),
        })),
      });

      const roleIds = new Map<string, string>();
      for (const role of SYSTEM_ROLES) {
        const created = await tx.role.create({
          data: { tenantId: tenant.id, code: role.code, name: role.name, isSystem: true },
          select: { id: true },
        });
        roleIds.set(role.code, created.id);

        const matcher = SCOPE_MATCHERS[role.scope]!;
        const granted = permissions.filter((p) => matcher(p.code));
        await tx.rolePermission.createMany({
          data: granted.map((p) => ({
            tenantId: tenant.id,
            roleId: created.id,
            permissionCode: p.code,
          })),
        });
      }

      const owner = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: input.ownerEmail,
          fullName: input.ownerFullName,
          passwordHash: input.ownerPasswordHash,
          status: 'ACTIVE',
        },
        select: { id: true },
      });

      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: owner.id, roleId: roleIds.get('TENANT_OWNER')! },
      });
      await tx.accessVersion.create({
        data: { tenantId: tenant.id, userId: owner.id, version: 1 },
      });

      /**
       * Konfigurasi bawaan modul cuti dan payroll.
       *
       * Tanpa ini, tenant baru mendapati modul cuti aktif dengan daftar jenis
       * cuti KOSONG — tidak ada seorang pun yang dapat mengajukan cuti, dan yang
       * terlihat hanya dropdown tanpa pilihan — serta modul payroll yang setiap
       * slipnya bernilai nol rupiah karena tidak ada satu pun komponen.
       * Keduanya gagal tanpa galat, dan keduanya memblokir onboarding mandiri
       * pada hari pertama.
       *
       * Dibuat di dalam transaksi provisioning yang sama: tenant yang lahir
       * setengah terkonfigurasi adalah tenant yang tidak dapat dipakai, dan
       * memperbaikinya kemudian menuntut seseorang mengetahui bahwa ia perlu
       * diperbaiki.
       */
      await tx.leaveType.createMany({
        data: DEFAULT_LEAVE_TYPES.map((type) => ({ tenantId: tenant.id, ...type })),
      });

      await tx.payrollComponent.createMany({
        data: DEFAULT_PAYROLL_COMPONENTS.map((component) => ({
          tenantId: tenant.id,
          ...component,
        })),
      });

      await writeAudit(tx, tenant.id, {
        action: 'tenant.provisioned',
        entityType: 'tenant',
        entityId: tenant.id,
        actorUserId: owner.id,
        after: { code: tenant.code, planCode, modules },
        ip: ctx.ip,
        correlationId: ctx.correlationId,
      });

      await publishEvent(tx, tenant.id, {
        topic: EventTopic.TENANT_PROVISIONED,
        payload: {
          tenantId: tenant.id,
          tenantCode: tenant.code,
          planCode,
          ownerUserId: owner.id,
        },
        correlationId: ctx.correlationId,
      });

      return {
        tenantId: tenant.id,
        tenantCode: tenant.code,
        ownerUserId: owner.id,
        modules: modules.sort(),
        trialEndsAt,
      };
    });
  } catch (error) {
    // Prisma 7 dengan driver adapter tidak mengisi `meta.target` — nama
    // constraint-nya dilaporkan sebagai "(not available)". Jadi pencocokan
    // dilakukan lewat model, dan itu tetap tepat di sini: `tenant.tenants` hanya
    // punya dua indeks unique, yaitu `tenants_pkey` (id) dan `tenants_code_key`,
    // sedangkan id-nya adalah UUID yang baru saja kita bangkitkan sendiri.
    //
    // Bila kelak ada indeks unique ketiga pada tabel ini, pencocokan ini
    // menjadi salah. Uji pendaftaran ganda adalah yang akan menangkapnya.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      error.meta?.['modelName'] === 'Tenant'
    ) {
      throw new TenantCodeTakenError(input.tenantCode);
    }
    throw error;
  }
}
