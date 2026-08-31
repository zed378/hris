-- =============================================================================
-- Kebijakan presensi per tenant (dokumen 10 §2.4)
-- =============================================================================
--
-- Empat angka yang menentukan perilaku presensi selama ini adalah KONSTANTA di
-- dalam kode: ambang tinjauan 60, retensi foto 90 hari, dan keharusan lokasi
-- serta foto yang berlaku bagi semua orang.
--
-- Dokumen 10 §2.4 menyatakan alasannya dengan tepat: "Keputusan ini milik
-- tenant, bukan milik sistem — perusahaan konstruksi dan perusahaan konsultan
-- punya jawaban berbeda." Kantor konsultan yang stafnya bekerja dari rumah tidak
-- membutuhkan foto pada setiap ketukan; proyek konstruksi membutuhkannya.
--
-- Akibat konstanta itu sudah tercatat sebagai utang teknis: pengujian
-- menghasilkan rasio bertanda jauh di atas ambang 12% **karena presensi ujinya
-- tanpa foto** — bukan karena ada yang mencurigakan. Tenant yang memang tidak
-- meminta foto akan mengalami hal yang sama setiap hari, dan HR yang antrean
-- tinjauannya penuh berhenti meninjau. Pada saat itu skor kepercayaan berubah
-- menjadi teater.
--
-- Satu baris per tenant, dibuat saat dibutuhkan. Ketiadaan barisnya berarti
-- nilai bawaan — sehingga tenant yang tidak pernah menyentuh layar setelan tetap
-- berperilaku persis seperti sebelum tabel ini ada.

CREATE TABLE "attendance"."attendance_policies" (
    "tenant_id" UUID NOT NULL,

    -- Keharusan bukti. `false` berarti ketiadaannya TIDAK menurunkan skor —
    -- bukan berarti buktinya diabaikan bila ada.
    "require_location" BOOLEAN NOT NULL DEFAULT true,
    "require_photo" BOOLEAN NOT NULL DEFAULT true,

    -- Yang dilakukan saat pengguna menolak izin lokasi atau kamera.
    "on_permission_denied" TEXT NOT NULL DEFAULT 'ALLOW_FLAGGED',

    -- Di bawah ambang ini, ketukan masuk antrean tinjauan HR.
    "auto_approve_threshold" SMALLINT NOT NULL DEFAULT 60,

    -- Foto wajah adalah data pribadi yang keperluannya berakhir begitu
    -- presensinya selesai ditinjau (UU PDP No. 27/2022).
    "photo_retention_days" INTEGER NOT NULL DEFAULT 90,

    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "attendance_policies_pkey" PRIMARY KEY ("tenant_id"),

    CONSTRAINT "attendance_policies_on_permission_denied_check"
      CHECK ("on_permission_denied" IN ('BLOCK', 'ALLOW_FLAGGED', 'FALLBACK_ONLY')),

    -- Ambang di luar 0-100 bukan ambang; ia cara mematikan tinjauan tanpa
    -- mengatakannya. 100 berarti semuanya ditinjau, 0 berarti tidak ada.
    CONSTRAINT "attendance_policies_threshold_check"
      CHECK ("auto_approve_threshold" BETWEEN 0 AND 100),

    -- Retensi nol berarti foto dihapus sebelum sempat ditinjau; lebih dari dua
    -- tahun sulit dibenarkan sebagai "selama diperlukan".
    CONSTRAINT "attendance_policies_retention_check"
      CHECK ("photo_retention_days" BETWEEN 1 AND 730)
);

ALTER TABLE "attendance".attendance_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance".attendance_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "attendance".attendance_policies;
CREATE POLICY tenant_isolation ON "attendance".attendance_policies
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON "attendance".attendance_policies
  TO hrms_app, hrms_worker;
