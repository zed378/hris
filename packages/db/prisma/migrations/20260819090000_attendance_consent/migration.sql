-- Persetujuan pemrosesan data presensi, dan jejak akses foto.
--
-- Dua tabel yang menegakkan aturan PR2 dan PR6 pada dokumen 10 §8.2.
--
-- PR2 menuntut persetujuan lokasi dan foto diminta TERPISAH dari persetujuan
-- umum aplikasi, dan dapat ditarik. Terpisah itu bukan detail tata letak: UU PDP
-- No. 27/2022 menuntut persetujuan yang spesifik per tujuan, dan persetujuan
-- yang tercampur ke dalam "Saya menyetujui syarat dan ketentuan" bukan
-- persetujuan atas pengambilan koordinat.
--
-- Versi teksnya ikut disimpan. Persetujuan diberikan atas kalimat tertentu, dan
-- ketika kalimat itu berubah — misalnya retensi foto diperpanjang — persetujuan
-- lama tidak otomatis berlaku untuk kalimat baru.

-- CreateTable
CREATE TABLE "attendance"."attendance_consents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "consent_type" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3),
    "withdrawn_at" TIMESTAMP(3),
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_consents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attendance_consents_tenant_employee_type_version_key"
  ON "attendance"."attendance_consents"("tenant_id", "employee_id", "consent_type", "version");

CREATE INDEX "attendance_consents_tenant_id_employee_id_idx"
  ON "attendance"."attendance_consents"("tenant_id", "employee_id");

ALTER TABLE "attendance"."attendance_consents"
  ADD CONSTRAINT "attendance_consents_type_known"
  CHECK ("consent_type" IN ('LOCATION', 'PHOTO', 'BIOMETRIC'));

-- Sebuah baris persetujuan harus menyatakan sesuatu. Baris dengan kedua kolom
-- kosong tidak berarti "belum memutuskan" — ia berarti ada jalur kode yang
-- membuat baris tanpa mengisi keputusannya, dan baris seperti itu akan dibaca
-- sebagai penolakan diam-diam oleh satu pembaca dan diabaikan oleh pembaca lain.
ALTER TABLE "attendance"."attendance_consents"
  ADD CONSTRAINT "attendance_consents_has_decision"
  CHECK ("granted_at" IS NOT NULL OR "withdrawn_at" IS NOT NULL);

-- PR6: setiap akses HR ke foto presensi dicatat.
--
-- Yang dicatat adalah PEMBACAAN, bukan perubahan — sehingga tabel ini tidak
-- dapat digantikan oleh audit_logs biasa, yang mencatat tindakan yang mengubah
-- keadaan. Foto presensi adalah data pribadi yang dilihat orang lain, dan
-- "siapa saja yang pernah melihat foto saya" adalah pertanyaan yang berhak
-- dijawab karyawan.
CREATE TABLE "attendance"."photo_access_logs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "punch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "accessed_by" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_access_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "photo_access_logs_tenant_id_employee_id_accessed_at_idx"
  ON "attendance"."photo_access_logs"("tenant_id", "employee_id", "accessed_at");

CREATE INDEX "photo_access_logs_tenant_id_accessed_by_accessed_at_idx"
  ON "attendance"."photo_access_logs"("tenant_id", "accessed_by", "accessed_at");

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_consents', 'photo_access_logs'] LOOP
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

GRANT SELECT, INSERT, UPDATE, DELETE
  ON attendance.attendance_consents, attendance.photo_access_logs
  TO hrms_app, hrms_worker;

GRANT USAGE, SELECT ON SEQUENCE attendance.photo_access_logs_id_seq TO hrms_app, hrms_worker;
