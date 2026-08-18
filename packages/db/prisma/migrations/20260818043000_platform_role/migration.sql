-- =============================================================================
-- Principal basis data untuk control plane
--
-- `hrms_app` sengaja tidak punya USAGE pada schema `platform` — itulah cara P11
-- ditegakkan secara teknis. Konsekuensinya: kode control plane tidak dapat
-- memakai koneksi aplikasi, dan membutuhkan principal sendiri.
--
-- Yang boleh dijangkau `hrms_platform`:
--   - seluruh schema `platform` (rumahnya sendiri);
--   - metadata tenant: kode, nama, status, paket, modul — bukan isi datanya;
--   - menulis `tenant_modules`, karena mengaktifkan modul adalah aksi operasional.
--
-- Yang TIDAK boleh, dan ini yang menanggung beban:
--   - `auth.users`, `iam.*`, `audit.*` — tidak ada satu pun GRANT.
--   - Seluruh tabel data karyawan yang akan datang. Karena hak akses diberikan
--     per tabel dan bukan per schema, modul domain baru tidak akan pernah
--     terjangkau control plane secara tidak sengaja.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_platform') THEN
    CREATE ROLE hrms_platform NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE hrms_platform NOBYPASSRLS;

GRANT USAGE ON SCHEMA platform TO hrms_platform;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA platform TO hrms_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA platform TO hrms_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA platform
  GRANT SELECT, INSERT, UPDATE ON TABLES TO hrms_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA platform
  GRANT USAGE, SELECT ON SEQUENCES TO hrms_platform;

-- Metadata tenant, tabel per tabel. Tidak memakai ALL TABLES IN SCHEMA dengan
-- sengaja: `tenant` adalah schema yang akan bertambah isinya, dan hibah menyapu
-- berarti tabel berikutnya ikut terbuka tanpa ada yang memutuskannya.
GRANT USAGE ON SCHEMA tenant TO hrms_platform;
GRANT SELECT ON tenant.tenants, tenant.modules, tenant.plans, tenant.plan_modules TO hrms_platform;
GRANT SELECT, INSERT, UPDATE ON tenant.tenant_modules TO hrms_platform;

-- RLS pada tabel tenant tetap berlaku bagi role ini. Tanpa kebijakan yang
-- menyebutnya, `hrms_platform` melihat nol baris — yang benar sebagai default.
-- Kebijakan di bawah memberinya pandangan metadata lintas tenant, dan hanya itu.
DROP POLICY IF EXISTS platform_metadata_read ON tenant.tenants;
CREATE POLICY platform_metadata_read ON tenant.tenants
  TO hrms_platform USING (true);

DROP POLICY IF EXISTS platform_module_admin ON tenant.tenant_modules;
CREATE POLICY platform_module_admin ON tenant.tenant_modules
  TO hrms_platform USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Jumlah pengguna per tenant, tanpa membuka tabel penggunanya
--
-- Dashboard global perlu tahu sebuah tenant punya 250 pengguna. Ia tidak boleh
-- tahu satu pun nama atau alamat email mereka. Memberi SELECT pada `auth.users`
-- akan memberikan keduanya sekaligus.
--
-- Fungsi ini mengembalikan angka, dan hanya angka. Ia pengecualian RLS keempat
-- dalam sistem — uji `rls-coverage` sengaja gagal saat jumlahnya berubah, supaya
-- penambahan semacam ini selalu menjadi keputusan yang dijelaskan di PR.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.tenant_user_counts()
  RETURNS TABLE (tenant_id uuid, user_count bigint)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT u.tenant_id, count(*) FROM auth.users u GROUP BY u.tenant_id
$$;

COMMENT ON FUNCTION platform.tenant_user_counts() IS
  'Dashboard global: jumlah pengguna per tenant. Mengembalikan angka saja. Jangan tambahkan kolom apa pun di sini.';

REVOKE ALL ON FUNCTION platform.tenant_user_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.tenant_user_counts() TO hrms_platform;
