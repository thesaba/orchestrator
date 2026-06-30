#!/usr/bin/env bash
# Usage: rename-domain.sh <old_domain> <new_domain>
#
# Renames a site's domain on disk:
#   - moves /var/www/sites/<old> -> /var/www/sites/<new>
#   - rewrites the Nginx config (server_name + root) and re-links sites-enabled
#   - reloads Nginx
#
# NOTE: any existing SSL certificate was issued for <old_domain> and will
# NOT automatically cover <new_domain> — re-run SSL setup afterwards.
set -euo pipefail

OLD="${1:?old domain required}"
NEW="${2:?new domain required}"

# Safety guard: both must look like real hostnames (no path traversal)
for d in "$OLD" "$NEW"; do
  if ! echo "$d" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9.\-]+[a-zA-Z0-9]$'; then
    echo "ERROR: invalid domain '$d'" >&2
    exit 1
  fi
done

OLD_DIR="/var/www/sites/$OLD"
NEW_DIR="/var/www/sites/$NEW"
OLD_CONF="/etc/nginx/sites-available/$OLD"
NEW_CONF="/etc/nginx/sites-available/$NEW"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "=== Renaming $OLD -> $NEW ==="

if [ ! -d "$OLD_DIR" ]; then
  echo "ERROR: $OLD_DIR does not exist" >&2
  exit 1
fi
if [ -e "$NEW_DIR" ]; then
  echo "ERROR: $NEW_DIR already exists" >&2
  exit 1
fi

log "[1/2] Moving site directory..."
mv "$OLD_DIR" "$NEW_DIR"
log "  $OLD_DIR -> $NEW_DIR"

if [ -f "$OLD_CONF" ]; then
  log "[2/2] Rewriting Nginx config..."
  sed -e "s|server_name ${OLD};|server_name ${NEW};|g" \
      -e "s|${OLD_DIR}|${NEW_DIR}|g" \
      "$OLD_CONF" > "$NEW_CONF"
  rm -f "$OLD_CONF" "${OLD_CONF}.bak"
  rm -f "/etc/nginx/sites-enabled/$OLD"
  ln -sf "$NEW_CONF" "/etc/nginx/sites-enabled/$NEW"

  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    log "  Nginx reloaded"
  else
    echo "ERROR: nginx -t failed after rewrite — config left in place, please check manually" >&2
    exit 1
  fi
else
  log "  WARNING: no Nginx config found at $OLD_CONF — skipped Nginx rewrite"
fi

# ── 3. Supervisor config ─────────────────────────────────────────────────────
# Stale conf.d files for the old domain cause CANT_REREAD for ALL sites on
# every subsequent `supervisorctl update` call — remove it unconditionally.
OLD_SUP="/etc/supervisor/conf.d/${OLD}-worker.conf"
if [ -f "$OLD_SUP" ]; then
  log "[3/3] Removing stale supervisor config for old domain..."
  rm -f "$OLD_SUP"
  supervisorctl reread && supervisorctl update 2>&1 || true
  log "  Removed $OLD_SUP and reloaded supervisor"
else
  log "[3/3] No supervisor config found for $OLD — skipping"
fi

log "=== Done. $OLD renamed to $NEW ==="
log "NOTE: re-run SSL setup for $NEW if this site was using HTTPS."
