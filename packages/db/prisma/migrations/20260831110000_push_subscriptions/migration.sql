-- =============================================================================
-- Langganan Web Push
-- =============================================================================
--
-- `NotificationChannel.WEB_PUSH` ada di enum sejak modul notifikasi dibangun,
-- tanpa satu pun produsen — pola yang sama dengan LEAVE, MANUAL, DISCARDED, dan
-- metode akrual cuti. Tabel ini yang mengisinya.
--
-- Satu baris per LANGGANAN, bukan per pengguna. Satu orang memakai ponsel dan
-- komputer kantor; masing-masing menghasilkan endpoint push tersendiri, dan
-- mengirim hanya ke salah satunya berarti separuh notifikasi tidak sampai.
--
-- `endpoint` unik lintas tenant, bukan per tenant. Endpoint diterbitkan layanan
-- push peramban (FCM, Mozilla, Apple) dan sudah unik secara global; membuatnya
-- unik per tenant berarti satu perangkat yang berpindah perusahaan meninggalkan
-- baris lama yang tetap menerima notifikasi perusahaan sebelumnya.

CREATE TABLE "notification"."push_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    "endpoint" TEXT NOT NULL,
    -- Kunci enkripsi milik peramban, bukan milik kita. Keduanya wajib ada:
    -- payload push dienkripsi untuk penerimanya, dan layanan push di antaranya
    -- tidak dapat membacanya.
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,

    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_success_at" TIMESTAMP(3),
    -- Langganan mati tidak melapor; ia hanya berhenti bekerja. Penghitung ini
    -- yang membuatnya dapat dibuang sebelum menumpuk.
    "failure_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_subscriptions_endpoint_key"
  ON "notification"."push_subscriptions"("endpoint");

CREATE INDEX "push_subscriptions_tenant_user_idx"
  ON "notification"."push_subscriptions"("tenant_id", "user_id");

ALTER TABLE "notification".push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification".push_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "notification".push_subscriptions;
CREATE POLICY tenant_isolation ON "notification".push_subscriptions
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON "notification".push_subscriptions
  TO hrms_app, hrms_worker;
