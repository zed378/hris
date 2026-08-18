-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "notification";

-- CreateEnum
CREATE TYPE "notification"."NotificationChannel" AS ENUM ('EMAIL', 'WEB_PUSH', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "notification"."NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "notification"."notification_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel" "notification"."NotificationChannel" NOT NULL,
    "topic" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "notification"."NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_logs_tenant_id_status_created_at_idx" ON "notification"."notification_logs"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_logs_tenant_id_dedupe_key_key" ON "notification"."notification_logs"("tenant_id", "dedupe_key");

-- =============================================================================
-- Hak akses dan RLS untuk schema notification
-- =============================================================================

GRANT USAGE ON SCHEMA notification TO hrms_app, hrms_worker;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA notification TO hrms_app, hrms_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA notification TO hrms_app, hrms_worker;

-- Kali ini SEQUENCE ikut disebut sejak awal. Migrasi employee melewatkannya, dan
-- akibatnya setiap INSERT ke tabel ber-BIGSERIAL yang lahir belakangan ditolak
-- dengan galat yang tidak menyebut satu pun tabel di kode kita.
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA notification
  GRANT SELECT, INSERT, UPDATE ON TABLES TO hrms_app, hrms_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA notification
  GRANT USAGE, SELECT ON SEQUENCES TO hrms_app, hrms_worker;

ALTER TABLE notification.notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notification.notification_logs;
CREATE POLICY tenant_isolation ON notification.notification_logs
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

-- Catatan pengiriman tidak boleh dihapus: pertanyaan "apakah pengingat itu
-- pernah dikirim" muncul justru ketika seseorang mengaku tidak menerimanya.
REVOKE DELETE ON notification.notification_logs FROM hrms_app, hrms_worker;
