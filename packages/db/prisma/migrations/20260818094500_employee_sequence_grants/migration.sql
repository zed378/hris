-- =============================================================================
-- Hak akses sequence untuk schema employee
--
-- Migrasi 20260818083841 memberi hibah untuk TABEL dan menyetel default
-- privileges untuk TABEL — tetapi tidak untuk SEQUENCE. Akibatnya, tabel ber-
-- BIGSERIAL yang dibuat migrasi berikutnya (`import_rows`) mendapat hibah untuk
-- tabelnya sendiri tetapi tidak untuk sequence-nya, dan setiap INSERT gagal
-- dengan "permission denied for sequence".
--
-- Gejalanya menyesatkan: tabel jelas dapat ditulis, RLS jelas benar, dan yang
-- ditolak adalah objek yang tidak pernah disebut di kode mana pun.
--
-- Ini konsekuensi langsung dari memilih hibah per-schema alih-alih menyapu:
-- setiap jenis objek harus disebut, dan yang tidak disebut tidak mendapat apa pun.
-- Itu default yang benar — dan biayanya adalah migrasi seperti ini.
-- =============================================================================

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA employee TO hrms_app, hrms_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA employee
  GRANT USAGE, SELECT ON SEQUENCES TO hrms_app, hrms_worker;
