/**
 * Penilaian kepercayaan bukti presensi (dokumen 10 §5, prinsip P14).
 *
 * Aturan yang mengikat seluruh berkas ini: **skor, bukan ya/tidak.**
 *
 * Koordinat dan foto adalah klaim perangkat, dan setiap klaim perangkat dapat
 * dipalsukan. Sistem yang menolak presensi berdasarkan satu sinyal akan menolak
 * orang yang benar-benar bekerja — GPS di dalam gudang beton meleset ratusan
 * meter, ponsel murah melaporkan akurasi buruk, dan jaringan seluler di kawasan
 * industri membuat lokasi jatuh ke menara terdekat.
 *
 * Yang benar adalah menilai, menandai yang mencurigakan, dan menyerahkan
 * keputusan akhir kepada manusia yang mengenal konteksnya.
 *
 * Batas kejujuran yang harus dinyatakan (dokumen 10 §1.1): sistem ini TIDAK
 * dapat mendeteksi mock GPS dari peramban. Presensi web karenanya selalu
 * mendapat penalti dan tidak pernah boleh dijual sebagai "antipalsu".
 */

export interface TrustFlag {
  code: string;
  /** Pengurangan skor. Positif. */
  penalty: number;
  message: string;
}

export interface TrustInput {
  source: 'WEB' | 'MOBILE' | 'DEVICE' | 'MANUAL';
  /** Jarak ke lokasi kerja terdekat, meter. Null bila lokasi tidak dikirim. */
  distanceM: number | null;
  /** Radius geofence lokasi terdekat. */
  radiusM: number | null;
  /** Akurasi yang dilaporkan perangkat, meter. */
  accuracyM: number | null;
  maxAccuracyM: number | null;
  hasPhoto: boolean;
  /** Selisih jam perangkat terhadap jam server, detik. */
  clockSkewSeconds: number | null;
  /** Perangkat melaporkan lokasi tiruan. Hanya tersedia di aplikasi native. */
  mockLocationReported: boolean;
  /**
   * Bukti yang tidak ada KARENA karyawan menarik persetujuannya (UU PDP).
   *
   * Dibedakan dari bukti yang sekadar tidak ada, dan pembedaan itu menentukan
   * keabsahan persetujuannya. Bila menarik persetujuan lokasi membuat setiap
   * presensi masuk antrean tinjauan, karyawan akan menyetujuinya untuk berhenti
   * dipanggil HR — dan persetujuan yang diberikan untuk menghindari akibat
   * bukan persetujuan bebas, sehingga tidak sah menurut UU PDP No. 27/2022.
   *
   * Karena itu penaltinya nol. Tandanya tetap ada supaya catatan presensinya
   * jujur tentang mengapa buktinya tipis, tetapi ia tidak mendorong siapa pun
   * ke antrean.
   */
  consentWithheld?: { location?: boolean; photo?: boolean } | undefined;
}

export interface TrustAssessment {
  score: number;
  flags: TrustFlag[];
  /** Di bawah ambang ini, presensi masuk antrean tinjauan HR. */
  needsReview: boolean;
}

/**
 * Ambang tinjauan.
 *
 * Dipilih supaya satu sinyal lemah saja tidak memicu tinjauan, tetapi kombinasi
 * dua sinyal memicu. Metrik yang harus dipantau: bila lebih dari 12% presensi
 * masuk antrean, HR berhenti meninjau dan skornya menjadi teater (PLAN/12 §11).
 */
const REVIEW_THRESHOLD = 60;

export function assessTrust(input: TrustInput): TrustAssessment {
  const flags: TrustFlag[] = [];

  // --- Sumber ----------------------------------------------------------------
  if (input.source === 'WEB') {
    // Risiko R47. Peramban tidak menyediakan API untuk mendeteksi mock GPS,
    // sehingga presensi web secara struktural lebih lemah daripada native.
    // Penaltinya kecil supaya tidak sendirian memicu tinjauan — ia menjadi
    // penentu hanya bila digabung sinyal lain.
    flags.push({
      code: 'WEB_UNVERIFIED_DEVICE',
      penalty: 15,
      message: 'Presensi dari peramban — keaslian lokasi tidak dapat diverifikasi',
    });
  }

  if (input.source === 'MANUAL') {
    flags.push({
      code: 'MANUAL_ENTRY',
      penalty: 40,
      message: 'Diinput manual oleh HR, bukan oleh karyawan',
    });
  }

  /**
   * Mesin absensi tidak dinilai dengan ukuran ponsel.
   *
   * Ketukan dari mesin fingerprint atau face recognition tidak membawa koordinat
   * dan tidak membawa swafoto — dan tidak satu pun dari keduanya berarti buktinya
   * lemah. Lokasinya adalah mesin itu sendiri, yang terpasang di dinding kantor
   * dan tidak bisa dibawa pulang. Identitasnya adalah sidik jari, yang lebih sulit
   * dipalsukan daripada foto apa pun yang dikirim peramban.
   *
   * Tanpa pengecualian ini, ketukan mesin bernilai 50 — di bawah ambang — sehingga
   * SETIAP ketukan dari mesin masuk antrean tinjauan. Bagi tenant yang memang
   * memakai mesin, antrean itu berisi seluruh presensinya, dan HR berhenti
   * meninjau pada hari pertama.
   *
   * Yang tetap dinilai adalah jalur masuknya. Berkas CSV diunggah oleh manusia
   * dan isinya dapat disunting sebelum diunggah; kepercayaannya melekat pada
   * mesinnya, bukan pada berkasnya. Penaltinya kecil supaya tidak sendirian
   * memicu tinjauan, dan akan hilang ketika integrasi langsung menggantikan impor.
   */
  if (input.source === 'DEVICE') {
    flags.push({
      code: 'DEVICE_IMPORT_UNVERIFIED',
      penalty: 10,
      message: 'Dari impor berkas mesin absensi, bukan integrasi langsung',
    });

    const score = Math.max(0, 100 - flags.reduce((sum, flag) => sum + flag.penalty, 0));
    return { score, flags, needsReview: score < REVIEW_THRESHOLD };
  }

  // --- Lokasi ----------------------------------------------------------------
  if (input.distanceM === null) {
    flags.push(
      input.consentWithheld?.location
        ? {
            code: 'LOCATION_CONSENT_WITHHELD',
            penalty: 0,
            message: 'Tanpa lokasi — persetujuan lokasi tidak diberikan',
          }
        : { code: 'NO_LOCATION', penalty: 30, message: 'Tanpa data lokasi' },
    );
  } else if (input.radiusM !== null && input.distanceM > input.radiusM) {
    const excess = input.distanceM - input.radiusM;

    // Penalti berjenjang. Meleset 30 meter dari pagar kantor hampir selalu
    // ketidaktepatan GPS; meleset dua kilometer hampir selalu bukan.
    const penalty = excess > 2000 ? 50 : excess > 500 ? 35 : excess > 100 ? 20 : 10;

    flags.push({
      code: 'OUTSIDE_GEOFENCE',
      penalty,
      message: `${formatDistance(input.distanceM)} dari lokasi kerja (radius ${input.radiusM} m)`,
    });
  }

  if (
    input.accuracyM !== null &&
    input.maxAccuracyM !== null &&
    input.accuracyM > input.maxAccuracyM
  ) {
    // Akurasi buruk membuat jarak tidak dapat dipercaya ke dua arah — ia bisa
    // menyembunyikan orang yang jauh, dan menuduh orang yang dekat. Penaltinya
    // sedang, dan pesannya menyebutkan angkanya supaya HR dapat menilai sendiri.
    flags.push({
      code: 'LOW_GPS_ACCURACY',
      penalty: 15,
      message: `Akurasi GPS ${input.accuracyM} m (batas ${input.maxAccuracyM} m)`,
    });
  }

  // --- Bukti foto ------------------------------------------------------------
  if (!input.hasPhoto) {
    flags.push(
      input.consentWithheld?.photo
        ? {
            code: 'PHOTO_CONSENT_WITHHELD',
            penalty: 0,
            message: 'Tanpa foto — persetujuan foto tidak diberikan',
          }
        : { code: 'NO_PHOTO', penalty: 20, message: 'Tanpa foto swafoto' },
    );
  }

  // --- Waktu perangkat -------------------------------------------------------
  if (input.clockSkewSeconds !== null && Math.abs(input.clockSkewSeconds) > 300) {
    // Jam perangkat yang meleset lebih dari lima menit adalah sinyal kuat: itu
    // cara paling sederhana memalsukan presensi luring. Toleransi lima menit
    // memberi ruang untuk jam yang sekadar tidak tersinkron.
    flags.push({
      code: 'CLOCK_SKEW',
      penalty: 35,
      message: `Jam perangkat meleset ${Math.round(Math.abs(input.clockSkewSeconds) / 60)} menit`,
    });
  }

  // --- Sinyal paling kuat ----------------------------------------------------
  if (input.mockLocationReported) {
    // Satu-satunya sinyal yang cukup kuat untuk memicu tinjauan sendirian.
    // Perangkat yang mengaku memakai lokasi tiruan tidak menyisakan tafsiran lain.
    flags.push({
      code: 'MOCK_LOCATION',
      penalty: 70,
      message: 'Perangkat melaporkan penggunaan lokasi tiruan',
    });
  }

  const score = Math.max(0, 100 - flags.reduce((sum, flag) => sum + flag.penalty, 0));

  return { score, flags, needsReview: score < REVIEW_THRESHOLD };
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`;
}

/**
 * Jarak Haversine dalam meter.
 *
 * Bumi diperlakukan sebagai bola, bukan elipsoid. Galatnya sampai 0,5% — pada
 * radius geofence 150 meter itu kurang dari satu meter, jauh di bawah ketidak-
 * tepatan GPS mana pun. Vincenty lebih akurat dan tidak memberi manfaat apa pun
 * di sini.
 */
export function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}
