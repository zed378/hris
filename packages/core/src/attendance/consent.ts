import { writeAudit, type TenantClient } from '@hrms/db';

/**
 * Persetujuan pemrosesan data presensi (dokumen 10 §8.2, UU PDP No. 27/2022).
 *
 * Aturan PR2 menuntut dua hal yang mudah diucapkan dan mudah dilanggar:
 * persetujuan diminta **terpisah** dari persetujuan umum aplikasi, dan **dapat
 * ditarik**.
 *
 * Yang membuatnya bukan formalitas adalah bagian kedua. Persetujuan yang dapat
 * ditarik tetapi penarikannya tidak mengubah apa pun bukan persetujuan — ia
 * pemberitahuan. Karena itu penarikan di sini bukan sekadar baris basis data:
 * `punchPermissions()` yang membacanya menentukan apakah lokasi dan foto boleh
 * DIAMBIL sama sekali, dan penolakannya berlaku di server, bukan hanya di layar.
 *
 * Yang tidak berubah karena penarikan: presensinya tetap dapat dilakukan. Menarik
 * persetujuan lokasi berarti presensi tanpa lokasi, bukan kehilangan hak absen —
 * dan konsekuensi wajarnya adalah skor kepercayaan yang lebih rendah, yang
 * memang jujur karena buktinya memang lebih sedikit.
 */

export type ConsentType = 'LOCATION' | 'PHOTO' | 'BIOMETRIC';

/**
 * Versi teks persetujuan yang berlaku saat ini.
 *
 * Dinaikkan setiap kali kalimat persetujuannya berubah secara material — tujuan
 * baru, retensi lebih panjang, penerima baru. Menaikkannya membuat seluruh
 * persetujuan lama berhenti berlaku dan layarnya muncul kembali, dan itulah
 * perilaku yang benar: orang menyetujui kalimat, bukan nama fitur.
 */
export const CONSENT_VERSION: Record<ConsentType, string> = {
  LOCATION: '2026-08-lokasi-v1',
  PHOTO: '2026-08-foto-v1',
  BIOMETRIC: '2026-08-biometrik-v1',
};

export interface ConsentState {
  type: ConsentType;
  version: string;
  granted: boolean;
  grantedAt: string | null;
  withdrawnAt: string | null;
  /**
   * True bila karyawan pernah memutuskan untuk versi teks yang BERLAKU SEKARANG.
   * False berarti layarnya harus ditampilkan — termasuk kepada orang yang dulu
   * sudah menyetujui versi sebelumnya.
   */
  decided: boolean;
}

/** Jenis yang diminta pada Fase 3. BIOMETRIC menyusul bersama Tingkat 4. */
const ACTIVE_TYPES: ConsentType[] = ['LOCATION', 'PHOTO'];

export async function readConsents(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
): Promise<ConsentState[]> {
  const rows = await tx.attendanceConsent.findMany({
    where: { tenantId, employeeId, consentType: { in: ACTIVE_TYPES } },
    select: {
      consentType: true,
      version: true,
      grantedAt: true,
      withdrawnAt: true,
    },
  });

  return ACTIVE_TYPES.map((type) => {
    const version = CONSENT_VERSION[type];
    const row = rows.find((r) => r.consentType === type && r.version === version);

    return {
      type,
      version,
      // Tidak ada baris berarti BELUM menyetujui, bukan menyetujui.
      //
      // Arah bawaan ini menanggung seluruh maksud aturannya. Menganggap diam
      // sebagai setuju akan membuat setiap karyawan baru diambil lokasinya
      // sebelum ia pernah ditanya, dan itu persis yang dilarang.
      granted: Boolean(row?.grantedAt && !row.withdrawnAt),
      grantedAt: row?.grantedAt?.toISOString() ?? null,
      withdrawnAt: row?.withdrawnAt?.toISOString() ?? null,
      decided: Boolean(row),
    };
  });
}

export interface ConsentDecision {
  type: ConsentType;
  grant: boolean;
  ip?: string | null | undefined;
}

export async function recordConsent(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
  decision: ConsentDecision,
  actorUserId: string,
): Promise<ConsentState[]> {
  const version = CONSENT_VERSION[decision.type];
  const now = new Date();

  // Baris versi ini diperbarui, bukan ditambah. Riwayat lintas versi tetap utuh
  // karena versinya bagian dari kunci unik — yang tidak disimpan hanyalah
  // riwayat bolak-balik setuju/tarik pada versi yang sama, dan yang mengikat
  // secara hukum adalah keadaan terakhirnya.
  await tx.attendanceConsent.upsert({
    where: {
      tenantId_employeeId_consentType_version: {
        tenantId,
        employeeId,
        consentType: decision.type,
        version,
      },
    },
    create: {
      tenantId,
      employeeId,
      consentType: decision.type,
      version,
      grantedAt: decision.grant ? now : null,
      withdrawnAt: decision.grant ? null : now,
      ip: decision.ip ?? null,
    },
    update: decision.grant
      ? { grantedAt: now, withdrawnAt: null, ip: decision.ip ?? null }
      : { withdrawnAt: now, ip: decision.ip ?? null },
  });

  // Diaudit apa pun arahnya. Sengketa tentang persetujuan hampir selalu berupa
  // "saya tidak pernah menyetujui itu", dan yang menjawabnya adalah catatan
  // kapan tombolnya ditekan dan dari alamat mana.
  await writeAudit(tx, tenantId, {
    action: decision.grant ? 'attendance.consent.granted' : 'attendance.consent.withdrawn',
    entityType: 'attendance_consent',
    entityId: employeeId,
    actorUserId,
    after: { consentType: decision.type, version },
    ip: decision.ip ?? undefined,
  });

  return readConsents(tx, tenantId, employeeId);
}

export interface PunchPermissions {
  /** Boleh mengirim koordinat. */
  location: boolean;
  /** Boleh mengirim foto swafoto. */
  photo: boolean;
  /** Jenis yang belum pernah diputuskan untuk versi teks yang berlaku. */
  pending: ConsentType[];
}

/**
 * Menerjemahkan persetujuan menjadi apa yang boleh dikirim saat presensi.
 *
 * Dipanggil di server sebelum menyimpan, bukan hanya dibaca oleh layar. Layar
 * yang menyembunyikan tombol kamera adalah kenyamanan; yang menegakkan janji
 * privasinya adalah penolakan di sisi ini (P9).
 */
export async function punchPermissions(
  tx: TenantClient,
  tenantId: string,
  employeeId: string,
): Promise<PunchPermissions> {
  const consents = await readConsents(tx, tenantId, employeeId);
  const of = (type: ConsentType): ConsentState =>
    consents.find((consent) => consent.type === type)!;

  return {
    location: of('LOCATION').granted,
    photo: of('PHOTO').granted,
    pending: consents.filter((consent) => !consent.decided).map((consent) => consent.type),
  };
}
