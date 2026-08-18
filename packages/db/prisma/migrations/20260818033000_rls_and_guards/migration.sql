-- =============================================================================
-- Row-Level Security, hak akses role, dan pengaman integritas
--
-- Prisma tidak membangkitkan apa pun di berkas ini. Ditulis tangan, dan itu
-- disengaja: RLS adalah batas keamanan, bukan detail skema (PLAN/06 §2.6).
--
-- Seluruh berkas ini idempoten — dijalankan tiga kali berturut-turut tetap
-- berhasil (PLAN/12 F1 DoD).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Role
--
-- Dibuat NOLOGIN tanpa kata sandi. LOGIN dan kata sandi diberikan di luar migrasi
-- (dev: ops/initdb; produksi: runbook), sehingga tidak ada satu pun kredensial
-- yang pernah masuk ke git.
--
-- hrms_app    — runtime aplikasi web. Tidak pernah melihat menembus RLS.
-- hrms_worker — proses latar. Sama seperti hrms_app, ditambah satu pengecualian
--               sempit: ia boleh membaca outbox lintas tenant, karena pompa event
--               adalah infrastruktur, bukan akses data oleh manusia. Pengecualian
--               itu berlaku pada SATU tabel dan diverifikasi uji CI.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    CREATE ROLE hrms_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_worker') THEN
    CREATE ROLE hrms_worker NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- Pagar terakhir: bila seseorang kelak memberi BYPASSRLS "demi kemudahan
-- dukungan", migrasi ini mencabutnya kembali pada setiap deploy (risiko R21).
ALTER ROLE hrms_app NOBYPASSRLS;
ALTER ROLE hrms_worker NOBYPASSRLS;


-- -----------------------------------------------------------------------------
-- 2. Fungsi konteks tenant
--
-- Mengembalikan NULL bila `app.tenant_id` belum dipasang. Itu membuat setiap
-- kebijakan gagal-tertutup: `tenant_id = NULL` bernilai NULL, bukan TRUE, sehingga
-- query tanpa konteks tenant mengembalikan nol baris — bukan seluruh tabel.
--
-- `search_path` dikunci agar fungsi tidak dapat dibajak lewat schema bayangan.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.app_current_tenant()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

COMMENT ON FUNCTION public.app_current_tenant() IS
  'Konteks tenant untuk request berjalan. Dipasang withTenant() lewat set_config(..., true) sehingga selalu transaction-scoped.';

GRANT EXECUTE ON FUNCTION public.app_current_tenant() TO hrms_app, hrms_worker;


-- -----------------------------------------------------------------------------
-- 3. Hak akses schema
--
-- `platform` sengaja tidak muncul di sini. Control plane tidak dapat dijangkau
-- role aplikasi, dan itulah cara P11 ditegakkan secara teknis, bukan lewat
-- kesepakatan (PLAN/07 §2).
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA tenant, auth, iam, audit, messaging TO hrms_app, hrms_worker;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA tenant, auth, iam, messaging
  TO hrms_app, hrms_worker;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA tenant, auth, iam, audit, messaging
  TO hrms_app, hrms_worker;

-- Katalog produk: hanya dibaca aplikasi. Menambah modul atau permission adalah
-- migrasi/seed, bukan aksi runtime.
REVOKE INSERT, UPDATE, DELETE ON tenant.modules, tenant.plans, tenant.plan_modules FROM hrms_app, hrms_worker;
REVOKE INSERT, UPDATE, DELETE ON iam.permissions, iam.menus FROM hrms_app, hrms_worker;

-- Jejak audit hanya boleh bertambah (P5). Trigger di §6 menegakkan hal yang sama
-- pada level basis data; pencabutan hak ini adalah lapisan pertamanya.
GRANT SELECT, INSERT ON audit.audit_logs TO hrms_app, hrms_worker;
REVOKE UPDATE, DELETE ON audit.audit_logs FROM hrms_app, hrms_worker;

-- Tabel yang ditambahkan migrasi berikutnya ikut terjangkau tanpa perlu diingat.
-- Yang TIDAK otomatis adalah kebijakan RLS-nya — itu disengaja, dan ada gerbang
-- CI yang menolak tabel ber-tenant_id tanpa policy.
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA tenant, auth, iam, messaging
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hrms_app, hrms_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA tenant, auth, iam, audit, messaging
  GRANT USAGE, SELECT ON SEQUENCES TO hrms_app, hrms_worker;

-- Eksplisit, meski PostgreSQL 15+ sudah tidak memberi apa pun ke PUBLIC pada
-- schema baru. Baris ini ada agar niatnya terbaca saat audit.
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM PUBLIC;


-- -----------------------------------------------------------------------------
-- 4. Kebijakan isolasi tenant
--
-- FORCE ROW LEVEL SECURITY dipasang di semua tabel, termasuk untuk pemilik tabel.
-- Tanpa FORCE, pemilik melewati kebijakan diam-diam — dan itu berarti setiap
-- skrip pemeliharaan yang berjalan sebagai owner adalah kebocoran yang menunggu.
-- -----------------------------------------------------------------------------

-- tenant.tenants — kasus khusus: barisnya sendiri adalah tenantnya.
ALTER TABLE tenant.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant.tenants;
CREATE POLICY tenant_isolation ON tenant.tenants
  USING (id = public.app_current_tenant())
  WITH CHECK (id = public.app_current_tenant());

ALTER TABLE tenant.tenant_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.tenant_modules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant.tenant_modules;
CREATE POLICY tenant_isolation ON tenant.tenant_modules
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON auth.users;
CREATE POLICY tenant_isolation ON auth.users
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE auth.refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.refresh_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON auth.refresh_tokens;
CREATE POLICY tenant_isolation ON auth.refresh_tokens
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE iam.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.roles;
CREATE POLICY tenant_isolation ON iam.roles
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE iam.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.role_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.role_permissions;
CREATE POLICY tenant_isolation ON iam.role_permissions
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE iam.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.user_roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.user_roles;
CREATE POLICY tenant_isolation ON iam.user_roles
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE iam.user_permission_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.user_permission_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.user_permission_grants;
CREATE POLICY tenant_isolation ON iam.user_permission_grants
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE iam.access_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.access_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.access_versions;
CREATE POLICY tenant_isolation ON iam.access_versions
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE audit.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit.audit_logs;
CREATE POLICY tenant_isolation ON audit.audit_logs
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE messaging.outbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.outbox_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON messaging.outbox_messages;
CREATE POLICY tenant_isolation ON messaging.outbox_messages
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

-- Satu-satunya pengecualian dalam sistem: pompa outbox membaca lintas tenant.
-- Berlaku hanya untuk role hrms_worker dan hanya pada tabel ini. Uji CI
-- memverifikasi bahwa hrms_worker tetap terkurung RLS di seluruh tabel lain.
DROP POLICY IF EXISTS outbox_publisher ON messaging.outbox_messages;
CREATE POLICY outbox_publisher ON messaging.outbox_messages
  TO hrms_worker
  USING (true)
  WITH CHECK (true);


-- -----------------------------------------------------------------------------
-- 5. Katalog global: dibaca semua tenant, tanpa RLS
--
-- modules, plans, plan_modules, permissions, menus tidak punya tenant_id karena
-- ia definisi produk, bukan data pelanggan. Ditegakkan hak akses baca-saja di §3.
-- -----------------------------------------------------------------------------

COMMENT ON TABLE tenant.modules IS 'Katalog produk. Global, tanpa RLS, baca-saja bagi aplikasi.';
COMMENT ON TABLE tenant.plans IS 'Katalog produk. Global, tanpa RLS, baca-saja bagi aplikasi.';
COMMENT ON TABLE iam.permissions IS 'Katalog produk. Global, tanpa RLS, baca-saja bagi aplikasi.';
COMMENT ON TABLE iam.menus IS 'Katalog produk. Global, tanpa RLS, baca-saja bagi aplikasi.';


-- -----------------------------------------------------------------------------
-- 6. Jejak audit bersifat append-only (P5)
--
-- Hak akses saja tidak cukup: pemilik tabel tetap dapat meng-UPDATE. Trigger ini
-- menolak siapa pun, termasuk owner.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit.reject_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'audit.audit_logs bersifat append-only; % ditolak', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit.audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit.audit_logs
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit.reject_mutation();


-- -----------------------------------------------------------------------------
-- 7. MFA superuser ditegakkan basis data (PLAN/07 §3.2)
--
-- "Akun superuser tanpa MFA tidak dapat diaktifkan" adalah butir DoD. Di lapisan
-- aplikasi ia dapat dilupakan saat menambah jalur baru; sebagai constraint ia tidak bisa.
-- -----------------------------------------------------------------------------

ALTER TABLE platform.superusers
  DROP CONSTRAINT IF EXISTS superusers_active_requires_totp;
ALTER TABLE platform.superusers
  ADD CONSTRAINT superusers_active_requires_totp
  CHECK (is_active = false OR totp_secret IS NOT NULL);


-- -----------------------------------------------------------------------------
-- 8. Integritas data
-- -----------------------------------------------------------------------------

-- Kode tenant dipakai saat login. Huruf kecil, angka, dan tanda hubung saja —
-- agar tidak pernah ada dua tenant yang hanya berbeda huruf besar-kecil.
ALTER TABLE tenant.tenants DROP CONSTRAINT IF EXISTS tenants_code_format;
ALTER TABLE tenant.tenants
  ADD CONSTRAINT tenants_code_format
  CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$');

-- Email disimpan huruf kecil. Unique (tenant_id, email) baru bermakna bila
-- normalisasinya dijamin basis data, bukan hanya oleh kode pemanggil.
ALTER TABLE auth.users DROP CONSTRAINT IF EXISTS users_email_lowercase;
ALTER TABLE auth.users
  ADD CONSTRAINT users_email_lowercase
  CHECK (email = lower(email));

-- Grant per pengguna wajib punya alasan. Grant tanpa alasan tidak dapat
-- ditinjau ulang enam bulan kemudian, dan access review menjadi teater.
ALTER TABLE iam.user_permission_grants DROP CONSTRAINT IF EXISTS user_permission_grants_reason_not_blank;
ALTER TABLE iam.user_permission_grants
  ADD CONSTRAINT user_permission_grants_reason_not_blank
  CHECK (length(btrim(reason)) >= 8);
