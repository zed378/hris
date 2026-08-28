-- =============================================================================
-- Hak menangguhkan tenant, dibatasi pada tiga kolom
-- =============================================================================
--
-- `TenantStatus.SUSPENDED` dan `CHURNED` diperiksa sejak awal pada login,
-- refresh token, dan permintaan reset kata sandi — seluruhnya fail-closed dan
-- benar. Yang tidak ada adalah satu pun jalur yang MENGHASILKAN status itu.
--
-- Akibatnya langsung mengenai sisi komersial: pelanggan yang berhenti membayar
-- tidak dapat dinonaktifkan. Seluruh mesin langganan bekerja — paket,
-- entitlement, uji coba, penolakan 402 per modul — tanpa tombol terakhir yang
-- menghentikan akses ketika tagihan tidak dibayar.
--
-- Sebabnya ditemukan saat mencoba: `hrms_platform` hanya punya SELECT pada
-- `tenant.tenants`. Penolakan itu adalah rancangan yang bekerja, bukan bug —
-- control plane sengaja hampir tidak dapat menulis apa pun ke bidang tenant.
--
-- Karena itu haknya diperluas SEKECIL mungkin: UPDATE pada TIGA KOLOM, bukan
-- pada tabel. Superuser yang kelak dikompromikan tidak dapat mengganti nama
-- perusahaan, memindahkan paketnya, atau menyentuh kolom mana pun selain yang
-- dibutuhkan untuk menangguhkan.
--
-- PostgreSQL memang menyediakan hak per-kolom, dan ini persis kasus yang
-- dimaksudkannya.

-- `updated_at` ikut, dan alasannya perlu dicatat karena tidak terlihat dari
-- kode mana pun. Kolom itu ber-`@updatedAt` pada Prisma, sehingga SETIAP
-- pembaruan menuliskannya — termasuk pembaruan yang secara logis hanya
-- menyentuh status. Tanpa kolom ini di dalam daftar, hak per-kolom menolak
-- seluruh pernyataannya.
--
-- Yang membuatnya mahal untuk didiagnosis: PostgreSQL menjawab "permission
-- denied for TABLE tenants" — menyebut tabelnya, bukan kolom yang kurang —
-- sehingga penolakannya terlihat seperti hak tabel yang lupa diberikan, dan
-- godaan berikutnya adalah memberikan UPDATE penuh.
GRANT UPDATE (status, suspended_at, churned_at, updated_at)
  ON tenant.tenants
  TO hrms_platform;

COMMENT ON COLUMN tenant.tenants.suspended_at IS
  'Kapan tenant terakhir ditangguhkan. TIDAK dikosongkan saat diaktifkan kembali — riwayatnya dibutuhkan saat sengketa tagihan.';

COMMENT ON COLUMN tenant.tenants.churned_at IS
  'Kapan layanan diakhiri. Data TIDAK dihapus: pelanggan yang berhenti tetap berhak atas ekspor portabilitasnya.';
