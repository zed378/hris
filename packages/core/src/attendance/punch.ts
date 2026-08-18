import { writeAudit, publishEvent, Prisma, type TenantClient } from '@hrms/db';
import { assessTrust, haversineMeters, type TrustFlag } from './trust.ts';

/**
 * Pencatatan ketukan presensi (dokumen 10).
 *
 * Aturan yang tidak dapat dikompromikan: **presensi tidak pernah ditolak karena
 * buktinya lemah.** Ia dicatat, dinilai, dan ditandai.
 *
 * Karyawan yang benar-benar bekerja tetapi ponselnya melaporkan lokasi buruk
 * tetap bekerja. Menolak ketukannya berarti memotong gajinya berdasarkan sinyal
 * yang mungkin salah — dan yang menanggung akibatnya adalah orang yang paling
 * tidak punya cara membantahnya.
 */

export class PunchError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'duplicate' | 'locked',
  ) {
    super(message);
    this.name = 'PunchError';
  }
}

export interface PunchInput {
  employeeId: string;
  type: 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END';
  source: 'WEB' | 'MOBILE' | 'DEVICE' | 'MANUAL';
  /** Waktu ketukan menurut klien. Diverifikasi terhadap jam server. */
  punchedAt: Date;
  latitude?: number | null | undefined;
  longitude?: number | null | undefined;
  accuracyM?: number | null | undefined;
  photoKey?: string | null | undefined;
  mockLocationReported?: boolean | undefined;
  /** Dibangkitkan klien sebelum mengirim. Kunci idempotensi antrean luring. */
  dedupeKey: string;
  deviceInfo?: string | null | undefined;
  ip?: string | null | undefined;
}

export interface PunchResult {
  id: string;
  workDate: string;
  trustScore: number;
  flags: TrustFlag[];
  needsReview: boolean;
  /** True bila ketukan ini sudah pernah tercatat (pengiriman ulang luring). */
  duplicate: boolean;
}

/** Retensi foto presensi. Dokumen 10 §4.4. */
const PHOTO_RETENTION_DAYS = 90;

export async function recordPunch(
  tx: TenantClient,
  tenantId: string,
  input: PunchInput,
  actorUserId: string,
): Promise<PunchResult> {
  const employee = await tx.employee.findFirst({
    where: { id: input.employeeId, tenantId },
    select: { id: true },
  });
  if (!employee) throw new PunchError('Karyawan tidak ditemukan', 'not_found');

  // Pengiriman ulang diperiksa SEBELUM menyisipkan, bukan ditangkap sesudahnya.
  //
  // Versi pertama mengandalkan constraint unique lalu memulihkan diri di blok
  // catch. Itu tidak bekerja di PostgreSQL: begitu sebuah pernyataan gagal di
  // dalam transaksi, transaksinya masuk keadaan aborted dan SETIAP query
  // berikutnya ikut gagal — termasuk query yang hendak mengambil baris yang
  // sudah ada. Hasilnya 500, padahal yang terjadi hanyalah antrean luring
  // mengirim ulang ketukan yang sudah tersimpan.
  //
  // Constraint unique tetap ada dan tetap menjadi penjamin sesungguhnya; yang
  // berubah hanya bahwa jalur yang lazim tidak lagi lewat galat.
  const alreadyRecorded = await tx.punchLog.findFirst({
    where: { tenantId, dedupeKey: input.dedupeKey },
    select: { id: true, workDate: true, trustScore: true, review: true, trustFlags: true },
  });

  if (alreadyRecorded) {
    return {
      id: alreadyRecorded.id,
      workDate: alreadyRecorded.workDate.toISOString().slice(0, 10),
      trustScore: alreadyRecorded.trustScore,
      flags: (alreadyRecorded.trustFlags as TrustFlag[] | null) ?? [],
      needsReview: alreadyRecorded.review === 'NEEDS_REVIEW',
      duplicate: true,
    };
  }

  // --- Lokasi kerja terdekat -------------------------------------------------
  let workSiteId: string | null = null;
  let distanceM: number | null = null;
  let radiusM: number | null = null;
  let maxAccuracyM: number | null = null;

  if (input.latitude != null && input.longitude != null) {
    const sites = await tx.workSite.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        latitude: true,
        longitude: true,
        radiusM: true,
        maxAccuracyM: true,
      },
    });

    // Lokasi TERDEKAT, bukan yang pertama cocok. Perusahaan dengan beberapa
    // cabang berdekatan akan membuat "yang pertama cocok" memilih cabang yang
    // salah, dan rekap per lokasi menjadi tidak berarti.
    for (const site of sites) {
      const d = haversineMeters(
        { lat: input.latitude, lon: input.longitude },
        { lat: Number(site.latitude), lon: Number(site.longitude) },
      );
      if (distanceM === null || d < distanceM) {
        distanceM = d;
        workSiteId = site.id;
        radiusM = site.radiusM;
        maxAccuracyM = site.maxAccuracyM;
      }
    }
  }

  // --- Penilaian kepercayaan -------------------------------------------------
  const serverNow = new Date();
  const clockSkewSeconds = Math.round(
    (input.punchedAt.getTime() - serverNow.getTime()) / 1000,
  );

  const assessment = assessTrust({
    source: input.source,
    distanceM,
    radiusM,
    accuracyM: input.accuracyM ?? null,
    maxAccuracyM,
    hasPhoto: Boolean(input.photoKey),
    // Ketukan luring dikirim belakangan; selisih waktu di situ wajar dan bukan
    // sinyal. Yang dinilai hanya ketukan yang dikirim seketika.
    clockSkewSeconds: input.source === 'DEVICE' ? null : clockSkewSeconds,
    mockLocationReported: input.mockLocationReported ?? false,
  });

  // --- Tanggal kerja ---------------------------------------------------------
  const workDate = resolveWorkDate(input.punchedAt);

  try {
    const punch = await tx.punchLog.create({
      data: {
        tenantId,
        employeeId: input.employeeId,
        type: input.type,
        source: input.source,
        punchedAt: input.punchedAt,
        workDate,
        latitude: input.latitude != null ? new Prisma.Decimal(input.latitude) : null,
        longitude: input.longitude != null ? new Prisma.Decimal(input.longitude) : null,
        accuracyM: input.accuracyM ?? null,
        workSiteId,
        distanceM,
        photoKey: input.photoKey ?? null,
        photoExpiresAt: input.photoKey
          ? new Date(Date.now() + PHOTO_RETENTION_DAYS * 86_400_000)
          : null,
        trustScore: assessment.score,
        trustFlags: assessment.flags.length > 0 ? (assessment.flags as never) : Prisma.DbNull,
        review: assessment.needsReview ? 'NEEDS_REVIEW' : 'ACCEPTED',
        dedupeKey: input.dedupeKey,
        deviceInfo: input.deviceInfo ?? null,
        ip: input.ip ?? null,
      },
      select: { id: true },
    });

    // Entri manual SELALU diaudit, apa pun skornya.
    //
    // Ini jalur dengan risiko tertinggi dalam modul presensi: HR mengetuk atas
    // nama orang lain, tanpa lokasi, tanpa foto, dan tanpa kehadiran orang
    // yang bersangkutan. Skor kepercayaannya memang sudah rendah, tetapi skor
    // hanya memicu tinjauan — yang dibutuhkan saat ada sengketa adalah catatan
    // siapa yang memasukkannya dan kapan.
    if (input.source === "MANUAL") {
      await writeAudit(tx, tenantId, {
        action: "attendance.punch.manual_entry",
        entityType: "punch_log",
        entityId: punch.id,
        actorUserId,
        after: {
          employeeId: input.employeeId,
          type: input.type,
          punchedAt: input.punchedAt.toISOString(),
        },
        ip: input.ip ?? undefined,
      });
    }

    if (assessment.needsReview) {
      await publishEvent(tx, tenantId, {
        topic: 'attendance.punch.flagged',
        payload: {
          tenantId,
          punchId: punch.id,
          employeeId: input.employeeId,
          trustScore: assessment.score,
          flags: assessment.flags.map((f) => f.code),
        },
      });
    }

    return {
      id: punch.id,
      workDate: workDate.toISOString().slice(0, 10),
      trustScore: assessment.score,
      flags: assessment.flags,
      needsReview: assessment.needsReview,
      duplicate: false,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Dua pengiriman tiba benar-benar bersamaan dan keduanya lolos
      // pemeriksaan di atas. Constraint unique menolak yang kedua, dan itu
      // perilaku yang benar — tepat satu baris tersimpan.
      //
      // Transaksi ini sudah aborted, jadi tidak ada yang dapat dibaca lagi di
      // sini. Pemanggil menerjemahkannya menjadi jawaban sukses: dari sudut
      // pandang klien, ketukannya memang sudah tercatat.
      throw new PunchError(
        'Presensi ini sudah tercatat',
        'duplicate',
      );
    }
    throw error;
  }
}
function resolveWorkDate(punchedAt: Date): Date {
  const local = new Date(punchedAt);
  if (local.getUTCHours() < 4) {
    local.setUTCDate(local.getUTCDate() - 1);
  }
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()),
  );
}

export interface ReviewDecision {
  punchId: string;
  approve: boolean;
  note: string;
}

/**
 * Meninjau presensi yang ditandai.
 *
 * Keputusan HR dicatat bersama alasannya, dan `trustScore` tidak diubah. Skor
 * adalah penilaian mesin atas bukti; keputusan adalah penilaian manusia atas
 * konteks. Menimpa yang pertama dengan yang kedua akan menghapus alasan mengapa
 * presensi itu ditandai — dan itu justru yang dibutuhkan saat pola yang sama
 * berulang bulan depan.
 */
export async function reviewPunch(
  tx: TenantClient,
  tenantId: string,
  decision: ReviewDecision,
  actorUserId: string,
): Promise<void> {
  const punch = await tx.punchLog.findFirst({
    where: { id: decision.punchId, tenantId },
    select: { id: true, review: true, employeeId: true },
  });
  if (!punch) throw new PunchError('Data presensi tidak ditemukan', 'not_found');

  await tx.punchLog.update({
    where: { id: decision.punchId },
    data: {
      review: decision.approve ? 'APPROVED' : 'REJECTED',
      reviewedBy: actorUserId,
      reviewedAt: new Date(),
      reviewNote: decision.note.trim(),
    },
  });

  await writeAudit(tx, tenantId, {
    action: decision.approve ? 'attendance.punch.approved' : 'attendance.punch.rejected',
    entityType: 'punch_log',
    entityId: decision.punchId,
    actorUserId,
    before: { review: punch.review },
    after: { review: decision.approve ? 'APPROVED' : 'REJECTED', note: decision.note },
  });
}
