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

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$OUT_DIR/hrms-$STAMP.dump"

echo "Mencadangkan $DB dari kontainer $CONTAINER…"

# `--no-owner` dan `--no-privileges` supaya dump dapat dipulihkan ke instance
# yang perannya belum dibuat. Peran dan hak akses dibangun ulang oleh migrasi,
# bukan oleh dump — dan mencampurnya membuat pemulihan gagal di lingkungan baru
# dengan galat "role does not exist" yang tidak menjelaskan apa pun.
docker exec "$CONTAINER" pg_dump \
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
TABLES=$(docker exec -i "$CONTAINER" pg_restore --list < "$FILE" 2>/dev/null | grep -c "TABLE DATA" || true)
echo "Berisi $TABLES tabel dengan data."

if [ "$TABLES" -lt 10 ]; then
  echo "PERINGATAN: jumlah tabel jauh di bawah yang diharapkan. Periksa cadangan ini." >&2
  exit 1
fi

# Retensi: simpan 14 cadangan terakhir.
#
# Bukan berdasarkan umur, melainkan jumlah. Cadangan harian yang dihapus
# berdasarkan umur akan menghapus semuanya sekaligus bila job-nya berhenti
# selama dua pekan lalu berjalan lagi.
ls -1t "$OUT_DIR"/hrms-*.dump 2>/dev/null | tail -n +15 | while read -r old; do
  echo "Menghapus cadangan lama: $old"
  rm -f "$old"
done
