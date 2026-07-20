#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Install a catch-all default server so an UNMATCHED hostname never gets served
# somebody else's site.
#
# Why this matters: nginx, when no server_name matches a request, falls back to
# the "default server" — and if none is declared for that port, it uses the
# FIRST server block it loaded. On a multi-tenant box that means a brand-new
# domain (or a typo'd/www variant, or any random domain someone points at your
# IP) silently shows another customer's website. That is confusing at best and
# an information leak at worst.
#
# After this runs, an unmatched host gets a blank 404 instead — on both HTTP and
# HTTPS. Sites with a real server_name are completely unaffected.
#
# Idempotent: safe to re-run. Guarded by `nginx -t` with automatic rollback, so
# a failure can never leave nginx unable to start.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CONF="/etc/nginx/sites-available/000-catchall"
LINK="/etc/nginx/sites-enabled/000-catchall"
CERT_DIR="/etc/nginx/orchestrator-catchall"
CRT="$CERT_DIR/self.crt"
KEY="$CERT_DIR/self.key"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

[ "$(id -u)" = "0" ] || { echo "ERROR: run as root." >&2; exit 1; }

# ── A self-signed cert, purely so nginx can terminate TLS for unknown hosts ───
# It is never shown for a real site (those match their own server_name first).
if [ ! -s "$CRT" ] || [ ! -s "$KEY" ]; then
  log "Generating a self-signed certificate for the catch-all server…"
  mkdir -p "$CERT_DIR"; chmod 700 "$CERT_DIR"
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$KEY" -out "$CRT" -subj "/CN=invalid" >/dev/null 2>&1
  chmod 600 "$KEY"
fi

# ── Is a default_server already declared for :443 by someone else? ────────────
# Declaring a second one makes nginx refuse to start, so bail out politely.
if nginx -T 2>/dev/null | grep -qE '^\s*listen\s+(\[::\]:)?443[^;]*default_server' \
   && ! grep -qs 'default_server' "$CONF"; then
  log "A 443 default_server is already declared elsewhere — leaving it alone."
  exit 0
fi

BACKUP=""
if [ -f "$CONF" ]; then BACKUP="$CONF.bak.$$"; cp -f "$CONF" "$BACKUP"; fi

cat > "$CONF" <<NGINX
# Managed by Orchestrator — catch-all for hostnames that match no site.
# Returns an empty 404 so an unknown/typo'd/not-yet-configured domain can never
# be served another customer's website.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 404;
}

server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;

    ssl_certificate     $CRT;
    ssl_certificate_key $KEY;

    return 404;
}
NGINX

ln -sf "$CONF" "$LINK"

# The stock Debian/Ubuntu default site also claims :80 default_server, which
# would collide. Disable it — it only ever serves the "Welcome to nginx" page.
if [ -L /etc/nginx/sites-enabled/default ]; then
  log "Disabling the stock 'default' site (it also claims :80 default_server)…"
  rm -f /etc/nginx/sites-enabled/default
  STOCK_DISABLED=1
fi

if ! nginx -t 2>/tmp/oc-catchall.$$; then
  echo "nginx -t failed — rolling back." >&2
  cat /tmp/oc-catchall.$$ >&2; rm -f /tmp/oc-catchall.$$
  rm -f "$LINK"
  if [ -n "$BACKUP" ]; then mv -f "$BACKUP" "$CONF"; else rm -f "$CONF"; fi
  [ "${STOCK_DISABLED:-0}" = "1" ] && ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  exit 1
fi
rm -f /tmp/oc-catchall.$$ "$BACKUP" 2>/dev/null || true

systemctl reload nginx
log "✓ Catch-all default server installed — unmatched hosts now get 404."
