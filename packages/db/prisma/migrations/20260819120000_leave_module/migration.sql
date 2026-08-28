-- Modul Cuti (PLAN/12 F4, skema dokumen 02 §8, konkurensi dokumen 03 §4.1).
--
-- Seluruh berkas ini berputar pada satu kalimat pada DoD Fase 4:
--
--   "50 persetujuan simultan pada saldo 2 hari → tepat 1 berhasil"
--
-- Yang menjamin itu bukan kode aplikasi, melainkan tiga lapis yang saling
-- menopang, dan lapisan terakhirnya ada di sini:
--
--   1. `SELECT … FOR UPDATE` pada baris saldo — transaksi kedua menunggu.
--   2. Validasi yang membaca nilai SETELAH lock diperoleh.
--   3. `chk_no_negative_balance` — jaring pengaman basis data.
--
-- Lapis ketiga tetap dipasang meski dua lapis pertama sudah benar. Ia yang
-- bertahan ketika seseorang menambahkan jalur tulis baru enam bulan dari
-- sekarang dan lupa mengambil lock-nya.

CREATE SCHEMA IF NOT EXISTS "leave";

-- Diperlukan constraint EXCLUDE yang menggabungkan kesamaan uuid dengan
-- tumpang tindih rentang tanggal.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "leave"."AccrualMethod" AS ENUM (
  'ANNUAL_GRANT', 'MONTHLY_ACCRUAL', 'ANNIVERSARY', 'UNLIMITED', 'NONE'
);

CREATE TYPE "leave"."RequestStatus" AS ENUM (
  'DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'TAKEN'
);

CREATE TABLE "leave"."leave_types" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_paid" BOOLEAN NOT NULL DEFAULT true,
    "accrual_method" "leave"."AccrualMethod" NOT NULL DEFAULT 'ANNUAL_GRANT',
    "default_quota_days" DECIMAL(5,2) NOT NULL DEFAULT 12,
    "max_carry_over_days" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "min_service_months" SMALLINT NOT NULL DEFAULT 12,
    "requires_attachment" BOOLEAN NOT NULL DEFAULT false,
    "deduct_from_balance" BOOLEAN NOT NULL DEFAULT true,
    "affects_payroll" BOOLEAN NOT NULL DEFAULT false,
    "color_hex" TEXT NOT NULL DEFAULT '#3b82f6',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "leave_types_tenant_id_code_key"
  ON "leave"."leave_types"("tenant_id", "code");

CREATE TABLE "leave"."leave_balances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "period_year" SMALLINT NOT NULL,

    "entitled_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "carried_over_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "adjustment_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "used_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    -- Ditahan saat pengajuan, bukan saat persetujuan.
    --
    -- Inilah yang mencegah seseorang mengajukan tiga cuti 2 hari di atas saldo
    -- 2 hari lalu menunggu ketiganya disetujui. Tanpa penahanan, saldo terlihat
    -- cukup pada setiap pengajuan karena tidak ada satu pun yang sudah memotong.
    "pending_days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "expired_days" DECIMAL(6,2) NOT NULL DEFAULT 0,

    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);

-- Kolom turunan, dihitung basis data.
--
-- Sengaja GENERATED, bukan dihitung di TypeScript. Rumus saldo yang hidup di
-- dua tempat akan berbeda pada hari seseorang menambahkan satu jenis mutasi
-- baru dan hanya memperbarui salah satunya — dan perbedaan itu muncul sebagai
-- karyawan yang saldonya tampak cukup di layar tetapi ditolak basis data.
ALTER TABLE "leave"."leave_balances"
  ADD COLUMN "available_days" DECIMAL(6,2)
  GENERATED ALWAYS AS (
    "entitled_days" + "carried_over_days" + "adjustment_days"
    - "used_days" - "pending_days" - "expired_days"
  ) STORED;

CREATE UNIQUE INDEX "leave_balances_tenant_employee_type_year_key"
  ON "leave"."leave_balances"("tenant_id", "employee_id", "leave_type_id", "period_year");

CREATE INDEX "leave_balances_tenant_id_employee_id_idx"
  ON "leave"."leave_balances"("tenant_id", "employee_id");

-- Jaring pengaman terakhir. Lihat penjelasan di kepala berkas ini.
ALTER TABLE "leave"."leave_balances"
  ADD CONSTRAINT "chk_no_negative_balance" CHECK (
    "entitled_days" + "carried_over_days" + "adjustment_days"
    - "used_days" - "pending_days" - "expired_days" >= 0
  );

CREATE TABLE "leave"."leave_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_number" TEXT NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,

    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "is_half_day" BOOLEAN NOT NULL DEFAULT false,
    "total_days" DECIMAL(5,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "attachment_key" TEXT,

    "status" "leave"."RequestStatus" NOT NULL DEFAULT 'DRAFT',
    "current_approver_id" UUID,
    "submitted_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "leave_requests_tenant_id_request_number_key"
  ON "leave"."leave_requests"("tenant_id", "request_number");

CREATE INDEX "leave_requests_tenant_id_employee_id_start_date_idx"
  ON "leave"."leave_requests"("tenant_id", "employee_id", "start_date");

CREATE INDEX "leave_requests_inbox_idx"
  ON "leave"."leave_requests"("tenant_id", "current_approver_id", "status")
  WHERE "status" = 'PENDING';

CREATE INDEX "leave_requests_calendar_idx"
  ON "leave"."leave_requests"("tenant_id", "start_date", "end_date")
  WHERE "status" IN ('APPROVED', 'TAKEN');

ALTER TABLE "leave"."leave_requests"
  ADD CONSTRAINT "leave_requests_dates_ordered" CHECK ("end_date" >= "start_date");

ALTER TABLE "leave"."leave_requests"
  ADD CONSTRAINT "leave_requests_days_positive" CHECK ("total_days" > 0);

-- Satu orang tidak dapat cuti dua kali pada hari yang sama.
--
-- Ditegakkan basis data, bukan dicek aplikasi, karena pemeriksaan aplikasi
-- selalu punya jendela antara membaca dan menulis. Dua pengajuan yang tiba
-- bersamaan akan sama-sama membaca "belum ada cuti di tanggal itu".
--
-- Rentangnya inklusif di kedua ujung: cuti 10-12 Agustus memang mencakup
-- tanggal 12. Memakai bentuk baku '[)' akan membuat cuti yang berakhir hari
-- Senin tidak dianggap bertumpang tindih dengan cuti yang mulai hari Senin.
ALTER TABLE "leave"."leave_requests"
  ADD CONSTRAINT "excl_leave_overlap" EXCLUDE USING gist (
    "employee_id" WITH =,
    daterange("start_date", "end_date", '[]') WITH &&
  ) WHERE ("status" IN ('PENDING', 'APPROVED', 'TAKEN'));

CREATE TABLE "leave"."leave_approvals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "step_order" SMALLINT NOT NULL,
    "approver_id" UUID NOT NULL,
    "decision" TEXT,
    "comment" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "leave_approvals_request_id_step_order_key"
  ON "leave"."leave_approvals"("request_id", "step_order");

ALTER TABLE "leave"."leave_approvals"
  ADD CONSTRAINT "leave_approvals_decision_known"
  CHECK ("decision" IS NULL OR "decision" IN ('APPROVED', 'REJECTED', 'DELEGATED'));

-- Buku besar mutasi saldo.
--
-- Setiap perubahan saldo meninggalkan barisnya di sini, tanpa kecuali. Saldo
-- adalah angka yang diperdebatkan karyawan, dan "saldo saya berkurang tiga hari
-- padahal saya cuti dua" adalah pertanyaan yang tidak dapat dijawab oleh kolom
-- angka — hanya oleh riwayat mutasinya.
CREATE TABLE "leave"."balance_ledger" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "balance_id" UUID NOT NULL,
    -- GRANT / ACCRUAL / HOLD / RELEASE / CONSUME / EXPIRE / ADJUST
    "entry_type" TEXT NOT NULL,
    -- Positif menambah saldo tersedia, negatif menguranginya.
    "days" DECIMAL(6,2) NOT NULL,
    "reference_type" TEXT,
    "reference_id" UUID,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_ledger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "balance_ledger_tenant_id_balance_id_created_at_idx"
  ON "leave"."balance_ledger"("tenant_id", "balance_id", "created_at");

ALTER TABLE "leave"."balance_ledger"
  ADD CONSTRAINT "balance_ledger_entry_type_known"
  CHECK ("entry_type" IN ('GRANT', 'ACCRUAL', 'HOLD', 'RELEASE', 'CONSUME', 'EXPIRE', 'ADJUST'));

-- -----------------------------------------------------------------------------
-- Kunci asing
-- -----------------------------------------------------------------------------
ALTER TABLE "leave"."leave_balances"
  ADD CONSTRAINT "leave_balances_leave_type_id_fkey"
  FOREIGN KEY ("leave_type_id") REFERENCES "leave"."leave_types"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "leave"."leave_requests"
  ADD CONSTRAINT "leave_requests_leave_type_id_fkey"
  FOREIGN KEY ("leave_type_id") REFERENCES "leave"."leave_types"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "leave"."leave_approvals"
  ADD CONSTRAINT "leave_approvals_request_id_fkey"
  FOREIGN KEY ("request_id") REFERENCES "leave"."leave_requests"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "leave"."balance_ledger"
  ADD CONSTRAINT "balance_ledger_balance_id_fkey"
  FOREIGN KEY ("balance_id") REFERENCES "leave"."leave_balances"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Hak akses dan RLS
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA "leave" TO hrms_app, hrms_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA "leave"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hrms_app, hrms_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA "leave"
  GRANT USAGE, SELECT ON SEQUENCES TO hrms_app, hrms_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "leave"
  TO hrms_app, hrms_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "leave" TO hrms_app, hrms_worker;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leave_types', 'leave_balances', 'leave_requests', 'leave_approvals', 'balance_ledger'
  ] LOOP
    EXECUTE format('ALTER TABLE "leave".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE "leave".%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON "leave".%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON "leave".%I USING (tenant_id = public.app_current_tenant()) WITH CHECK (tenant_id = public.app_current_tenant())',
      t
    );
  END LOOP;
END
$$;
