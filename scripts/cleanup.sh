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

# DB name/user (when provided) must be plain identifiers — they are interpolated
# into privileged SQL below, so reject anything that could break out of it.
if [ -n "$DB_NAME" ] && ! printf '%s' "$DB_NAME" | grep -qE '^[A-Za-z0-9_]+$'; then
  echo "ERROR: invalid db name '$DB_NAME'" >&2
  exit 1
fi
if [ -n "$DB_USER" ] && ! printf '%s' "$DB_USER" | grep -qE '^[A-Za-z0-9_]+$'; then
  echo "ERROR: invalid db user '$DB_USER'" >&2
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
  # provision.sh creates the user for BOTH 'localhost' (socket) and '127.0.0.1'
  # (TCP) — drop both grantees so no orphan user/credential is left behind.
  [ -n "$DB_USER" ] && sudo mysql -e "DROP USER IF EXISTS '${DB_USER}'@'localhost', '${DB_USER}'@'127.0.0.1'; FLUSH PRIVILEGES;" && log "  Dropped user: $DB_USER"
else
  log "[2/3] No DB info — skipping MySQL cleanup"
fi

# ── 3. Supervisor worker config ───────────────────────────────────────────────
SUPERVISOR_CONF="/etc/supervisor/conf.d/${DOMAIN}-worker.conf"
log "[3/4] Removing supervisor worker config (if any)..."
if [ -f "$SUPERVISOR_CONF" ]; then
  rm -f "$SUPERVISOR_CONF"
  supervisorctl reread && supervisorctl update 2>&1 || true
  log "  Removed $SUPERVISOR_CONF and reloaded supervisor"
else
  log "  No supervisor config found for $DOMAIN — skipping"
fi

# ── 4. Site files ────────────────────────────────────────────────────────────
log "[4/4] Removing site files..."
if [ -d "$ROOT_PATH" ]; then
  rm -rf "$ROOT_PATH"
  log "  Removed $ROOT_PATH"
else
  log "  $ROOT_PATH not found — skipping"
fi

log "=== Cleanup complete for $DOMAIN ==="
