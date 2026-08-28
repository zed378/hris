-- =============================================================================
-- Membuang PII teks biasa yang tertinggal di staging impor
-- =============================================================================
--
-- `import_rows.raw` dan `.parsed` menyimpan isi berkas impor apa adanya, dan
-- berkas impor karyawan memuat kolom NIK, NPWP, dan Nomor Rekening. Artinya
-- setiap impor meninggalkan salinan nomor identitas sebagai **teks biasa** di
-- dalam JSON — di basis data yang sama yang mengenkripsi kolom NIK di tabel
-- sebelahnya dengan AES-256-GCM.
--
-- Enkripsi kolom karyawan karenanya tidak menjaga apa pun bagi tenant yang
-- melakukan onboarding lewat impor, dan impor adalah jalur onboarding utama
-- (Gerbang A: tiga pilot mengimpor ≥100 karyawan secara mandiri).
--
-- Yang memperburuknya: tidak ada satu pun jalur yang menghapus baris pratinjau.
-- Status `DISCARDED` ada di enum sejak awal tanpa produsen, sehingga pratinjau
-- yang ditinggalkan bertahan selamanya.
--
-- Kode kini menyiapkan PII pada saat pratinjau dibuat — terenkripsi, ber-indeks
-- buta, bertopeng — sehingga teks biasa tidak pernah lagi masuk. Migrasi ini
-- membersihkan yang terlanjur ada.
--
-- Barisnya DIHAPUS, bukan ditimpa. Menimpa satu per satu menuntut mengetahui
-- kolom mana yang PII pada setiap berkas, dan pemetaan itu ada di dalam baris
-- yang hendak dibersihkan. Yang hilang hanyalah kemampuan melanjutkan pratinjau
-- lama — berkasnya masih ada pada orang yang mengunggahnya, dan mengunggah
-- ulang memakan waktu sepuluh detik.

DELETE FROM employee.import_rows;

UPDATE employee.import_jobs
   SET status = 'DISCARDED'
 WHERE status = 'PREVIEW';

COMMENT ON COLUMN employee.import_rows.parsed IS
  'Baris hasil validasi. Kolom PII (NIK, NPWP, rekening) DISIMPAN TERENKRIPSI, bukan teks biasa — lihat prepareRowPii di packages/core/src/employee/import.ts.';

COMMENT ON COLUMN employee.import_rows.raw IS
  'Sel apa adanya untuk pesan galat, dengan kolom PII diganti bentuk bertopeng.';
