-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "employee";

-- CreateEnum
CREATE TYPE "employee"."EmployeeStatus" AS ENUM ('PROBATION', 'ACTIVE', 'RESIGNED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "employee"."EmploymentType" AS ENUM ('PKWTT', 'PKWT', 'MAGANG', 'HARIAN', 'BORONGAN');

-- CreateEnum
CREATE TYPE "employee"."Gender" AS ENUM ('MALE', 'FEMALE');

-- CreateTable
CREATE TABLE "employee"."departments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "path" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee"."positions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee"."employees" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_number" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "national_id_encrypted" TEXT,
    "national_id_index" TEXT,
    "tax_id_encrypted" TEXT,
    "tax_id_index" TEXT,
    "bank_account_encrypted" TEXT,
    "bank_name" TEXT,
    "bank_account_holder" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "birth_date" DATE,
    "birth_place" TEXT,
    "gender" "employee"."Gender",
    "address" TEXT,
    "join_date" DATE NOT NULL,
    "resign_date" DATE,
    "status" "employee"."EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee"."employments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "type" "employee"."EmploymentType" NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "manager_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee"."employee_contracts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "contract_number" TEXT NOT NULL,
    "type" "employee"."EmploymentType" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "file_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departments_tenant_id_path_idx" ON "employee"."departments"("tenant_id", "path");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_code_key" ON "employee"."departments"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "positions_tenant_id_code_key" ON "employee"."positions"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "employees_tenant_id_status_idx" ON "employee"."employees"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "employees_tenant_id_full_name_idx" ON "employee"."employees"("tenant_id", "full_name");

-- CreateIndex
CREATE UNIQUE INDEX "employees_tenant_id_employee_number_key" ON "employee"."employees"("tenant_id", "employee_number");

-- CreateIndex
CREATE UNIQUE INDEX "employees_tenant_id_national_id_index_key" ON "employee"."employees"("tenant_id", "national_id_index");

-- CreateIndex
CREATE INDEX "employments_tenant_id_employee_id_effective_from_idx" ON "employee"."employments"("tenant_id", "employee_id", "effective_from");

-- CreateIndex
CREATE INDEX "employments_tenant_id_department_id_idx" ON "employee"."employments"("tenant_id", "department_id");

-- CreateIndex
CREATE INDEX "employee_contracts_tenant_id_end_date_idx" ON "employee"."employee_contracts"("tenant_id", "end_date");

-- CreateIndex
CREATE INDEX "employee_contracts_tenant_id_employee_id_start_date_idx" ON "employee"."employee_contracts"("tenant_id", "employee_id", "start_date");

-- CreateIndex
CREATE UNIQUE INDEX "employee_contracts_tenant_id_contract_number_key" ON "employee"."employee_contracts"("tenant_id", "contract_number");

-- AddForeignKey
ALTER TABLE "employee"."departments" ADD CONSTRAINT "departments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "employee"."departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee"."employments" ADD CONSTRAINT "employments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"."employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee"."employments" ADD CONSTRAINT "employments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "employee"."departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee"."employments" ADD CONSTRAINT "employments_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "employee"."positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee"."employee_contracts" ADD CONSTRAINT "employee_contracts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee"."employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- RLS, hak akses, dan aturan integritas untuk schema employee
--
-- Ditulis tangan. Prisma tidak membangkitkan satu pun baris di bawah ini, dan
-- tabel ber-tenant_id tanpa kebijakan akan lolos migrasi tanpa keluhan.
-- =============================================================================

GRANT USAGE ON SCHEMA employee TO hrms_app, hrms_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA employee TO hrms_app, hrms_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA employee TO hrms_app, hrms_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA employee
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hrms_app, hrms_worker;

-- Control plane sengaja TIDAK diberi apa pun di sini. Inilah bentuk konkret dari
-- janji "hibah per tabel, bukan menyapu": modul domain baru tidak pernah terbuka
-- ke `hrms_platform` hanya karena ia ditambahkan.

ALTER TABLE employee.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee.departments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee.departments;
CREATE POLICY tenant_isolation ON employee.departments
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE employee.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee.positions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee.positions;
CREATE POLICY tenant_isolation ON employee.positions
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE employee.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee.employees FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee.employees;
CREATE POLICY tenant_isolation ON employee.employees
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE employee.employments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee.employments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee.employments;
CREATE POLICY tenant_isolation ON employee.employments
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE employee.employee_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee.employee_contracts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee.employee_contracts;
CREATE POLICY tenant_isolation ON employee.employee_contracts
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());


-- -----------------------------------------------------------------------------
-- Integritas riwayat penempatan
--
-- Tepat satu penempatan berjalan per karyawan. Tanpa ini, satu mutasi yang gagal
-- di tengah meninggalkan dua baris terbuka, dan pertanyaan "di departemen mana
-- orang ini sekarang" punya dua jawaban — yang jauh lebih buruk daripada nol.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX employments_one_open_per_employee
  ON employee.employments (employee_id)
  WHERE effective_to IS NULL;

-- Periode harus maju. `effective_to` sama dengan `effective_from` diperbolehkan:
-- itu penempatan satu hari, yang memang terjadi pada mutasi berturut-turut.
ALTER TABLE employee.employments
  ADD CONSTRAINT employments_period_forward
  CHECK (effective_to IS NULL OR effective_to >= effective_from);

-- -----------------------------------------------------------------------------
-- Aturan kontrak kerja
--
-- PKWT WAJIB punya tanggal berakhir; PKWTT tidak boleh punya. Ditegakkan di
-- basis data, bukan hanya di formulir — kontrak masuk lewat impor Excel juga,
-- dan jalur itu tidak melewati validasi formulir mana pun.
--
-- Ini bukan kerapian: PKWT tanpa tanggal berakhir adalah PKWTT demi hukum, dan
-- baris yang salah tipe di sini berarti pengingat perpanjangan tidak pernah
-- berbunyi untuk kontrak yang paling membutuhkannya.
-- -----------------------------------------------------------------------------
ALTER TABLE employee.employee_contracts
  ADD CONSTRAINT contracts_end_date_matches_type
  CHECK (
    (type = 'PKWTT' AND end_date IS NULL) OR
    (type <> 'PKWTT' AND end_date IS NOT NULL AND end_date > start_date)
  );

-- Nomor karyawan tidak boleh kosong atau hanya spasi. Impor Excel akan mencoba
-- memasukkan sel kosong, dan "" adalah nilai yang lolos NOT NULL.
ALTER TABLE employee.employees
  ADD CONSTRAINT employees_number_not_blank
  CHECK (length(btrim(employee_number)) > 0);

ALTER TABLE employee.employees
  ADD CONSTRAINT employees_name_not_blank
  CHECK (length(btrim(full_name)) > 0);

-- Tanggal resign tidak boleh mendahului tanggal masuk.
ALTER TABLE employee.employees
  ADD CONSTRAINT employees_resign_after_join
  CHECK (resign_date IS NULL OR resign_date >= join_date);
