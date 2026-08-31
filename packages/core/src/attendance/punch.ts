import { EventTopic } from '@hrms/contracts';
import { writeAudit, publishEvent, Prisma, type TenantClient } from '@hrms/db';
import { readPolicy } from './policy.ts';
import { assessTrust, haversineMeters, type TrustFlag } from './trust.ts';
import { resolveWorkDate, tenantTimeZone } from './workdate.ts';
import { punchPermissions } from './consent.ts';

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
    readonly kind: 'not_found' | 'duplicate' | 'locked' | 'blocked',
  ) {
    super(message);
    this.name = 'PunchError';
  }
}

interface PunchBase {
  employeeId: string;
  type: 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END';
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

/**
 * Entri manual wajib membawa alasannya, dan itu dipaksakan oleh tipe.
 *
 * Alasannya bukan kerapian data. Ketukan manual adalah satu-satunya jalur di
 * mana catatan kehadiran muncul tanpa kehadiran orang yang bersangkutan —
 * tanpa lokasi, tanpa foto, tanpa perangkatnya. Ketika kelak ada sengketa upah,
 * yang menentukan bukan skor kepercayaannya melainkan apakah ada kalimat yang
 * menjelaskan mengapa baris itu ada. Kolom opsional akan membuat kalimat itu
 * hilang persis pada baris yang paling membutuhkannya.
 */
export type PunchInput = PunchBase &
  (
    | { source: 'WEB' | 'MOBILE' | 'DEVICE'; manualReason?: undefined }
    | { source: 'MANUAL'; manualReason: string }
  );

export interface PunchResult {
  id: string;
  workDate: string;
  trustScore: number;
  flags: TrustFlag[];
  needsReview: boolean;
  /** True bila ketukan ini sudah pernah tercatat (pengiriman ulang luring). */
  duplicate: boolean;
}

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

  const timeZone = await tenantTimeZone(tx, tenantId);

  /**
   * Persetujuan diperiksa di SERVER, bukan hanya di layar (P9).
   *
   * Layar presensi memang menyembunyikan tombol kamera ketika persetujuan foto
   * ditarik — tetapi layar dapat diganti, dan yang menanggung akibatnya adalah
   * orang yang mengira permintaannya dihormati. Koordinat dan foto yang dikirim
   * tanpa persetujuan dibuang di sini, sebelum menyentuh basis data.
   *
   * Ketukan mesin absensi dan entri HR tidak membawa keduanya, jadi tidak ada
   * yang perlu diperiksa untuk mereka.
   */
  const consent =
    input.source === 'WEB' || input.source === 'MOBILE'
      ? await punchPermissions(tx, tenantId, input.employeeId)
      : { location: true, photo: true, pending: [] };

  const latitude = consent.location ? (input.latitude ?? null) : null;
  const longitude = consent.location ? (input.longitude ?? null) : null;
  const accuracyM = consent.location ? (input.accuracyM ?? null) : null;
  const photoKey = consent.photo ? (input.photoKey ?? null) : null;

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
  /**
   * Kunci dedupe wajib ada, dan diperiksa saat berjalan meski tipenya sudah
   * mewajibkannya.
   *
   * `where: { dedupeKey: undefined }` pada Prisma **mengabaikan syaratnya** —
   * ia tidak mencari baris ber-kunci null, melainkan mencocokkan baris mana pun
   * di tenant itu. Ketukan yang datang tanpa kunci karenanya akan dijawab
   * "sudah tercatat" beserta skor kepercayaan milik ketukan orang lain, dan
   * tidak ada satu pun baris baru yang tersimpan.
   *
   * TypeScript sudah mencegahnya pada seluruh pemanggil yang ada. Penjagaan ini
   * untuk yang tidak dilihat TypeScript: badan JSON yang lolos validasi karena
   * skemanya kelak dilonggarkan, dan pemanggilan dari berkas yang dijalankan
   * dengan transform-types — yang menghapus tipe tanpa memeriksanya.
   *
   * Ditemukan justru lewat berkas seperti itu: sebuah skrip verifikasi yang
   * lupa menyertakan kuncinya menerima "duplikat" untuk setiap ketukan, dan
   * selama beberapa menit hasilnya terbaca seperti kebijakan tenant yang tidak
   * berfungsi.
   */
  if (!input.dedupeKey) {
    throw new PunchError('Ketukan tanpa kunci dedupe tidak dapat diproses', 'not_found');
  }

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

  if (latitude != null && longitude != null) {
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
        { lat: latitude, lon: longitude },
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

  // --- Periode yang sudah ditutup --------------------------------------------
  //
  // Hanya entri manual yang ditolak di sini, dan pembedaan itu disengaja.
  //
  // Ketukan WEB yang tiba terlambat — antrean luring yang baru tersambung
  // setelah periode ditutup — tetap dicatat. Barisnya tidak berbahaya:
  // `persistDay` menolak memperbarui hari yang terkunci, jadi angka yang dipakai
  // payroll tidak bergeser. Menolak ketukannya justru akan membuang satu-satunya
  // bukti bahwa orang itu hadir.
  //
  // Entri manual berbeda karena niatnya berbeda. HR memasukkannya JUSTRU untuk
  // mengubah angkanya, dan angka itu tidak akan berubah. Membiarkannya
  // "berhasil" berarti HR mengira koreksinya sudah beres sementara slip gaji
  // tetap salah — kegagalan yang baru ketahuan saat karyawannya protes.
  if (input.source === 'MANUAL') {
    const workDateForLock = resolveWorkDate(input.punchedAt, timeZone);
    const closed = await tx.attendancePeriod.findFirst({
      where: {
        tenantId,
        closedAt: { not: null },
        startDate: { lte: workDateForLock },
        endDate: { gte: workDateForLock },
      },
      select: { year: true, month: true },
    });

    if (closed) {
      throw new PunchError(
        `Periode ${String(closed.month).padStart(2, '0')}/${closed.year} sudah ditutup. ` +
          'Koreksi pada periode tertutup tidak lagi mengubah angka yang dipakai payroll.',
        'locked',
      );
    }
  }

  // --- Kebijakan tenant ------------------------------------------------------
  const policy = await readPolicy(tx, tenantId);

  /**
   * Kebijakan saat izin ditolak (dokumen 10 §2.4).
   *
   * `BLOCK` berarti presensi mobile tidak dapat dilakukan tanpa bukti yang
   * diwajibkan — dan penolakannya harus menyebut **apa yang kurang dan apa
   * jalan keluarnya**, bukan sekadar "gagal". Karyawan yang ditolak di gerbang
   * pabrik pukul tujuh pagi tidak dapat berbuat apa-apa dengan pesan yang tidak
   * memberitahunya harus ke mana.
   *
   * Ketukan dari mesin absensi dan entri manual HR dikecualikan: keduanya
   * memang tidak membawa lokasi maupun foto menurut sifatnya, dan
   * memblokirnya berarti mematikan dua jalur koreksi yang justru dibutuhkan
   * ketika ponsel karyawan bermasalah.
   */
  if (policy.onPermissionDenied === 'BLOCK' && input.source !== 'DEVICE' && input.source !== 'MANUAL') {
    const kurang: string[] = [];
    if (policy.requireLocation && distanceM === null) kurang.push('lokasi');
    if (policy.requirePhoto && !photoKey) kurang.push('foto');

    if (kurang.length > 0) {
      throw new PunchError(
        `Presensi membutuhkan ${kurang.join(' dan ')}. ` +
          'Aktifkan izinnya di setelan peramban, gunakan mesin absensi, ' +
          'atau minta HR memasukkan koreksi manual.',
        'blocked',
      );
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
    accuracyM,
    maxAccuracyM,
    hasPhoto: Boolean(photoKey),
    // Ketukan luring dikirim belakangan; selisih waktu di situ wajar dan bukan
    // sinyal. Yang dinilai hanya ketukan yang dikirim seketika.
    clockSkewSeconds: input.source === 'DEVICE' ? null : clockSkewSeconds,
    mockLocationReported: input.mockLocationReported ?? false,
    consentWithheld: { location: !consent.location, photo: !consent.photo },
    policy: {
      requireLocation: policy.requireLocation,
      requirePhoto: policy.requirePhoto,
      autoApproveThreshold: policy.autoApproveThreshold,
    },
  });

  // --- Tanggal kerja ---------------------------------------------------------
  const workDate = resolveWorkDate(input.punchedAt, timeZone);

  try {
    const punch = await tx.punchLog.create({
      data: {
        tenantId,
        employeeId: input.employeeId,
        type: input.type,
        source: input.source,
        punchedAt: input.punchedAt,
        workDate,
        latitude: latitude != null ? new Prisma.Decimal(latitude) : null,
        longitude: longitude != null ? new Prisma.Decimal(longitude) : null,
        accuracyM,
        workSiteId,
        distanceM,
        photoKey,
        // Retensi dari kebijakan tenant, bukan konstanta. Angkanya dihitung
        // SAAT MENYIMPAN, bukan saat menghapus — sehingga menaikkan retensi
        // tidak memperpanjang umur foto yang sudah ada, dan menurunkannya tidak
        // memendekkannya. Foto tunduk pada janji yang berlaku saat ia diambil.
        photoExpiresAt: photoKey
          ? new Date(Date.now() + policy.photoRetentionDays * 86_400_000)
          : null,
        trustScore: assessment.score,
        trustFlags: assessment.flags.length > 0 ? (assessment.flags as never) : Prisma.DbNull,
        // Entri manual tidak masuk antrean tinjauan, dan itu bukan kelonggaran.
        //
        // Ia sudah ditinjau — oleh orang yang memasukkannya, pada saat ia
        // memasukkannya, dengan alasan yang tercatat pada baris ini. Mengirimnya
        // ke antrean berarti meminta HR meninjau pekerjaannya sendiri, dan
        // sementara itu ia menaikkan rasio bertanda: metrik yang justru dipakai
        // untuk mendeteksi ambang kepercayaan yang salah setel akan berbohong
        // sebanding dengan seberapa rajin HR mengoreksi.
        //
        // Skornya TETAP rendah dan tetap terlihat. Buktinya memang lemah, dan
        // menaikkan skornya akan menyembunyikan hal yang benar.
        ...(input.source === 'MANUAL'
          ? {
              review: 'APPROVED' as const,
              reviewedBy: actorUserId,
              reviewedAt: new Date(),
              reviewNote: input.manualReason,
            }
          : { review: assessment.needsReview ? ('NEEDS_REVIEW' as const) : ('ACCEPTED' as const) }),
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
          reason: input.manualReason,
        },
        ip: input.ip ?? undefined,
      });
    }

    if (assessment.needsReview && input.source !== 'MANUAL') {
      await publishEvent(tx, tenantId, {
        topic: EventTopic.PUNCH_FLAGGED,
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
      needsReview: assessment.needsReview && input.source !== 'MANUAL',
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
