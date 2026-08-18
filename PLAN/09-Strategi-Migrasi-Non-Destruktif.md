# 09 — Strategi Migrasi Non-Destruktif

---

## 1. Prinsip Dasar

### 1.1 Lima Aturan yang Mengikat

| # | Aturan | Konsekuensi teknis |
|---|--------|-------------------|
| **M1** | **Forward-only.** Tidak ada `down migration` yang dijalankan di produksi | Perbaikan dilakukan dengan migrasi maju baru, bukan dengan membalik migrasi lama |
| **M2** | **Aditif lebih dulu.** Setiap perubahan dimulai dengan menambah, tidak pernah dengan mengubah di tempat | `ADD COLUMN`, bukan `ALTER COLUMN TYPE`. `ADD COLUMN` baru, bukan `RENAME` |
| **M3** | **Dua versi harus bisa hidup bersamaan.** Skema harus kompatibel dengan versi aplikasi lama dan baru selama rolling update | Tidak ada perubahan yang membuat versi aplikasi sebelumnya gagal |
| **M4** | **Tidak ada `DROP DATABASE`, `DROP TABLE`, atau `TRUNCATE` di produksi.** Selamanya | Ditegakkan gerbang CI, bukan kesepakatan lisan |
| **M5** | **Penghapusan kolom hanya lewat tangga deprekasi berjenjang** dengan arsip, minimal 3 rilis dan 90 hari | Data lama tetap dapat dipulihkan |

### 1.2 Mengapa Bukan Sekadar "Jangan Pernah Hapus"

Larangan mutlak terdengar aman, tetapi menghasilkan masalah lain yang sama seriusnya:

- Kolom mati menumpuk. Setelah dua tahun, `employees` punya 40 kolom yang 12 di antaranya tidak dipakai dan tidak ada yang berani menyentuh.
- Setiap developer baru harus menebak kolom mana yang hidup.
- Indeks pada kolom mati tetap memakan ruang dan memperlambat setiap `INSERT`.
- Kolom lama yang berisi PII tetap menyimpan data pribadi yang seharusnya sudah dihapus — masalah kepatuhan UU PDP, bukan sekadar kebersihan kode.

**Pendekatan yang dipakai: penghapusan bukan dilarang, melainkan dibuat lambat, terlihat, dan dapat dibatalkan.**

```
Rilis N     : kolom ditandai deprecated di katalog; monitor pembacaan
Rilis N+1   : aplikasi berhenti membaca; kolom masih ditulis (dual-write)
Rilis N+2   : aplikasi berhenti menulis; nol akses selama ≥ 30 hari
Rilis N+3   : kolom DISALIN ke tabel arsip, lalu dilepas dari tabel aktif
              (setelah 90 hari total + verifikasi nol akses + 2 persetujuan)
```

Yang dilepas adalah kolom dari tabel aktif; datanya tetap ada di `_archive`. Basis data tidak pernah di-drop, dan tidak ada data yang benar-benar hilang.

---

## 2. Daftar Operasi: Aman, Berbahaya, Terlarang

### 2.1 Klasifikasi

| Operasi | Status | Kunci yang diambil | Catatan |
|---------|--------|-------------------|---------|
| `ADD COLUMN` (nullable, tanpa default) | ✅ Aman | ACCESS EXCLUSIVE, instan | Hanya ubah katalog |
| `ADD COLUMN ... DEFAULT <konstanta>` | ✅ Aman (PG 11+) | ACCESS EXCLUSIVE, instan | Tanpa penulisan ulang tabel |
| `ADD COLUMN ... DEFAULT <fungsi volatile>` | ⚠️ Berbahaya | Penulisan ulang penuh | Contoh: `DEFAULT random()`, `DEFAULT now()` pada tabel besar |
| `ADD COLUMN ... NOT NULL` tanpa default | ❌ Terlarang | Gagal bila ada baris | Pakai pola dua langkah (§3.3) |
| `CREATE INDEX` | ❌ Terlarang | SHARE, memblokir tulis | Selalu pakai `CONCURRENTLY` |
| `CREATE INDEX CONCURRENTLY` | ✅ Aman | Tidak memblokir | Tidak boleh di dalam transaksi |
| `ADD CONSTRAINT ... NOT VALID` | ✅ Aman | Sebentar | Lalu `VALIDATE CONSTRAINT` terpisah |
| `VALIDATE CONSTRAINT` | ✅ Aman | SHARE UPDATE EXCLUSIVE | Tidak memblokir baca/tulis |
| `ADD CONSTRAINT` (langsung valid) | ⚠️ Berbahaya | ACCESS EXCLUSIVE + pemindaian penuh | Pada tabel besar bisa menit |
| `SET NOT NULL` | ⚠️ Berbahaya | Pemindaian penuh | Aman bila ada CHECK tervalidasi lebih dulu (PG 12+) |
| `DROP NOT NULL` | ✅ Aman | Instan | Melonggarkan, bukan mengetatkan |
| `ALTER COLUMN TYPE` (memperlebar) | ⚠️ Bergantung | Lihat §3.4 | `varchar(50)→varchar(100)`, `numeric(10,2)→numeric(18,2)` tanpa rewrite |
| `ALTER COLUMN TYPE` (mengubah tipe) | ❌ Terlarang | Penulisan ulang penuh + ACCESS EXCLUSIVE | Pakai kolom baru + backfill (§3.4) |
| `ALTER COLUMN TYPE` (mempersempit) | ❌ Terlarang | Rewrite + risiko kehilangan data | Tidak pernah |
| `RENAME COLUMN` / `RENAME TABLE` | ❌ Terlarang | Instan tapi merusak M3 | Versi aplikasi lama langsung gagal |
| `ALTER TYPE ... ADD VALUE` (enum) | ⚠️ Bergantung | Instan | Tidak dapat dipakai di transaksi yang sama; lihat §3.6 |
| `ALTER TYPE ... RENAME VALUE` | ❌ Terlarang | — | Merusak versi aplikasi lama |
| Menghapus nilai enum | ❌ Tidak mungkin | — | PostgreSQL tidak mendukungnya |
| `DROP COLUMN` | ❌ Terlarang tanpa tangga deprekasi | ACCESS EXCLUSIVE | §5 |
| `DROP TABLE` / `TRUNCATE` / `DROP DATABASE` | ❌ **Terlarang mutlak** | — | Tidak ada pengecualian di produksi |

### 2.2 Pengaman Wajib di Setiap Migrasi

```sql
-- Header WAJIB pada setiap berkas migrasi
-- Tanpa ini, satu ALTER yang menunggu lock akan mengantre di belakang
-- query panjang, dan SEMUA query berikutnya mengantre di belakangnya.
-- Satu migrasi bisa membekukan seluruh tabel selama berjam-jam.
SET lock_timeout = '3s';
SET statement_timeout = '60s';
SET idle_in_transaction_session_timeout = '30s';
```

Runner migrasi mengulang otomatis bila `lock_timeout` terlampaui:

```typescript
// packages/shared/src/migration/safe-runner.ts
export async function runWithLockRetry(sql: string, opts = { attempts: 10 }) {
  for (let i = 1; i <= opts.attempts; i++) {
    try {
      await prisma.$executeRawUnsafe(`SET lock_timeout = '3s'; ${sql}`);
      return;
    } catch (err: any) {
      if (err.code !== '55P03') throw err;              // bukan lock_not_available
      const wait = Math.min(2 ** i * 1000, 60_000);
      logger.warn({ attempt: i, waitMs: wait }, 'lock tidak tersedia, mencoba lagi');
      await sleep(wait);
    }
  }
  throw new Error('MIGRATION_LOCK_TIMEOUT: gagal memperoleh lock setelah 10 percobaan');
}
```

---

## 3. Resep Migrasi Aman

### 3.1 Menambah Kolom

```sql
-- ✅ Aman, instan, kompatibel dengan versi aplikasi lama
ALTER TABLE employees ADD COLUMN IF NOT EXISTS blood_type text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS remote_work_eligible boolean NOT NULL DEFAULT false;

-- ❌ Berbahaya pada tabel besar: default volatile memicu penulisan ulang penuh
-- ALTER TABLE punch_logs ADD COLUMN processed_at timestamptz NOT NULL DEFAULT now();

-- ✅ Alternatif aman untuk kasus di atas
ALTER TABLE punch_logs ADD COLUMN IF NOT EXISTS processed_at timestamptz;
-- lalu backfill bertahap (§4), lalu SET NOT NULL bila memang wajib (§3.3)
```

`IF NOT EXISTS` dipakai di seluruh migrasi agar setiap berkas **idempoten** — dijalankan dua kali tidak menimbulkan kesalahan. Ini penting karena migrasi bisa terputus di tengah dan diulang.

### 3.2 Menambah Indeks

```sql
-- CREATE INDEX CONCURRENTLY tidak dapat berjalan di dalam blok transaksi.
-- Prisma membungkus migrasi dalam transaksi, sehingga berkas ini
-- harus ditandai agar dijalankan di luar transaksi.
-- prisma-migration-config: { "transaction": false }

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_employees_blood_type
  ON employees (tenant_id, blood_type) WHERE deleted_at IS NULL;
```

Indeks `CONCURRENTLY` dapat berakhir dalam keadaan `INVALID` bila gagal. Migrasi berikutnya harus memeriksanya:

```sql
DO $$
DECLARE inv record;
BEGIN
  FOR inv IN
    SELECT c.relname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE NOT i.indisvalid
  LOOP
    RAISE NOTICE 'Indeks tidak valid ditemukan: %, membangun ulang', inv.relname;
    EXECUTE format('DROP INDEX CONCURRENTLY IF EXISTS %I', inv.relname);
    -- indeks dibuat ulang oleh migrasi ini
  END LOOP;
END $$;
```

> `DROP INDEX` adalah satu-satunya operasi `DROP` yang diizinkan, karena indeks bukan data — ia dapat dibangun ulang kapan saja dari tabel.

### 3.3 Membuat Kolom Menjadi NOT NULL

Dilakukan dalam empat langkah lintas rilis, bukan sekali jalan.

```sql
-- Rilis N — tambah kolom nullable + default untuk baris baru
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS priority text DEFAULT 'NORMAL';

-- Rilis N (aplikasi) — mulai mengisi kolom pada setiap penulisan

-- Rilis N+1 — backfill baris lama secara bertahap (§4), lalu:
-- CHECK NOT VALID hanya memeriksa baris BARU; tidak memindai tabel, tidak memblokir
ALTER TABLE leave_requests
  ADD CONSTRAINT chk_priority_not_null CHECK (priority IS NOT NULL) NOT VALID;

-- Rilis N+2 — validasi baris lama. SHARE UPDATE EXCLUSIVE: baca & tulis tetap berjalan
ALTER TABLE leave_requests VALIDATE CONSTRAINT chk_priority_not_null;

-- Rilis N+3 — PG 12+ memakai CHECK yang sudah tervalidasi, sehingga SET NOT NULL
-- tidak perlu memindai ulang tabel dan selesai instan
ALTER TABLE leave_requests ALTER COLUMN priority SET NOT NULL;
ALTER TABLE leave_requests DROP CONSTRAINT chk_priority_not_null;   -- constraint, bukan data
```

### 3.4 Mengubah Tipe Kolom

Ada dua kategori yang harus dibedakan, karena satu aman dan satu berbahaya.

**Kategori aman — tanpa penulisan ulang tabel:**

```sql
-- Memperlebar varchar, atau varchar → text
ALTER TABLE employees ALTER COLUMN phone TYPE varchar(50);      -- dari varchar(20)
ALTER TABLE employees ALTER COLUMN notes TYPE text;             -- dari varchar(500)

-- Menaikkan presisi numeric tanpa mengubah skala
ALTER TABLE payslips ALTER COLUMN gross_amount TYPE numeric(20,2);  -- dari numeric(18,2)
```

**Kategori berbahaya — semua perubahan tipe lain.** Contoh: `integer → bigint`, `text → jsonb`, `timestamp → timestamptz`. Ini memicu penulisan ulang penuh dengan `ACCESS EXCLUSIVE`, yang pada tabel 50 juta baris berarti downtime menit hingga jam.

Pola yang dipakai: **kolom bayangan + tulis ganda + backfill + pertukaran pembacaan.**

```sql
-- ══ Rilis N: tambah kolom baru ══
ALTER TABLE punch_logs ADD COLUMN IF NOT EXISTS device_meta_v2 jsonb;

-- Trigger tulis-ganda: menjaga kedua kolom sinkron tanpa mengubah kode aplikasi lama.
-- Versi aplikasi lama tetap menulis device_meta (text); trigger mengisi versi jsonb.
CREATE OR REPLACE FUNCTION sync_device_meta() RETURNS trigger AS $$
BEGIN
  IF NEW.device_meta IS NOT NULL AND NEW.device_meta_v2 IS NULL THEN
    BEGIN
      NEW.device_meta_v2 := NEW.device_meta::jsonb;
    EXCEPTION WHEN others THEN
      -- Data lama yang tidak valid JSON tidak boleh menggagalkan INSERT.
      -- Dicatat untuk diperbaiki manual, bukan dilewatkan diam-diam.
      INSERT INTO migration_anomalies (table_name, row_id, column_name, raw_value, error, detected_at)
      VALUES ('punch_logs', NEW.id, 'device_meta', NEW.device_meta, SQLERRM, now());
    END;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_device_meta
  BEFORE INSERT OR UPDATE ON punch_logs
  FOR EACH ROW EXECUTE FUNCTION sync_device_meta();

-- ══ Rilis N+1: backfill bertahap (§4) ══
-- ══ Rilis N+2: aplikasi membaca device_meta_v2 ══
-- ══ Rilis N+3: aplikasi berhenti menulis device_meta; trigger dilepas ══
-- ══ Rilis N+4: device_meta masuk tangga deprekasi (§5) ══
```

### 3.5 Mengganti Nama Kolom

`RENAME` instan di basis data tetapi langsung mematikan versi aplikasi lama yang masih berjalan — melanggar M3. Diganti dengan pola alias:

```sql
-- ❌ ALTER TABLE employees RENAME COLUMN nama_lengkap TO full_name;

-- ✅ Rilis N: kolom baru + tulis ganda dua arah
ALTER TABLE employees ADD COLUMN IF NOT EXISTS full_name text;

CREATE OR REPLACE FUNCTION sync_employee_name() RETURNS trigger AS $$
BEGIN
  -- Dua arah: aplikasi versi lama menulis nama_lengkap, versi baru menulis full_name.
  -- Keduanya berjalan bersamaan selama rolling update.
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

-- Rilis N+1: backfill · Rilis N+2: aplikasi pakai full_name
-- Rilis N+3: trigger dilepas · Rilis N+4: nama_lengkap masuk tangga deprekasi
```

### 3.6 Enum

PostgreSQL tidak dapat menghapus nilai enum, dan `RENAME VALUE` merusak versi aplikasi lama. Karena itu ada dua aturan:

**Aturan enum-1 — menambah nilai boleh, dan harus di luar transaksi:**

```sql
-- prisma-migration-config: { "transaction": false }
ALTER TYPE day_status ADD VALUE IF NOT EXISTS 'SUSPENDED';
-- Catatan: nilai baru tidak dapat dipakai dalam transaksi yang sama dengan
-- pembuatannya. Migrasi yang menambah nilai TIDAK boleh sekaligus memakainya.
```

**Aturan enum-2 — domain yang masih berkembang tidak memakai enum:**

| Pakai `enum` | Pakai `text` + `CHECK` |
|--------------|------------------------|
| Domain yang benar-benar stabil dan ditentukan regulasi | Domain yang kemungkinan bertambah atau berubah |
| Contoh: `punch_type` (IN/OUT/BREAK_START/BREAK_END) | Contoh: status alur kerja, kategori kasus, jenis dokumen |

```sql
-- Domain berkembang: text + CHECK. Menambah/mengubah nilai cukup
-- mengganti constraint — jauh lebih murah dan reversibel.
ALTER TABLE employee_issues
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'DISCIPLINE';

ALTER TABLE employee_issues
  ADD CONSTRAINT chk_issue_category
  CHECK (category IN ('DISCIPLINE','GRIEVANCE','CONFLICT','SAFETY')) NOT VALID;
ALTER TABLE employee_issues VALIDATE CONSTRAINT chk_issue_category;

-- Menambah kategori baru di rilis berikutnya:
ALTER TABLE employee_issues DROP CONSTRAINT IF EXISTS chk_issue_category;
ALTER TABLE employee_issues
  ADD CONSTRAINT chk_issue_category
  CHECK (category IN ('DISCIPLINE','GRIEVANCE','CONFLICT','SAFETY','HARASSMENT')) NOT VALID;
ALTER TABLE employee_issues VALIDATE CONSTRAINT chk_issue_category;
```

> Enum yang sudah terlanjur dipakai untuk domain berkembang **tidak dikonversi paksa**. Konversinya mahal dan berisiko. Aturan ini berlaku untuk kolom baru; kolom lama dibiarkan sampai ada alasan lain untuk menyentuhnya.

### 3.7 Menambah Foreign Key & Unique Constraint

```sql
-- ❌ Memindai seluruh tabel sambil memegang ACCESS EXCLUSIVE
-- ALTER TABLE payslips ADD CONSTRAINT fk_run FOREIGN KEY (run_id) REFERENCES runs(id);

-- ✅ Dua langkah
ALTER TABLE payslips
  ADD CONSTRAINT fk_run FOREIGN KEY (run_id) REFERENCES runs(id) NOT VALID;   -- instan
ALTER TABLE payslips VALIDATE CONSTRAINT fk_run;                              -- tidak memblokir

-- Unique constraint: bangun indeks dulu secara concurrent, baru pasang constraint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_payslip_run_employee
  ON payslips (run_id, employee_id);
ALTER TABLE payslips
  ADD CONSTRAINT uq_payslip_run_employee UNIQUE USING INDEX uq_payslip_run_employee;
```

### 3.8 Memecah dan Menggabung Tabel

Tabel lama **tidak pernah dihapus**; ia menjadi view agar versi aplikasi lama tetap berfungsi.

```sql
-- ══ Rilis N: tabel baru + tulis ganda ══
CREATE TABLE IF NOT EXISTS employee_contacts (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  value       text NOT NULL,
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT apply_rls_everywhere();       -- WAJIB: tabel baru harus terlindungi RLS

-- Trigger menjaga employees.phone dan employee_contacts tetap sinkron
CREATE OR REPLACE FUNCTION sync_employee_contact() RETURNS trigger AS $$
BEGIN
  IF NEW.phone IS DISTINCT FROM COALESCE(OLD.phone, '') THEN
    INSERT INTO employee_contacts (tenant_id, employee_id, kind, value, is_primary)
    VALUES (NEW.tenant_id, NEW.id, 'PHONE', NEW.phone, true)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ══ Rilis N+2: kolom lama dibaca lewat view kompatibilitas ══
-- (setelah kolom phone masuk tangga deprekasi, akses lama tetap berfungsi)
CREATE OR REPLACE VIEW v_employees_legacy AS
SELECT e.*,
       (SELECT value FROM employee_contacts c
         WHERE c.employee_id = e.id AND c.kind = 'PHONE' AND c.is_primary
         LIMIT 1) AS phone_compat
  FROM employees e;
```

### 3.9 Partisi

Manajemen partisi bersifat aditif dan aman. Partisi lama **tidak di-drop**, melainkan dilepas dan diarsipkan:

```sql
-- Menambah partisi bulan depan: aman, dijalankan terjadwal tanggal 25
SELECT ensure_punch_partition(date_trunc('month', CURRENT_DATE + interval '1 month')::date);

-- Mengarsipkan partisi lama: DETACH, bukan DROP.
-- Tabelnya tetap ada dan tetap dapat di-query; hanya tidak lagi menjadi bagian
-- tabel induk sehingga tidak membebani planner.
ALTER TABLE punch_logs DETACH PARTITION punch_logs_2024m01 CONCURRENTLY;
ALTER TABLE punch_logs_2024m01 SET SCHEMA archive;
-- Data historis tetap utuh dan dapat dipasang kembali bila dibutuhkan
```

---

## 4. Backfill: Mengisi Data Lama

Backfill adalah bagian migrasi yang paling sering menjatuhkan produksi, karena `UPDATE employees SET x = y` pada 5 juta baris mengunci tabel dan membanjiri WAL.

### 4.1 Aturan Backfill

| Aturan | Alasan |
|--------|--------|
| Selalu berbatch (500–5.000 baris) | Transaksi pendek, lock pendek |
| Selalu dapat dilanjutkan (resumable) | Proses bisa mati di tengah |
| Selalu idempoten | Dijalankan ulang tidak merusak |
| Selalu di-throttle | Melindungi beban produksi |
| Selalu sadar tenant | Tenant besar tidak boleh memblokir tenant kecil |
| Tidak pernah di dalam berkas migrasi | Migrasi harus selesai cepat; backfill adalah job terpisah |

### 4.2 Kerangka Backfill

```sql
-- Tabel pelacak, ada di setiap basis data service
CREATE TABLE IF NOT EXISTS backfill_jobs (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  name           text UNIQUE NOT NULL,          -- 'employees.full_name.20260817'
  target_table   text NOT NULL,
  status         text NOT NULL DEFAULT 'PENDING', -- PENDING/RUNNING/PAUSED/DONE/FAILED
  cursor_value   text,                          -- posisi terakhir (id terurut)
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
      // Jeda otomatis bila produksi sedang tertekan.
      // Backfill tidak pernah lebih penting daripada request pengguna.
      const load = await this.metrics.currentLoad();
      if (load.dbCpuPct > 70 || load.replicationLagSec > 10) {
        logger.warn({ job: job.name, load }, 'beban tinggi, backfill dijeda 60 detik');
        await sleep(60_000);
        continue;
      }

      const processed = await this.prisma.$transaction(async (tx) => {
        // Kunci: WHERE hanya menyentuh baris yang BELUM diproses.
        // Ini yang membuat backfill idempoten dan dapat dilanjutkan.
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
      await sleep(state.throttleMs);                 // beri ruang bernapas
      state = await this.repo.load(job.name);        // hormati jeda manual dari operator
      if (state.status === 'PAUSED') return;
    }

    await this.repo.complete(job.name);
    metrics.increment('backfill.completed', { job: job.name });
  }
}
```

### 4.3 Contoh Spesifikasi

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
  // Verifikasi wajib sebelum job dinyatakan selesai
  verifySql: `SELECT count(*) FROM employees WHERE full_name IS NULL AND nama_lengkap IS NOT NULL`,
  expectVerifyZero: true,
};
```

### 4.4 Backfill di Basis Data Terpartisi

`punch_logs` berukuran ratusan juta baris. Backfill dilakukan **per partisi**, bukan pada tabel induk, sehingga setiap batch hanya menyentuh satu bulan data dan partisi lama yang sudah selesai tidak disentuh lagi.

---

## 5. Tangga Deprekasi Kolom

### 5.1 Katalog Deprekasi

```sql
CREATE TABLE IF NOT EXISTS deprecated_columns (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  table_name        text NOT NULL,
  column_name       text NOT NULL,
  deprecated_at     timestamptz NOT NULL DEFAULT now(),
  deprecated_in_release text NOT NULL,
  replacement       text,                       -- kolom/tabel pengganti
  reason            text NOT NULL,
  stage             text NOT NULL DEFAULT 'ANNOUNCED',
    -- ANNOUNCED → READ_STOPPED → WRITE_STOPPED → ARCHIVED → DETACHED
  last_read_at      timestamptz,                -- dipantau; harus tetap NULL setelah READ_STOPPED
  archived_at       timestamptz,
  archive_table     text,
  detached_at       timestamptz,
  approved_by       uuid[],                     -- minimal 2 untuk tahap DETACHED
  eligible_after    timestamptz NOT NULL,       -- deprecated_at + 90 hari
  UNIQUE (table_name, column_name)
);

-- Komentar di kolom: terlihat langsung oleh siapa pun yang membaca skema
COMMENT ON COLUMN employees.nama_lengkap IS
  'DEPRECATED sejak 2026-08-17 (rilis 2.4). Gunakan full_name. Dilepas paling cepat 2026-11-15.';
```

### 5.2 Prosedur Pelepasan

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
    RAISE EXCEPTION 'DETACH_DENIED: kolom tidak terdaftar di katalog deprekasi';
  END IF;
  IF dep.stage <> 'WRITE_STOPPED' THEN
    RAISE EXCEPTION 'DETACH_DENIED: tahap saat ini %, harus WRITE_STOPPED', dep.stage;
  END IF;
  IF now() < dep.eligible_after THEN
    RAISE EXCEPTION 'DETACH_DENIED: masa tunggu 90 hari belum terpenuhi (berakhir %)', dep.eligible_after;
  END IF;
  IF dep.last_read_at IS NOT NULL AND dep.last_read_at > now() - interval '30 days' THEN
    RAISE EXCEPTION 'DETACH_DENIED: kolom masih dibaca pada %', dep.last_read_at;
  END IF;
  IF array_length(p_approvals, 1) < 2 THEN
    RAISE EXCEPTION 'DETACH_DENIED: butuh minimal 2 persetujuan';
  END IF;

  archive_tbl := format('archive.%s__%s', p_table, p_column);

  IF p_dry_run THEN
    EXECUTE format('SELECT count(*) FROM %I WHERE %I IS NOT NULL', p_table, p_column) INTO cnt;
    RETURN format('DRY RUN: %s baris akan diarsipkan ke %s', cnt, archive_tbl);
  END IF;

  -- 1. Salin data ke arsip SEBELUM apa pun dilepas
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %s AS SELECT id, tenant_id, %I, now() AS archived_at FROM %I WHERE %I IS NOT NULL',
    archive_tbl, p_column, p_table, p_column);

  -- 2. Baru lepaskan kolom dari tabel aktif
  EXECUTE format('ALTER TABLE %I DROP COLUMN %I', p_table, p_column);

  UPDATE deprecated_columns
     SET stage = 'DETACHED', archived_at = now(), archive_table = archive_tbl,
         detached_at = now(), approved_by = p_approvals
   WHERE table_name = p_table AND column_name = p_column;

  RETURN format('Kolom %I.%I diarsipkan ke %s dan dilepas', p_table, p_column, archive_tbl);
END $$ LANGUAGE plpgsql SECURITY DEFINER;
```

Fungsi ini **default `dry_run = true`** dan memiliki lima prasyarat keras. Sama seperti purge tenant di dokumen `06`: kesulitan menjalankannya adalah fitur, bukan gangguan.

### 5.3 Deteksi Kolom Masih Terbaca

Tahap `READ_STOPPED` tidak boleh berdasarkan keyakinan, melainkan bukti:

```sql
-- Dijalankan harian; mencari kolom deprecated yang masih muncul di query
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
      RAISE WARNING 'Kolom deprecated %.% masih diakses', d.table_name, d.column_name;
    END IF;
  END LOOP;
END $$ LANGUAGE plpgsql;
```

Deteksi ini tidak sempurna (pencocokan teks bisa keliru), tetapi **kesalahannya condong ke arah aman**: false positive menunda pelepasan, bukan mempercepatnya.

---

## 6. Migrasi pada Arsitektur Microservices

### 6.1 Migrasi Bersifat Lokal per Service

Setiap service memigrasikan basis datanya sendiri. Tidak ada migrasi terpusat, karena tidak ada satu pun proses yang memiliki kredensial ke semua basis data.

```
services/payroll-service/prisma/migrations/
├── 20260817120000_add_thr_component/
│   ├── migration.sql
│   └── meta.json           { "transaction": true, "estimatedLockMs": 5, "reviewedBy": [...] }
├── 20260901090000_backfill_ptkp_status/
│   ├── migration.sql       (hanya DDL; backfill dijalankan job terpisah)
│   └── backfill.ts
└── 20260915100000_index_payslip_period/
    ├── migration.sql       (CREATE INDEX CONCURRENTLY)
    └── meta.json           { "transaction": false }
```

### 6.2 Migrasi Skema vs Migrasi Kontrak

Ini pembeda terbesar dibanding monolit: mengubah skema tidak cukup, karena **kontrak event dan gRPC juga harus bermigrasi non-destruktif**.

| Perubahan | Skema | Kontrak |
|-----------|-------|---------|
| Menambah field opsional | `ADD COLUMN` | Tetap `v1`; konsumen lama mengabaikannya |
| Mengubah arti field | Kolom baru | **Terbitkan `v2`, publikasikan `v1` dan `v2` paralel ≥ 1 rilis** |
| Menghapus field | Tangga deprekasi | Hentikan `v1` hanya setelah semua konsumen pindah |
| Menambah RPC gRPC | — | Aditif, aman |
| Mengubah signature RPC | — | RPC baru; `buf breaking` menggagalkan CI bila yang lama diubah |

```typescript
// Publikasi paralel selama masa transisi
await Outbox.emit(tx, { type: 'employee.employee.updated', version: 1, payload: legacyShape });
await Outbox.emit(tx, { type: 'employee.employee.updated', version: 2, payload: newShape });

// Dihentikan hanya setelah dashboard konsumen menunjukkan nol konsumsi v1 selama 14 hari
```

### 6.3 Migrasi Tabel Replika

Perubahan pada `employees` sering berarti perubahan pada `employee_ref` di tujuh service lain. Ini titik paling rawan lupa.

**Urutan wajib:**

```
1. employee-service  : ADD COLUMN (data sumber)
2. contracts         : field baru sebagai OPSIONAL di event v1
3. employee-service  : mulai menerbitkan field baru
4. tiap konsumen     : ADD COLUMN pada employee_ref lokal (nullable)
5. tiap konsumen     : konsumer mengisi kolom baru
6. rekonsiliasi      : full resync mengisi baris lama
7. tiap konsumen     : mulai membaca kolom baru
```

Membalik urutan 1 dan 4 menyebabkan konsumen menerima field yang belum ada tempatnya. Membalik 3 dan 4 menyebabkan field hilang tanpa jejak — kasus yang paling sulit didiagnosis karena tidak menimbulkan error.

```typescript
// Gerbang CI: perubahan pada kontrak employee memaksa peninjauan seluruh konsumen
// .github/workflows/replica-check.yml
// Bila packages/contracts/src/events/employee.*.ts berubah, PR wajib mencantumkan
// checklist konsumen yang sudah disesuaikan; tanpa itu, CI gagal.
```

### 6.4 Migrasi saat Modul Diaktifkan

Konsisten dengan dokumen `05` §10 dan `01` §2.1: `onEnable` menjalankan migrasi, `onDisable` **tidak pernah menghapus data**.

```typescript
export default defineService({
  key: 'claim',
  onEnable: async (ctx) => {
    await ctx.runMigrations();              // aditif; aman dijalankan berulang
    await ctx.seedDefaults();               // ON CONFLICT DO NOTHING
    await ctx.registerPermissions();
    await ctx.showMenus();
  },
  onDisable: async (ctx) => {
    await ctx.hideMenus();                  // is_visible = false
    await ctx.revokePermissions();
    await ctx.pauseScheduledJobs();
    // Tabel, data, dan konfigurasi TIDAK disentuh.
    // Tenant yang mengaktifkan kembali 6 bulan kemudian menemukan semuanya utuh.
  },
});
```

---

## 7. Perkakas & Gerbang CI

### 7.1 Prisma Membutuhkan Pagar

`prisma migrate dev` menghasilkan SQL destruktif tanpa ragu — ia akan menulis `DROP COLUMN` dan `ALTER COLUMN TYPE` bila skema berubah. Karena itu alurnya diubah:

```bash
# ❌ Tidak dipakai untuk produksi
# prisma migrate dev

# ✅ Alur yang dipakai
pnpm prisma migrate diff \
  --from-schema-datamodel prisma/schema.prisma \
  --to-schema-datasource "$DATABASE_URL" \
  --script > /tmp/candidate.sql

pnpm migration:lint /tmp/candidate.sql     # menolak operasi terlarang
# SQL diperiksa dan diedit manual menjadi bentuk aman, lalu disimpan sebagai migrasi
```

### 7.2 Linter Migrasi

```typescript
// tools/migration-lint/rules.ts
export const FORBIDDEN: LintRule[] = [
  { pattern: /\bDROP\s+DATABASE\b/i,  severity: 'ERROR',
    message: 'DROP DATABASE dilarang mutlak.' },
  { pattern: /\bDROP\s+TABLE\b/i,     severity: 'ERROR',
    message: 'DROP TABLE dilarang. Pindahkan ke schema archive bila perlu.' },
  { pattern: /\bTRUNCATE\b/i,         severity: 'ERROR',
    message: 'TRUNCATE dilarang.' },
  { pattern: /\bDROP\s+COLUMN\b/i,    severity: 'ERROR',
    message: 'DROP COLUMN hanya lewat archive_and_detach_column() dengan 2 persetujuan.' },
  { pattern: /\bRENAME\s+(COLUMN|TO)\b/i, severity: 'ERROR',
    message: 'RENAME merusak kompatibilitas versi. Pakai pola kolom baru + tulis ganda.' },
  { pattern: /ALTER\s+TYPE\s+\w+\s+RENAME\s+VALUE/i, severity: 'ERROR',
    message: 'RENAME VALUE pada enum merusak versi aplikasi lama.' },
  { pattern: /CREATE\s+(UNIQUE\s+)?INDEX(?!\s+CONCURRENTLY)/i, severity: 'ERROR',
    message: 'Gunakan CREATE INDEX CONCURRENTLY.' },
  { pattern: /ALTER\s+TABLE\s+\w+\s+ALTER\s+COLUMN\s+\w+\s+TYPE/i, severity: 'WARN',
    message: 'Perubahan tipe: pastikan tidak memicu rewrite. Lihat dok. 09 §3.4.' },
  { pattern: /ADD\s+COLUMN.*NOT\s+NULL(?!.*DEFAULT)/i, severity: 'ERROR',
    message: 'ADD COLUMN NOT NULL tanpa DEFAULT akan gagal. Pakai pola empat langkah §3.3.' },
  { pattern: /ADD\s+CONSTRAINT(?![\s\S]*NOT\s+VALID)/i, severity: 'WARN',
    message: 'Pertimbangkan NOT VALID + VALIDATE terpisah untuk tabel besar.' },
  { pattern: /^(?![\s\S]*SET\s+lock_timeout)/i, severity: 'ERROR', appliesTo: 'file',
    message: 'Setiap migrasi wajib menetapkan lock_timeout.' },
];

// Pengecualian hanya lewat anotasi eksplisit yang terlihat di review:
// -- migration-lint-disable-next-line DROP_COLUMN reason="archive_and_detach_column, approved MIG-142"
```

### 7.3 Pipeline CI

```yaml
name: migration-safety
on: [pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres: { image: postgres:16, ports: ['5432:5432'] }
    steps:
      - uses: actions/checkout@v4

      - name: Lint SQL migrasi
        run: pnpm migration:lint services/*/prisma/migrations/**/migration.sql

      - name: Uji maju dari skema produksi terkini
        run: |
          pnpm db:restore-schema-snapshot        # skema produksi (tanpa data)
          pnpm prisma migrate deploy
          pnpm prisma migrate status --exit-code

      - name: Uji kompatibilitas versi lama
        run: |
          # Skema baru + kode versi SEBELUMNYA harus tetap lulus tes.
          # Ini yang memverifikasi aturan M3.
          git checkout HEAD~1 -- services/
          pnpm test:integration
          git checkout HEAD -- services/

      - name: Uji dengan volume produksi
        run: |
          pnpm db:seed-large --rows=5000000      # tabel terbesar
          pnpm migration:timing                  # gagal bila ada lock > 2 detik

      - name: Verifikasi RLS pada tabel baru
        run: pnpm test:rls-coverage              # 100% tabel ber-tenant_id

      - name: Verifikasi idempotensi
        run: |
          pnpm prisma migrate deploy             # jalankan kedua kali
          pnpm prisma migrate deploy             # dan ketiga kali
```

### 7.4 Templat PR Migrasi

```markdown
## Migrasi Basis Data

- **Service:** payroll-service
- **Tabel terdampak:** payslips (± 12 juta baris)
- **Perkiraan durasi lock:** < 10 ms
- **Butuh backfill:** Ya — `payslips.tax_method.20260817`
- **Kompatibel versi sebelumnya:** Ya

### Ceklis
- [ ] Hanya operasi aditif (`ADD COLUMN` / `ADD CONSTRAINT NOT VALID` / `CREATE INDEX CONCURRENTLY`)
- [ ] Tidak ada `DROP` / `RENAME` / `TRUNCATE` / perubahan tipe yang memicu rewrite
- [ ] `SET lock_timeout` ada di berkas migrasi
- [ ] `IF NOT EXISTS` pada seluruh objek baru (idempoten)
- [ ] Tabel baru sudah dipanggil `apply_rls_everywhere()`
- [ ] Backfill sebagai job terpisah, berbatch, resumable, ter-throttle
- [ ] Kode versi sebelumnya tetap berfungsi dengan skema ini
- [ ] Kontrak event: field baru bersifat opsional, atau `v2` diterbitkan paralel
- [ ] Konsumen `employee_ref` sudah disesuaikan (bila menyentuh data yang direplikasi)
- [ ] Diuji pada snapshot berukuran produksi
```

---

## 8. Rollback: Maju, Bukan Mundur

### 8.1 Tidak Ada Down Migration di Produksi

Alasannya: bila migrasi maju sudah menulis data dalam bentuk baru, membalikkannya berarti kehilangan tulisan yang terjadi setelahnya. Down migration yang benar-benar aman hanya mungkin bila migrasi maju sepenuhnya aditif — dan bila memang aditif, membaliknya tidak perlu.

| Situasi | Tindakan |
|---------|----------|
| Migrasi gagal di tengah | Migrasi idempoten → jalankan ulang |
| Migrasi berhasil tetapi aplikasi bermasalah | **Rollback aplikasi saja.** Skema aditif tetap kompatibel dengan versi lama |
| Migrasi menyebabkan masalah performa | Migrasi maju baru: hapus indeks bermasalah, atau tambah indeks yang kurang |
| Kolom baru salah rancang | Biarkan. Tandai deprecated, buat kolom yang benar |
| Backfill mengisi nilai salah | Backfill koreksi baru; data asli masih ada di kolom sumber |

> Inilah alasan sesungguhnya aturan aditif bukan sekadar soal kerapian: **skema aditif membuat rollback aplikasi selalu aman.** Deploy dan migrasi menjadi dua hal yang dapat dibalik secara independen.

### 8.2 Urutan Deploy

```
1. Migrasi skema dijalankan (aditif, kompatibel dua arah)
2. Verifikasi: skema baru + kode LAMA masih sehat (health check, smoke test)
3. Deploy kode baru secara bertahap (rolling / canary)
4. Backfill dijalankan sebagai job terpisah, terpantau
5. Setelah backfill selesai & terverifikasi: aktifkan pembacaan kolom baru (feature flag)
6. Rilis berikutnya: hentikan penulisan kolom lama
7. ≥ 90 hari kemudian: tangga deprekasi (§5)
```

Langkah 2 sering dilewatkan dan justru paling berharga: ia membuktikan aturan M3 di lingkungan nyata, bukan hanya di CI.

---

## 9. Prosedur Khusus

### 9.1 Menambah Service Baru

Service baru berarti basis data baru. Ini satu-satunya kasus `CREATE DATABASE`, dan tetap tidak melibatkan `DROP` apa pun.

```sql
CREATE DATABASE claim_db;
CREATE ROLE claim_user LOGIN PASSWORD :'claim_pw' NOBYPASSRLS;
GRANT CONNECT ON DATABASE claim_db TO claim_user;
REVOKE ALL ON DATABASE claim_db FROM PUBLIC;

\connect claim_db
\i 00_foundation.sql        -- ekstensi, uuid_v7, outbox, processed_messages, employee_ref, RLS
\i 01_claim_schema.sql
SELECT apply_rls_everywhere();
```

### 9.2 Memecah Service

Bila `planning-service` suatu saat perlu dipecah, data **disalin**, bukan dipindahkan:

```
1. Buat basis data baru + skema
2. Salin data terkait (COPY, bukan MOVE) — sumber tetap utuh
3. Service baru mulai membaca dari basis datanya sendiri
4. Verifikasi paritas hasil selama ≥ 14 hari (bandingkan keluaran kedua jalur)
5. Alihkan penulisan ke service baru
6. Tabel lama masuk tangga deprekasi setelah 90 hari
```

### 9.3 Perubahan Regulasi Payroll

Kasus khusus yang tidak boleh mengubah data historis: perubahan tarif PPh21 tidak boleh mengubah slip gaji yang sudah terbit.

```sql
-- ❌ JANGAN: mengubah nilai konfigurasi yang sudah dipakai menghitung slip lama
-- UPDATE statutory_configs SET value = '{"rate": 0.06}' WHERE config_key = 'PPH21_TER';

-- ✅ Tambahkan baris baru dengan periode berlaku baru.
-- EXCLUDE constraint mencegah tumpang tindih periode.
UPDATE statutory_configs
   SET effective = daterange(lower(effective), '2027-01-01', '[)')
 WHERE config_key = 'PPH21_TER' AND upper_inf(effective);

INSERT INTO statutory_configs (config_key, effective, value, source_ref)
VALUES ('PPH21_TER', daterange('2027-01-01', NULL, '[)'),
        '{"brackets": [...]}'::jsonb, 'PMK 168/2026');
```

Prinsip yang sama berlaku untuk seluruh data berdimensi waktu: struktur gaji, kebijakan cuti, komponen payroll. **Riwayat tidak pernah ditimpa; ia ditutup dan dilanjutkan baris baru.**

---

## 9.4 Contoh Nyata: Menambahkan Bukti Presensi

Penambahan koordinat, foto, dan skor kepercayaan ke `punch_logs` (dokumen `10` §3.1) adalah contoh lengkap penerapan aturan di dokumen ini pada tabel terpartisi berisi ratusan juta baris:

| Langkah | Operasi | Mengapa aman |
|---------|---------|--------------|
| 1 | `ADD COLUMN IF NOT EXISTS` × 20, semuanya nullable atau ber-default konstanta | Hanya mengubah katalog; instan meski tabel berisi 200 juta baris |
| 2 | `ADD CONSTRAINT chk_review_status ... NOT VALID` | Tidak memindai baris lama |
| 3 | Migrasi terpisah: `VALIDATE CONSTRAINT` | `SHARE UPDATE EXCLUSIVE`; baca dan tulis tetap berjalan |
| 4 | `CREATE INDEX CONCURRENTLY` per partisi, bukan pada tabel induk | Setiap indeks hanya menyentuh satu bulan data |
| 5 | Tabel baru (`work_sites`, `attendance_policies`, dst.) + `apply_rls_everywhere()` | Aditif murni |
| 6 | Tanpa backfill | Kolom bukti hanya bermakna untuk presensi baru; presensi lama sah tanpa bukti |

Yang **tidak** dilakukan, dan alasannya:

- Tidak ada `ALTER COLUMN TYPE` pada `latitude`/`longitude` meski `numeric(9,6)` terasa sempit — perubahan tipe pada tabel terpartisi 200 juta baris berarti penulisan ulang setiap partisi.
- Tidak ada `NOT NULL` pada kolom bukti. Presensi dari mesin fingerprint tidak punya foto maupun koordinat, dan itu sah.
- Tidak ada penghapusan kolom `location_name` yang kini tergantikan `site_id` — ia masuk katalog deprekasi, bukan dilepas.

---

## 10. Pemantauan

| Metrik | Ambang | Arti |
|--------|--------|------|
| `migration_duration_seconds{service}` | > 30 dtk | Migrasi terlalu berat untuk jendela deploy |
| `migration_lock_wait_seconds` | > 2 dtk | Berisiko mengantrekan query lain |
| `backfill_progress_pct{job}` | Stagnan > 1 jam | Backfill macet |
| `backfill_lag_days{job}` | > 14 hari | Rilis berikutnya tidak boleh mengandalkan kolom ini |
| `deprecated_column_reads_total` | > 0 setelah `READ_STOPPED` | Ada kode yang belum bermigrasi |
| `migration_anomalies_unresolved` | > 0 | Data yang gagal dikonversi menunggu penanganan manual |
| `schema_drift_detected` | > 0 | Skema produksi berbeda dari migrasi — indikasi perubahan manual |
| `invalid_index_count` | > 0 | `CREATE INDEX CONCURRENTLY` gagal, perlu dibangun ulang |

Deteksi *schema drift* dijalankan harian dan membandingkan skema produksi dengan hasil menjalankan seluruh migrasi pada basis data kosong. Selisih apa pun berarti seseorang mengubah produksi secara manual — pelanggaran serius terhadap M1 yang harus segera diselidiki.

---

## 11. Dampak pada Dokumen Lain

| Dokumen | Perubahan |
|---------|-----------|
| `01` §8.2 | Pola ekspansi–kontraksi diperluas menjadi tangga deprekasi lengkap; linter migrasi masuk pipeline CI |
| `02` | Seluruh DDL memakai `IF NOT EXISTS`; `apply_rls_everywhere()` wajib dipanggil setelah tabel baru |
| `03` | Evolusi kontrak event mengikuti aturan yang sama: aditif dulu, `v2` paralel, hentikan setelah nol konsumsi |
| `05` §10 / `08` | `onDisable` tidak pernah menghapus data — sudah konsisten dengan M4 |
| `06` §4.2 | Purge tenant adalah **satu-satunya** penghapusan data yang diizinkan, dengan prasyarat sangat ketat |
| `04` | Gerbang CI migrasi masuk DoD Fase 1 |

---

## 12. Risiko

| # | Risiko | Prob. | Dampak | Mitigasi |
|---|--------|-------|--------|----------|
| **R32** | **Skema membengkak: kolom mati menumpuk karena tidak pernah dilepas** | **Tinggi** | Sedang | Tangga deprekasi dengan pelepasan terjadwal; tinjauan katalog `deprecated_columns` setiap kuartal |
| R33 | Migrasi memblokir tabel di jam sibuk | Sedang | Tinggi | `lock_timeout` wajib, retry berjenjang, jendela deploy di luar jam kerja, uji timing di CI |
| R34 | Backfill membanjiri basis data | Sedang | Tinggi | Berbatch, ter-throttle, jeda otomatis saat beban tinggi |
| R35 | Kolom deprecated dilepas padahal masih dipakai | Rendah | Tinggi | Prasyarat 5 lapis, deteksi pembacaan, arsip sebelum pelepasan, 2 persetujuan |
| R36 | Konsumen `employee_ref` lupa disesuaikan | **Sedang** | Tinggi | Gerbang CI pada perubahan kontrak; checklist konsumen wajib di PR |
| R37 | Seseorang mengubah skema produksi secara manual | Sedang | Tinggi | Deteksi drift harian; kredensial DDL produksi hanya dimiliki runner migrasi |
| R38 | PII tertinggal di kolom deprecated melewati masa retensi | Sedang | Tinggi | Kolom PII wajib memiliki `eligible_after` sesuai kebijakan retensi; arsip PII terenkripsi |

> R32 adalah risiko yang lahir langsung dari kebijakan non-destruktif itu sendiri. Ia tidak bisa dihilangkan, hanya dikelola — dan mengelolanya membutuhkan tinjauan kuartalan yang benar-benar dijalankan, bukan hanya dijadwalkan.
