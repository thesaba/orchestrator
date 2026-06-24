#!/usr/bin/env bash
# Usage: backup.sh <site_root>
#
# Reads DB credentials from <site_root>/shared/.env and creates a gzipped mysqldump.
# Keeps the 30 most recent backups; older ones are deleted automatically.
#
# Cron example (written by Orchestrator to /etc/cron.d/):
#   0 2 * * * www-data /opt/orchestrator/scripts/backup.sh /var/www/sites/example.com
set -euo pipefail

SITE_ROOT="${1:?site_root required}"
ENV_FILE="$SITE_ROOT/shared/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "[$(date '+%H:%M:%S')] ERROR: $ENV_FILE not found" >&2
  exit 1
fi

# Extract a value from the .env file (handles quoted and unquoted values)
get_env() {
  grep -m1 "^${1}=" "$ENV_FILE" 2>/dev/null \
    | cut -d= -f2- \
    | sed "s/^['\"]//;s/['\"]$//" \
    | xargs 2>/dev/null || true
}

DB_NAME=$(get_env DB_DATABASE)
DB_USER=$(get_env DB_USERNAME)
DB_PASS=$(get_env DB_PASSWORD)

if [ -z "$DB_NAME" ]; then
  echo "[$(date '+%H:%M:%S')] ERROR: DB_DATABASE not set in $ENV_FILE" >&2
  exit 1
fi

BACKUPS_DIR="$SITE_ROOT/backups"
mkdir -p "$BACKUPS_DIR"

TIMESTAMP=$(date +%Y%m%d%H%M%S)
FILENAME="${DB_NAME}_${TIMESTAMP}.sql.gz"
FILEPATH="$BACKUPS_DIR/$FILENAME"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "Starting backup of $DB_NAME → $FILENAME"

export MYSQL_PWD="$DB_PASS"
mysqldump ${DB_USER:+-u "$DB_USER"} "$DB_NAME" | gzip > "$FILEPATH"

SIZE=$(du -sh "$FILEPATH" | cut -f1)
log "Backup complete: $FILEPATH ($SIZE)"

# Retain only the 30 most recent backups
REMOVED=$(ls -t "$BACKUPS_DIR"/*.sql.gz 2>/dev/null | tail -n +31 | wc -l | tr -d ' ')
ls -t "$BACKUPS_DIR"/*.sql.gz 2>/dev/null | tail -n +31 | xargs rm -f || true
[ "$REMOVED" -gt 0 ] && log "Pruned $REMOVED old backup(s)"

log "Done."
