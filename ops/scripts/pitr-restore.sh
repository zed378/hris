#!/usr/bin/env bash
# =============================================================================
# Point-in-time recovery
# =============================================================================
#
# Answers the question a daily backup cannot: "restore the whole database to
# 14:32:07, just before that DELETE without a WHERE ran."
#
# Usage:
#   ops/scripts/pitr-restore.sh <base-backup-dir> <wal-archive-dir> "<target-time>" [container-name]
#
# Example:
#   ops/scripts/pitr-restore.sh ./backups/base-20260831T060000Z ./wal \
#     "2026-08-31 14:32:07+07" hrms-pitr
#
# =============================================================================
# READ THIS BEFORE RUNNING IT
# =============================================================================
#
# **This never touches the running database.** It builds a NEW instance in its
# own container and volume. That is deliberate: a restore that overwrites
# production cannot be undone, and the question "is this the right point?" can
# only be answered by looking at the result.
#
# The flow is: restore into a new instance -> inspect the data -> only then
# decide whether to swap it in. The swap steps are in RUNBOOK.md §7.
#
# **Everything goes into a Docker volume, and files are copied in with
# `docker cp` rather than bind-mounted.** Two reasons, both learned by hitting
# them:
#
#   - PostgreSQL refuses to start on a data directory whose permissions are
#     wrong, and bind mounts from Windows or macOS hosts cannot carry Unix
#     ownership.
#   - Host path translation differs across Docker Desktop, WSL, and native
#     Linux. A missing mount shows up as "recovery ended before configured
#     recovery target was reached" — a message that says nothing about the
#     mount.
#
# Together those mean a restore that works on the Linux server would fail on the
# laptop of whoever tries to rehearse it. A recovery procedure that can only be
# rehearsed in production is a procedure nobody will rehearse.
#
# **The target time must carry a timezone.** "2026-08-31 14:32:07" without one
# is read in the server's `timezone`, and a server running in UTC will restore
# to a point seven hours away from what someone in Jakarta meant.

set -euo pipefail
export MSYS_NO_PATHCONV=1

BASE_DIR="${1:?Give the base backup directory}"
WAL_DIR="${2:?Give the WAL archive directory}"
TARGET_TIME="${3:?Give the target time, e.g. \"2026-08-31 14:32:07+07\"}"
CONTAINER="${4:-hrms-pitr}"
PORT="${HRMS_PITR_PORT:-5434}"
IMAGE="${HRMS_PG_IMAGE:-postgres:16-alpine}"
VOLUME="${CONTAINER}-data"
PREP="${CONTAINER}-prep"

[ -d "$BASE_DIR" ] || { echo "Base backup directory not found: $BASE_DIR" >&2; exit 1; }
[ -d "$WAL_DIR" ] || { echo "WAL archive directory not found: $WAL_DIR" >&2; exit 1; }
[ -f "$BASE_DIR/base.tar.gz" ] || { echo "base.tar.gz missing from $BASE_DIR" >&2; exit 1; }

if ! echo "$TARGET_TIME" | grep -qE '[+-][0-9]{2}(:?[0-9]{2})?$|Z$|UTC$'; then
  echo "Target time must carry a timezone, e.g. \"2026-08-31 14:32:07+07\"." >&2
  echo "Without one the result shifts by the server's timezone offset." >&2
  exit 1
fi

echo "Preparing recovery"
echo "  base backup   : $BASE_DIR"
echo "  WAL archive   : $WAL_DIR"
echo "  target time   : $TARGET_TIME"
echo "  new instance  : $CONTAINER (port $PORT, volume $VOLUME)"
echo

docker rm -f "$CONTAINER" "$PREP" >/dev/null 2>&1 || true
docker volume rm "$VOLUME" >/dev/null 2>&1 || true
docker volume create "$VOLUME" >/dev/null

# A helper container holds the volume open so files can be copied into it. It
# runs as root because the extracted data directory has to be handed to the
# postgres user afterwards, and only root can do that.
docker run -d --name "$PREP" -u root -v "$VOLUME:/data" "$IMAGE" sleep 600 >/dev/null
trap 'docker rm -f "$PREP" >/dev/null 2>&1 || true' EXIT

docker cp "$BASE_DIR/base.tar.gz" "$PREP:/tmp/base.tar.gz"
if [ -f "$BASE_DIR/pg_wal.tar.gz" ]; then
  docker cp "$BASE_DIR/pg_wal.tar.gz" "$PREP:/tmp/pg_wal.tar.gz"
fi

docker exec "$PREP" mkdir -p /data/pitr_wal
docker cp "$WAL_DIR/." "$PREP:/data/pitr_wal"

docker exec "$PREP" sh -c "
set -e
tar -xzf /tmp/base.tar.gz -C /data

# Segments included by --wal-method=stream. These are what make the base backup
# self-consistent before the archive is touched at all.
if [ -f /tmp/pg_wal.tar.gz ]; then
  mkdir -p /data/pg_wal
  tar -xzf /tmp/pg_wal.tar.gz -C /data/pg_wal
fi

# This marker is what puts PostgreSQL into recovery mode instead of starting
# normally. Without it, it treats the copy as a database that was not shut down
# cleanly and recovers to the LAST point it knows about — not the one asked for.
touch /data/recovery.signal

cat >> /data/postgresql.conf <<'CONF'

# --- added by pitr-restore.sh ---
restore_command = 'cp /var/lib/postgresql/data/pitr_wal/%f %p'
recovery_target_time = '$TARGET_TIME'
# 'promote' makes the instance writable once it reaches the target.
# 'pause' would leave it read-only awaiting a manual command — useful when
# probing repeatedly, confusing for someone running this once at 3am.
recovery_target_action = 'promote'
recovery_target_inclusive = on
CONF

chown -R 70:70 /data
chmod 700 /data
"

docker rm -f "$PREP" >/dev/null 2>&1 || true
trap - EXIT

echo "Starting recovery instance…"
docker run -d \
  --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=pitr \
  -p "$PORT:5432" \
  -v "$VOLUME:/var/lib/postgresql/data" \
  "$IMAGE" >/dev/null

echo "Waiting for recovery to finish…"
for _ in $(seq 1 120); do
  docker exec "$CONTAINER" pg_isready -q 2>/dev/null && break
  sleep 1
done

if ! docker exec "$CONTAINER" pg_isready -q 2>/dev/null; then
  echo
  echo "Instance did not come up. Logs:" >&2
  docker logs --tail 40 "$CONTAINER" >&2
  exit 1
fi

echo
echo "Recovery finished. Instance is listening on port $PORT."
echo
echo "INSPECT THE DATA BEFORE SWAPPING IT INTO PRODUCTION:"
echo "  psql -h localhost -p $PORT -U postgres"
echo
echo "If it looks right, the swap steps are in RUNBOOK.md §7."
echo "If not, try a different target time:"
echo "  docker rm -f $CONTAINER && docker volume rm $VOLUME"
