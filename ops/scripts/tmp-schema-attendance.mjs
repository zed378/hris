import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';

const p = 'packages/db/prisma/schema.prisma';
const eol = readFileSync(p, 'utf8').includes('\r\n') ? '\r\n' : '\n';

{
  const raw = readFileSync(p, 'utf8');
  let s = raw.split('\r\n').join('\n');
  const old =
    'schemas  = ["tenant", "auth", "iam", "audit", "messaging", "platform", "employee", "notification"]';
  const next =
    'schemas  = ["tenant", "auth", "iam", "audit", "messaging", "platform", "employee", "notification", "attendance"]';
  if (!s.includes(old)) throw new Error('daftar schema tidak ditemukan');
  writeFileSync(p, s.replace(old, next).split('\n').join(eol));
}

const block = `
// =============================================================================
// SCHEMA: attendance — presensi (Fase 3)
//
// Dokumen 10 mengikat seluruh schema ini lewat dua prinsip:
//
//   P14  Bukti presensi DINILAI, bukan dipercaya. Koordinat dan foto adalah
//        klaim perangkat yang dapat dipalsukan. Sistem memberi skor kepercayaan
//        dan menandai anomali untuk ditinjau manusia — bukan menerima atau
//        menolak otomatis berdasarkan satu sinyal.
//
//   P15  Pembatasan tujuan pada data lokasi. Lokasi diambil hanya saat presensi,
//        tidak pernah di latar belakang, dan tidak diteruskan ke pelaporan
//        sebagai koordinat mentah. Ini yang membedakan alat presensi dari alat
//        pengawasan.
// =============================================================================

enum PunchType {
  IN
  OUT
  BREAK_START
  BREAK_END

  @@schema("attendance")
}

enum PunchSource {
  /// Dari aplikasi web/PWA karyawan.
  WEB
  /// Aplikasi native (Fase 3 lanjutan).
  MOBILE
  /// Mesin fingerprint/face, lewat impor CSV atau webhook.
  DEVICE
  /// Diinput HR secara manual. Selalu ditandai untuk audit.
  MANUAL

  @@schema("attendance")
}

enum PunchReviewStatus {
  /// Skor kepercayaan memadai; tidak perlu tinjauan.
  ACCEPTED
  /// Ditandai untuk ditinjau HR. TETAP TERCATAT — tidak pernah dibuang.
  NEEDS_REVIEW
  APPROVED
  REJECTED

  @@schema("attendance")
}

enum DayStatus {
  PRESENT
  LATE
  ABSENT
  LEAVE
  HOLIDAY
  DAY_OFF

  @@schema("attendance")
}

/// Lokasi kerja beserta radius geofence.
///
/// Radius disimpan per lokasi, bukan global: kantor pusat di gedung bertingkat
/// membutuhkan radius jauh lebih kecil daripada area pabrik atau proyek lapangan.
/// Radius global memaksa memilih antara terlalu longgar untuk yang satu atau
/// terlalu ketat untuk yang lain.
model WorkSite {
  id       String  @id @default(uuid()) @db.Uuid
  tenantId String  @map("tenant_id") @db.Uuid
  code     String
  name     String

  latitude  Decimal @db.Decimal(10, 7)
  longitude Decimal @db.Decimal(10, 7)
  /// Radius dalam meter.
  radiusM   Int     @default(150) @map("radius_m")

  /// Ambang akurasi GPS yang masih diterima, dalam meter. GPS di dalam gedung
  /// kerap melaporkan akurasi 100 m atau lebih; menolaknya berarti menolak
  /// presensi seluruh kantor (risiko R43).
  maxAccuracyM Int @default(100) @map("max_accuracy_m")

  isActive  Boolean  @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  punches PunchLog[]

  @@unique([tenantId, code])
  @@index([tenantId, isActive])
  @@map("work_sites")
  @@schema("attendance")
}

/// Pola jam kerja.
model Shift {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @map("tenant_id") @db.Uuid
  code     String
  name     String

  /// Menit sejak tengah malam. Disimpan sebagai menit, bukan time, supaya shift
  /// malam yang melewati tengah malam (22:00–06:00) dapat dinyatakan tanpa
  /// tanggal — 1320 sampai 1800.
  startMinute Int @map("start_minute")
  endMinute   Int @map("end_minute")

  /// Toleransi keterlambatan dalam menit.
  graceMinutes Int @default(10) @map("grace_minutes")
  breakMinutes Int @default(60) @map("break_minutes")

  isActive  Boolean  @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  schedules      Schedule[]
  attendanceDays AttendanceDay[]

  @@unique([tenantId, code])
  @@map("shifts")
  @@schema("attendance")
}

/// Jadwal shift seorang karyawan pada satu tanggal.
model Schedule {
  id         String   @id @default(uuid()) @db.Uuid
  tenantId   String   @map("tenant_id") @db.Uuid
  employeeId String   @map("employee_id") @db.Uuid
  workDate   DateTime @map("work_date") @db.Date
  shiftId    String?  @map("shift_id") @db.Uuid
  /// Hari libur mingguan karyawan ini.
  isDayOff   Boolean  @default(false) @map("is_day_off")

  shift Shift? @relation(fields: [shiftId], references: [id])

  @@unique([employeeId, workDate])
  @@index([tenantId, workDate])
  @@map("schedules")
  @@schema("attendance")
}

/// Hari libur nasional dan cuti bersama.
model Holiday {
  id       String   @id @default(uuid()) @db.Uuid
  tenantId String   @map("tenant_id") @db.Uuid
  date     DateTime @db.Date
  name     String
  /// Cuti bersama memotong hak cuti tahunan; libur nasional tidak.
  isJointLeave Boolean @default(false) @map("is_joint_leave")

  @@unique([tenantId, date])
  @@index([tenantId, date])
  @@map("holidays")
  @@schema("attendance")
}

/// Satu ketukan presensi, beserta seluruh buktinya.
///
/// Baris di sini TIDAK PERNAH dihapus dan tidak pernah ditolak otomatis. Presensi
/// di luar geofence tetap tercatat dan ditandai — karena karyawan yang benar-benar
/// bekerja di lokasi yang salah tetap bekerja, dan menghapus catatannya berarti
/// memotong gajinya berdasarkan sinyal yang mungkin salah (P14).
model PunchLog {
  id         String @id @default(uuid()) @db.Uuid
  tenantId   String @map("tenant_id") @db.Uuid
  employeeId String @map("employee_id") @db.Uuid

  type       PunchType
  source     PunchSource
  punchedAt  DateTime  @map("punched_at")
  /// Tanggal kerja yang dituju. Berbeda dari tanggal `punchedAt` pada shift malam.
  workDate   DateTime  @map("work_date") @db.Date

  // --- Bukti lokasi ----------------------------------------------------------
  latitude   Decimal? @db.Decimal(10, 7)
  longitude  Decimal? @db.Decimal(10, 7)
  /// Akurasi yang dilaporkan perangkat, dalam meter.
  accuracyM  Int?     @map("accuracy_m")
  workSiteId String?  @map("work_site_id") @db.Uuid
  /// Jarak ke lokasi kerja terdekat, dalam meter. Dihitung saat menyimpan.
  distanceM  Int?     @map("distance_m")

  // --- Bukti foto ------------------------------------------------------------
  /// Kunci objek di penyimpanan. EXIF sudah dihapus sebelum disimpan.
  photoKey      String?   @map("photo_key")
  /// Foto dihapus setelah retensi habis; catatan presensinya tetap utuh.
  photoExpiresAt DateTime? @map("photo_expires_at")

  // --- Penilaian kepercayaan (P14) -------------------------------------------
  /// 0–100. Bukan ya/tidak: satu sinyal buruk tidak membatalkan presensi, dan
  /// beberapa sinyal buruk sekaligus yang menaikkan kecurigaan.
  trustScore Int               @default(100) @map("trust_score")
  /// Alasan pengurangan skor, sebagai daftar kode. Ditampilkan di antrean tinjauan.
  trustFlags Json?             @map("trust_flags")
  review     PunchReviewStatus @default(ACCEPTED)
  reviewedBy String?           @map("reviewed_by") @db.Uuid
  reviewedAt DateTime?         @map("reviewed_at")
  reviewNote String?           @map("review_note")

  /// Idempotensi antrean luring. Klien membangkitkannya sebelum mengirim, sehingga
  /// pengiriman ulang setelah jaringan pulih tidak menggandakan ketukan.
  dedupeKey String @map("dedupe_key")

  deviceInfo String?  @map("device_info")
  ip         String?
  createdAt  DateTime @default(now()) @map("created_at")

  workSite WorkSite? @relation(fields: [workSiteId], references: [id])

  @@unique([tenantId, dedupeKey])
  @@index([tenantId, employeeId, workDate])
  @@index([tenantId, review])
  @@index([tenantId, workDate])
  @@index([photoExpiresAt])
  @@map("punch_logs")
  @@schema("attendance")
}

/// Hasil kalkulasi harian per karyawan.
///
/// Diturunkan dari punch_logs, dan dapat dihitung ulang. Disimpan karena rekap
/// bulanan atas jutaan ketukan terlalu mahal untuk dihitung setiap kali dibuka —
/// dan karena payroll membutuhkan angka yang tidak berubah setelah periode ditutup.
model AttendanceDay {
  id         String   @id @default(uuid()) @db.Uuid
  tenantId   String   @map("tenant_id") @db.Uuid
  employeeId String   @map("employee_id") @db.Uuid
  workDate   DateTime @map("work_date") @db.Date

  shiftId  String?   @map("shift_id") @db.Uuid
  checkIn  DateTime? @map("check_in")
  checkOut DateTime? @map("check_out")

  status        DayStatus
  lateMinutes   Int @default(0) @map("late_minutes")
  earlyMinutes  Int @default(0) @map("early_minutes")
  workMinutes   Int @default(0) @map("work_minutes")
  overtimeMinutes Int @default(0) @map("overtime_minutes")

  /// Diisi bila HR mengoreksi manual. Nilai asli tetap dapat dihitung ulang dari
  /// punch_logs, sehingga koreksi tidak pernah menghapus bukti.
  correctedBy   String?   @map("corrected_by") @db.Uuid
  correctedAt   DateTime? @map("corrected_at")
  correctionNote String?  @map("correction_note")

  /// Setelah periode ditutup, baris ini tidak boleh berubah lagi.
  isLocked Boolean @default(false) @map("is_locked")

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  shift Shift? @relation(fields: [shiftId], references: [id])

  @@unique([employeeId, workDate])
  @@index([tenantId, workDate, status])
  @@map("attendance_days")
  @@schema("attendance")
}

/// Penutupan periode presensi.
///
/// Payroll membaca dari snapshot ini, bukan dari attendance_days langsung. Itu
/// yang membuat perhitungan gaji deterministik: koreksi presensi yang masuk
/// setelah periode ditutup tidak mengubah slip gaji yang sudah terbit.
model AttendancePeriod {
  id       String   @id @default(uuid()) @db.Uuid
  tenantId String   @map("tenant_id") @db.Uuid
  year     Int
  month    Int
  startDate DateTime @map("start_date") @db.Date
  endDate   DateTime @map("end_date") @db.Date

  closedAt DateTime? @map("closed_at")
  closedBy String?   @map("closed_by") @db.Uuid

  /// Ringkasan per karyawan pada saat penutupan.
  snapshot Json?

  createdAt DateTime @default(now()) @map("created_at")

  @@unique([tenantId, year, month])
  @@map("attendance_periods")
  @@schema("attendance")
}
`;

appendFileSync(p, block.split('\n').join(eol));
console.log('skema attendance ditambahkan');
