-- =============================================================================
-- Pengingat dokumen karyawan yang akan kedaluwarsa
-- =============================================================================
--
-- `employee_documents.expires_at` sudah ada sejak modul dokumen dibangun, dengan
-- komentar "untuk dokumen yang memang berumur — KITAS, SIM, kontrak". Tetapi
-- tidak ada satu pun yang membacanya. Kolom itu diisi HR, lalu tanggalnya lewat,
-- dan tidak terjadi apa-apa.
--
-- Yang lewat bukan sekadar tanggal di basis data. KITAS yang kedaluwarsa berarti
-- tenaga kerja asing bekerja tanpa izin — pidana bagi perusahaan, deportasi bagi
-- orangnya. SIM yang kedaluwarsa berarti sopir perusahaan mengemudi tanpa izin,
-- dan asuransi kendaraan batal pada kecelakaan pertama. Keduanya baru ketahuan
-- saat ada yang memeriksa, dan yang memeriksa biasanya bukan HR.
--
-- Tabel ini yang membuat pengingatnya tepat satu kali per ambang. Bentuknya
-- sengaja sama persis dengan `contract_reminders`: unique (document_id,
-- threshold) adalah kunci idempotensinya, dan pemindaian harian yang menemukan
-- dokumen yang sama setiap hari selama tiga bulan tetap menghasilkan satu email
-- per ambang.

CREATE TABLE "employee"."document_reminders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "threshold" "employee"."ReminderThreshold" NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_reminders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "document_reminders_tenant_id_sent_at_idx"
  ON "employee"."document_reminders"("tenant_id", "sent_at");

-- Kunci idempotensi. Tanpa ini, pemindaian harian mengirim satu email setiap
-- hari selama sembilan puluh hari untuk satu KITAS yang sama, dan penerimanya
-- berhenti membaca email dari sistem ini jauh sebelum yang penting tiba.
CREATE UNIQUE INDEX "document_reminders_document_id_threshold_key"
  ON "employee"."document_reminders"("document_id", "threshold");

ALTER TABLE "employee"."document_reminders"
  ADD CONSTRAINT "document_reminders_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "employee"."employee_documents"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE employee.document_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee.document_reminders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee.document_reminders;
CREATE POLICY tenant_isolation ON employee.document_reminders
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON employee.document_reminders
  TO hrms_app, hrms_worker;
