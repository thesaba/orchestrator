#!/usr/bin/env bash
# Back up the Orchestrator panel's OWN SQLite database (users, sites, audit log,
# settings, tasks, …). This is separate from the per-site MySQL backups.
#
# Usage: panel-backup.sh [db_path] [backup_dir] [keep]
#   db_path    default: /opt/orchestrator/apps/api/prod.db
#   backup_dir default: /opt/orchestrator/backups/panel
#   keep       number of backups to retain (default: 14)
#
# Install as a daily job with the provided systemd timer:
#   sudo cp orchestrator-backup.{service,timer} /etc/systemd/system/
#   sudo systemctl enable --now orchestrator-backup.timer
set -euo pipefail

DB_PATH="${1:-/opt/orchestrator/apps/api/prod.db}"
BACKUP_DIR="${2:-/opt/orchestrator/backups/panel}"
KEEP="${3:-14}"

if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: database not found at $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_DIR/panel-$TS.db"

# Prefer sqlite3's online .backup — it is consistent even while the API is
# writing (WAL-safe). Fall back to a plain copy if sqlite3 isn't installed.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$DEST'"
else
  cp "$DB_PATH" "$DEST"
fi

gzip -f "$DEST"
echo "Backed up $DB_PATH -> ${DEST}.gz"

# Retain only the newest $KEEP archives.
ls -1t "$BACKUP_DIR"/panel-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
