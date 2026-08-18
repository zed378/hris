-- CreateTable
CREATE TABLE "platform"."platform_audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "superuser_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "detail" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_audit_logs_superuser_id_created_at_idx" ON "platform"."platform_audit_logs"("superuser_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "platform_audit_logs_target_type_target_id_idx" ON "platform"."platform_audit_logs"("target_type", "target_id");
