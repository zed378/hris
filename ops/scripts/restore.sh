#!/usr/bin/env bash
#
# Pemulihan basis data HRMS dari cadangan.
#
# **Prosedur ini menghapus isi basis data tujuan.** Ia menuntut konfirmasi
# eksplisit berupa nama basis datanya, bukan sekadar "y" — karena satu-satunya
# hal yang lebih buruk daripada tidak punya cadangan adalah memulihkan cadangan
# lama ke atas basis data produksi yang masih baik.
#
# Peran dan hak akses TIDAK ada di dalam dump (lihat `backup.sh`). Keduanya
# dibangun ulang oleh migrasi, sehingga urutannya:
#
#   1. Basis data kosong dibuat.
#   2. Peran dipastikan ada (skrip ini).
#   3. Dump dipulihkan.
#   4. `prisma migrate deploy` dijalankan — idempoten, hanya melengkapi yang
#      belum ada, termasuk kebijakan RLS dan hak akses.
#
# Langkah 4 tidak boleh dilewati. Dump memuat tabel dan datanya, tetapi
# kebijakan RLS ikut di dalamnya hanya bila versi PostgreSQL-nya sama — dan
# basis data tanpa RLS berarti setiap tenant membaca data seluruh tenant lain.
#
#   bash ops/scripts/restore.sh <berkas.dump> [nama-basis-data-tujuan]
#
set -euo pipefail

CONTAINER="${HRMS_PG_CONTAINER:-hrms-postgres}"
DB_USER="${HRMS_DB_USER:-hrms_owner}"
FILE="${1:?Sebutkan berkas cadangan: bash ops/scripts/restore.sh backups/hrms-....dump [db]}"
TARGET="${2:-hrms_restore}"

if [ ! -f "$FILE" ]; then
  echo "Berkas tidak ditemukan: $FILE" >&2
  exit 1
fi

echo "Akan MEMULIHKAN  : $FILE"
echo "Ke basis data    : $TARGET"
echo "Kontainer        : $CONTAINER"
echo
echo "SELURUH ISI basis data \"$TARGET\" akan dihapus."
printf 'Ketik nama basis datanya untuk melanjutkan: '
read -r CONFIRM

if [ "$CONFIRM" != "$TARGET" ]; then
  echo "Dibatalkan — yang diketik tidak cocok." >&2
  exit 1
fi

echo
echo "1/4 Membuat ulang basis data…"
# Koneksi yang masih terbuka menahan DROP DATABASE. Diputus lebih dulu supaya
# pemulihan tidak berhenti dengan "database is being accessed by other users"
# pada saat yang paling tidak tepat.
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -q -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET' AND pid <> pg_backend_pid()" \
  >/dev/null 2>&1 || true

docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -q -c "DROP DATABASE IF EXISTS \"$TARGET\""
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -q -c "CREATE DATABASE \"$TARGET\""

echo "2/4 Memastikan peran aplikasi ada…"
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -q <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    CREATE ROLE hrms_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_worker') THEN
    CREATE ROLE hrms_worker NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_platform') THEN
    CREATE ROLE hrms_platform NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
SQL

echo "3/4 Memulihkan data…"
# `--exit-on-error` TIDAK dipakai. Dump `--no-owner` menghasilkan sejumlah
# peringatan tentang kepemilikan objek yang memang diabaikan, dan berhenti
# pada peringatan pertama akan membatalkan pemulihan yang sebenarnya berhasil.
# Yang diperiksa adalah hasilnya, di langkah 4.
docker exec -i "$CONTAINER" pg_restore \
  -U "$DB_USER" \
  -d "$TARGET" \
  --no-owner \
  --no-privileges \
  < "$FILE" 2>&1 | grep -v "^pg_restore: warning" || true

echo "4/4 Memeriksa hasil…"

TABLES=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$TARGET" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")
EMPLOYEES=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$TARGET" -tAc \
  "SELECT count(*) FROM employee.employees" 2>/dev/null || echo "?")
TENANTS=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$TARGET" -tAc \
  "SELECT count(*) FROM tenant.tenants" 2>/dev/null || echo "?")

echo "   tabel    : $TABLES"
echo "   tenant   : $TENANTS"
echo "   karyawan : $EMPLOYEES"

# Pemeriksaan yang menentukan. Data yang pulih tanpa RLS bukan pemulihan yang
# berhasil — ia kebocoran yang menunggu permintaan pertama.
DRIFT=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$TARGET" -tAc \
  "SELECT count(*) FROM public.schema_drift_report()" 2>/dev/null || echo "?")

echo "   drift RLS: $DRIFT"
echo

if [ "$DRIFT" = "0" ]; then
  echo "Pemulihan selesai dan RLS utuh."
else
  echo "PERINGATAN: pemeriksaan drift mengembalikan \"$DRIFT\"." >&2
  echo "Jalankan migrasi terhadap basis data ini sebelum memakainya:" >&2
  echo "  DATABASE_URL=<url-ke-$TARGET> pnpm --filter @hrms/db exec prisma migrate deploy" >&2
  exit 1
fi
