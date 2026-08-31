-- Kredensial pengembangan lokal.
--
-- Peran itu sendiri dibuat oleh migrasi (idempoten, tanpa kata sandi), sehingga
-- produksi tidak pernah mewarisi kredensial dari git. Berkas ini hanya memberi
-- LOGIN dan kata sandi untuk mesin pengembang.
--
-- Dua properti yang menanggung beban keamanan (PLAN/06 §2.6, PLAN/12 §3.3):
--   NOBYPASSRLS  — peran ini tidak pernah melihat menembus kebijakan RLS.
--   bukan owner  — pemilik tabel melewati RLS kecuali FORCE dipasang. FORCE memang
--                  dipasang, tetapi menjauhkan aplikasi dari peran owner berarti
--                  satu FORCE yang terlupa bukan otomatis kebocoran tenant.

CREATE ROLE hrms_app    WITH LOGIN PASSWORD 'hrms_app_password'    NOBYPASSRLS;
CREATE ROLE hrms_worker WITH LOGIN PASSWORD 'hrms_worker_password' NOBYPASSRLS;

GRANT CONNECT ON DATABASE hrms TO hrms_app, hrms_worker;

-- Control plane. Punya rumahnya sendiri (schema platform) dan pandangan
-- metadata tenant, tetapi tidak satu pun GRANT ke auth.users, iam.*, atau audit.*.
CREATE ROLE hrms_platform WITH LOGIN PASSWORD 'hrms_platform_password' NOBYPASSRLS;
GRANT CONNECT ON DATABASE hrms TO hrms_platform;

-- Bidang auth (PLAN/14 tahap 5). Menjangkau auth, iam, tenant, audit, messaging,
-- dan TIDAK SATU PUN tabel di employee, attendance, leave, atau payroll —
-- komponen yang memegang hash kata sandi tidak boleh sekaligus menjadi jalan
-- menuju gaji dan NIK semua orang. GRANT-nya diberikan migrasi; berkas ini hanya
-- memberi LOGIN dan kata sandi pengembangan.
CREATE ROLE hrms_auth WITH LOGIN PASSWORD 'hrms_auth_password' NOBYPASSRLS;
GRANT CONNECT ON DATABASE hrms TO hrms_auth;
