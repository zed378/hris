# 09 — Non-Destructive Migration Strategy

---

## 1. Fundamental Principles

### 1.1 Five Binding Rules

| # | Rule | Technical consequence |
|---|------|----------------------|
| **M1** | **Forward-only.** No `down migration` is ever run in production | A fix is a new forward migration, not the reversal of an old one |
| **M2** | **Additive first.** Every change starts by adding, never by changing in place | `ADD COLUMN`, not `ALTER COLUMN TYPE`. A new `ADD COLUMN`, not a `RENAME` |
| **M3** | **Two versions must be able to live side by side.** The schema has to be compatible with both the old and the new application version throughout a rolling update | No change may make the previous application version fail |
| **M4** | **No `DROP DATABASE`, `DROP TABLE`, or `TRUNCATE` in production.** Ever | Enforced by a CI gate, not by verbal agreement |
| **M5** | **A column is only removed through a tiered deprecation ladder** with an archive, spanning at least 3 releases and 90 days | The old data remains recoverable |

### 1.2 Why Not Simply "Never Delete"

An absolute prohibition sounds safe, but it produces another problem just as serious:

- Dead columns accumulate. After two years `employees` has 40 columns, 12 of them unused and untouchable because nobody dares.
- Every new developer has to guess which columns are alive.
- Indexes on dead columns still consume space and slow down every `INSERT`.
- An old column holding PII keeps storing personal data that should already have been deleted — a Personal Data Protection Act compliance problem, not merely code hygiene.

**The approach taken: deletion is not forbidden, it is made slow, visible, and reversible.**

```
Release N     : the column is marked deprecated in the catalogue; reads are monitored
Release N+1   : the application stops reading it; it is still written (dual-write)
Release N+2   : the application stops writing it; zero access for ≥ 30 days
Release N+3   : the column is COPIED into an archive table, then detached from the live table
                (after 90 days total + verified zero access + 2 approvals)
```

What is detached is a column from a live table; the data still exists in `_archive`. The database is never dropped, and no data is genuinely lost.

---

## 2. The Operation List: Safe, Dangerous, Forbidden

### 2.1 Classification

| Operation | Status | Lock taken | Note |
|-----------|--------|------------|------|
| `ADD COLUMN` (nullable, no default) | ✅ Safe | ACCESS EXCLUSIVE, instant | Catalogue change only |
| `ADD COLUMN ... DEFAULT <constant>` | ✅ Safe (PG 11+) | ACCESS EXCLUSIVE, instant | No table rewrite |
| `ADD COLUMN ... DEFAULT <volatile function>` | ⚠️ Dangerous | Full rewrite | For example `DEFAULT random()`, `DEFAULT now()` on a large table |
| `ADD COLUMN ... NOT NULL` with no default | ❌ Forbidden | Fails if any row exists | Use the two-step pattern (§3.3) |
| `CREATE INDEX` | ❌ Forbidden | SHARE, blocks writes | Always use `CONCURRENTLY` |
| `CREATE INDEX CONCURRENTLY` | ✅ Safe | Non-blocking | Must not run inside a transaction |
| `ADD CONSTRAINT ... NOT VALID` | ✅ Safe | Brief | Followed by a separate `VALIDATE CONSTRAINT` |
| `VALIDATE CONSTRAINT` | ✅ Safe | SHARE UPDATE EXCLUSIVE | Does not block reads or writes |
| `ADD CONSTRAINT` (immediately valid) | ⚠️ Dangerous | ACCESS EXCLUSIVE + full scan | Minutes on a large table |
| `SET NOT NULL` | ⚠️ Dangerous | Full scan | Safe if a validated CHECK exists first (PG 12+) |
| `DROP NOT NULL` | ✅ Safe | Instant | It loosens rather than tightens |
| `ALTER COLUMN TYPE` (widening) | ⚠️ It depends | See §3.4 | `varchar(50)→varchar(100)`, `numeric(10,2)→numeric(18,2)` without a rewrite |
| `ALTER COLUMN TYPE` (changing type) | ❌ Forbidden | Full rewrite + ACCESS EXCLUSIVE | Use a new column + backfill (§3.4) |
| `ALTER COLUMN TYPE` (narrowing) | ❌ Forbidden | Rewrite + risk of data loss | Never |
| `RENAME COLUMN` / `RENAME TABLE` | ❌ Forbidden | Instant, but breaks M3 | The old application version fails immediately |
| `ALTER TYPE ... ADD VALUE` (enum) | ⚠️ It depends | Instant | Cannot be used in the same transaction; see §3.6 |
| `ALTER TYPE ... RENAME VALUE` | ❌ Forbidden | — | Breaks the old application version |
| Removing an enum value | ❌ Impossible | — | PostgreSQL does not support it |
| `DROP COLUMN` | ❌ Forbidden without the deprecation ladder | ACCESS EXCLUSIVE | §5 |
| `DROP TABLE` / `TRUNCATE` / `DROP DATABASE` | ❌ **Absolutely forbidden** | — | No exceptions in production |

### 2.2 Mandatory Safeguards in Every Migration

```sql
-- A MANDATORY header in every migration file
-- Without it, one ALTER waiting for a lock queues behind a long query, and
-- EVERY subsequent query queues behind that.
-- A single migration can freeze an entire table for hours.
SET lock_timeout = '3s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
```

The migration runner retries automatically when `lock_timeout` is exceeded:

```typescript
// packages/shared/src/migration/safe-runner.ts
export async function runWithLockRetry(sql: string, opts = { attempts: 10 }) {
  for (let i = 1; i <= opts.attempts; i++) {
    try {
      await prisma.$executeRawUnsafe(`SET lock_timeout = '3s'; ${sql}`);
      return;
    } catch (err: any) {
      if (err.code !== '55P03') throw err;              // not lock_not_available
      const wait = Math.min(2 ** i * 1000, 60_000);
      logger.warn({ attempt: i, waitMs: wait }, 'lock unavailable, retrying');
      await sleep(wait);
    }
  }
  throw new Error('MIGRATION_LOCK_TIMEOUT: could not acquire the lock after 10 attempts');
}
```

---

## 3. Safe Migration Recipes

### 3.1 Adding a Column

```sql
-- ✅ Safe, instant, compatible with the old application version
ALTER TABLE employees ADD COLUMN IF NOT EXISTS blood_type text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS remote_work_eligible boolean NOT NULL DEFAULT false;

-- ❌ Dangerous on a large table: a volatile default triggers a full rewrite
-- ALTER TABLE punch_logs ADD COLUMN processed_at timestamptz NOT NULL DEFAULT now();

-- ✅ The safe alternative for the case above
ALTER TABLE punch_logs ADD COLUMN IF NOT EXISTS processed_at timestamptz;
-- then backfill gradually (§4), then SET NOT NULL if it really is required (§3.3)
```

`IF NOT EXISTS` is used throughout so every file is **idempotent** — running it twice raises no error. This matters because a migration can be interrupted halfway and repeated.

### 3.2 Adding an Index

```sql
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- Prisma wraps migrations in a transaction, so this file has to be
-- marked to run outside one.
-- prisma-migration-config: { "transaction": false }

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_employees_blood_type
  ON employees (tenant_id, blood_type) WHERE deleted_at IS NULL;
```

A `CONCURRENTLY` index can end up `INVALID` if it fails. The next migration has to check for that:

```sql
DO $$
DECLARE inv record;
BEGIN
  FOR inv IN
    SELECT c.relname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE NOT i.indisvalid
  LOOP
    RAISE NOTICE 'Invalid index found: %, rebuilding', inv.relname;
    EXECUTE format('DROP INDEX CONCURRENTLY IF EXISTS %I', inv.relname);
    -- the index is recreated by this migration
  END LOOP;
END $$;
```

> `DROP INDEX` is the only `DROP` operation permitted, because an index is not data — it can be rebuilt from the table at any time.

### 3.3 Making a Column NOT NULL

Done in four steps across releases, not in one go.

```sql
-- Release N — add a nullable column with a default for new rows
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS priority text DEFAULT 'NORMAL';

-- Release N (application) — start filling the column on every write

-- Release N+1 — backfill the old rows gradually (§4), then:
-- A NOT VALID CHECK only examines NEW rows; it does not scan the table and does not block
ALTER TABLE leave_requests
  ADD CONSTRAINT chk_priority_not_null CHECK (priority IS NOT NULL) NOT VALID;

-- Release N+2 — validate the old rows. SHARE UPDATE EXCLUSIVE: reads and writes keep running
ALTER TABLE leave_requests VALIDATE CONSTRAINT chk_priority_not_null;

-- Release N+3 — PG 12+ uses the already-validated CHECK, so SET NOT NULL
-- needs no rescan and completes instantly
ALTER TABLE leave_requests ALTER COLUMN priority SET NOT NULL;
ALTER TABLE leave_requests DROP CONSTRAINT chk_priority_not_null;   -- a constraint, not data
```

### 3.4 Changing a Column's Type

There are two categories to distinguish, because one is safe and one is dangerous.

**The safe category — no table rewrite:**

```sql
-- Widening a varchar, or varchar → text
ALTER TABLE employees ALTER COLUMN phone TYPE varchar(50);      -- from varchar(20)
ALTER TABLE employees ALTER COLUMN notes TYPE text;             -- from varchar(500)

-- Raising numeric precision without changing the scale
ALTER TABLE payslips ALTER COLUMN gross_amount TYPE numeric(20,2);  -- from numeric(18,2)
```

**The dangerous category — every other type change.** For example `integer → bigint`, `text → jsonb`, `timestamp → timestamptz`. These trigger a full rewrite under `ACCESS EXCLUSIVE`, which on a 50-million-row table means minutes to hours of downtime.

The pattern used: **a shadow column + dual write + backfill + swapping the reads.**

```sql
-- ══ Release N: add the new column ══
ALTER TABLE punch_logs ADD COLUMN IF NOT EXISTS device_meta_v2 jsonb;

-- The dual-write trigger keeps both columns in sync without changing the old application code.
-- The old version keeps writing device_meta (text); the trigger fills the jsonb version.
CREATE OR REPLACE FUNCTION sync_device_meta() RETURNS trigger AS $$
BEGIN
  IF NEW.device_meta IS NOT NULL AND NEW.device_meta_v2 IS NULL THEN
    BEGIN
      NEW.device_meta_v2 := NEW.device_meta::jsonb;
    EXCEPTION WHEN others THEN
      -- Old data that is not valid JSON must not fail the INSERT.
      -- It is recorded for manual repair, not silently skipped.
      INSERT INTO migration_anomalies (table_name, row_id, column_name, raw_value, error, detected_at)
      VALUES ('punch_logs', NEW.id, 'device_meta', NEW.device_meta, SQLERRM, now());
    END;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_device_meta
  BEFORE INSERT OR UPDATE ON punch_logs
  FOR EACH ROW EXECUTE FUNCTION sync_device_meta();

-- ══ Release N+1: gradual backfill (§4) ══
-- ══ Release N+2: the application reads device_meta_v2 ══
-- ══ Release N+3: the application stops writing device_meta; the trigger is removed ══
-- ══ Release N+4: device_meta enters the deprecation ladder (§5) ══
```

### 3.5 Renaming a Column

`RENAME` is instant in the database but immediately kills the old application version still running — a breach of M3. It is replaced by an alias pattern:

```sql
-- ❌ ALTER TABLE employees RENAME COLUMN nama_lengkap TO full_name;

-- ✅ Release N: a new column + a two-way dual write
ALTER TABLE employees ADD COLUMN IF NOT EXISTS full_name text;

CREATE OR REPLACE FUNCTION sync_employee_name() RETURNS trigger AS $$
BEGIN
  -- Two-way: the old application version writes nama_lengkap, the new one writes full_name.
  -- Both run side by side during the rolling update.
  IF TG_OP = 'INSERT' THEN
    NEW.full_name    := COALESCE(NEW.full_name, NEW.nama_lengkap);
    NEW.nama_lengkap := COALESCE(NEW.nama_lengkap, NEW.full_name);
  ELSE
    IF NEW.full_name IS DISTINCT FROM OLD.full_name THEN
      NEW.nama_lengkap := NEW.full_name;
    ELSIF NEW.nama_lengkap IS DISTINCT FROM OLD.nama_lengkap THEN
      NEW.full_name := NEW.nama_lengkap;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_employee_name
  BEFORE INSERT OR UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION sync_employee_name();

-- Release N+1: backfill · Release N+2: the application uses full_name
-- Release N+3: the trigger is removed · Release N+4: nama_lengkap enters the deprecation ladder
```

### 3.6 Enums

PostgreSQL cannot remove an enum value, and `RENAME VALUE` breaks the old application version. Hence two rules:

**Enum rule 1 — adding a value is allowed, and must happen outside a transaction:**

```sql
-- prisma-migration-config: { "transaction": false }
ALTER TYPE day_status ADD VALUE IF NOT EXISTS 'SUSPENDED';
-- Note: a new value cannot be used in the same transaction that created it.
-- A migration that adds a value must NOT also use it.
```

**Enum rule 2 — a domain that is still evolving does not use an enum:**

| Use `enum` | Use `text` + `CHECK` |
|------------|----------------------|
| A domain that is genuinely stable and defined by regulation | A domain likely to grow or change |
| Example: `punch_type` (IN/OUT/BREAK_START/BREAK_END) | Example: workflow statuses, case categories, document kinds |

```sql
-- An evolving domain: text + CHECK. Adding or changing a value only means
-- swapping the constraint — far cheaper and reversible.
ALTER TABLE employee_issues
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'DISCIPLINE';

ALTER TABLE employee_issues
  ADD CONSTRAINT chk_issue_category
  CHECK (category IN ('DISCIPLINE','GRIEVANCE','CONFLICT','SAFETY')) NOT VALID;
ALTER TABLE employee_issues VALIDATE CONSTRAINT chk_issue_category;

-- Adding a new category in a later release:
ALTER TABLE employee_issues DROP CONSTRAINT IF EXISTS chk_issue_category;
ALTER TABLE employee_issues
  ADD CONSTRAINT chk_issue_category
  CHECK (category IN ('DISCIPLINE','GRIEVANCE','CONFLICT','SAFETY','HARASSMENT')) NOT VALID;
ALTER TABLE employee_issues VALIDATE CONSTRAINT chk_issue_category;
```

> An enum already in use for an evolving domain is **not force-converted**. The conversion is expensive and risky. This rule applies to new columns; existing ones are left alone until there is another reason to touch them.

### 3.7 Adding a Foreign Key & Unique Constraint

```sql
-- ❌ Scans the whole table while holding ACCESS EXCLUSIVE
-- ALTER TABLE payslips ADD CONSTRAINT fk_run FOREIGN KEY (run_id) REFERENCES runs(id);

-- ✅ Two steps
ALTER TABLE payslips
  ADD CONSTRAINT fk_run FOREIGN KEY (run_id) REFERENCES runs(id) NOT VALID;   -- instant
ALTER TABLE payslips VALIDATE CONSTRAINT fk_run;                              -- non-blocking

-- A unique constraint: build the index concurrently first, then attach the constraint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_payslip_run_employee
  ON payslips (run_id, employee_id);
ALTER TABLE payslips
  ADD CONSTRAINT uq_payslip_run_employee UNIQUE USING INDEX uq_payslip_run_employee;
```

### 3.8 Splitting and Merging Tables

The old table is **never dropped**; it becomes a view so the old application version keeps working.

```sql
-- ══ Release N: the new table + dual write ══
CREATE TABLE IF NOT EXISTS employee_contacts (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  value       text NOT NULL,
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT apply_rls_everywhere();       -- MANDATORY: a new table must be protected by RLS

-- The trigger keeps employees.phone and employee_contacts in sync
CREATE OR REPLACE FUNCTION sync_employee_contact() RETURNS trigger AS $$
BEGIN
  IF NEW.phone IS DISTINCT FROM COALESCE(OLD.phone, '') THEN
    INSERT INTO employee_contacts (tenant_id, employee_id, kind, value, is_primary)
    VALUES (NEW.tenant_id, NEW.id, 'PHONE', NEW.phone, true)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ══ Release N+2: the old column is read through a compatibility view ══
-- (once the phone column enters the deprecation ladder, old access still works)
CREATE OR REPLACE VIEW v_employees_legacy AS
SELECT e.*,
       (SELECT value FROM employee_contacts c
         WHERE c.employee_id = e.id AND c.kind = 'PHONE' AND c.is_primary
         LIMIT 1) AS phone_compat
  FROM employees e;
```

### 3.9 Partitions

Partition management is additive and safe. An old partition is **not dropped** but detached and archived:

```sql
-- Adding next month's partition: safe, scheduled for the 25th
SELECT ensure_punch_partition(date_trunc('month', CURRENT_DATE + interval '1 month')::date);

-- Archiving an old partition: DETACH, not DROP.
-- The table still exists and can still be queried; it is simply no longer part of
-- the parent table, so it no longer burdens the planner.
ALTER TABLE punch_logs DETACH PARTITION punch_logs_2024m01 CONCURRENTLY;
ALTER TABLE punch_logs_2024m01 SET SCHEMA archive;
-- The historical data stays intact and can be reattached if needed
```

---

## 4. Backfill: Filling In the Old Data

The backfill is the part of a migration that most often takes production down, because `UPDATE employees SET x = y` across 5 million rows locks the table and floods the WAL.

### 4.1 Backfill Rules

| Rule | Reason |
|------|--------|
| Always batched (500–5,000 rows) | Short transactions, short locks |
| Always resumable | The process can die halfway |
| Always idempotent | Re-running breaks nothing |
| Always throttled | It protects the production load |
| Always tenant-aware | A large tenant must not block a small one |
| Never inside a migration file | A migration has to finish fast; a backfill is a separate job |

### 4.2 The Backfill Framework

```sql
-- The tracking table, present in every service database
CREATE TABLE IF NOT EXISTS backfill_jobs (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  name           text UNIQUE NOT NULL,          -- 'employees.full_name.20260817'
  target_table   text NOT NULL,
  status         text NOT NULL DEFAULT 'PENDING', -- PENDING/RUNNING/PAUSED/DONE/FAILED
  cursor_value   text,                          -- the last position (ordered id)
  rows_processed bigint NOT NULL DEFAULT 0,
  rows_total     bigint,
  batch_size     integer NOT NULL DEFAULT 1000,
  throttle_ms    integer NOT NULL DEFAULT 100,
  started_at     timestamptz,
  completed_at   timestamptz,
  last_error     text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS migration_anomalies (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name  text NOT NULL,
  row_id      uuid,
  column_name text,
  raw_value   text,
  error       text,
  resolved_at timestamptz,
  detected_at timestamptz NOT NULL DEFAULT now()
);
```

```typescript
// packages/shared/src/migration/backfill-runner.ts
export class BackfillRunner {
  async run(job: BackfillJobSpec) {
    let state = await this.repo.loadOrCreate(job.name);
    if (state.status === 'DONE') return;

    await this.repo.setStatus(job.name, 'RUNNING');

    for (;;) {
      // Pause automatically when production is under pressure.
      // A backfill is never more important than a user request.
      const load = await this.metrics.currentLoad();
      if (load.dbCpuPct > 70 || load.replicationLagSec > 10) {
        logger.warn({ job: job.name, load }, 'load high, backfill paused for 60 seconds');
        await sleep(60_000);
        continue;
      }

      const processed = await this.prisma.$transaction(async (tx) => {
        // The key: WHERE only touches rows that have NOT been processed.
        // That is what makes the backfill idempotent and resumable.
        const rows = await tx.$queryRawUnsafe<{ id: string }[]>(`
          ${job.selectSql}
           WHERE ${job.pendingPredicate}
             AND id > $1
           ORDER BY id
           LIMIT $2
           FOR UPDATE SKIP LOCKED`,
          state.cursorValue ?? '00000000-0000-0000-0000-000000000000',
          state.batchSize);

        if (!rows.length) return 0;

        await tx.$executeRawUnsafe(job.updateSql, rows.map(r => r.id));
        await tx.$executeRaw`
          UPDATE backfill_jobs
             SET cursor_value = ${rows.at(-1)!.id},
                 rows_processed = rows_processed + ${rows.length},
                 updated_at = now()
           WHERE name = ${job.name}`;
        return rows.length;
      });

      if (processed === 0) break;
      await sleep(state.throttleMs);                 // leave room to breathe
      state = await this.repo.load(job.name);        // honour a manual pause from an operator
      if (state.status === 'PAUSED') return;
    }

    await this.repo.complete(job.name);
    metrics.increment('backfill.completed', { job: job.name });
  }
}
```

### 4.3 An Example Specification

```typescript
// services/employee-service/src/migrations/backfills/20260817-full-name.ts
export const backfillFullName: BackfillJobSpec = {
  name: 'employees.full_name.20260817',
  targetTable: 'employees',
  selectSql: `SELECT id FROM employees`,
  pendingPredicate: `full_name IS NULL AND nama_lengkap IS NOT NULL`,
  updateSql: `UPDATE employees SET full_name = nama_lengkap WHERE id = ANY($1::uuid[])`,
  batchSize: 1000,
  throttleMs: 100,
  // A mandatory verification before the job may be declared finished
  verifySql: `SELECT count(*) FROM employees WHERE full_name IS NULL AND nama_lengkap IS NOT NULL`,
  expectVerifyZero: true,
};
```

### 4.4 Backfilling a Partitioned Database

`punch_logs` holds hundreds of millions of rows. The backfill runs **per partition** rather than against the parent table, so each batch touches only one month of data and a finished partition is never touched again.

---

## 5. The Column Deprecation Ladder

### 5.1 The Deprecation Catalogue

```sql
CREATE TABLE IF NOT EXISTS deprecated_columns (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  table_name        text NOT NULL,
  column_name       text NOT NULL,
  deprecated_at     timestamptz NOT NULL DEFAULT now(),
  deprecated_in_release text NOT NULL,
  replacement       text,                       -- the replacement column/table
  reason            text NOT NULL,
  stage             text NOT NULL DEFAULT 'ANNOUNCED',
    -- ANNOUNCED → READ_STOPPED → WRITE_STOPPED → ARCHIVED → DETACHED
  last_read_at      timestamptz,                -- monitored; must stay NULL after READ_STOPPED
  archived_at       timestamptz,
  archive_table     text,
  detached_at       timestamptz,
  approved_by       uuid[],                     -- at least 2 for the DETACHED stage
  eligible_after    timestamptz NOT NULL,       -- deprecated_at + 90 days
  UNIQUE (table_name, column_name)
);

-- A column comment: immediately visible to anyone reading the schema
COMMENT ON COLUMN employees.nama_lengkap IS
  'DEPRECATED since 2026-08-17 (release 2.4). Use full_name. Removable no earlier than 2026-11-15.';
```

### 5.2 The Removal Procedure

```sql
CREATE OR REPLACE FUNCTION archive_and_detach_column(
  p_table text, p_column text, p_approvals uuid[], p_dry_run boolean DEFAULT true
) RETURNS text AS $$
DECLARE
  dep record;
  archive_tbl text;
  cnt bigint;
BEGIN
  SELECT * INTO dep FROM deprecated_columns
   WHERE table_name = p_table AND column_name = p_column;

  IF dep IS NULL THEN
    RAISE EXCEPTION 'DETACH_DENIED: the column is not registered in the deprecation catalogue';
  END IF;
  IF dep.stage <> 'WRITE_STOPPED' THEN
    RAISE EXCEPTION 'DETACH_DENIED: current stage is %, it must be WRITE_STOPPED', dep.stage;
  END IF;
  IF now() < dep.eligible_after THEN
    RAISE EXCEPTION 'DETACH_DENIED: the 90-day waiting period is not over (ends %)', dep.eligible_after;
  END IF;
  IF dep.last_read_at IS NOT NULL AND dep.last_read_at > now() - interval '30 days' THEN
    RAISE EXCEPTION 'DETACH_DENIED: the column was still read at %', dep.last_read_at;
  END IF;
  IF array_length(p_approvals, 1) < 2 THEN
    RAISE EXCEPTION 'DETACH_DENIED: at least 2 approvals are required';
  END IF;

  archive_tbl := format('archive.%s__%s', p_table, p_column);

  IF p_dry_run THEN
    EXECUTE format('SELECT count(*) FROM %I WHERE %I IS NOT NULL', p_table, p_column) INTO cnt;
    RETURN format('DRY RUN: %s rows would be archived into %s', cnt, archive_tbl);
  END IF;

  -- 1. Copy the data into the archive BEFORE anything is detached
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %s AS SELECT id, tenant_id, %I, now() AS archived_at FROM %I WHERE %I IS NOT NULL',
    archive_tbl, p_column, p_table, p_column);

  -- 2. Only then detach the column from the live table
  EXECUTE format('ALTER TABLE %I DROP COLUMN %I', p_table, p_column);

  UPDATE deprecated_columns
     SET stage = 'DETACHED', archived_at = now(), archive_table = archive_tbl,
         detached_at = now(), approved_by = p_approvals
   WHERE table_name = p_table AND column_name = p_column;

  RETURN format('Column %I.%I archived into %s and detached', p_table, p_column, archive_tbl);
END $$ LANGUAGE plpgsql SECURITY DEFINER;
```

This function **defaults to `dry_run = true`** and has five hard preconditions. Just like the tenant purge in document `06`: the difficulty of running it is a feature, not friction.

### 5.3 Detecting Columns That Are Still Read

The `READ_STOPPED` stage must rest on evidence, not belief:

```sql
-- Run daily; looks for deprecated columns still appearing in queries
CREATE OR REPLACE FUNCTION detect_deprecated_column_reads() RETURNS void AS $$
DECLARE d record;
BEGIN
  FOR d IN SELECT * FROM deprecated_columns WHERE stage IN ('READ_STOPPED','WRITE_STOPPED')
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_stat_statements
       WHERE query ILIKE '%' || d.column_name || '%'
         AND query ILIKE '%' || d.table_name || '%'
         AND calls > 0
    ) THEN
      UPDATE deprecated_columns SET last_read_at = now()
       WHERE table_name = d.table_name AND column_name = d.column_name;
      RAISE WARNING 'Deprecated column %.% is still being accessed', d.table_name, d.column_name;
    END IF;
  END LOOP;
END $$ LANGUAGE plpgsql;
```

The detection is imperfect (text matching can be wrong), but **its errors lean towards safety**: a false positive delays removal rather than hastening it.

---

## 6. Migrations Under a Microservices Architecture

### 6.1 Migrations Are Local to a Service

Every service migrates its own database. There is no central migration, because no single process holds credentials to every database.

```
services/payroll-service/prisma/migrations/
├── 20260817120000_add_thr_component/
│   ├── migration.sql
│   └── meta.json           { "transaction": true, "estimatedLockMs": 5, "reviewedBy": [...] }
├── 20260901090000_backfill_ptkp_status/
│   ├── migration.sql       (DDL only; the backfill runs as a separate job)
│   └── backfill.ts
└── 20260915100000_index_payslip_period/
    ├── migration.sql       (CREATE INDEX CONCURRENTLY)
    └── meta.json           { "transaction": false }
```

### 6.2 Schema Migration vs Contract Migration

This is the biggest difference from a monolith: changing the schema is not enough, because **the event and gRPC contracts also have to migrate non-destructively**.

| Change | Schema | Contract |
|--------|--------|----------|
| Adding an optional field | `ADD COLUMN` | Stays `v1`; old consumers ignore it |
| Changing a field's meaning | A new column | **Publish `v2`, and publish `v1` and `v2` in parallel for ≥ 1 release** |
| Removing a field | The deprecation ladder | Retire `v1` only once every consumer has moved |
| Adding a gRPC RPC | — | Additive, safe |
| Changing an RPC signature | — | A new RPC; `buf breaking` fails CI if the old one is changed |

```typescript
// Parallel publication during the transition period
await Outbox.emit(tx, { type: 'employee.employee.updated', version: 1, payload: legacyShape });
await Outbox.emit(tx, { type: 'employee.employee.updated', version: 2, payload: newShape });

// Stopped only once the consumer dashboard shows zero v1 consumption for 14 days
```

### 6.3 Migrating Replica Tables

A change to `employees` often means a change to `employee_ref` in seven other services. This is the easiest thing in the system to forget.

**The mandatory order:**

```
1. employee-service  : ADD COLUMN (the source data)
2. contracts         : the new field, OPTIONAL, in event v1
3. employee-service  : start publishing the new field
4. each consumer     : ADD COLUMN on its local employee_ref (nullable)
5. each consumer     : the consumer starts filling the new column
6. reconciliation    : a full resync fills the old rows
7. each consumer     : start reading the new column
```

Swapping steps 1 and 4 makes consumers receive a field with nowhere to put it. Swapping 3 and 4 makes the field vanish without a trace — the hardest case to diagnose, because it raises no error.

```typescript
// A CI gate: a change to the employee contract forces a review of every consumer
// .github/workflows/replica-check.yml
// If packages/contracts/src/events/employee.*.ts changes, the PR must include a
// checklist of the consumers already adjusted; without it, CI fails.
```

### 6.4 Migrating When a Module Is Enabled

Consistent with document `05` §10 and `01` §2.1: `onEnable` runs the migrations, `onDisable` **never deletes data**.

```typescript
export default defineService({
  key: 'claim',
  onEnable: async (ctx) => {
    await ctx.runMigrations();              // additive; safe to run repeatedly
    await ctx.seedDefaults();               // ON CONFLICT DO NOTHING
    await ctx.registerPermissions();
    await ctx.showMenus();
  },
  onDisable: async (ctx) => {
    await ctx.hideMenus();                  // is_visible = false
    await ctx.revokePermissions();
    await ctx.pauseScheduledJobs();
    // Tables, data, and configuration are NOT touched.
    // A tenant re-enabling it 6 months later finds everything intact.
  },
});
```

---

## 7. Tooling & CI Gates

### 7.1 Prisma Needs Fences

`prisma migrate dev` generates destructive SQL without hesitation — it will write `DROP COLUMN` and `ALTER COLUMN TYPE` whenever the schema changes. So the workflow is changed:

```bash
# ❌ Not used for production
# prisma migrate dev

# ✅ The workflow used
pnpm prisma migrate diff \
  --from-schema-datamodel prisma/schema.prisma \
  --to-schema-datasource "$DATABASE_URL" \
  --script > /tmp/candidate.sql

pnpm migration:lint /tmp/candidate.sql     # rejects forbidden operations
# The SQL is reviewed and hand-edited into a safe form, then saved as a migration
```

### 7.2 The Migration Linter

```typescript
// tools/migration-lint/rules.ts
export const FORBIDDEN: LintRule[] = [
  { pattern: /\bDROP\s+DATABASE\b/i,  severity: 'ERROR',
    message: 'DROP DATABASE is absolutely forbidden.' },
  { pattern: /\bDROP\s+TABLE\b/i,     severity: 'ERROR',
    message: 'DROP TABLE is forbidden. Move it to the archive schema if necessary.' },
  { pattern: /\bTRUNCATE\b/i,         severity: 'ERROR',
    message: 'TRUNCATE is forbidden.' },
  { pattern: /\bDROP\s+COLUMN\b/i,    severity: 'ERROR',
    message: 'DROP COLUMN only through archive_and_detach_column() with 2 approvals.' },
  { pattern: /\bRENAME\s+(COLUMN|TO)\b/i, severity: 'ERROR',
    message: 'RENAME breaks version compatibility. Use the new column + dual write pattern.' },
  { pattern: /ALTER\s+TYPE\s+\w+\s+RENAME\s+VALUE/i, severity: 'ERROR',
    message: 'RENAME VALUE on an enum breaks the old application version.' },
  { pattern: /CREATE\s+(UNIQUE\s+)?INDEX(?!\s+CONCURRENTLY)/i, severity: 'ERROR',
    message: 'Use CREATE INDEX CONCURRENTLY.' },
  { pattern: /ALTER\s+TABLE\s+\w+\s+ALTER\s+COLUMN\s+\w+\s+TYPE/i, severity: 'WARN',
    message: 'Type change: make sure it triggers no rewrite. See doc. 09 §3.4.' },
  { pattern: /ADD\s+COLUMN.*NOT\s+NULL(?!.*DEFAULT)/i, severity: 'ERROR',
    message: 'ADD COLUMN NOT NULL without a DEFAULT will fail. Use the four-step pattern in §3.3.' },
  { pattern: /ADD\s+CONSTRAINT(?![\s\S]*NOT\s+VALID)/i, severity: 'WARN',
    message: 'Consider NOT VALID + a separate VALIDATE for a large table.' },
  { pattern: /^(?![\s\S]*SET\s+lock_timeout)/i, severity: 'ERROR', appliesTo: 'file',
    message: 'Every migration must set lock_timeout.' },
];

// An exception is only possible through an explicit annotation, visible in review:
// -- migration-lint-disable-next-line DROP_COLUMN reason="archive_and_detach_column, approved MIG-142"
```

### 7.3 The CI Pipeline

```yaml
name: migration-safety
on: [pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres: { image: postgres:18, ports: ['5432:5432'] }
    steps:
      - uses: actions/checkout@v4

      - name: Lint the migration SQL
        run: pnpm migration:lint services/*/prisma/migrations/**/migration.sql

      - name: Roll forward from the current production schema
        run: |
          pnpm db:restore-schema-snapshot        # the production schema (without data)
          pnpm prisma migrate deploy
          pnpm prisma migrate status --exit-code

      - name: Test compatibility with the previous version
        run: |
          # The new schema plus the PREVIOUS code version must still pass the tests.
          # This is what verifies rule M3.
          git checkout HEAD~1 -- services/
          pnpm test:integration
          git checkout HEAD -- services/

      - name: Test at production volume
        run: |
          pnpm db:seed-large --rows=5000000      # the largest table
          pnpm migration:timing                  # fails if any lock exceeds 2 seconds

      - name: Verify RLS on new tables
        run: pnpm test:rls-coverage              # 100% of tenant_id tables

      - name: Verify idempotency
        run: |
          pnpm prisma migrate deploy             # run a second time
          pnpm prisma migrate deploy             # and a third
```

### 7.4 The Migration PR Template

```markdown
## Database Migration

- **Service:** payroll-service
- **Tables affected:** payslips (± 12 million rows)
- **Estimated lock duration:** < 10 ms
- **Needs a backfill:** Yes — `payslips.tax_method.20260817`
- **Compatible with the previous version:** Yes

### Checklist
- [ ] Additive operations only (`ADD COLUMN` / `ADD CONSTRAINT NOT VALID` / `CREATE INDEX CONCURRENTLY`)
- [ ] No `DROP` / `RENAME` / `TRUNCATE` / type change that triggers a rewrite
- [ ] `SET lock_timeout` present in the migration file
- [ ] `IF NOT EXISTS` on every new object (idempotent)
- [ ] `apply_rls_everywhere()` called for any new table
- [ ] The backfill is a separate job: batched, resumable, throttled
- [ ] The previous code version still works against this schema
- [ ] Event contracts: the new field is optional, or `v2` is published in parallel
- [ ] `employee_ref` consumers have been adjusted (if replicated data is touched)
- [ ] Tested against a production-sized snapshot
```

---

## 8. Rollback: Forward, Not Backward

### 8.1 No Down Migrations in Production

The reason: once the forward migration has written data in the new shape, reversing it means losing everything written since. A genuinely safe down migration is only possible when the forward migration was entirely additive — and if it was additive, reversing it is unnecessary.

| Situation | Action |
|-----------|--------|
| The migration failed halfway | The migration is idempotent → run it again |
| The migration succeeded but the application misbehaves | **Roll back the application only.** An additive schema stays compatible with the old version |
| The migration caused a performance problem | A new forward migration: drop the problem index, or add the missing one |
| A new column was designed wrongly | Leave it. Mark it deprecated and create the right one |
| The backfill wrote wrong values | A new corrective backfill; the original data still exists in the source column |

> This is the real reason the additive rule is not merely about tidiness: **an additive schema makes an application rollback always safe.** Deploys and migrations become two things that can be reversed independently.

### 8.2 The Deploy Order

```
1. Run the schema migration (additive, compatible both ways)
2. Verify: the new schema + the OLD code is still healthy (health check, smoke test)
3. Deploy the new code gradually (rolling / canary)
4. Run the backfill as a separate, monitored job
5. Once the backfill is finished and verified: turn on reads of the new column (feature flag)
6. Next release: stop writing the old column
7. ≥ 90 days later: the deprecation ladder (§5)
```

Step 2 is often skipped and is precisely the most valuable one: it proves rule M3 in a real environment, not only in CI.

---

## 9. Special Procedures

### 9.1 Adding a New Service

A new service means a new database. This is the only `CREATE DATABASE` case, and it still involves no `DROP` of any kind.

```sql
CREATE DATABASE claim_db;
CREATE ROLE claim_user LOGIN PASSWORD :'claim_pw' NOBYPASSRLS;
GRANT CONNECT ON DATABASE claim_db TO claim_user;
REVOKE ALL ON DATABASE claim_db FROM PUBLIC;

\connect claim_db
\i 00_foundation.sql        -- extensions, uuid_v7, outbox, processed_messages, employee_ref, RLS
\i 01_claim_schema.sql
SELECT apply_rls_everywhere();
```

### 9.2 Splitting a Service

If `planning-service` ever needs splitting, the data is **copied**, not moved:

```
1. Create the new database and schema
2. Copy the relevant data (COPY, not MOVE) — the source stays intact
3. The new service starts reading from its own database
4. Verify result parity for ≥ 14 days (compare the output of both paths)
5. Redirect writes to the new service
6. The old table enters the deprecation ladder after 90 days
```

### 9.3 Payroll Regulation Changes

A special case that must not alter historical data: a change to the PPh21 rate must not change payslips that have already been issued.

```sql
-- ❌ DO NOT: change a configuration value already used to compute old payslips
-- UPDATE statutory_configs SET value = '{"rate": 0.06}' WHERE config_key = 'PPH21_TER';

-- ✅ Add a new row with a new effective period.
-- The EXCLUDE constraint prevents overlapping periods.
UPDATE statutory_configs
   SET effective = daterange(lower(effective), '2027-01-01', '[)')
 WHERE config_key = 'PPH21_TER' AND upper_inf(effective);

INSERT INTO statutory_configs (config_key, effective, value, source_ref)
VALUES ('PPH21_TER', daterange('2027-01-01', NULL, '[)'),
        '{"brackets": [...]}'::jsonb, 'PMK 168/2026');
```

The same principle governs every time-dimensioned piece of data: salary structures, leave policies, payroll components. **History is never overwritten; it is closed off and continued with a new row.**

---

## 9.4 A Real Example: Adding Attendance Evidence

Adding coordinates, photos, and trust scores to `punch_logs` (document `10` §3.1) is a complete example of these rules applied to a partitioned table holding hundreds of millions of rows:

| Step | Operation | Why it is safe |
|------|-----------|----------------|
| 1 | `ADD COLUMN IF NOT EXISTS` × 20, all nullable or with a constant default | Catalogue changes only; instant even at 200 million rows |
| 2 | `ADD CONSTRAINT chk_review_status ... NOT VALID` | Does not scan the old rows |
| 3 | A separate migration: `VALIDATE CONSTRAINT` | `SHARE UPDATE EXCLUSIVE`; reads and writes keep running |
| 4 | `CREATE INDEX CONCURRENTLY` per partition, not on the parent table | Each index touches only one month of data |
| 5 | New tables (`work_sites`, `attendance_policies`, and so on) + `apply_rls_everywhere()` | Purely additive |
| 6 | No backfill | The evidence columns only mean anything for new punches; old punches are valid without evidence |

What was **not** done, and why:

- No `ALTER COLUMN TYPE` on `latitude`/`longitude` even though `numeric(9,6)` feels tight — a type change on a partitioned 200-million-row table means rewriting every partition.
- No `NOT NULL` on the evidence columns. A punch from a fingerprint machine has neither a photo nor coordinates, and that is legitimate.
- No removal of the `location_name` column now superseded by `site_id` — it enters the deprecation catalogue rather than being detached.

---

## 10. Monitoring

| Metric | Threshold | Meaning |
|--------|-----------|---------|
| `migration_duration_seconds{service}` | > 30 s | The migration is too heavy for the deploy window |
| `migration_lock_wait_seconds` | > 2 s | It risks queueing other queries behind it |
| `backfill_progress_pct{job}` | Stalled > 1 h | The backfill is stuck |
| `backfill_lag_days{job}` | > 14 days | The next release must not depend on this column |
| `deprecated_column_reads_total` | > 0 after `READ_STOPPED` | Some code has not migrated |
| `migration_anomalies_unresolved` | > 0 | Data that failed to convert is waiting on manual handling |
| `schema_drift_detected` | > 0 | The production schema differs from the migrations — an indication of a manual change |
| `invalid_index_count` | > 0 | A `CREATE INDEX CONCURRENTLY` failed and needs rebuilding |

Schema drift detection runs daily and compares the production schema against the result of running every migration on an empty database. Any difference means someone changed production by hand — a serious breach of M1 that must be investigated immediately.

---

## 11. Impact on the Other Documents

| Document | Change |
|----------|--------|
| `01` §8.2 | The expand–contract pattern is extended into a full deprecation ladder; the migration linter joins the CI pipeline |
| `02` | All DDL uses `IF NOT EXISTS`; `apply_rls_everywhere()` must be called after every new table |
| `03` | Event contract evolution follows the same rules: additive first, `v2` in parallel, retire only after zero consumption |
| `05` §10 / `08` | `onDisable` never deletes data — already consistent with M4 |
| `06` §4.2 | A tenant purge is the **only** permitted data deletion, under very strict preconditions |
| `04` | The migration CI gates join the Phase 1 DoD |

---

## 12. Risks

| # | Risk | Prob. | Impact | Mitigation |
|---|------|-------|--------|------------|
| **R32** | **Schema bloat: dead columns accumulate because they are never removed** | **High** | Medium | The deprecation ladder with scheduled removal; a quarterly review of the `deprecated_columns` catalogue |
| R33 | A migration locks a table during peak hours | Medium | High | Mandatory `lock_timeout`, tiered retry, deploy windows outside working hours, timing tests in CI |
| R34 | A backfill floods the database | Medium | High | Batched, throttled, auto-paused under high load |
| R35 | A deprecated column is removed while still in use | Low | High | Five layers of precondition, read detection, archiving before removal, 2 approvals |
| R36 | `employee_ref` consumers are forgotten | **Medium** | High | A CI gate on contract changes; a mandatory consumer checklist in the PR |
| R37 | Someone changes the production schema by hand | Medium | High | Daily drift detection; production DDL credentials belong to the migration runner alone |
| R38 | PII is left behind in a deprecated column past its retention period | Medium | High | A PII column must carry an `eligible_after` matching the retention policy; the PII archive is encrypted |

> R32 is a risk born directly from the non-destructive policy itself. It cannot be eliminated, only managed — and managing it requires a quarterly review that is actually carried out, not merely scheduled.
