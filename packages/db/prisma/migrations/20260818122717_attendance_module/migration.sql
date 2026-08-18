-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "attendance";

-- CreateEnum
CREATE TYPE "attendance"."PunchType" AS ENUM ('IN', 'OUT', 'BREAK_START', 'BREAK_END');

-- CreateEnum
CREATE TYPE "attendance"."PunchSource" AS ENUM ('WEB', 'MOBILE', 'DEVICE', 'MANUAL');

-- CreateEnum
CREATE TYPE "attendance"."PunchReviewStatus" AS ENUM ('ACCEPTED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "attendance"."DayStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'LEAVE', 'HOLIDAY', 'DAY_OFF');

-- CreateTable
CREATE TABLE "attendance"."work_sites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "radius_m" INTEGER NOT NULL DEFAULT 150,
    "max_accuracy_m" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance"."shifts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "grace_minutes" INTEGER NOT NULL DEFAULT 10,
    "break_minutes" INTEGER NOT NULL DEFAULT 60,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance"."schedules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "shift_id" UUID,
    "is_day_off" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance"."holidays" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "is_joint_leave" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance"."punch_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" "attendance"."PunchType" NOT NULL,
    "source" "attendance"."PunchSource" NOT NULL,
    "punched_at" TIMESTAMP(3) NOT NULL,
    "work_date" DATE NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "accuracy_m" INTEGER,
    "work_site_id" UUID,
    "distance_m" INTEGER,
    "photo_key" TEXT,
    "photo_expires_at" TIMESTAMP(3),
    "trust_score" INTEGER NOT NULL DEFAULT 100,
    "trust_flags" JSONB,
    "review" "attendance"."PunchReviewStatus" NOT NULL DEFAULT 'ACCEPTED',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "device_info" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "punch_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance"."attendance_days" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "shift_id" UUID,
    "check_in" TIMESTAMP(3),
    "check_out" TIMESTAMP(3),
    "status" "attendance"."DayStatus" NOT NULL,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "early_minutes" INTEGER NOT NULL DEFAULT 0,
    "work_minutes" INTEGER NOT NULL DEFAULT 0,
    "overtime_minutes" INTEGER NOT NULL DEFAULT 0,
    "corrected_by" UUID,
    "corrected_at" TIMESTAMP(3),
    "correction_note" TEXT,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance"."attendance_periods" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "closed_at" TIMESTAMP(3),
    "closed_by" UUID,
    "snapshot" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_sites_tenant_id_is_active_idx" ON "attendance"."work_sites"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "work_sites_tenant_id_code_key" ON "attendance"."work_sites"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_tenant_id_code_key" ON "attendance"."shifts"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "schedules_tenant_id_work_date_idx" ON "attendance"."schedules"("tenant_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_employee_id_work_date_key" ON "attendance"."schedules"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "holidays_tenant_id_date_idx" ON "attendance"."holidays"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_tenant_id_date_key" ON "attendance"."holidays"("tenant_id", "date");

-- CreateIndex
CREATE INDEX "punch_logs_tenant_id_employee_id_work_date_idx" ON "attendance"."punch_logs"("tenant_id", "employee_id", "work_date");

-- CreateIndex
CREATE INDEX "punch_logs_tenant_id_review_idx" ON "attendance"."punch_logs"("tenant_id", "review");

-- CreateIndex
CREATE INDEX "punch_logs_tenant_id_work_date_idx" ON "attendance"."punch_logs"("tenant_id", "work_date");

-- CreateIndex
CREATE INDEX "punch_logs_photo_expires_at_idx" ON "attendance"."punch_logs"("photo_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "punch_logs_tenant_id_dedupe_key_key" ON "attendance"."punch_logs"("tenant_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "attendance_days_tenant_id_work_date_status_idx" ON "attendance"."attendance_days"("tenant_id", "work_date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_days_employee_id_work_date_key" ON "attendance"."attendance_days"("employee_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_periods_tenant_id_year_month_key" ON "attendance"."attendance_periods"("tenant_id", "year", "month");

-- AddForeignKey
ALTER TABLE "attendance"."schedules" ADD CONSTRAINT "schedules_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "attendance"."shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance"."punch_logs" ADD CONSTRAINT "punch_logs_work_site_id_fkey" FOREIGN KEY ("work_site_id") REFERENCES "attendance"."work_sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance"."attendance_days" ADD CONSTRAINT "attendance_days_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "attendance"."shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Hak akses dan RLS untuk schema attendance
-- =============================================================================

GRANT USAGE ON SCHEMA attendance TO hrms_app, hrms_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA attendance TO hrms_app, hrms_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA attendance TO hrms_app, hrms_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA attendance
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hrms_app, hrms_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA attendance
  GRANT USAGE, SELECT ON SEQUENCES TO hrms_app, hrms_worker;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'work_sites', 'shifts', 'schedules', 'holidays',
    'punch_logs', 'attendance_days', 'attendance_periods'
  ] LOOP
    EXECUTE format('ALTER TABLE attendance.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE attendance.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON attendance.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON attendance.%I USING (tenant_id = public.app_current_tenant()) WITH CHECK (tenant_id = public.app_current_tenant())',
      t
    );
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- Aturan integritas presensi
-- -----------------------------------------------------------------------------

-- Menit dalam sehari. Shift malam dinyatakan dengan endMinute > 1440
-- (mis. 1320 sampai 1800 untuk 22:00-06:00), sehingga batas atasnya 2880.
ALTER TABLE attendance.shifts
  ADD CONSTRAINT shifts_minutes_in_range
  CHECK (start_minute >= 0 AND start_minute < 1440 AND end_minute > start_minute AND end_minute <= 2880);

-- Radius geofence yang tidak masuk akal membuat penilaian kepercayaan tidak
-- bermakna: radius 50 km menerima seluruh kota.
ALTER TABLE attendance.work_sites
  ADD CONSTRAINT work_sites_radius_sane
  CHECK (radius_m BETWEEN 20 AND 5000);

ALTER TABLE attendance.work_sites
  ADD CONSTRAINT work_sites_coordinates_valid
  CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180);

-- Skor kepercayaan selalu 0-100. Nilai di luar rentang berarti ada penilai yang
-- salah hitung, dan lebih baik gagal saat menyimpan daripada muncul sebagai
-- angka aneh di antrean tinjauan HR.
ALTER TABLE attendance.punch_logs
  ADD CONSTRAINT punch_trust_score_range
  CHECK (trust_score BETWEEN 0 AND 100);

-- Presensi yang membawa koordinat wajib membawa akurasinya juga. Koordinat tanpa
-- akurasi tidak dapat dinilai — dan yang tidak dapat dinilai tidak boleh
-- diperlakukan seolah sudah dinilai (P14).
ALTER TABLE attendance.punch_logs
  ADD CONSTRAINT punch_location_complete
  CHECK (
    (latitude IS NULL AND longitude IS NULL) OR
    (latitude IS NOT NULL AND longitude IS NOT NULL AND accuracy_m IS NOT NULL)
  );

ALTER TABLE attendance.attendance_periods
  ADD CONSTRAINT periods_month_valid
  CHECK (month BETWEEN 1 AND 12 AND year BETWEEN 2000 AND 2100);
