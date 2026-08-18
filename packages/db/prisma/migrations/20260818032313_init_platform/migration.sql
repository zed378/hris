-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "audit";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "iam";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "messaging";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "tenant";

-- CreateEnum
CREATE TYPE "tenant"."TenantStatus" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED', 'CHURNED');

-- CreateEnum
CREATE TYPE "tenant"."ModuleTier" AS ENUM ('CORE', 'BASIC', 'ADVANCED', 'ULTIMATE', 'INDUSTRY');

-- CreateEnum
CREATE TYPE "tenant"."TenantModuleStatus" AS ENUM ('ENABLED', 'DISABLED');

-- CreateEnum
CREATE TYPE "auth"."UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "iam"."GrantEffect" AS ENUM ('GRANT', 'DENY');

-- CreateTable
CREATE TABLE "tenant"."modules" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tier" "tenant"."ModuleTier" NOT NULL,
    "is_core" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modules_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "tenant"."plans" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "tenant"."plan_modules" (
    "plan_code" TEXT NOT NULL,
    "module_code" TEXT NOT NULL,

    CONSTRAINT "plan_modules_pkey" PRIMARY KEY ("plan_code","module_code")
);

-- CreateTable
CREATE TABLE "tenant"."tenants" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "tenant"."TenantStatus" NOT NULL DEFAULT 'TRIAL',
    "plan_code" TEXT NOT NULL,
    "trial_ends_at" TIMESTAMP(3),
    "suspended_at" TIMESTAMP(3),
    "churned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_modules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "module_code" TEXT NOT NULL,
    "status" "tenant"."TenantModuleStatus" NOT NULL DEFAULT 'ENABLED',
    "enabled_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "status" "auth"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."refresh_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "replaced_by_token_id" UUID,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,
    "ip" TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iam"."permissions" (
    "code" TEXT NOT NULL,
    "module_code" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "iam"."menus" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "parent_id" UUID,
    "module_code" TEXT NOT NULL,
    "permission_code" TEXT,
    "path" TEXT,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iam"."roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iam"."role_permissions" (
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_code" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_code")
);

-- CreateTable
CREATE TABLE "iam"."user_roles" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" UUID,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "iam"."user_permission_grants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "permission_code" TEXT NOT NULL,
    "effect" "iam"."GrantEffect" NOT NULL,
    "reason" TEXT NOT NULL,
    "granted_by" UUID NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permission_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iam"."access_versions" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_versions_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "audit"."audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messaging"."outbox_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."superusers" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "totp_secret" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "superusers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_code_key" ON "tenant"."tenants"("code");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenant"."tenants"("status");

-- CreateIndex
CREATE INDEX "tenant_modules_tenant_id_status_idx" ON "tenant"."tenant_modules"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_modules_tenant_id_module_code_key" ON "tenant"."tenant_modules"("tenant_id", "module_code");

-- CreateIndex
CREATE INDEX "users_tenant_id_status_idx" ON "auth"."users"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "auth"."users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "auth"."refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_tenant_id_user_id_idx" ON "auth"."refresh_tokens"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "auth"."refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "auth"."refresh_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "permissions_module_code_idx" ON "iam"."permissions"("module_code");

-- CreateIndex
CREATE UNIQUE INDEX "menus_code_key" ON "iam"."menus"("code");

-- CreateIndex
CREATE INDEX "menus_parent_id_idx" ON "iam"."menus"("parent_id");

-- CreateIndex
CREATE INDEX "menus_module_code_idx" ON "iam"."menus"("module_code");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_code_key" ON "iam"."roles"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "role_permissions_tenant_id_idx" ON "iam"."role_permissions"("tenant_id");

-- CreateIndex
CREATE INDEX "user_roles_tenant_id_idx" ON "iam"."user_roles"("tenant_id");

-- CreateIndex
CREATE INDEX "user_permission_grants_tenant_id_idx" ON "iam"."user_permission_grants"("tenant_id");

-- CreateIndex
CREATE INDEX "user_permission_grants_expires_at_idx" ON "iam"."user_permission_grants"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_permission_grants_user_id_permission_code_key" ON "iam"."user_permission_grants"("user_id", "permission_code");

-- CreateIndex
CREATE INDEX "access_versions_tenant_id_idx" ON "iam"."access_versions"("tenant_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit"."audit_logs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_idx" ON "audit"."audit_logs"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_actor_user_id_created_at_idx" ON "audit"."audit_logs"("tenant_id", "actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_messages_published_at_created_at_idx" ON "messaging"."outbox_messages"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_messages_tenant_id_topic_idx" ON "messaging"."outbox_messages"("tenant_id", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "superusers_email_key" ON "platform"."superusers"("email");

-- AddForeignKey
ALTER TABLE "tenant"."plan_modules" ADD CONSTRAINT "plan_modules_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "tenant"."plans"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."plan_modules" ADD CONSTRAINT "plan_modules_module_code_fkey" FOREIGN KEY ("module_code") REFERENCES "tenant"."modules"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenants" ADD CONSTRAINT "tenants_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "tenant"."plans"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_modules" ADD CONSTRAINT "tenant_modules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_modules" ADD CONSTRAINT "tenant_modules_module_code_fkey" FOREIGN KEY ("module_code") REFERENCES "tenant"."modules"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."permissions" ADD CONSTRAINT "permissions_module_code_fkey" FOREIGN KEY ("module_code") REFERENCES "tenant"."modules"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."menus" ADD CONSTRAINT "menus_module_code_fkey" FOREIGN KEY ("module_code") REFERENCES "tenant"."modules"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."menus" ADD CONSTRAINT "menus_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "iam"."permissions"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."menus" ADD CONSTRAINT "menus_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "iam"."menus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "iam"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."role_permissions" ADD CONSTRAINT "role_permissions_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "iam"."permissions"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "iam"."roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."user_permission_grants" ADD CONSTRAINT "user_permission_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."user_permission_grants" ADD CONSTRAINT "user_permission_grants_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "iam"."permissions"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."access_versions" ADD CONSTRAINT "access_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
