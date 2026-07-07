#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Apply per-site nginx security (HTTP basic auth + IP allow/deny) SAFELY.
#
# The security directives live in a dedicated snippet that the site's vhost
# `include`s. The vhost is edited only ONCE (to add the include), guarded by a
# backup + `nginx -t` + automatic rollback, so a hosted site can NEVER be left
# in a broken state:
#   • adding the include: if `nginx -t` fails, the original vhost is restored.
#   • changing the snippet: if `nginx -t` fails, the snippet is blanked out and
#     nginx reloaded, so the site keeps serving (just without the new rules).
#
# Inputs (env): SEC_SNIPPET (nginx directives, may be empty = disabled),
#               SEC_HTPASSWD (htpasswd file content, empty = none).
# Arg 1: domain.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${1:?domain required}"
SECDIR="/etc/nginx/orchestrator-security"
CONF="$SECDIR/$DOMAIN.conf"
HTP="$SECDIR/$DOMAIN.htpasswd"
VHOST="/etc/nginx/sites-available/$DOMAIN"
INCLUDE_LINE="    include $CONF;"

mkdir -p "$SECDIR"; chmod 750 "$SECDIR"

# Write the snippet (empty when disabling) and the htpasswd file.
printf '%s\n' "${SEC_SNIPPET:-}" > "$CONF"
if [ -n "${SEC_HTPASSWD:-}" ]; then
  printf '%s\n' "$SEC_HTPASSWD" > "$HTP"; chmod 640 "$HTP"
else
  rm -f "$HTP" 2>/dev/null || true
fi

[ -f "$VHOST" ] || { echo "vhost not found: $VHOST" >&2; exit 1; }

# Ensure the include exists (edits the vhost only the first time), after every
# server_name so both the :80 and :443 server blocks are covered.
if ! grep -qF "include $CONF;" "$VHOST"; then
  cp -f "$VHOST" "$VHOST.security-bak"
  awk -v inc="$INCLUDE_LINE" '{ print } /server_name/ { print inc }' "$VHOST.security-bak" > "$VHOST.tmp"
  mv -f "$VHOST.tmp" "$VHOST"
  if ! nginx -t 2>/tmp/oc-nginx-sec.$$; then
    cp -f "$VHOST.security-bak" "$VHOST"   # ← restore: site untouched
    echo "nginx -t failed while adding include — reverted." >&2
    cat /tmp/oc-nginx-sec.$$ >&2; rm -f /tmp/oc-nginx-sec.$$
    exit 1
  fi
  rm -f /tmp/oc-nginx-sec.$$
fi

# Validate the (possibly new) snippet; if bad, blank it so the site stays up.
if ! nginx -t 2>/tmp/oc-nginx-sec2.$$; then
  : > "$CONF"
  echo "nginx -t failed on the security snippet — cleared it to keep the site up." >&2
  cat /tmp/oc-nginx-sec2.$$ >&2; rm -f /tmp/oc-nginx-sec2.$$
  systemctl reload nginx || true
  exit 1
fi
rm -f /tmp/oc-nginx-sec2.$$

systemctl reload nginx
echo "OK"
