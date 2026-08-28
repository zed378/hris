-- Batas waktu query dan transaksi menganggur (PLAN/12 F6 — pengerasan).
--
-- Yang dijaga di sini bukan performa satu query, melainkan ketersediaan sistem
-- bagi tenant LAIN.
--
-- Satu query tanpa indeks yang menyapu jutaan baris menahan koneksinya sampai
-- selesai. Pada pool yang terbatas, beberapa query semacam itu menghabiskan
-- seluruh koneksi, dan yang berhenti bekerja bukan tenant yang menjalankannya —
-- melainkan semua orang. Kegagalannya terlihat sebagai "aplikasi lambat" tanpa
-- satu pun galat, dan penyebabnya hampir mustahil ditemukan saat sedang terjadi.
--
-- Batasnya ditetapkan PER PERAN, bukan per koneksi, supaya tidak ada jalur kode
-- yang dapat lupa memasangnya.

-- -----------------------------------------------------------------------------
-- hrms_app — melayani permintaan pengguna
-- -----------------------------------------------------------------------------
--
-- 15 detik. Permintaan yang lebih lama dari itu sudah gagal dari sudut pandang
-- penggunanya: ia sudah menekan muat ulang, dan query yang masih berjalan hanya
-- menahan koneksi untuk halaman yang tidak akan pernah ia lihat.
--
-- Ekspor Excel adalah operasi terberat pada jalur ini, dan 5.000 baris terukur
-- selesai dalam sekitar 2,5 detik — enam kali lipat di bawah batas.
ALTER ROLE hrms_app SET statement_timeout = '15s';

-- Transaksi yang dibuka lalu ditinggalkan menahan lock-nya selamanya.
--
-- Ini yang membuat penutupan periode presensi atau persetujuan cuti tampak
-- "menggantung": transaksi lain menunggu lock yang dipegang transaksi yang
-- sudah tidak dilanjutkan siapa pun karena prosesnya mati di tengah jalan.
ALTER ROLE hrms_app SET idle_in_transaction_session_timeout = '30s';

-- Batas menunggu lock. Lebih pendek dari statement_timeout dengan sengaja:
-- gagal cepat dengan pesan "sedang diproses orang lain" jauh lebih berguna
-- daripada menggantung lima belas detik lalu gagal tanpa keterangan.
ALTER ROLE hrms_app SET lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- hrms_worker — proses latar
-- -----------------------------------------------------------------------------
--
-- Jauh lebih longgar, dan itu memang bedanya: tidak ada orang yang menunggu di
-- depan layar. Impor 5.000 karyawan, penutupan tahun cuti, dan perhitungan
-- payroll seribu orang seluruhnya berjalan di sini.
--
-- Tetap DIBATASI, bukan dibiarkan tanpa batas. Job yang berputar selamanya
-- karena satu bug tetap menahan koneksinya, dan konsekuensinya sama saja bagi
-- tenant lain.
ALTER ROLE hrms_worker SET statement_timeout = '5min';
ALTER ROLE hrms_worker SET idle_in_transaction_session_timeout = '10min';
ALTER ROLE hrms_worker SET lock_timeout = '30s';

-- -----------------------------------------------------------------------------
-- hrms_platform — portal admin platform
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_platform') THEN
    EXECUTE 'ALTER ROLE hrms_platform SET statement_timeout = ''30s''';
    EXECUTE 'ALTER ROLE hrms_platform SET idle_in_transaction_session_timeout = ''60s''';
    EXECUTE 'ALTER ROLE hrms_platform SET lock_timeout = ''10s''';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Pemeriksaan drift skema
-- -----------------------------------------------------------------------------
--
-- Mengembalikan tabel ber-`tenant_id` yang TIDAK punya kebijakan RLS aktif.
--
-- Ada gerbang CI yang memeriksa hal yang sama, tetapi CI hanya melihat skema
-- yang dibangun dari migrasi. Yang dijaga fungsi ini adalah basis data
-- PRODUKSI: seseorang yang menambahkan tabel lewat psql pada malam insiden,
-- atau migrasi yang gagal separuh jalan, menghasilkan tabel tanpa RLS yang
-- tidak akan pernah terlihat oleh CI mana pun.
--
-- Tabel ber-`tenant_id` tanpa RLS berarti setiap tenant membaca data seluruh
-- tenant lain. Ia tidak menghasilkan galat, dan tidak ada yang menyadarinya
-- sampai seseorang melihat data yang bukan miliknya.
CREATE OR REPLACE FUNCTION public.schema_drift_report()
RETURNS TABLE (
  kind        text,
  object_name text,
  detail      text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  -- 1. Tabel ber-tenant_id tanpa RLS aktif atau tanpa FORCE.
  SELECT
    'rls_missing'::text,
    (c.table_schema || '.' || c.table_name)::text,
    CASE
      WHEN NOT t.relrowsecurity THEN 'RLS tidak aktif'
      WHEN NOT t.relforcerowsecurity THEN 'RLS aktif tetapi tidak FORCE'
    END::text
  FROM information_schema.columns c
  JOIN pg_class t ON t.relname = c.table_name
  JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = c.table_schema
  WHERE c.column_name = 'tenant_id'
    AND c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pgboss')
    AND t.relkind = 'r'
    AND (NOT t.relrowsecurity OR NOT t.relforcerowsecurity)

  UNION ALL

  -- 2. Tabel ber-tenant_id yang RLS-nya aktif tetapi tanpa satu pun kebijakan.
  --
  -- Lebih berbahaya daripada RLS yang mati: RLS aktif tanpa kebijakan menolak
  -- SEMUANYA, sehingga modulnya berhenti bekerja total — dan itu terlihat
  -- seperti kerusakan aplikasi, bukan seperti masalah konfigurasi.
  SELECT
    'policy_missing'::text,
    (n.nspname || '.' || t.relname)::text,
    'RLS aktif tetapi tidak punya kebijakan'::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE t.relkind = 'r'
    AND t.relrowsecurity
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pgboss')
    AND EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = n.nspname AND c.table_name = t.relname
        AND c.column_name = 'tenant_id'
    )
    AND NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = n.nspname AND p.tablename = t.relname)

  UNION ALL

  -- 3. Peran aplikasi yang dapat menembus RLS.
  --
  -- Satu `ALTER ROLE hrms_app BYPASSRLS` yang dijalankan untuk "sementara"
  -- saat menyelesaikan insiden akan membuat seluruh isolasi tenant berhenti
  -- berlaku, dan tidak ada satu pun uji yang akan menangkapnya.
  SELECT
    'bypass_rls'::text,
    r.rolname::text,
    'Peran aplikasi dapat menembus RLS'::text
  FROM pg_roles r
  WHERE r.rolname IN ('hrms_app', 'hrms_worker', 'hrms_platform')
    AND r.rolbypassrls;
$$;

COMMENT ON FUNCTION public.schema_drift_report() IS
  'Menemukan tabel ber-tenant_id tanpa RLS, RLS tanpa kebijakan, dan peran aplikasi yang dapat menembus RLS. Dijalankan harian oleh worker.';

GRANT EXECUTE ON FUNCTION public.schema_drift_report() TO hrms_app, hrms_worker;
