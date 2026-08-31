import { writeAudit, type TenantClient } from '@hrms/db';

/**
 * Kebijakan presensi per tenant (dokumen 10 §2.4).
 *
 * Empat perilaku yang menentukan presensi selama ini adalah konstanta di dalam
 * kode: ambang tinjauan 60, retensi foto 90 hari, dan keharusan lokasi serta
 * foto yang berlaku bagi semua orang.
 *
 * Dokumen 10 menyatakan alasannya dengan tepat: *"Keputusan ini milik tenant,
 * bukan milik sistem — perusahaan konstruksi dan perusahaan konsultan punya
 * jawaban berbeda."* Kantor konsultan yang stafnya bekerja dari rumah tidak
 * membutuhkan foto pada setiap ketukan; proyek konstruksi membutuhkannya.
 *
 * Akibat konstanta itu sudah tercatat sebagai utang teknis sebelum berkas ini
 * ada: pengujian menghasilkan rasio bertanda jauh di atas ambang 12% **karena
 * presensi ujinya tanpa foto**, bukan karena ada yang mencurigakan. Tenant yang
 * memang tidak meminta foto akan mengalaminya setiap hari, dan HR yang antrean
 * tinjauannya penuh berhenti meninjau. Pada saat itu skor kepercayaan berubah
 * menjadi teater — persis yang diperingatkan PLAN/12 §11.
 */

export type OnPermissionDenied = 'BLOCK' | 'ALLOW_FLAGGED' | 'FALLBACK_ONLY';

export interface AttendancePolicyView {
  requireLocation: boolean;
  requirePhoto: boolean;
  onPermissionDenied: OnPermissionDenied;
  autoApproveThreshold: number;
  photoRetentionDays: number;
}

/**
 * Nilai bawaan.
 *
 * Sama persis dengan konstanta yang digantikannya, dan itu disengaja: tenant
 * yang tidak pernah menyentuh layar setelan harus berperilaku seperti sebelum
 * tabel ini ada. Perubahan perilaku yang datang bersama fitur konfigurasi
 * adalah perubahan yang tidak diminta siapa pun.
 */
export const DEFAULT_POLICY: AttendancePolicyView = {
  requireLocation: true,
  requirePhoto: true,
  onPermissionDenied: 'ALLOW_FLAGGED',
  autoApproveThreshold: 60,
  photoRetentionDays: 90,
};

export async function readPolicy(
  tx: TenantClient,
  tenantId: string,
): Promise<AttendancePolicyView> {
  const row = await tx.attendancePolicy.findUnique({
    where: { tenantId },
    select: {
      requireLocation: true,
      requirePhoto: true,
      onPermissionDenied: true,
      autoApproveThreshold: true,
      photoRetentionDays: true,
    },
  });

  // Ketiadaan baris BUKAN galat. Ia keadaan awal setiap tenant, dan membuat
  // barisnya saat dibaca akan mengubah pembacaan menjadi penulisan.
  if (!row) return DEFAULT_POLICY;

  return {
    requireLocation: row.requireLocation,
    requirePhoto: row.requirePhoto,
    onPermissionDenied: row.onPermissionDenied as OnPermissionDenied,
    autoApproveThreshold: row.autoApproveThreshold,
    photoRetentionDays: row.photoRetentionDays,
  };
}

export interface PolicyUpdate {
  requireLocation?: boolean | undefined;
  requirePhoto?: boolean | undefined;
  onPermissionDenied?: OnPermissionDenied | undefined;
  autoApproveThreshold?: number | undefined;
  photoRetentionDays?: number | undefined;
}

export async function updatePolicy(
  tx: TenantClient,
  tenantId: string,
  input: PolicyUpdate,
  actorUserId: string,
): Promise<AttendancePolicyView> {
  const before = await readPolicy(tx, tenantId);

  // Kunci ber-`undefined` dibuang lebih dulu.
  //
  // `exactOptionalPropertyTypes` menolaknya, dan penolakan itu benar: `{ requirePhoto:
  // undefined }` yang diteruskan ke `update` akan terbaca sebagai "setel ke
  // undefined", bukan "jangan sentuh" — dan pada Prisma keduanya memang berbeda.
  const perubahan = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Record<string, unknown>;

  await tx.attendancePolicy.upsert({
    where: { tenantId },
    create: { tenantId, ...DEFAULT_POLICY, ...perubahan, updatedBy: actorUserId },
    update: { ...perubahan, updatedBy: actorUserId },
  });

  const after = await readPolicy(tx, tenantId);

  /**
   * Diaudit, dan nilai sebelumnya ikut dicatat.
   *
   * Menurunkan ambang tinjauan dari 60 ke 20 membuat antrean HR kosong dalam
   * semalam — dan itu terlihat persis seperti presensi yang membaik. Menaikkan
   * retensi foto dari 90 ke 730 hari mengubah kewajiban perusahaan menurut UU
   * PDP tanpa satu pun tanda di layar mana pun.
   *
   * Keduanya sah dilakukan tenant. Keduanya juga harus dapat ditelusuri
   * kembali, dan "dari berapa ke berapa" adalah satu-satunya bentuk yang
   * menjawabnya.
   */
  await writeAudit(tx, tenantId, {
    action: 'attendance.policy.updated',
    entityType: 'attendance_policy',
    entityId: tenantId,
    actorUserId,
    before: { ...before },
    after: { ...after },
  });

  return after;
}
