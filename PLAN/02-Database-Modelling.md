# 02 — Pemodelan Basis Data (Database-per-Service, PostgreSQL 16)

---

## 1. Prinsip Pemodelan

| # | Prinsip | Alasan |
|---|---------|--------|
| D1 | **Satu basis data logis per service.** Tidak ada service yang memiliki kredensial ke basis data service lain | Batas service ditegakkan hak akses, bukan kesepakatan |
| D2 | **Tidak ada foreign key lintas service.** Referensi antar-domain disimpan sebagai UUID polos tanpa FK | FK lintas basis data mustahil; memaksakannya berarti menggabungkan basis data |
| D3 | **Setiap service memiliki replika baca lokal** (`employee_ref`, `org_unit_ref`) yang disinkronkan event | Menghindari panggilan gRPC untuk sekadar menampilkan nama |
| D4 | **Setiap tabel bisnis memiliki `tenant_id`** dan RLS aktif | Isolasi tenant tidak bergantung pada kedisiplinan developer |
| D5 | **Setiap service memiliki tabel `outbox_events` dan `processed_messages` sendiri** | Konsistensi event dijamin per service, bukan terpusat |
| D6 | **Primary key UUIDv7** | Dapat digenerate klien, terurut waktu, tidak membocorkan volume bisnis |
| D7 | **Uang selalu `NUMERIC(18,2)`, waktu selalu `TIMESTAMPTZ`** | Presisi finansial dan kebenaran zona waktu |
| D8 | **Kolom `version bigint`** pada entitas yang direplikasi ke service lain | Konsumer dapat menolak event yang tiba tidak berurutan |
| D9 | **Seluruh DDL memakai `IF NOT EXISTS`** dan dapat dijalankan berulang | Migrasi bisa terputus di tengah dan harus aman diulang |
| D10 | **Skema hanya berubah secara aditif.** Tidak ada `DROP`, `RENAME`, atau perubahan tipe yang memicu penulisan ulang tabel | Rollback aplikasi selalu aman; dua versi service dapat hidup bersamaan. Aturan lengkap di dokumen `09` |

> DDL di dokumen ini ditulis dalam bentuk "keadaan akhir" agar mudah dibaca. Dalam praktik, setiap objek dibuat lewat migrasi ber-`IF NOT EXISTS`, dan setiap perubahan pada tabel yang sudah berisi data mengikuti resep aman di dokumen `09` §3 — bukan dengan menyunting DDL di sini lalu menjalankannya ulang.

### 1.1 Peta Basis Data

```
Klaster PostgreSQL (fase awal: satu klaster, banyak database logis)
├── auth_db          ← auth-service      (auth_user)
├── iam_db           ← iam-service       (iam_user)
├── tenant_db        ← tenant-service    (tenant_user)
├── employee_db      ← employee-service  (employee_user)
├── attendance_db    ← attendance-service(attendance_user)
├── leave_db         ← leave-service     (leave_user)
├── payroll_db       ← payroll-service   (payroll_user)
├── performance_db   ← performance-service
├── recruitment_db   ← recruitment-service
├── relation_db      ← relation-service
├── planning_db      ← planning-service
├── notification_db  ← notification-service
├── file_db          ← file-service
├── reporting_db     ← reporting-service (read model, CQRS)
└── platform_db      ← platform-service   (platform_user) ← CONTROL PLANE, terisolasi

Basis data service ekspansi (usulan, dokumen 08):
├── claim_db         ← claim-service      (reimbursement, SPPD, kasbon)
├── onboarding_db    ← onboarding-service
├── asset_db         ← asset-service
├── hse_db           ← hse-service
└── training_db      ← training-service
```

> `contract-compliance` dan `roster-planning` **tidak** memiliki basis data sendiri — keduanya perluasan `employee_db` dan `attendance_db`. Menambah basis data untuk data yang sudah ada di tempatnya hanya menghasilkan panggilan gRPC bolak-balik tanpa manfaat isolasi.

> **`platform_db` adalah pengecualian yang disengaja terhadap D4.** Ia tidak memiliki kolom `tenant_id` dan tidak menerapkan RLS, karena isinya memang bukan data tenant melainkan data *tentang* tenant: penghitung agregat, metadata langganan, dan telemetri. Konsekuensinya, `platform_db` **tidak boleh berisi data pribadi apa pun** — larangan ini ditegakkan gerbang CI yang memeriksa nama kolom (dok. 07, §9). Peran `platform_user` tidak memiliki `GRANT` ke basis data service mana pun, dan NetworkPolicy egress memblokir jalur jaringannya.

```sql
-- Isolasi ditegakkan hak akses, bukan konvensi.
CREATE ROLE payroll_user LOGIN PASSWORD :'payroll_pw' NOBYPASSRLS;
GRANT CONNECT ON DATABASE payroll_db TO payroll_user;
-- payroll_user TIDAK memiliki GRANT apa pun ke attendance_db.
-- Percobaan koneksi silang gagal di level PostgreSQL, bukan di level review kode.
REVOKE ALL ON DATABASE attendance_db FROM payroll_user;
```

> Pemisahan menjadi klaster fisik terpisah dilakukan saat sebuah service melampaui ambang beban (dipantau lewat `pg_stat_database`). Karena tidak ada query lintas basis data sejak awal, pemisahan itu hanya mengubah connection string.

---

## 2. Fondasi Bersama (di-deploy ke setiap basis data)

Berkas ini dijalankan sebagai migrasi pertama pada setiap service.

```sql
-- =====================================================================
-- 00_foundation.sql — identik di semua basis data service
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid AS $$
DECLARE unix_ts_ms bytea; rand_bytes bytea;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
  rand_bytes := gen_random_bytes(10);
  rand_bytes := set_byte(rand_bytes, 0, (b'0111' || get_byte(rand_bytes,0)::bit(8) >> 4)::bit(8)::int);
  rand_bytes := set_byte(rand_bytes, 2, ((b'10' || get_byte(rand_bytes,2)::bit(8) >> 2)::bit(8))::int);
  RETURN encode(unix_ts_ms || rand_bytes, 'hex')::uuid;
END $$ LANGUAGE plpgsql VOLATILE;

-- Konteks tenant dari X-Tenant-ID yang sudah divalidasi gateway
CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- ---------- Outbox: setiap service punya sendiri ----------
CREATE TYPE outbox_status AS ENUM ('PENDING','PUBLISHED','FAILED');

CREATE TABLE outbox_events (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id      uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  event_version  smallint NOT NULL DEFAULT 1,
  payload        jsonb NOT NULL,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- correlationId, causationId, traceparent, actorId
  status         outbox_status NOT NULL DEFAULT 'PENDING',
  attempts       smallint NOT NULL DEFAULT 0,
  available_at   timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_dispatch ON outbox_events (available_at, id) WHERE status = 'PENDING';

-- ---------- Idempotensi konsumer ----------
CREATE TABLE processed_messages (
  consumer     text NOT NULL,
  message_id   uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);
CREATE INDEX idx_processed_gc ON processed_messages (processed_at);

-- ---------- Audit lokal service ----------
CREATE TABLE audit_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id      uuid NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_id       uuid,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      uuid,
  before         jsonb,
  after          jsonb,
  correlation_id text,
  ip_address     inet,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;

-- ---------- Replika baca karyawan (di semua service domain) ----------
CREATE TABLE employee_ref (
  employee_id      uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  employee_number  text NOT NULL,
  full_name        text NOT NULL,
  org_unit_id      uuid,
  org_unit_name    text,
  position_title   text,
  manager_id       uuid,
  state            text NOT NULL,
  hire_date        date NOT NULL,
  termination_date date,
  source_version   bigint NOT NULL,      -- versi dari employee-service; tolak event basi
  synced_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_employee_ref_tenant ON employee_ref (tenant_id, state);
CREATE INDEX idx_employee_ref_mgr    ON employee_ref (tenant_id, manager_id);
CREATE INDEX idx_employee_ref_stale  ON employee_ref (synced_at);

-- ---------- Penerapan RLS otomatis ke semua tabel ber-tenant_id ----------
CREATE OR REPLACE FUNCTION apply_rls_everywhere() RETURNS void AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_schema, c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
       AND c.table_schema = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY;', r.table_schema, r.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE  ROW LEVEL SECURITY;', r.table_schema, r.table_name);
    EXECUTE format($f$
      DROP POLICY IF EXISTS tenant_isolation ON %I.%I;
      CREATE POLICY tenant_isolation ON %I.%I
        USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
    $f$, r.table_schema, r.table_name, r.table_schema, r.table_name);
  END LOOP;
END $$ LANGUAGE plpgsql;

-- Dipanggil di akhir setiap migrasi; uji CI memverifikasi tidak ada tabel yang luput
SELECT apply_rls_everywhere();
```

---

## 3. `tenant_db` — Tenant, Langganan, Modul

```sql
-- =====================================================================
-- tenant-service
-- =====================================================================
CREATE TYPE tenant_status AS ENUM ('PROVISIONING','TRIAL','ACTIVE','SUSPENDED','CHURNED','PURGED');
CREATE TYPE module_tier   AS ENUM ('CORE','BASIC','ADVANCED','ULTIMATE','EXTENSION');

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  code          citext UNIQUE NOT NULL,     -- dipakai saat login: "ACME"
  legal_name    text NOT NULL,
  npwp          text,
  timezone      text NOT NULL DEFAULT 'Asia/Jakarta',
  currency      char(3) NOT NULL DEFAULT 'IDR',
  locale        text NOT NULL DEFAULT 'id-ID',
  status        tenant_status NOT NULL DEFAULT 'PROVISIONING',
  logo_url      text,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  employee_quota integer,
  storage_quota_mb integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Catatan: tabel ini TIDAK ber-RLS. Ia adalah katalog tenant itu sendiri;
-- aksesnya dibatasi karena hanya tenant-service yang memiliki kredensialnya.

CREATE TABLE modules (
  key           text PRIMARY KEY,           -- 'attendance','leave','payroll'
  name          text NOT NULL,
  description   text,
  tier          module_tier NOT NULL,
  service_name  text NOT NULL,              -- service mana yang mengimplementasikannya
  requires      text[] NOT NULL DEFAULT '{}',
  monthly_price numeric(12,2),
  is_active     boolean NOT NULL DEFAULT true,
  display_order smallint NOT NULL DEFAULT 0
);

CREATE TABLE plans (
  key           text PRIMARY KEY,           -- 'BASIC','ADVANCED','ULTIMATE'
  name          text NOT NULL,
  module_keys   text[] NOT NULL,
  monthly_price numeric(12,2) NOT NULL,
  annual_price  numeric(12,2),
  max_employees integer,
  display_order smallint NOT NULL DEFAULT 0
);

CREATE TABLE subscriptions (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_key      text NOT NULL REFERENCES plans(key),
  status        text NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE/PAST_DUE/CANCELLED
  billing_cycle text NOT NULL DEFAULT 'MONTHLY',
  period        daterange NOT NULL,
  seats         integer NOT NULL DEFAULT 0,
  auto_renew    boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT excl_subscription_overlap
    EXCLUDE USING gist (tenant_id WITH =, period WITH &&)
);

-- Sumber kebenaran entitlement. Gateway membaca ini (via cache) pada setiap request.
CREATE TABLE tenant_modules (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key    text NOT NULL REFERENCES modules(key),
  enabled       boolean NOT NULL DEFAULT true,
  source        text NOT NULL DEFAULT 'PLAN',   -- PLAN / ADDON / TRIAL / MANUAL
  enabled_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, module_key)
);
CREATE INDEX idx_tenant_modules_active ON tenant_modules (tenant_id) WHERE enabled;

CREATE TABLE tenant_exports (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by uuid,
  file_key     text,
  status       text NOT NULL DEFAULT 'PENDING',
  completed_at timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

**Event yang dipublikasikan:** `tenant.provisioned`, `tenant.suspended`, `tenant.subscription.changed`, `tenant.module.enabled`, `tenant.module.disabled`. Gateway dan frontend mendengarkan `tenant.subscription.changed` untuk menyegarkan menu tanpa perlu login ulang.

---

## 4. `auth_db` — Autentikasi

Rancangan sengaja sederhana sesuai keputusan menunda SSO/OIDC. Detail alur ada di dokumen `06`.

```sql
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id      uuid NOT NULL,                 -- tanpa FK: tenant ada di basis data lain (D2)
  email          citext NOT NULL,
  password_hash  text NOT NULL,                 -- Argon2id
  full_name      text NOT NULL,
  employee_id    uuid,                          -- referensi lunak ke employee-service
  is_active      boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_attempts smallint NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)      -- email sama boleh ada di tenant berbeda
);
CREATE INDEX idx_users_login ON users (tenant_id, email) WHERE is_active;

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id          uuid NOT NULL,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL,
  user_agent         text,
  ip_address         inet,
  device_label       text,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoke_reason      text,
  last_used_at       timestamptz
);
CREATE UNIQUE INDEX uq_session_refresh ON sessions (refresh_token_hash);
CREATE INDEX idx_session_active ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE login_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_code text,
  email       citext,
  succeeded   boolean NOT NULL,
  failure_reason text,
  ip_address  inet,
  user_agent  text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_attempts ON login_attempts (email, attempted_at DESC);
```

---

## 5. `iam_db` — Peran, Permission, Menu

Skema lengkapnya — `menus`, `menu_permissions`, `role_menus`, `user_menu_grants`, `user_permission_grants`, `access_delegations`, `access_versions`, beserta fungsi `fn_effective_permissions` dan `fn_effective_menus` — didefinisikan di **dokumen `05-Dynamic-Role-Menu-Access.md`**. Di bawah hanya ringkasan tabel inti dan penyesuaian yang diperlukan untuk microservices.

```sql
CREATE TABLE roles (
  id         uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id  uuid,                        -- NULL = peran sistem global
  key        text NOT NULL,
  name       text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, key)
);

CREATE TABLE permissions (
  key          text PRIMARY KEY,          -- 'payroll.run.approve'
  module_key   text NOT NULL,             -- tanpa FK: katalog modul ada di tenant_db (D2)
  service_name text NOT NULL,
  resource     text NOT NULL,
  action       text NOT NULL,
  scope        text CHECK (scope IN ('self','team','unit','all')),
  is_sensitive boolean NOT NULL DEFAULT false,
  implies      text[] NOT NULL DEFAULT '{}',
  description  text
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  user_id      uuid NOT NULL,             -- referensi lunak ke auth_db
  tenant_id    uuid NOT NULL,
  role_id      uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  org_unit_ids uuid[] NOT NULL DEFAULT '{}',
  valid_from   date,
  valid_until  date,
  granted_by   uuid,
  grant_reason text,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- Replika modul aktif per tenant, disinkronkan dari tenant-service.
-- Diperlukan agar resolusi permission dapat menggugurkan izin modul yang tidak dilanggan
-- tanpa panggilan gRPC pada jalur kritis.
CREATE TABLE tenant_module_ref (
  tenant_id      uuid NOT NULL,
  module_key     text NOT NULL,
  enabled        boolean NOT NULL,
  expires_at     timestamptz,
  source_version bigint NOT NULL,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_key)
);
```

> **Penyesuaian penting terhadap dokumen `05`:** fungsi `fn_effective_permissions` di sana melakukan JOIN ke `core.tenant_modules`. Dalam arsitektur microservices, JOIN itu diarahkan ke `tenant_module_ref` — replika lokal di `iam_db`. Semantiknya identik (lisensi tetap mengalahkan peran), tetapi tidak melanggar batas service.

---

## 6. `employee_db` — Data Karyawan

```sql
CREATE TYPE employment_status AS ENUM ('PROBATION','PERMANENT','CONTRACT','INTERN','OUTSOURCE');
CREATE TYPE employee_state    AS ENUM ('ACTIVE','ON_LEAVE','SUSPENDED','RESIGNED','TERMINATED','RETIRED');

CREATE TABLE org_units (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL,
  parent_id   uuid REFERENCES org_units(id) ON DELETE RESTRICT,
  path        ltree NOT NULL,
  code        text NOT NULL,
  name        text NOT NULL,
  cost_center text,
  head_employee_id uuid,
  is_active   boolean NOT NULL DEFAULT true,
  version     bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);
CREATE INDEX idx_org_units_path ON org_units USING gist (path);

CREATE TABLE positions (
  id         uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id  uuid NOT NULL,
  code       text NOT NULL,
  title      text NOT NULL,
  job_level  smallint,
  job_family text,
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

CREATE TABLE employees (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id        uuid NOT NULL,
  user_id          uuid,                      -- referensi lunak ke auth_db
  employee_number  text NOT NULL,
  full_name        text NOT NULL,
  email_work       citext,
  phone            text,
  gender           text,
  birth_date       date,
  marital_status   text,
  dependents_count smallint NOT NULL DEFAULT 0,

  national_id_enc  bytea,                     -- NIK KTP, pgp_sym_encrypt
  tax_id_enc       bytea,                     -- NPWP
  bank_account_enc bytea,
  bank_name        text,

  bpjs_ketenagakerjaan text,
  bpjs_kesehatan       text,

  address           jsonb NOT NULL DEFAULT '{}'::jsonb,
  emergency_contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  custom_fields     jsonb NOT NULL DEFAULT '{}'::jsonb,

  hire_date         date NOT NULL,
  probation_end_date date,
  termination_date  date,
  termination_reason text,
  state             employee_state NOT NULL DEFAULT 'ACTIVE',
  manager_id        uuid REFERENCES employees(id) ON DELETE SET NULL,
  photo_url         text,

  -- Dinaikkan pada SETIAP perubahan. Konsumer replika memakainya
  -- untuk menolak event yang tiba tidak berurutan.
  version           bigint NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  UNIQUE (tenant_id, employee_number),
  CONSTRAINT chk_termination_after_hire
    CHECK (termination_date IS NULL OR termination_date >= hire_date)
);
CREATE INDEX idx_employees_active ON employees (tenant_id, state) WHERE deleted_at IS NULL;
CREATE INDEX idx_employees_name   ON employees USING gin (full_name gin_trgm_ops);

CREATE TABLE employee_positions (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  position_id  uuid NOT NULL REFERENCES positions(id) ON DELETE RESTRICT,
  org_unit_id  uuid NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  is_primary   boolean NOT NULL DEFAULT true,
  effective    daterange NOT NULL,
  fte_ratio    numeric(4,3) NOT NULL DEFAULT 1.000 CHECK (fte_ratio > 0 AND fte_ratio <= 1),
  assignment_reason text,
  CONSTRAINT excl_primary_position_overlap
    EXCLUDE USING gist (employee_id WITH =, effective WITH &&) WHERE (is_primary)
);

CREATE TABLE employment_contracts (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id       uuid NOT NULL,
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  contract_number text NOT NULL,
  status          employment_status NOT NULL,
  period          daterange NOT NULL,
  document_key    text,
  signed_at       timestamptz,
  UNIQUE (tenant_id, contract_number),
  CONSTRAINT excl_contract_overlap EXCLUDE USING gist (employee_id WITH =, period WITH &&)
);

-- Checksum untuk rekonsiliasi replika (dok. 01, §4.4)
CREATE OR REPLACE VIEW v_replica_checksum AS
SELECT tenant_id,
       count(*) AS row_count,
       md5(string_agg(id::text || ':' || version::text, ',' ORDER BY id)) AS checksum
  FROM employees
 WHERE deleted_at IS NULL
 GROUP BY tenant_id;
```

**Event yang dipublikasikan:** `employee.created`, `employee.updated`, `employee.terminated`, `employee.reinstated`, `org_unit.changed`. Setiap event membawa `version` agar konsumer dapat mengurutkannya.

---

## 7. `attendance_db` — Daily Presence

```sql
CREATE TYPE punch_source AS ENUM ('BIOMETRIC','MOBILE_GPS','WEB','QR','MANUAL_HR','IMPORT');
CREATE TYPE punch_type   AS ENUM ('IN','OUT','BREAK_START','BREAK_END');
CREATE TYPE day_status   AS ENUM
  ('PRESENT','LATE','EARLY_LEAVE','ABSENT','ON_LEAVE','HOLIDAY','DAY_OFF','INCOMPLETE','BUSINESS_TRIP');
CREATE TYPE period_status AS ENUM ('OPEN','LOCKED','CLOSED');

CREATE TABLE shifts (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL,
  code          text NOT NULL,
  name          text NOT NULL,
  start_time    time NOT NULL,
  end_time      time NOT NULL,
  crosses_midnight boolean NOT NULL DEFAULT false,
  break_minutes smallint NOT NULL DEFAULT 60,
  grace_in_minutes  smallint NOT NULL DEFAULT 0,
  min_work_minutes  smallint NOT NULL DEFAULT 480,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

CREATE TABLE shift_assignments (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL,
  employee_id uuid NOT NULL,               -- tanpa FK lintas service (D2)
  shift_id    uuid NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  work_date   date NOT NULL,
  is_day_off  boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, employee_id, work_date)
);

CREATE TABLE punch_logs (
  id          uuid NOT NULL DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL,
  employee_id uuid NOT NULL,
  punched_at  timestamptz NOT NULL,
  work_date   date NOT NULL,
  punch_type  punch_type NOT NULL,
  source      punch_source NOT NULL,
  device_id   text,
  latitude    numeric(9,6),
  longitude   numeric(9,6),
  selfie_key  text,
  is_valid    boolean NOT NULL DEFAULT true,
  invalid_reason text,
  dedupe_key  text GENERATED ALWAYS AS (
                employee_id::text || '|' || punched_at::text || '|' || punch_type::text) STORED,
  raw_payload jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, work_date)
) PARTITION BY RANGE (work_date);

CREATE TABLE punch_logs_2026m08 PARTITION OF punch_logs
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Kolom bukti presensi (akurasi lokasi, geofence, foto, skor kepercayaan, status tinjauan,
-- sinkronisasi luring) ditambahkan lewat migrasi aditif — lihat dokumen `10` §3.1.
-- Tabel pendukungnya: work_sites, site_assignments, attendance_policies,
-- employee_devices, attendance_consents, photo_access_logs.
CREATE UNIQUE INDEX uq_punch_dedupe_2026m08 ON punch_logs_2026m08 (tenant_id, dedupe_key);
CREATE INDEX idx_punch_emp_2026m08 ON punch_logs_2026m08 (tenant_id, employee_id, work_date, punched_at);

CREATE TABLE daily_records (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id           uuid NOT NULL,
  employee_id         uuid NOT NULL,
  work_date           date NOT NULL,
  shift_id            uuid REFERENCES shifts(id),
  first_in_at         timestamptz,
  last_out_at         timestamptz,
  worked_minutes      integer NOT NULL DEFAULT 0,
  late_minutes        integer NOT NULL DEFAULT 0,
  early_leave_minutes integer NOT NULL DEFAULT 0,
  overtime_minutes    integer NOT NULL DEFAULT 0,
  status              day_status NOT NULL,
  leave_request_id    uuid,                -- referensi lunak ke leave-service
  leave_type_code     text,                -- didenormalisasi dari event leave.request.approved
  is_locked           boolean NOT NULL DEFAULT false,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  computed_by         text NOT NULL DEFAULT 'system',
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, employee_id, work_date)
);
CREATE INDEX idx_daily_dashboard ON daily_records (tenant_id, work_date, status);
CREATE INDEX idx_daily_payroll   ON daily_records (tenant_id, employee_id, work_date)
  INCLUDE (worked_minutes, overtime_minutes, late_minutes, status);

CREATE TABLE periods (
  id        uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id uuid NOT NULL,
  period    daterange NOT NULL,
  status    period_status NOT NULL DEFAULT 'OPEN',
  closed_at timestamptz,
  closed_by uuid,
  version   integer NOT NULL DEFAULT 1,
  CONSTRAINT excl_period_overlap EXCLUDE USING gist (tenant_id WITH =, period WITH &&)
);

-- Snapshot rekap periode: dibekukan saat periode ditutup.
-- payroll-service mengambil ini lewat gRPC, sehingga rekalkulasi payroll
-- selalu memberi hasil sama meski data harian kemudian dikoreksi.
CREATE TABLE period_snapshots (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL,
  period_id    uuid NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL,
  working_days numeric(5,2) NOT NULL,
  present_days numeric(5,2) NOT NULL,
  absent_days  numeric(5,2) NOT NULL,
  paid_leave_days   numeric(5,2) NOT NULL DEFAULT 0,
  unpaid_leave_days numeric(5,2) NOT NULL DEFAULT 0,
  late_minutes     integer NOT NULL DEFAULT 0,
  overtime_minutes integer NOT NULL DEFAULT 0,
  frozen_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_id, employee_id)
);
```

---

## 8. `leave_db` — Kalender Cuti

```sql
CREATE TYPE accrual_method AS ENUM ('ANNUAL_GRANT','MONTHLY_ACCRUAL','ANNIVERSARY','UNLIMITED','NONE');
CREATE TYPE request_status AS ENUM ('DRAFT','PENDING','APPROVED','REJECTED','CANCELLED','TAKEN');

CREATE TABLE leave_types (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id          uuid NOT NULL,
  code               text NOT NULL,
  name               text NOT NULL,
  is_paid            boolean NOT NULL DEFAULT true,
  accrual_method     accrual_method NOT NULL DEFAULT 'ANNUAL_GRANT',
  default_quota_days numeric(5,2) NOT NULL DEFAULT 12,
  max_carry_over_days numeric(5,2) NOT NULL DEFAULT 0,
  min_service_months smallint NOT NULL DEFAULT 12,
  requires_attachment boolean NOT NULL DEFAULT false,
  deduct_from_balance boolean NOT NULL DEFAULT true,
  affects_payroll    boolean NOT NULL DEFAULT false,
  color_hex          char(7) NOT NULL DEFAULT '#3b82f6',
  is_active          boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

CREATE TABLE holidays (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL,
  holiday_date date NOT NULL,
  name         text NOT NULL,
  is_joint_leave boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, holiday_date)
);

CREATE TABLE leave_balances (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id         uuid NOT NULL,
  employee_id       uuid NOT NULL,
  leave_type_id     uuid NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  period_year       smallint NOT NULL,
  entitled_days     numeric(6,2) NOT NULL DEFAULT 0,
  carried_over_days numeric(6,2) NOT NULL DEFAULT 0,
  adjustment_days   numeric(6,2) NOT NULL DEFAULT 0,
  used_days         numeric(6,2) NOT NULL DEFAULT 0,
  pending_days      numeric(6,2) NOT NULL DEFAULT 0,
  expired_days      numeric(6,2) NOT NULL DEFAULT 0,
  available_days    numeric(6,2) GENERATED ALWAYS AS
    (entitled_days + carried_over_days + adjustment_days - used_days - pending_days - expired_days) STORED,
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, employee_id, leave_type_id, period_year),
  CONSTRAINT chk_no_negative_balance CHECK
    (entitled_days + carried_over_days + adjustment_days - used_days - pending_days - expired_days >= 0)
);
```

> `chk_no_negative_balance` adalah jaring pengaman terakhir terhadap persetujuan cuti bersamaan. Meskipun aplikasi memakai `SELECT … FOR UPDATE`, constraint ini menjamin basis data menolak saldo minus dalam kondisi apa pun. Penanganan lengkapnya di dokumen `03`, §6.1.

```sql
CREATE TABLE leave_requests (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id      uuid NOT NULL,
  request_number text NOT NULL,
  employee_id    uuid NOT NULL,
  leave_type_id  uuid NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
  period         daterange NOT NULL,
  is_half_day    boolean NOT NULL DEFAULT false,
  total_days     numeric(5,2) NOT NULL CHECK (total_days > 0),
  reason         text NOT NULL,
  attachment_key text,
  status         request_status NOT NULL DEFAULT 'DRAFT',
  current_approver_id uuid,
  submitted_at   timestamptz,
  decided_at     timestamptz,
  version        integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, request_number),
  CONSTRAINT excl_leave_overlap EXCLUDE USING gist (
    employee_id WITH =, period WITH &&
  ) WHERE (status IN ('PENDING','APPROVED','TAKEN'))
);
CREATE INDEX idx_leave_calendar ON leave_requests USING gist (period)
  WHERE status IN ('APPROVED','TAKEN');
CREATE INDEX idx_leave_inbox ON leave_requests (tenant_id, current_approver_id, status)
  WHERE status = 'PENDING';

CREATE TABLE leave_approvals (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL,
  request_id  uuid NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  step_order  smallint NOT NULL,
  approver_id uuid NOT NULL,
  decision    text CHECK (decision IN ('APPROVED','REJECTED','DELEGATED')),
  comment     text,
  decided_at  timestamptz,
  UNIQUE (request_id, step_order)
);

CREATE TABLE balance_ledger (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  balance_id    uuid NOT NULL REFERENCES leave_balances(id) ON DELETE CASCADE,
  entry_type    text NOT NULL,   -- GRANT/ACCRUAL/HOLD/RELEASE/CONSUME/EXPIRE/ADJUST
  days          numeric(6,2) NOT NULL,
  reference_type text,
  reference_id  uuid,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

---

## 9. `payroll_db` — Wages & Salary

```sql
CREATE TYPE component_type AS ENUM ('EARNING','DEDUCTION','EMPLOYER_CONTRIBUTION','INFO');
CREATE TYPE calc_method    AS ENUM ('FIXED','FORMULA','PER_DAY','PER_HOUR','PERCENTAGE','TABLE_LOOKUP');
CREATE TYPE run_status     AS ENUM
  ('DRAFT','VALIDATING','CALCULATING','CALCULATED','FAILED','PENDING_APPROVAL','APPROVED','PAID','CANCELLED');

CREATE TABLE components (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL,
  code          text NOT NULL,
  name          text NOT NULL,
  type          component_type NOT NULL,
  calc_method   calc_method NOT NULL,
  formula       text,
  fixed_amount  numeric(18,2),
  percentage    numeric(7,4),
  base_component_codes text[] NOT NULL DEFAULT '{}',
  is_taxable    boolean NOT NULL DEFAULT true,
  is_bpjs_base  boolean NOT NULL DEFAULT false,
  is_prorated   boolean NOT NULL DEFAULT false,
  display_order smallint NOT NULL DEFAULT 0,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

CREATE TABLE salary_structures (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL,
  employee_id uuid NOT NULL,
  effective   daterange NOT NULL,
  ptkp_status text NOT NULL DEFAULT 'TK/0',
  tax_method  text NOT NULL DEFAULT 'GROSS',
  approved_by uuid,
  approved_at timestamptz,
  version     integer NOT NULL DEFAULT 1,
  CONSTRAINT excl_salary_overlap EXCLUDE USING gist (employee_id WITH =, effective WITH &&)
);

CREATE TABLE salary_structure_lines (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL,
  structure_id uuid NOT NULL REFERENCES salary_structures(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES components(id) ON DELETE RESTRICT,
  amount       numeric(18,2),
  percentage   numeric(7,4),
  UNIQUE (structure_id, component_id)
);

CREATE TABLE runs (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id       uuid NOT NULL,
  run_number      text NOT NULL,
  period_month    date NOT NULL,
  period          daterange NOT NULL,
  pay_date        date NOT NULL,
  run_type        text NOT NULL DEFAULT 'REGULAR',
  status          run_status NOT NULL DEFAULT 'DRAFT',
  employee_count  integer NOT NULL DEFAULT 0,
  total_gross     numeric(18,2) NOT NULL DEFAULT 0,
  total_deduction numeric(18,2) NOT NULL DEFAULT 0,
  total_net       numeric(18,2) NOT NULL DEFAULT 0,
  total_employer_cost numeric(18,2) NOT NULL DEFAULT 0,

  -- Snapshot lintas service: rekap absensi & cuti dibekukan pada saat kalkulasi.
  -- Tanpa ini, rekalkulasi memberi hasil berbeda ketika data hulu berubah.
  attendance_snapshot_id uuid,
  leave_snapshot_id      uuid,
  snapshot_config        jsonb,

  saga_id         uuid,                      -- korelasi ke payroll_saga (dok. 03, §5)
  progress_percent smallint NOT NULL DEFAULT 0,
  error_summary   jsonb,
  created_by      uuid,
  approved_by     uuid,
  approved_at     timestamptz,
  paid_at         timestamptz,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, run_number)
);

-- Anti double-payroll: hanya satu run non-batal per (tenant, bulan, tipe)
CREATE UNIQUE INDEX uq_run_active
  ON runs (tenant_id, period_month, run_type) WHERE status <> 'CANCELLED';

CREATE TABLE payslips (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id         uuid NOT NULL,
  run_id            uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL,
  employee_snapshot jsonb NOT NULL,          -- data karyawan saat penggajian, dibekukan
  working_days      numeric(5,2) NOT NULL DEFAULT 0,
  present_days      numeric(5,2) NOT NULL DEFAULT 0,
  absent_days       numeric(5,2) NOT NULL DEFAULT 0,
  paid_leave_days   numeric(5,2) NOT NULL DEFAULT 0,
  unpaid_leave_days numeric(5,2) NOT NULL DEFAULT 0,
  overtime_hours    numeric(7,2) NOT NULL DEFAULT 0,
  gross_amount      numeric(18,2) NOT NULL DEFAULT 0,
  deduction_amount  numeric(18,2) NOT NULL DEFAULT 0,
  tax_amount        numeric(18,2) NOT NULL DEFAULT 0,
  net_amount        numeric(18,2) NOT NULL DEFAULT 0,
  employer_cost     numeric(18,2) NOT NULL DEFAULT 0,
  payment_status    text NOT NULL DEFAULT 'UNPAID',
  pdf_key           text,
  published_at      timestamptz,
  calculation_trace jsonb,                   -- rincian langkah hitung untuk sengketa
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, employee_id)               -- idempotensi saat worker melanjutkan setelah crash
);
CREATE INDEX idx_payslip_employee ON payslips (tenant_id, employee_id, created_at DESC);

CREATE TABLE payslip_lines (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  payslip_id     uuid NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  component_id   uuid NOT NULL REFERENCES components(id) ON DELETE RESTRICT,
  component_code text NOT NULL,
  component_name text NOT NULL,
  type           component_type NOT NULL,
  quantity       numeric(12,4),
  rate           numeric(18,4),
  amount         numeric(18,2) NOT NULL,
  is_taxable     boolean NOT NULL,
  display_order  smallint NOT NULL DEFAULT 0
);

CREATE TABLE statutory_configs (
  id         uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id  uuid,                          -- NULL = default nasional
  config_key text NOT NULL,                 -- PPH21_TER, BPJS_TK_RATE, PTKP, UMR
  effective  daterange NOT NULL,
  value      jsonb NOT NULL,
  source_ref text,
  CONSTRAINT excl_statutory_overlap EXCLUDE USING gist (
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    config_key WITH =, effective WITH &&
  )
);

-- Saga state: transaksi terdistribusi payroll (dok. 03, §5)
CREATE TABLE payroll_saga (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id      uuid NOT NULL,
  run_id         uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  current_step   text NOT NULL,
  status         text NOT NULL DEFAULT 'RUNNING',   -- RUNNING/COMPLETED/COMPENSATING/FAILED
  completed_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  compensations  jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error     text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  timeout_at     timestamptz NOT NULL
);
CREATE INDEX idx_saga_stuck ON payroll_saga (timeout_at) WHERE status = 'RUNNING';
```

---

## 10. Service Domain Lainnya (ringkas)

```sql
-- =====================================================================
-- performance_db
-- =====================================================================
CREATE TABLE review_cycles (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL,
  name         text NOT NULL,
  period       daterange NOT NULL,
  status       text NOT NULL DEFAULT 'DRAFT',
  rating_scale jsonb NOT NULL DEFAULT '{"min":1,"max":5}'::jsonb
);

CREATE TABLE appraisals (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id        uuid NOT NULL,
  cycle_id         uuid NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL,
  reviewer_id      uuid NOT NULL,
  self_score       numeric(5,2),
  manager_score    numeric(5,2),
  calibrated_score numeric(5,2),
  final_rating     text,
  nine_box_position smallint CHECK (nine_box_position BETWEEN 1 AND 9),
  status           text NOT NULL DEFAULT 'NOT_STARTED',
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (cycle_id, employee_id, reviewer_id)
);

CREATE TABLE appraisal_scores (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL,
  appraisal_id uuid NOT NULL REFERENCES appraisals(id) ON DELETE CASCADE,
  kpi_name     text NOT NULL,
  weight_percent numeric(5,2) NOT NULL CHECK (weight_percent > 0),
  target_value text,
  actual_value text,
  achievement_percent numeric(7,2),
  score        numeric(5,2)
);

-- =====================================================================
-- recruitment_db
-- =====================================================================
CREATE TABLE requisitions (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id          uuid NOT NULL,
  requisition_number text NOT NULL,
  position_id        uuid,                  -- referensi lunak ke employee-service
  org_unit_id        uuid,
  headcount          smallint NOT NULL DEFAULT 1 CHECK (headcount > 0),
  filled_count       smallint NOT NULL DEFAULT 0,
  salary_range       numrange,
  status             text NOT NULL DEFAULT 'DRAFT',
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, requisition_number),
  CONSTRAINT chk_filled_le_headcount CHECK (filled_count <= headcount)
);

CREATE TABLE candidates (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL,
  full_name     text NOT NULL,
  email         citext NOT NULL,
  phone         text,
  resume_key    text,
  source        text,
  skills        text[],
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(full_name,'') || ' ' || coalesce(array_to_string(skills,' '),''))
  ) STORED,
  consent_at    timestamptz,
  purge_after   date,
  UNIQUE (tenant_id, email)
);
CREATE INDEX idx_candidate_search ON candidates USING gin (search_vector);

CREATE TABLE applications (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id         uuid NOT NULL,
  requisition_id    uuid NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  candidate_id      uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  current_stage     text NOT NULL DEFAULT 'APPLIED',
  stage_entered_at  timestamptz NOT NULL DEFAULT now(),
  score             numeric(5,2),
  hired_employee_id uuid,                   -- diisi setelah employee-service konfirmasi
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (requisition_id, candidate_id)
);

-- =====================================================================
-- relation_db  (data paling sensitif: ACL eksplisit per kasus)
-- =====================================================================
CREATE TABLE employee_issues (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id       uuid NOT NULL,
  case_number     text NOT NULL,
  employee_id     uuid NOT NULL,
  category        text NOT NULL,
  severity        text NOT NULL DEFAULT 'LOW',
  title           text NOT NULL,
  description     text NOT NULL,
  is_confidential boolean NOT NULL DEFAULT true,
  reported_by     uuid,
  handled_by      uuid,
  status          text NOT NULL DEFAULT 'OPEN',
  sanction_type   text,                     -- SP1/SP2/SP3/TERMINATION
  sanction_valid_until date,
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, case_number)
);

CREATE TABLE case_acl (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL,
  case_id      uuid NOT NULL REFERENCES employee_issues(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  access_level text NOT NULL CHECK (access_level IN ('READ','WRITE','OWNER')),
  granted_by   uuid NOT NULL,
  expires_at   timestamptz,
  UNIQUE (case_id, user_id)
);

-- Pembacaan pun diaudit di service ini, bukan hanya penulisan
CREATE TABLE case_access_logs (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  case_id    uuid NOT NULL,
  user_id    uuid NOT NULL,
  action     text NOT NULL,                 -- VIEW/EXPORT/PRINT
  accessed_at timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- planning_db  (RACI/DACI, FTE, Development Plan)
-- =====================================================================
CREATE TYPE raci_role AS ENUM ('RESPONSIBLE','ACCOUNTABLE','CONSULTED','INFORMED');
CREATE TYPE daci_role AS ENUM ('DRIVER','APPROVER','CONTRIBUTOR','INFORMED');

CREATE TABLE matrices (
  id        uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id uuid NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('RACI','DACI')),
  name      text NOT NULL,
  scope_type text,
  org_unit_id uuid,
  version   integer NOT NULL DEFAULT 1
);

CREATE TABLE matrix_activities (
  id        uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id uuid NOT NULL,
  matrix_id uuid NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
  sequence  smallint NOT NULL,
  activity  text NOT NULL,
  UNIQUE (matrix_id, sequence)
);

CREATE TABLE matrix_assignments (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL,
  activity_id uuid NOT NULL REFERENCES matrix_activities(id) ON DELETE CASCADE,
  employee_id uuid,
  position_id uuid,
  raci_role   raci_role,
  daci_role   daci_role,
  CONSTRAINT chk_one_role    CHECK (num_nonnulls(raci_role, daci_role) = 1),
  CONSTRAINT chk_one_subject CHECK (num_nonnulls(employee_id, position_id) = 1)
);
CREATE UNIQUE INDEX uq_single_accountable
  ON matrix_assignments (activity_id) WHERE raci_role = 'ACCOUNTABLE';

CREATE TABLE fte_analyses (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL,
  name        text NOT NULL,
  org_unit_id uuid,
  period      daterange NOT NULL,
  standard_hours_per_month numeric(6,2) NOT NULL DEFAULT 173.33,
  status      text NOT NULL DEFAULT 'DRAFT'
);

CREATE TABLE fte_activities (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL,
  analysis_id uuid NOT NULL REFERENCES fte_analyses(id) ON DELETE CASCADE,
  position_id uuid,
  activity_name text NOT NULL,
  frequency_per_month numeric(9,2) NOT NULL,
  minutes_per_occurrence numeric(9,2) NOT NULL,
  total_hours numeric(10,2) GENERATED ALWAYS AS
    (frequency_per_month * minutes_per_occurrence / 60.0) STORED
);

CREATE TABLE development_plans (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL,
  employee_id  uuid NOT NULL,
  period_year  smallint NOT NULL,
  career_goal  text,
  appraisal_id uuid,                        -- referensi lunak ke performance-service
  mentor_id    uuid,
  status       text NOT NULL DEFAULT 'DRAFT',
  UNIQUE (tenant_id, employee_id, period_year)
);

CREATE TABLE development_activities (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL,
  plan_id      uuid NOT NULL REFERENCES development_plans(id) ON DELETE CASCADE,
  competency   text NOT NULL,
  method       text NOT NULL,               -- 70 / 20 / 10
  description  text NOT NULL,
  target_date  date,
  completed_at timestamptz,
  progress_percent smallint NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100)
);
```

---

## 11. `reporting_db` — Read Model Lintas Service (CQRS)

Dashboard membutuhkan data dari beberapa service sekaligus: jumlah hadir hari ini (attendance) berdasarkan departemen (employee) dikurangi yang sedang cuti (leave). Melakukan ini lewat agregasi gRPC berarti tiga panggilan pada setiap pembukaan halaman.

Solusinya: `reporting-service` berlangganan seluruh event domain dan membangun tabel denormalisasi.

```sql
-- Satu baris per karyawan per hari, diisi dari event tiga service berbeda
CREATE TABLE rpt_daily_attendance (
  tenant_id      uuid NOT NULL,
  work_date      date NOT NULL,
  employee_id    uuid NOT NULL,
  employee_name  text NOT NULL,             -- dari employee.*
  org_unit_id    uuid,
  org_unit_name  text,
  status         text NOT NULL,             -- dari attendance.daily.computed
  late_minutes   integer NOT NULL DEFAULT 0,
  overtime_minutes integer NOT NULL DEFAULT 0,
  leave_type_code text,                     -- dari leave.request.approved
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, work_date, employee_id)
);
CREATE INDEX idx_rpt_daily_unit ON rpt_daily_attendance (tenant_id, work_date, org_unit_id);

CREATE TABLE rpt_headcount_monthly (
  tenant_id     uuid NOT NULL,
  period_month  date NOT NULL,
  org_unit_id   uuid,
  org_unit_name text,
  headcount_start integer NOT NULL DEFAULT 0,
  hires         integer NOT NULL DEFAULT 0,
  exits         integer NOT NULL DEFAULT 0,
  headcount_end integer NOT NULL DEFAULT 0,
  turnover_rate numeric(6,3),
  PRIMARY KEY (tenant_id, period_month, org_unit_id)
);

CREATE TABLE rpt_payroll_cost (
  tenant_id     uuid NOT NULL,
  period_month  date NOT NULL,
  org_unit_id   uuid,
  org_unit_name text,
  employee_count integer NOT NULL DEFAULT 0,
  total_gross   numeric(18,2) NOT NULL DEFAULT 0,
  total_net     numeric(18,2) NOT NULL DEFAULT 0,
  total_employer_cost numeric(18,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period_month, org_unit_id)
);

-- Read model dashboard tenant: satu baris per tenant, disegarkan event
CREATE TABLE rpt_tenant_dashboard (
  tenant_id          uuid PRIMARY KEY,
  headcount_total    integer NOT NULL DEFAULT 0,
  headcount_active   integer NOT NULL DEFAULT 0,
  headcount_probation integer NOT NULL DEFAULT 0,
  hires_this_month   integer NOT NULL DEFAULT 0,
  exits_this_month   integer NOT NULL DEFAULT 0,
  present_today      integer NOT NULL DEFAULT 0,
  late_today         integer NOT NULL DEFAULT 0,
  absent_today       integer NOT NULL DEFAULT 0,
  on_leave_today     integer NOT NULL DEFAULT 0,
  pending_leave_requests integer NOT NULL DEFAULT 0,
  open_cases         integer NOT NULL DEFAULT 0,
  open_requisitions  integer NOT NULL DEFAULT 0,
  payroll_gross_current numeric(18,2),
  payroll_net_current   numeric(18,2),
  turnover_rate_ytd  numeric(6,3),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Read model dashboard tim: satu baris per unit organisasi.
-- Sengaja TANPA kolom biaya — manajer lini tidak berwenang atas data gaji,
-- sehingga kolomnya tidak ada sama sekali, bukan sekadar disembunyikan di API.
CREATE TABLE rpt_team_dashboard (
  tenant_id       uuid NOT NULL,
  org_unit_id     uuid NOT NULL,
  org_unit_name   text NOT NULL,
  headcount       integer NOT NULL DEFAULT 0,
  present_today   integer NOT NULL DEFAULT 0,
  late_today      integer NOT NULL DEFAULT 0,
  absent_today    integer NOT NULL DEFAULT 0,
  on_leave_today  integer NOT NULL DEFAULT 0,
  pending_approvals integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, org_unit_id)
);

-- Jejak event yang sudah diproyeksikan: mendeteksi lubang pada aliran event
CREATE TABLE projection_checkpoints (
  projection_name text PRIMARY KEY,
  last_event_id   uuid,
  last_event_at   timestamptz,
  events_processed bigint NOT NULL DEFAULT 0,
  lag_seconds     integer,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

> **Konsekuensi yang harus dikomunikasikan ke pengguna:** angka pada dashboard bersifat *eventually consistent* — biasanya tertinggal 1–3 detik dari kejadian nyata. Untuk laporan yang memerlukan akurasi mutlak (rekap payroll untuk pelaporan pajak), `reporting-service` tidak dipakai; laporan diambil langsung dari service pemilik data.

---

## 12. Strategi Indexing & Partisi

| Pola query | Service | Index |
|------------|---------|-------|
| Dashboard absensi harian per unit | reporting | `idx_rpt_daily_unit` |
| Payroll menarik rekap periode | attendance | `idx_daily_payroll ... INCLUDE (...)` — index-only scan |
| Inbox persetujuan atasan | leave | Partial index `WHERE status='PENDING'` |
| Kalender cuti (rentang tanggal) | leave | GiST pada `daterange` |
| Cari karyawan nama parsial | employee | GIN `gin_trgm_ops` |
| Cari kandidat berdasarkan skill | recruitment | GIN `tsvector` |
| Log absensi historis | attendance | Partisi bulanan + index lokal |
| Deteksi replika basi | semua | `idx_employee_ref_stale` |

**Otomatisasi partisi** (`attendance_db`), dijalankan tanggal 25 setiap bulan untuk bulan berikutnya:

```sql
CREATE OR REPLACE FUNCTION ensure_punch_partition(p_month date) RETURNS void AS $$
DECLARE
  start_date date := date_trunc('month', p_month)::date;
  end_date   date := (date_trunc('month', p_month) + interval '1 month')::date;
  part_name  text := format('punch_logs_%sm%s', to_char(start_date,'YYYY'), to_char(start_date,'MM'));
BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF punch_logs FOR VALUES FROM (%L) TO (%L)',
                 part_name, start_date, end_date);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS uq_%s_dedupe ON %I (tenant_id, dedupe_key)',
                 part_name, part_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_emp ON %I (tenant_id, employee_id, work_date, punched_at)',
                 part_name, part_name);
END $$ LANGUAGE plpgsql;
```

---

## 13. Migrasi Data dari Excel

Impor ditangani `reporting-service`? Tidak — impor menulis ke banyak domain, sehingga dijalankan sebagai **saga** yang dikoordinasi service khusus impor di dalam `api-gateway`, dengan staging di basis datanya sendiri.

```sql
-- import_db (dikelola import-orchestrator, bagian dari api-gateway)
CREATE TABLE import_batches (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL,
  target_service text NOT NULL,             -- 'employee','attendance','payroll'
  entity      text NOT NULL,
  file_key    text NOT NULL,
  total_rows  integer NOT NULL DEFAULT 0,
  valid_rows  integer NOT NULL DEFAULT 0,
  error_rows  integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'UPLOADED',
  mapping     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_rows (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id   uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  raw        jsonb NOT NULL,
  normalized jsonb,
  errors     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status     text NOT NULL DEFAULT 'PENDING',
  target_id  uuid
);
CREATE INDEX idx_import_rows_status ON import_rows (batch_id, status);
```

**Alur impor:** unggah → parsing ke staging → pemetaan kolom → validasi per baris → pratinjau → commit per batch 500 baris ke service tujuan lewat gRPC → laporan galat yang dapat diperbaiki dan diunggah ulang.

Prinsip yang dipertahankan dari analisis referensi: **impor tidak boleh gagal total karena satu sel salah.** Ini pengalaman yang menentukan apakah pengguna Excel bersedia berpindah.
