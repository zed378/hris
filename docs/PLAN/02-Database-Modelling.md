# 02 — Database Modelling (Database-per-Service, PostgreSQL 18)

---

## 1. Modelling Principles

| # | Principle | Reason |
|---|-----------|--------|
| D1 | **One logical database per service.** No service holds credentials to another service's database | Service boundaries are enforced by access rights, not by agreement |
| D2 | **No cross-service foreign keys.** Cross-domain references are stored as plain UUIDs without an FK | Cross-database FKs are impossible; forcing them means merging the databases |
| D3 | **Every service keeps a local read replica** (`employee_ref`, `org_unit_ref`) kept in sync by events | Avoids a gRPC call merely to display a name |
| D4 | **Every business table carries `tenant_id`** with RLS enabled | Tenant isolation does not depend on developer discipline |
| D5 | **Every service owns its own `outbox_events` and `processed_messages` tables** | Event consistency is guaranteed per service, not centrally |
| D6 | **UUIDv7 primary keys** | Client-generatable, time-ordered, and they do not leak business volume |
| D7 | **Money is always `NUMERIC(18,2)`, time is always `TIMESTAMPTZ`** | Financial precision and timezone correctness |
| D8 | **A `version bigint` column** on entities replicated to other services | Consumers can reject events that arrive out of order |
| D9 | **All DDL uses `IF NOT EXISTS`** and is re-runnable | A migration can be interrupted halfway and must be safe to repeat |
| D10 | **The schema only changes additively.** No `DROP`, no `RENAME`, and no type change that rewrites a table | An application rollback is always safe; two service versions can live side by side. Full rules in document `09` |

> The DDL in this document is written in "end state" form so it reads easily. In practice every object is created through an `IF NOT EXISTS` migration, and every change to a table that already holds data follows the safe recipe in document `09` §3 — not by editing the DDL here and re-running it.

### 1.1 Database Map

```
PostgreSQL cluster (early phase: one cluster, many logical databases)
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
└── platform_db      ← platform-service   (platform_user) ← CONTROL PLANE, isolated

Expansion service databases (proposed, document 08):
├── claim_db         ← claim-service      (reimbursement, business travel, cash advance)
├── onboarding_db    ← onboarding-service
├── asset_db         ← asset-service
├── hse_db           ← hse-service
└── training_db      ← training-service
```

> `contract-compliance` and `roster-planning` have **no** database of their own — both are extensions of `employee_db` and `attendance_db`. Adding a database for data that already lives where it belongs only produces gRPC round trips with none of the isolation benefit.

> **`platform_db` is a deliberate exception to D4.** It has no `tenant_id` column and enforces no RLS, because its contents are not tenant data but data *about* tenants: aggregate counters, subscription metadata, and telemetry. The consequence is that `platform_db` **must not hold any personal data** — a prohibition enforced by a CI gate that inspects column names (doc. 07, §9). The `platform_user` role holds no `GRANT` into any service database, and an egress NetworkPolicy blocks its network path.

```sql
-- Isolation is enforced by access rights, not by convention.
CREATE ROLE payroll_user LOGIN PASSWORD :'payroll_pw' NOBYPASSRLS;
GRANT CONNECT ON DATABASE payroll_db TO payroll_user;
-- payroll_user holds NO grant of any kind into attendance_db.
-- A cross-connection attempt fails at the PostgreSQL level, not at code review.
REVOKE ALL ON DATABASE attendance_db FROM payroll_user;
```

> Splitting into physically separate clusters happens once a service crosses a load threshold (watched through `pg_stat_database`). Because there were no cross-database queries to begin with, that split only changes a connection string.

---

## 2. Shared Foundation (deployed into every database)

This file runs as the first migration of every service.

```sql
-- =====================================================================
-- 00_foundation.sql — identical in every service database
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

-- Tenant context, taken from the X-Tenant-ID the gateway already validated
CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- ---------- Outbox: every service owns its own ----------
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

-- ---------- Consumer idempotency ----------
CREATE TABLE processed_messages (
  consumer     text NOT NULL,
  message_id   uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);
CREATE INDEX idx_processed_gc ON processed_messages (processed_at);

-- ---------- Service-local audit ----------
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

-- ---------- Employee read replica (present in every domain service) ----------
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
  source_version   bigint NOT NULL,      -- version from employee-service; reject stale events
  synced_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_employee_ref_tenant ON employee_ref (tenant_id, state);
CREATE INDEX idx_employee_ref_mgr    ON employee_ref (tenant_id, manager_id);
CREATE INDEX idx_employee_ref_stale  ON employee_ref (synced_at);

-- ---------- Automatic RLS for every table carrying tenant_id ----------
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

-- Called at the end of every migration; a CI test verifies no table was missed
SELECT apply_rls_everywhere();
```

---

## 3. `tenant_db` — Tenants, Subscriptions, Modules

```sql
-- =====================================================================
-- tenant-service
-- =====================================================================
CREATE TYPE tenant_status AS ENUM ('PROVISIONING','TRIAL','ACTIVE','SUSPENDED','CHURNED','PURGED');
CREATE TYPE module_tier   AS ENUM ('CORE','BASIC','ADVANCED','ULTIMATE','EXTENSION');

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  code          citext UNIQUE NOT NULL,     -- used at login: "ACME"
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
-- Note: this table carries NO RLS. It is the tenant catalogue itself;
-- access is bounded because only tenant-service holds its credentials.

CREATE TABLE modules (
  key           text PRIMARY KEY,           -- 'attendance','leave','payroll'
  name          text NOT NULL,
  description   text,
  tier          module_tier NOT NULL,
  service_name  text NOT NULL,              -- which service implements it
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

-- The source of truth for entitlement. The gateway reads this (through a cache) on every request.
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

**Events published:** `tenant.provisioned`, `tenant.suspended`, `tenant.subscription.changed`, `tenant.module.enabled`, `tenant.module.disabled`. The gateway and the frontend listen for `tenant.subscription.changed` to refresh the menu without requiring a new login.

---

## 4. `auth_db` — Authentication

The design is deliberately plain, in line with the decision to defer SSO/OIDC. The flow details are in document `06`.

```sql
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id      uuid NOT NULL,                 -- no FK: the tenant lives in another database (D2)
  email          citext NOT NULL,
  password_hash  text NOT NULL,                 -- Argon2id
  full_name      text NOT NULL,
  employee_id    uuid,                          -- soft reference into employee-service
  is_active      boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_attempts smallint NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)      -- the same email may exist in different tenants
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

## 5. `iam_db` — Roles, Permissions, Menus

The full schema — `menus`, `menu_permissions`, `role_menus`, `user_menu_grants`, `user_permission_grants`, `access_delegations`, `access_versions`, together with the `fn_effective_permissions` and `fn_effective_menus` functions — is defined in **document `05-Dynamic-Role-Menu-Access.md`**. What follows is only a summary of the core tables and the adjustments microservices require.

```sql
CREATE TABLE roles (
  id         uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id  uuid,                        -- NULL = global system role
  key        text NOT NULL,
  name       text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, key)
);

CREATE TABLE permissions (
  key          text PRIMARY KEY,          -- 'payroll.run.approve'
  module_key   text NOT NULL,             -- no FK: the module catalogue lives in tenant_db (D2)
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
  user_id      uuid NOT NULL,             -- soft reference into auth_db
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

-- Replica of the modules enabled per tenant, synced from tenant-service.
-- Needed so permission resolution can strike out permissions belonging to an
-- unsubscribed module without a gRPC call on the critical path.
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

> **An important adjustment relative to document `05`:** the `fn_effective_permissions` function there joins to `core.tenant_modules`. Under a microservices architecture that join is redirected to `tenant_module_ref` — the local replica inside `iam_db`. The semantics are identical (a licence still beats a role), but it does not cross the service boundary.

---

## 6. `employee_db` — Employee Data

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
  user_id          uuid,                      -- soft reference into auth_db
  employee_number  text NOT NULL,
  full_name        text NOT NULL,
  email_work       citext,
  phone            text,
  gender           text,
  birth_date       date,
  marital_status   text,
  dependents_count smallint NOT NULL DEFAULT 0,

  national_id_enc  bytea,                     -- NIK from the ID card, pgp_sym_encrypt
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

  -- Incremented on EVERY change. Replica consumers use it
  -- to reject events that arrive out of order.
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

-- Checksum for replica reconciliation (doc. 01, §4.4)
CREATE OR REPLACE VIEW v_replica_checksum AS
SELECT tenant_id,
       count(*) AS row_count,
       md5(string_agg(id::text || ':' || version::text, ',' ORDER BY id)) AS checksum
  FROM employees
 WHERE deleted_at IS NULL
 GROUP BY tenant_id;
```

**Events published:** `employee.created`, `employee.updated`, `employee.terminated`, `employee.reinstated`, `org_unit.changed`. Every event carries its `version` so consumers can order them.

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
  employee_id uuid NOT NULL,               -- no cross-service FK (D2)
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

-- The evidence columns (location accuracy, geofence, photo, trust score, review
-- status, offline sync) are added through additive migrations — see document `10` §3.1.
-- Their supporting tables: work_sites, site_assignments, attendance_policies,
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
  leave_request_id    uuid,                -- soft reference into leave-service
  leave_type_code     text,                -- denormalised from the leave.request.approved event
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

-- Period recap snapshot: frozen the moment the period is closed.
-- payroll-service fetches this over gRPC, so recalculating payroll always
-- produces the same result even if the daily data is corrected afterwards.
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

## 8. `leave_db` — Leave Calendar

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

> `chk_no_negative_balance` is the last safety net against concurrent leave approvals. Even though the application uses `SELECT … FOR UPDATE`, this constraint guarantees the database refuses a negative balance under any condition whatsoever. The full treatment is in document `03`, §6.1.

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

  -- Cross-service snapshot: the attendance and leave recaps are frozen at
  -- calculation time. Without this, recalculating gives a different result
  -- whenever the upstream data changes.
  attendance_snapshot_id uuid,
  leave_snapshot_id      uuid,
  snapshot_config        jsonb,

  saga_id         uuid,                      -- correlation to payroll_saga (doc. 03, §5)
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

-- Anti double-payroll: only one non-cancelled run per (tenant, month, type)
CREATE UNIQUE INDEX uq_run_active
  ON runs (tenant_id, period_month, run_type) WHERE status <> 'CANCELLED';

CREATE TABLE payslips (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id         uuid NOT NULL,
  run_id            uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL,
  employee_snapshot jsonb NOT NULL,          -- employee data at payroll time, frozen
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
  calculation_trace jsonb,                   -- the calculation steps, for disputes
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, employee_id)               -- idempotency when the worker resumes after a crash
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
  tenant_id  uuid,                          -- NULL = national default
  config_key text NOT NULL,                 -- PPH21_TER, BPJS_TK_RATE, PTKP, UMR
  effective  daterange NOT NULL,
  value      jsonb NOT NULL,
  source_ref text,
  CONSTRAINT excl_statutory_overlap EXCLUDE USING gist (
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    config_key WITH =, effective WITH &&
  )
);

-- Saga state: the distributed payroll transaction (doc. 03, §5)
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

## 10. The Remaining Domain Services (in brief)

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
  position_id        uuid,                  -- soft reference into employee-service
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
  hired_employee_id uuid,                   -- filled in once employee-service confirms
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (requisition_id, candidate_id)
);

-- =====================================================================
-- relation_db  (the most sensitive data: an explicit ACL per case)
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

-- In this service reads are audited too, not only writes
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
  appraisal_id uuid,                        -- soft reference into performance-service
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

## 11. `reporting_db` — Cross-Service Read Model (CQRS)

The dashboard needs data from several services at once: today's headcount present (attendance) broken down by department (employee) minus those on leave (leave). Doing that through gRPC aggregation means three calls every time the page opens.

The solution: `reporting-service` subscribes to every domain event and builds denormalised tables.

```sql
-- One row per employee per day, populated from the events of three different services
CREATE TABLE rpt_daily_attendance (
  tenant_id      uuid NOT NULL,
  work_date      date NOT NULL,
  employee_id    uuid NOT NULL,
  employee_name  text NOT NULL,             -- from employee.*
  org_unit_id    uuid,
  org_unit_name  text,
  status         text NOT NULL,             -- from attendance.daily.computed
  late_minutes   integer NOT NULL DEFAULT 0,
  overtime_minutes integer NOT NULL DEFAULT 0,
  leave_type_code text,                     -- from leave.request.approved
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

-- Tenant dashboard read model: one row per tenant, refreshed by events
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

-- Team dashboard read model: one row per organisational unit.
-- Deliberately WITHOUT any cost column — a line manager has no authority over
-- salary data, so the column does not exist at all rather than merely being
-- hidden by the API.
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

-- A trail of the events already projected: detects holes in the event stream
CREATE TABLE projection_checkpoints (
  projection_name text PRIMARY KEY,
  last_event_id   uuid,
  last_event_at   timestamptz,
  events_processed bigint NOT NULL DEFAULT 0,
  lag_seconds     integer,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

> **A consequence that has to be communicated to users:** the numbers on the dashboard are *eventually consistent* — usually 1–3 seconds behind what actually happened. For reports that require absolute accuracy (a payroll recap for tax filing), `reporting-service` is not used at all; the report is taken directly from the service that owns the data.

---

## 12. Indexing & Partitioning Strategy

| Query pattern | Service | Index |
|---------------|---------|-------|
| Daily attendance dashboard per unit | reporting | `idx_rpt_daily_unit` |
| Payroll pulling the period recap | attendance | `idx_daily_payroll ... INCLUDE (...)` — index-only scan |
| A manager's approval inbox | leave | Partial index `WHERE status='PENDING'` |
| Leave calendar (date range) | leave | GiST on `daterange` |
| Employee search by partial name | employee | GIN `gin_trgm_ops` |
| Candidate search by skill | recruitment | GIN `tsvector` |
| Historical attendance logs | attendance | Monthly partitions + local indexes |
| Detecting a stale replica | all | `idx_employee_ref_stale` |

**Partition automation** (`attendance_db`), run on the 25th of every month for the month ahead:

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

## 13. Migrating Data out of Excel

Is the import handled by `reporting-service`? No — an import writes into many domains, so it runs as a **saga** coordinated by a dedicated import service inside `api-gateway`, with staging in a database of its own.

```sql
-- import_db (owned by import-orchestrator, part of api-gateway)
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

**The import flow:** upload → parse into staging → map the columns → validate row by row → preview → commit in batches of 500 rows to the destination service over gRPC → an error report that can be corrected and re-uploaded.

The principle carried over from the reference-system analysis: **an import must never fail entirely because of one wrong cell.** That is the experience which decides whether an Excel user is willing to move at all.
