-- =============================================================================
-- Resolusi tenant saat login
--
-- Ada masalah ayam-telur di jalur login: untuk memasang konteks tenant kita butuh
-- tenantId, tetapi untuk mendapatkan tenantId dari kode tenant kita harus membaca
-- tenant.tenants — yang dilindungi RLS dan karenanya mengembalikan nol baris
-- selama konteks belum terpasang.
--
-- Jawabannya adalah satu fungsi SECURITY DEFINER yang sesempit mungkin:
--   - menerima satu kode tenant, mengembalikan HANYA id dan status;
--   - tidak pernah mengembalikan nama, paket, atau data lain;
--   - hanya dapat dieksekusi role aplikasi.
--
-- Ini pengecualian kedua dan terakhir terhadap RLS dalam sistem (yang pertama:
-- kebijakan outbox_publisher). Keduanya sengaja berumur pendek dan berdaftar,
-- supaya "pengecualian RLS" tetap menjadi sesuatu yang dapat dihitung dengan jari.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.resolve_tenant_by_code(p_code text)
  RETURNS TABLE (tenant_id uuid, tenant_status text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.status::text
  FROM tenant.tenants t
  WHERE t.code = lower(btrim(p_code))
$$;

COMMENT ON FUNCTION public.resolve_tenant_by_code(text) IS
  'Jalur login: kode tenant -> (id, status). SECURITY DEFINER dan sengaja sempit. Jangan tambahkan kolom di sini.';

REVOKE ALL ON FUNCTION public.resolve_tenant_by_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_tenant_by_code(text) TO hrms_app, hrms_worker;
