-- =============================================================================
-- Lampiran cuti sebagai berkas, bukan sebagai teks bebas
-- =============================================================================
--
-- `leave_types.requires_attachment` ada sejak modul cuti dibangun, dan seed
-- menyalakannya untuk Cuti Sakit dan Cuti Melahirkan. Pemeriksaannya berbunyi:
--
--     if (type.requiresAttachment && !input.attachmentKey) tolak
--
-- `attachmentKey` adalah kolom teks bebas, dan layarnya menampilkan kotak isian
-- bertuliskan "Nomor atau nama berkas surat dokter". Artinya syarat "wajib
-- melampirkan surat dokter" **dipenuhi dengan mengetik kata 'ada'.**
--
-- Untuk cuti sakit, surat dokter itulah satu-satunya hal yang membedakan cuti
-- berbayar dari mangkir. Syarat yang menerima sembarang teks bukan syarat; ia
-- kotak isian yang membuat semua pihak mengira ada bukti yang tersimpan.
--
-- Tabel ini yang menyimpan berkasnya. Barisnya dibuat saat unggah, SEBELUM
-- pengajuan cuti dibuat, karena pengunggahnya belum tahu id pengajuannya —
-- karena itu `request_id` boleh null sampai pengajuannya menyusul.

CREATE TABLE "leave"."leave_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    -- Diisi saat pengajuan dibuat. Null berarti lampiran yatim — diunggah lalu
    -- pengajuannya tidak jadi dikirim.
    "request_id" UUID,

    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,

    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_attachments_pkey" PRIMARY KEY ("id")
);

-- Kunci penyimpanan unik: satu berkas, satu baris. Dua baris yang menunjuk
-- kunci yang sama akan membuat penghapusan salah satunya meninggalkan yang lain
-- menunjuk berkas yang sudah tidak ada.
CREATE UNIQUE INDEX "leave_attachments_storage_key_key"
  ON "leave"."leave_attachments"("storage_key");

CREATE INDEX "leave_attachments_tenant_employee_idx"
  ON "leave"."leave_attachments"("tenant_id", "employee_id");

CREATE INDEX "leave_attachments_request_idx"
  ON "leave"."leave_attachments"("tenant_id", "request_id");

-- Lampiran yatim dibersihkan job berkala; indeks ini yang membuatnya murah.
CREATE INDEX "leave_attachments_orphan_idx"
  ON "leave"."leave_attachments"("tenant_id", "created_at")
  WHERE "request_id" IS NULL;

ALTER TABLE "leave"."leave_attachments"
  ADD CONSTRAINT "leave_attachments_request_id_fkey"
  FOREIGN KEY ("request_id") REFERENCES "leave"."leave_requests"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE "leave".leave_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave".leave_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "leave".leave_attachments;
CREATE POLICY tenant_isolation ON "leave".leave_attachments
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON "leave".leave_attachments
  TO hrms_app, hrms_worker;
