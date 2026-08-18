-- CreateEnum
CREATE TYPE "auth"."ActionTokenPurpose" AS ENUM ('PASSWORD_RESET', 'INVITATION');

-- CreateTable
CREATE TABLE "auth"."action_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "auth"."ActionTokenPurpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "ip" TEXT,

    CONSTRAINT "action_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "action_tokens_token_hash_key" ON "auth"."action_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "action_tokens_tenant_id_user_id_purpose_idx" ON "auth"."action_tokens"("tenant_id", "user_id", "purpose");

-- CreateIndex
CREATE INDEX "action_tokens_expires_at_idx" ON "auth"."action_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "auth"."action_tokens" ADD CONSTRAINT "action_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- RLS untuk action_tokens
--
-- Prisma tidak membangkitkan bagian ini. Tabel ber-tenant_id tanpa kebijakan
-- akan lolos migrasi tanpa keluhan dan diam-diam terbuka bagi seluruh tenant —
-- uji `rls-coverage` yang akan menangkapnya, tetapi lebih baik tidak sampai ke sana.
-- -----------------------------------------------------------------------------

ALTER TABLE auth.action_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.action_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON auth.action_tokens;
CREATE POLICY tenant_isolation ON auth.action_tokens
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

-- Sama seperti refresh token: alur reset kata sandi menerima token tanpa
-- mengetahui tenantnya, sehingga konteks belum dapat dipasang saat pencarian.
-- Fungsi ini sesempit yang lain — masukan berupa SHA-256, keluaran hanya
-- tenant_id. Seluruh pembacaan lain terjadi setelah konteks terpasang.
CREATE OR REPLACE FUNCTION public.resolve_action_token_owner(p_token_hash text)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT t.tenant_id FROM auth.action_tokens t WHERE t.token_hash = p_token_hash LIMIT 1
$$;

COMMENT ON FUNCTION public.resolve_action_token_owner(text) IS
  'Alur reset kata sandi & undangan: SHA-256 token -> tenant_id. SECURITY DEFINER dan sengaja sempit.';

REVOKE ALL ON FUNCTION public.resolve_action_token_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_action_token_owner(text) TO hrms_app;
