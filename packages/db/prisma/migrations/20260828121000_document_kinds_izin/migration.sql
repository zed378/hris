-- =============================================================================
-- Jenis dokumen perizinan: KITAS, IMTA, SIM
-- =============================================================================
--
-- Ditemukan saat menguji pengingat kedaluwarsa dokumen, dan temuannya
-- menjelaskan mengapa `expires_at` tidak pernah dipakai siapa pun.
--
-- Daftar jenis dokumen yang diizinkan berisi KTP, KK, NPWP, IJAZAH, KONTRAK,
-- SERTIFIKAT, LAINNYA. Dari tujuh itu, hanya KONTRAK dan SERTIFIKAT yang punya
-- tanggal berakhir — dan KONTRAK sudah punya jalur pengingatnya sendiri.
--
-- Dengan kata lain: kolom `expires_at` dibangun untuk dokumen yang tidak dapat
-- dimasukkan ke dalam sistem. KITAS dan IMTA — dokumen yang kedaluwarsanya
-- berarti tenaga kerja asing bekerja tanpa izin, pidana bagi perusahaan menurut
-- UU 6/2011 — hanya dapat disimpan sebagai 'LAINNYA', dan sebagai 'LAINNYA' ia
-- tidak dapat dibedakan dari fotokopi apa pun.
--
-- Penambahan ini bersifat aditif (P12): tidak ada nilai lama yang dihapus,
-- sehingga baris yang sudah ada tetap sah.

ALTER TABLE employee.employee_documents
  DROP CONSTRAINT IF EXISTS employee_documents_kind_known;

ALTER TABLE employee.employee_documents
  ADD CONSTRAINT employee_documents_kind_known CHECK (
    kind = ANY (ARRAY[
      'KTP', 'KK', 'NPWP', 'IJAZAH', 'KONTRAK', 'SERTIFIKAT',
      -- Perizinan yang berumur. Ketiganya adalah alasan pengingat kedaluwarsa
      -- dokumen dibangun sama sekali.
      'KITAS', 'IMTA', 'SIM',
      'LAINNYA'
    ]::text[])
  );
