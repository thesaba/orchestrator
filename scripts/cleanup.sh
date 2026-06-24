#!/usr/bin/env bash
# Usage: cleanup.sh <domain> <root_path> [db_name] [db_user]
#
# Removes all server-side resources for a site:
#   - Nginx config + sites-enabled symlink
#   - MySQL database and user (if provided)
#   - Site files (/var/www/sites/<domain>)
set -euo pipefail

DOMAIN="${1:?domain required}"
ROOT_PATH="${2:?root_path required}"
DB_NAME="${3:-}"
DB_USER="${4:-}"

# Safety guard: domain must look like a real hostname (no path traversal)
if ! echo "$DOMAIN" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9.\-]+[a-zA-Z0-9]$'; then
  echo "ERROR: invalid domain '$DOMAIN'" >&2
  exit 1
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "=== Cleaning up $DOMAIN ==="

# ── 1. Nginx ─────────────────────────────────────────────────────────────────
log "[1/3] Removing Nginx config..."
NGINX_CONF="/etc/nginx/sites-available/$DOMAIN"
NGINX_LINK="/etc/nginx/sites-enabled/$DOMAIN"

rm -f "$NGINX_LINK"
rm -f "$NGINX_CONF"
rm -f "${NGINX_CONF}.bak"
log "  Removed $NGINX_CONF (and symlink)"

if nginx -t 2>/dev/null; then
  systemctl reload nginx
  log "  Nginx reloaded"
else
  log "  WARNING: nginx -t failed after removal — not reloading"
fi

# ── 2. MySQL ─────────────────────────────────────────────────────────────────
if [ -n "$DB_NAME" ] || [ -n "$DB_USER" ]; then
  log "[2/3] Dropping MySQL database and user..."
  [ -n "$DB_NAME" ] && sudo mysql -e "DROP DATABASE IF EXISTS \`${DB_NAME}\`;" && log "  Dropped DB: $DB_NAME"
  [ -n "$DB_USER" ] && sudo mysql -e "DROP USER IF EXISTS '${DB_USER}'@'localhost'; FLUSH PRIVILEGES;" && log "  Dropped user: $DB_USER"
else
  log "[2/3] No DB info — skipping MySQL cleanup"
fi

# ── 3. Site files ────────────────────────────────────────────────────────────
log "[3/3] Removing site files..."
if [ -d "$ROOT_PATH" ]; then
  rm -rf "$ROOT_PATH"
  log "  Removed $ROOT_PATH"
else
  log "  $ROOT_PATH not found — skipping"
fi

log "=== Cleanup complete for $DOMAIN ==="
