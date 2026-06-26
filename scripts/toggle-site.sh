#!/usr/bin/env bash
# Usage: toggle-site.sh <domain> <on|off>
#
# Enables/disables serving for a site by adding/removing its Nginx
# sites-enabled symlink, then reloading Nginx. Does not touch the site's
# files, database, or Nginx config — fully reversible (run "on" to restore).
set -euo pipefail

DOMAIN="${1:?domain required}"
ACTION="${2:?on|off required}"

if ! echo "$DOMAIN" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9.\-]+[a-zA-Z0-9]$'; then
  echo "ERROR: invalid domain '$DOMAIN'" >&2
  exit 1
fi

CONF="/etc/nginx/sites-available/$DOMAIN"
LINK="/etc/nginx/sites-enabled/$DOMAIN"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

case "$ACTION" in
  off)
    if [ -L "$LINK" ] || [ -e "$LINK" ]; then
      rm -f "$LINK"
      log "Disabled: removed $LINK"
    else
      log "Already disabled (no symlink present)"
    fi
    ;;
  on)
    if [ ! -f "$CONF" ]; then
      echo "ERROR: no Nginx config at $CONF — provision the site first" >&2
      exit 1
    fi
    ln -sf "$CONF" "$LINK"
    log "Enabled: linked $LINK -> $CONF"
    ;;
  *)
    echo "ERROR: action must be 'on' or 'off'" >&2
    exit 1
    ;;
esac

if nginx -t 2>/dev/null; then
  systemctl reload nginx
  log "Nginx reloaded"
else
  echo "ERROR: nginx -t failed — not reloading, please check config" >&2
  exit 1
fi

log "Done."
