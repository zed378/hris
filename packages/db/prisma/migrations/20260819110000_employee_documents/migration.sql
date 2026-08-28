-- Dokumen karyawan (PLAN/12 F2, PLAN/04 §F2).
--
-- Berkas yang disimpan di sini bukan lampiran biasa: pindaian KTP, kartu
-- keluarga, ijazah, dan surat kontrak. Seluruhnya data pribadi menurut UU PDP
-- No. 27/2022, dan sebagiannya cukup untuk membuka rekening bank atas nama
-- orang lain.
--
-- Karena itu tabelnya membawa tiga hal yang tidak dibawa lampiran biasa:
-- jejak siapa mengunggah, jejak siapa membaca (tabel terpisah di bawah), dan
-- tanggal kedaluwarsa untuk dokumen yang memang berumur — KITAS, SIM, kontrak.

CREATE TABLE "employee"."employee_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,

    -- KTP, KK, NPWP, IJAZAH, KONTRAK, SERTIFIKAT, LAINNYA
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,

    -- Untuk dokumen yang memang berumur. NULL berarti tidak kedaluwarsa.
    "expires_at" TIMESTAMP(3),

    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    -- Dokumen tidak dihapus, ia diarsipkan (aturan M4 dokumen 09: tidak ada
    -- penghapusan data di produksi). Berkas fisiknya dihapus job retensi;
    -- barisnya bertahan supaya riwayat "pernah ada dokumen ini" tidak hilang.
    "archived_at" TIMESTAMP(3),
    "archived_by" UUID,

    CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "employee_documents_tenant_id_employee_id_idx"
  ON "employee"."employee_documents"("tenant_id", "employee_id");

CREATE INDEX "employee_documents_tenant_id_expires_at_idx"
  ON "employee"."employee_documents"("tenant_id", "expires_at");

CREATE UNIQUE INDEX "employee_documents_storage_key_key"
  ON "employee"."employee_documents"("storage_key");

ALTER TABLE "employee"."employee_documents"
  ADD CONSTRAINT "employee_documents_kind_known"
  CHECK ("kind" IN ('KTP', 'KK', 'NPWP', 'IJAZAH', 'KONTRAK', 'SERTIFIKAT', 'LAINNYA'));

-- Ukuran nol berarti unggahan yang gagal di tengah jalan tetapi barisnya
-- terlanjur tersimpan. Baris seperti itu tampak seperti dokumen yang ada sampai
-- seseorang mencoba membukanya.
ALTER TABLE "employee"."employee_documents"
  ADD CONSTRAINT "employee_documents_size_positive"
  CHECK ("size_bytes" > 0);

-- Jejak pembacaan dokumen.
--
-- Sejajar dengan `attendance.photo_access_logs` dan untuk alasan yang sama:
-- `audit_logs` mencatat perubahan, sedangkan yang perlu dijawab di sini adalah
-- "siapa saja yang pernah membuka pindaian KTP saya". Tidak ada tabel lain yang
-- menyimpan jawabannya.
CREATE TABLE "employee"."document_access_logs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "accessed_by" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_access_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "document_access_logs_tenant_id_employee_id_accessed_at_idx"
  ON "employee"."document_access_logs"("tenant_id", "employee_id", "accessed_at");

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_documents', 'document_access_logs'] LOOP
    EXECUTE format('ALTER TABLE employee.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE employee.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON employee.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON employee.%I USING (tenant_id = public.app_current_tenant()) WITH CHECK (tenant_id = public.app_current_tenant())',
      t
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON employee.employee_documents, employee.document_access_logs
  TO hrms_app, hrms_worker;

GRANT USAGE, SELECT ON SEQUENCE employee.document_access_logs_id_seq TO hrms_app, hrms_worker;
