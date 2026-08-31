#!/usr/bin/env bash
# =============================================================================
# Cadangan dasar fisik untuk point-in-time recovery
# =============================================================================
#
# Ini MEKANISME KEDUA, bukan pengganti `backup.sh`. Keduanya ada karena keduanya
# menjawab pertanyaan yang berbeda:
#
#   backup.sh (pg_dump)   — "kembalikan satu tabel", "pindahkan ke server lain",
#                            "buka isinya tanpa PostgreSQL yang sama versinya".
#                            Logis, portabel, selektif. TIDAK dapat dipakai PITR.
#
#   basebackup.sh (ini)   — "kembalikan seluruh basis data ke pukul 14:32:07,
#                            tepat sebelum DELETE tanpa WHERE itu dijalankan".
#                            Fisik, terikat versi, seluruhnya atau tidak sama
#                            sekali.
#
# Cadangan logis dan arsip WAL **tidak dapat digabungkan**. WAL menggambarkan
# perubahan pada tingkat blok fisik; ia hanya berarti di atas salinan fisik yang
# tepat. Karena itu PITR menuntut cadangan dasar tersendiri, dan itulah yang
# dibuat skrip ini.
#
# Pemakaian:
#   ops/scripts/basebackup.sh [direktori-tujuan]
#
# Variabel:
#   HRMS_PG_CONTAINER   nama kontainer PostgreSQL (default: hrms-postgres)
#   HRMS_DB_USER        peran dengan hak REPLICATION (default: hrms_owner)

set -euo pipefail

CONTAINER="${HRMS_PG_CONTAINER:-hrms-postgres}"
DB_USER="${HRMS_DB_USER:-hrms_owner}"
OUT_DIR="${1:-./backups}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET="$OUT_DIR/base-$STAMP"

mkdir -p "$TARGET"

echo "Cadangan dasar → $TARGET"

# `--wal-method=stream` menyertakan segmen WAL yang dibutuhkan agar cadangan ini
# konsisten dengan sendirinya. Tanpa itu, cadangan dasar hanya dapat dipulihkan
# bila arsip WAL-nya utuh sejak detik pertama — dan cadangan yang bergantung
# pada arsip untuk sekadar dapat dibuka bukan cadangan, ia setengah cadangan.
#
# `--checkpoint=fast` memaksa checkpoint segera alih-alih menunggu yang
# terjadwal. Tanpanya skrip ini dapat menggantung beberapa menit tanpa penjelasan
# apa pun, dan orang yang menjalankannya akan menekan Ctrl-C.
docker exec "$CONTAINER" pg_basebackup \
  -U "$DB_USER" \
  -D /tmp/basebackup \
  --format=tar \
  --gzip \
  --wal-method=stream \
  --checkpoint=fast \
  --progress

docker cp "$CONTAINER:/tmp/basebackup/." "$TARGET/"
docker exec "$CONTAINER" rm -rf /tmp/basebackup

# Titik mulai pemulihan dicatat bersama cadangannya.
#
# Tanpa berkas ini, orang yang memulihkan enam bulan kemudian harus menebak
# cadangan dasar mana yang mendahului waktu targetnya — dan menebak salah berarti
# PostgreSQL menolak memulai dengan pesan tentang "requested timeline" yang tidak
# menjelaskan apa pun kepada yang membacanya pada pukul tiga pagi.
LSN=$(docker exec "$CONTAINER" psql -U "$DB_USER" -tAc "SELECT pg_current_wal_lsn()" 2>/dev/null || echo 'tidak diketahui')
cat > "$TARGET/INFO.txt" <<EOF
Cadangan dasar fisik untuk PITR.

Dibuat        : $(date -u +'%Y-%m-%d %H:%M:%S') UTC
Kontainer     : $CONTAINER
Versi         : $(docker exec "$CONTAINER" postgres --version)
LSN saat ini  : $LSN

PENTING
  Cadangan ini hanya dapat dipulihkan oleh PostgreSQL dengan versi mayor yang
  sama. Untuk memindahkan data antar-versi, pakai cadangan logis (backup.sh).

  Pemulihan menuntut arsip WAL yang MENCAKUP rentang dari cadangan ini sampai
  waktu target. Membuang arsip WAL yang lebih tua dari cadangan dasar terbaru
  aman; membuang yang lebih baru menghancurkan kemampuan PITR tanpa peringatan.

  Prosedur pemulihan: ops/scripts/pitr-restore.sh, dan RUNBOOK.md §7.
EOF

UKURAN=$(du -sh "$TARGET" | cut -f1)
echo "Selesai: $TARGET ($UKURAN)"

# -----------------------------------------------------------------------------
# Pemangkasan arsip WAL
# -----------------------------------------------------------------------------
#
# Segmen yang lebih tua dari cadangan dasar TERTUA yang masih disimpan tidak
# dapat dipakai memulihkan apa pun — tidak ada titik awal yang mendahuluinya.
# Membiarkannya berarti disk penuh, dan disk penuh menghentikan
# `archive_command`, yang menghentikan PITR sama sekali.
#
# Yang dipangkas dihitung dari cadangan dasar, BUKAN dari umur. Retensi berbasis
# umur akan membuang arsip yang masih dibutuhkan cadangan dasar yang kebetulan
# lebih tua.
KEEP_BASE="${HRMS_KEEP_BASE:-2}"
TERTUA=$(ls -1d "$OUT_DIR"/base-* 2>/dev/null | sort | tail -n "$KEEP_BASE" | head -1 || true)

if [ -n "$TERTUA" ]; then
  echo "Cadangan dasar tertua yang dipertahankan: $(basename "$TERTUA")"
  echo "Segmen WAL yang lebih tua dari itu dapat dipangkas; lihat RUNBOOK.md §7."
fi

# Cadangan dasar lama dibuang setelah arsipnya tidak lagi dibutuhkan.
ls -1dt "$OUT_DIR"/base-* 2>/dev/null | tail -n "+$((KEEP_BASE + 1))" | while read -r lama; do
  rm -rf "$lama"
  echo "Dibuang: $(basename "$lama")"
done
