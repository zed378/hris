-- Zona waktu tenant.
--
-- Ditambahkan setelah menemukan bahwa batas hari kerja dihitung dalam UTC.
-- Untuk WIB (UTC+7) itu berarti setiap ketukan antara 06:00 dan 10:59 pagi
-- tercatat pada tanggal KEMARIN — yaitu jendela kedatangan hampir seluruh
-- angkatan kerja. Setiap hari kerja akan tampak sebagai pulang-tanpa-masuk,
-- dan setiap perhitungan gaji berdasarkan kehadiran menjadi salah.
--
-- Indonesia melintasi tiga zona (WIB/WITA/WIT, UTC+7/+8/+9) dan tidak memakai
-- DST, tetapi nilainya disimpan sebagai nama IANA — bukan offset angka. Offset
-- tetap akan benar hari ini dan salah pada hari pertama sebuah negara mengubah
-- aturannya, dan yang menanggungnya adalah rekap yang sudah terlanjur dihitung.
ALTER TABLE "tenant"."tenants"
  ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Asia/Jakarta';

COMMENT ON COLUMN "tenant"."tenants"."timezone" IS
  'Nama zona IANA, mis. Asia/Jakarta. Dipakai untuk menentukan batas hari kerja.';
