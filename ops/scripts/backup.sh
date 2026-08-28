#!/usr/bin/env bash
#
# Cadangan basis data HRMS.
#
# Memakai format `custom` (-Fc), bukan SQL biasa. Alasannya bukan ukuran:
# format custom dapat dipulihkan SEBAGIAN — satu tabel, satu skema — dan
# kemampuan itu yang menentukan apakah sebuah insiden dapat diselesaikan dalam
# sepuluh menit atau tiga jam. Berkas SQL hanya dapat dijalankan dari awal
# sampai akhir.
#
# Peran `hrms_owner` dipakai dengan sengaja: ia satu-satunya yang dapat membaca
# seluruh tabel tanpa terhalang RLS. Cadangan yang diambil peran aplikasi hanya
# akan memuat baris milik tenant yang kebetulan aktif pada koneksinya — yaitu
# tidak ada satu pun, karena `app_current_tenant()` mengembalikan NULL di luar
# `withTenant`. Cadangan itu akan berhasil, berukuran wajar, dan kosong.
#
#   bash ops/scripts/backup.sh [direktori-tujuan]
#
set -euo pipefail

CONTAINER="${HRMS_PG_CONTAINER:-hrms-postgres}"
DB="${HRMS_DB:-hrms}"
DB_USER="${HRMS_DB_USER:-hrms_owner}"
OUT_DIR="${1:-./backups}"

mkdir -p "$OUT_DIR"

# -----------------------------------------------------------------------------
# Dua mode, dipilih dari apa yang tersedia
# -----------------------------------------------------------------------------
#
# `pg_dump` LANGSUNG bila ada di PATH — inilah mode yang dipakai saat skrip
# berjalan di dalam kontainer atau di host yang punya klien PostgreSQL. Ia
# menuntut `PGHOST`/`PGPASSWORD` atau `DATABASE_URL`.
#
# `docker exec` sebagai cadangan — mode pengembangan, dan mode host yang hanya
# punya Docker tanpa klien PostgreSQL.
#
# Pemilihannya otomatis, dan modenya DINYATAKAN di keluaran. Skrip cadangan yang
# diam-diam berpindah mode adalah skrip yang berhasil di laptop dan gagal di
# server dengan pesan yang tidak menjelaskan bedanya.
if command -v pg_dump >/dev/null 2>&1 && [ -n "${PGHOST:-}${DATABASE_URL:-}" ]; then
  MODE="langsung"
  run_dump() { pg_dump "$@"; }
  run_restore_list() { pg_restore "$@"; }
else
  MODE="docker"
  run_dump() { docker exec "$CONTAINER" pg_dump "$@"; }
  run_restore_list() { docker exec -i "$CONTAINER" pg_restore "$@"; }
fi

echo "Mode: $MODE"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$OUT_DIR/hrms-$STAMP.dump"

echo "Mencadangkan $DB dari kontainer $CONTAINER…"

# `--no-owner` dan `--no-privileges` supaya dump dapat dipulihkan ke instance
# yang perannya belum dibuat. Peran dan hak akses dibangun ulang oleh migrasi,
# bukan oleh dump — dan mencampurnya membuat pemulihan gagal di lingkungan baru
# dengan galat "role does not exist" yang tidak menjelaskan apa pun.
run_dump \
  -U "$DB_USER" \
  -d "$DB" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  > "$FILE"

SIZE=$(du -h "$FILE" | cut -f1)
echo "Selesai: $FILE ($SIZE)"

# Verifikasi isi, bukan hanya keberadaan berkas.
#
# Cadangan yang gagal separuh jalan tetap meninggalkan berkas. Yang membedakan
# cadangan yang dapat dipakai dari berkas yang sekadar ada adalah apakah
# daftar isinya dapat dibaca — dan memeriksanya sekarang jauh lebih murah
# daripada menemukannya saat sedang memulihkan.
TABLES=$(run_restore_list --list < "$FILE" 2>/dev/null | grep -c "TABLE DATA" || true)
echo "Berisi $TABLES tabel dengan data."

if [ "$TABLES" -lt 10 ]; then
  echo "PERINGATAN: jumlah tabel jauh di bawah yang diharapkan. Periksa cadangan ini." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Berkas penyimpanan
# -----------------------------------------------------------------------------
#
# Foto presensi dan dokumen karyawan TIDAK ada di dalam basis data — keduanya
# berkas di disk, dan `pg_dump` tidak mengetahui keberadaannya.
#
# Cadangan yang hanya memuat basis data akan terlihat lengkap: seluruh tabel
# ada, seluruh baris ada, dan `punch_logs.photo_key` menunjuk berkas yang sudah
# tidak ada. Kegagalannya baru terlihat saat seseorang membuka foto presensi
# untuk menyelesaikan sengketa upah — yaitu satu-satunya saat foto itu penting.
#
# Diarsipkan terpisah dan diberi stempel waktu yang SAMA dengan dump-nya,
# supaya pasangan yang benar dapat dikenali saat memulihkan. Cadangan basis data
# dan berkas dari waktu berbeda menghasilkan rujukan yang tidak cocok.
STORAGE_DIR="${HRMS_STORAGE_DIR:-./.storage}"

if [ -d "$STORAGE_DIR" ]; then
  STORAGE_FILE="$OUT_DIR/hrms-$STAMP-storage.tar.gz"
  echo "Mengarsipkan berkas penyimpanan dari $STORAGE_DIR…"

  tar -czf "$STORAGE_FILE" -C "$(dirname "$STORAGE_DIR")" "$(basename "$STORAGE_DIR")"

  FILES=$(tar -tzf "$STORAGE_FILE" | grep -c -v '/$' || true)
  echo "Selesai: $STORAGE_FILE ($(du -h "$STORAGE_FILE" | cut -f1), $FILES berkas)"
else
  # Dinyatakan, bukan didiamkan. Direktori penyimpanan yang tidak ada bisa
  # berarti belum ada foto yang diunggah — atau berarti skrip ini dijalankan
  # dari direktori yang salah, dan cadangannya kehilangan seluruh berkas tanpa
  # satu pun peringatan.
  echo "CATATAN: direktori penyimpanan \"$STORAGE_DIR\" tidak ada — tidak ada berkas yang diarsipkan."
  echo "         Bila seharusnya ada, periksa HRMS_STORAGE_DIR dan direktori kerja."
fi

# Retensi: simpan 14 cadangan terakhir.
#
# Bukan berdasarkan umur, melainkan jumlah. Cadangan harian yang dihapus
# berdasarkan umur akan menghapus semuanya sekaligus bila job-nya berhenti
# selama dua pekan lalu berjalan lagi.
ls -1t "$OUT_DIR"/hrms-*.dump 2>/dev/null | tail -n +15 | while read -r old; do
  echo "Menghapus cadangan lama: $old"
  rm -f "$old"
  # Arsip berkas pasangannya ikut dihapus. Membiarkannya menumpuk akan
  # menghabiskan disk dengan foto yang basis datanya sudah tidak ada.
  rm -f "${old%.dump}-storage.tar.gz"
done
