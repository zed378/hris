-- CreateEnum
CREATE TYPE "employee"."ImportStatus" AS ENUM ('PREVIEW', 'COMMITTED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "employee"."ImportRowStatus" AS ENUM ('VALID', 'ERROR', 'COMMITTED');

-- CreateTable
CREATE TABLE "employee"."import_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "status" "employee"."ImportStatus" NOT NULL DEFAULT 'PREVIEW',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "error_rows" INTEGER NOT NULL DEFAULT 0,
    "committed_rows" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_at" TIMESTAMP(3),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee"."import_rows" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "parsed" JSONB,
    "errors" JSONB,
    "status" "employee"."ImportRowStatus" NOT NULL DEFAULT 'VALID',

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_jobs_tenant_id_status_created_at_idx" ON "employee"."import_jobs"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "import_rows_tenant_id_job_id_status_idx" ON "employee"."import_rows"("tenant_id", "job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_job_id_row_number_key" ON "employee"."import_rows"("job_id", "row_number");

-- AddForeignKey
ALTER TABLE "employee"."import_rows" ADD CONSTRAINT "import_rows_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "employee"."import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS untuk tabel impor. Berkas yang diunggah satu tenant tidak boleh terlihat
-- tenant lain — dan berkas impor karyawan adalah salah satu data paling sensitif
-- yang pernah melewati sistem ini, karena ia memuat seluruh PII sekaligus dalam
-- bentuk mentah.
ALTER TABLE employee.import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee.import_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee.import_jobs;
CREATE POLICY tenant_isolation ON employee.import_jobs
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

ALTER TABLE employee.import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee.import_rows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee.import_rows;
CREATE POLICY tenant_isolation ON employee.import_rows
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());
