-- =============================================================================
-- Resolusi tenant dari refresh token
--
-- Masalah yang sama seperti jalur login: saat sebuah refresh token masuk, kita
-- belum tahu tenantnya, sehingga konteks belum dapat dipasang, sehingga RLS
-- mengembalikan nol baris. Tanpa fungsi ini, alur refresh selalu gagal.
--
-- Sempit dengan cara yang sama: masukan berupa SHA-256 (bukan token mentah, dan
-- bukan sesuatu yang dapat ditebak), keluaran hanya tenant_id dan family_id.
-- Tidak mengembalikan userId, waktu kedaluwarsa, atau status — semuanya dibaca
-- setelah konteks terpasang, dengan RLS berlaku penuh.
--
-- Ini pengecualian RLS ketiga dan terakhir. Ketiganya terdaftar di PLAN dan
-- diverifikasi uji CI, supaya jumlahnya tetap dapat dihitung dengan jari.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.resolve_refresh_token_owner(p_token_hash text)
  RETURNS TABLE (tenant_id uuid, family_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT rt.tenant_id, rt.family_id
  FROM auth.refresh_tokens rt
  WHERE rt.token_hash = p_token_hash
  LIMIT 1
$$;

COMMENT ON FUNCTION public.resolve_refresh_token_owner(text) IS
  'Jalur refresh/logout: SHA-256 token -> (tenant_id, family_id). SECURITY DEFINER dan sengaja sempit. Jangan tambahkan kolom di sini.';

REVOKE ALL ON FUNCTION public.resolve_refresh_token_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_refresh_token_owner(text) TO hrms_app;
