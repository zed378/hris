#!/usr/bin/env bash
#
# HRMS database backup.
#
# Uses the `custom` format (-Fc) rather than plain SQL. The reason is not size:
# the custom format can be restored PARTIALLY — one table, one schema — and that
# capability decides whether an incident is resolved in ten minutes or three
# hours. A SQL file can only be run from beginning to end.
#
#
# The `hrms_owner` role is used deliberately: it is the only one that can read
# every table without RLS in the way. A backup taken by the application role
# would contain only the rows of whichever tenant happened to be active on its
# connection — which is none at all, because `app_current_tenant()` returns NULL
# outside `withTenant`. That backup would succeed, be a reasonable size, and be empty.
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
# Two modes, chosen from what is available
# -----------------------------------------------------------------------------
#
# `pg_dump` DIRECTLY when it is on the PATH — this is the mode used when the
# script runs inside a container or on a host with the PostgreSQL client. It
# needs `PGHOST`/`PGPASSWORD` or `DATABASE_URL`.
#
# `docker exec` as the fallback — the development mode, and the mode for a host
# that has Docker but no PostgreSQL client.
#
# The choice is automatic, and the mode is STATED in the output. A backup script
# that silently switches modes is one that succeeds on a laptop and fails on the
# server with a message that does not explain the difference.
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

# `--no-owner` and `--no-privileges` so the dump can be restored into an instance
# whose roles do not exist yet. Roles and grants are rebuilt by the migrations,
# not by the dump — and mixing them makes a restore fail in a new environment
# with a "role does not exist" error that explains nothing.
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

# Verify the contents, not merely that the file exists.
#
# A backup that failed halfway still leaves a file behind. What separates a
# usable backup from a file that merely exists is whether its table of contents
# can be read — and checking that now is far cheaper than discovering it during
# a restore.
TABLES=$(run_restore_list --list < "$FILE" 2>/dev/null | grep -c "TABLE DATA" || true)
echo "Berisi $TABLES tabel dengan data."

if [ "$TABLES" -lt 10 ]; then
  echo "PERINGATAN: jumlah tabel jauh di bawah yang diharapkan. Periksa cadangan ini." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Storage files
# -----------------------------------------------------------------------------
#
# Attendance photos and employee documents are NOT in the database — both are
# files on disk, and `pg_dump` does not know they exist.
#
# A backup holding only the database would look complete: every table there,
# every row there, and `punch_logs.photo_key` pointing at files that are gone.
# The failure only appears when someone opens an attendance photo to settle a
# wage dispute — the one moment that photo matters.
#
# Archived separately and stamped with the SAME time as its dump, so the right
# pair can be recognised at restore time. A database backup and a file archive
# from different moments produce references that do not match.
STORAGE_DIR="${HRMS_STORAGE_DIR:-./.storage}"

if [ -d "$STORAGE_DIR" ]; then
  STORAGE_FILE="$OUT_DIR/hrms-$STAMP-storage.tar.gz"
  echo "Mengarsipkan berkas penyimpanan dari $STORAGE_DIR…"

  tar -czf "$STORAGE_FILE" -C "$(dirname "$STORAGE_DIR")" "$(basename "$STORAGE_DIR")"

  FILES=$(tar -tzf "$STORAGE_FILE" | grep -c -v '/$' || true)
  echo "Selesai: $STORAGE_FILE ($(du -h "$STORAGE_FILE" | cut -f1), $FILES berkas)"
else
  # Stated, not left unsaid. A missing storage directory can mean no photos have
  # been uploaded yet — or it can mean this script was run from the wrong
  # directory, and its backup is missing every file with not one warning.
  # satu pun peringatan.
  echo "CATATAN: direktori penyimpanan \"$STORAGE_DIR\" tidak ada — tidak ada berkas yang diarsipkan."
  echo "         Bila seharusnya ada, periksa HRMS_STORAGE_DIR dan direktori kerja."
fi

# Retention: keep the last 14 backups.
#
# By count, not by age. Daily backups deleted by age would all disappear at once
# if the job stopped for two weeks and then ran again.
# selama dua pekan lalu berjalan lagi.
ls -1t "$OUT_DIR"/hrms-*.dump 2>/dev/null | tail -n +15 | while read -r old; do
  echo "Menghapus cadangan lama: $old"
  rm -f "$old"
  # The matching file archive is deleted with it. Letting those pile up would
  # fill the disk with photos whose database is long gone.
  rm -f "${old%.dump}-storage.tar.gz"
done
