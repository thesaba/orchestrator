#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Apply a per-site BILLING enforcement level SAFELY.
#
#   Usage: site-suspend.sh <domain> <none|banner|restrict|suspend|archived>
#
# Mirrors the safety model of site-security.sh: the directives live in their
# own snippet that the vhost `include`s. The vhost itself is edited only ONCE
# (to add the include), guarded by backup + `nginx -t` + automatic rollback, so
# a paying customer's site can NEVER be left broken by a billing action.
#
# Design notes that matter:
#
#  • A suspended site MUST still answer /.well-known/acme-challenge/ or certbot
#    renewals silently die and the cert expires while the site is suspended.
#    The suspend rule explicitly excludes that prefix.
#
#  • We return an internal-only status 598 and map it with `error_page 598 =503`.
#    This means the branded billing page is shown ONLY for requests we blocked —
#    the application's own 503 (e.g. `php artisan down` maintenance mode) passes
#    through completely untouched. A naive `error_page 503` would hijack it.
#
#  • The response is 503 + Retry-After, never 402/404, so search engines treat
#    it as temporary and do not de-index a client's site over a late invoice.
#
#  • Server-level `if (...) { return 598; }` is used instead of `location /`,
#    because a second `location /` in the same server block is a duplicate and
#    nginx would refuse the config. `return` inside `if` is explicitly safe.
#
# Env:
#   SUSP_LANG            ka | en                (default ka)
#   SUSP_TITLE           page heading           (optional, overrides default)
#   SUSP_MESSAGE         page body text         (optional)
#   SUSP_AMOUNT          e.g. "30.00 ₾"         (optional, shown if set)
#   SUSP_CONTACT         email/phone            (optional, shown if set)
#   SUSP_BANNER_TEXT     banner strip text      (optional)
#   SUSP_RESTRICT_PATHS  regex alternation      (default "admin|login")
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${1:?domain required}"
LEVEL="${2:?level required (none|banner|restrict|suspend|archived)}"

case "$LEVEL" in
  none|banner|restrict|suspend|archived) ;;
  *) echo "invalid level: $LEVEL" >&2; exit 2 ;;
esac

BILLDIR="/etc/nginx/orchestrator-billing"
CONF="$BILLDIR/$DOMAIN.conf"
HTML="$BILLDIR/$DOMAIN.html"
VHOST="/etc/nginx/sites-available/$DOMAIN"
INCLUDE_LINE="    include $CONF;"

LANG_CODE="${SUSP_LANG:-ka}"
RESTRICT_PATHS="${SUSP_RESTRICT_PATHS:-admin|login}"

# nginx workers (www-data) must be able to read the page.
mkdir -p "$BILLDIR"; chmod 755 "$BILLDIR"

[ -f "$VHOST" ] || { echo "vhost not found: $VHOST" >&2; exit 1; }

has_sub_module() { nginx -V 2>&1 | grep -q -- '--with-http_sub_module'; }

# Strip characters that would break an nginx single-quoted string.
sanitize() { printf '%s' "${1:-}" | tr -d "'\\\\" | tr '\n' ' '; }

# ── Default copy (Georgian / English) ────────────────────────────────────────
if [ "$LANG_CODE" = "en" ]; then
  DEF_TITLE="Site temporarily suspended"
  DEF_MSG="This website has been temporarily suspended due to an outstanding hosting payment. It will be restored immediately once the payment is received."
  DEF_BANNER="Your hosting payment is overdue. Please settle it to avoid suspension."
  LBL_AMOUNT="Amount due"
  LBL_CONTACT="Contact"
else
  DEF_TITLE="საიტი დროებით შეჩერებულია"
  DEF_MSG="საიტი დროებით შეჩერებულია ჰოსტინგის გადაუხდელობის გამო. თანხის ჩარიცხვისთანავე მუშაობა სრულად აღდგება."
  DEF_BANNER="ჰოსტინგის გადასახადი ვადაგადაცილებულია. გთხოვთ დაფაროთ დათიშვის თავიდან ასაცილებლად."
  LBL_AMOUNT="გადასახდელი თანხა"
  LBL_CONTACT="კონტაქტი"
fi

TITLE="${SUSP_TITLE:-$DEF_TITLE}"
MESSAGE="${SUSP_MESSAGE:-$DEF_MSG}"
BANNER_TEXT="$(sanitize "${SUSP_BANNER_TEXT:-$DEF_BANNER}")"
AMOUNT="${SUSP_AMOUNT:-}"
CONTACT="${SUSP_CONTACT:-}"

# ── The branded 503 page ─────────────────────────────────────────────────────
write_html() {
  local extra=""
  [ -n "$AMOUNT" ]  && extra="$extra<p class=\"row\"><span>$LBL_AMOUNT</span><b>$AMOUNT</b></p>"
  [ -n "$CONTACT" ] && extra="$extra<p class=\"row\"><span>$LBL_CONTACT</span><b>$CONTACT</b></p>"
  cat > "$HTML" <<HTMLDOC
<!DOCTYPE html>
<html lang="$LANG_CODE">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>$TITLE</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0f1116; color:#e7e9ee;
         font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Georgian",sans-serif; }
  .card { max-width:560px; padding:40px 36px; background:#171a21; border:1px solid #262b36;
          border-radius:16px; text-align:center; box-shadow:0 12px 40px rgba(0,0,0,.35); }
  .icon { font-size:44px; line-height:1; margin-bottom:16px; }
  h1 { font-size:22px; margin:0 0 12px; font-weight:600; }
  p  { margin:0 0 10px; color:#a8afbd; }
  .row { display:flex; justify-content:space-between; gap:16px; margin-top:14px;
         padding-top:14px; border-top:1px solid #262b36; color:#a8afbd; }
  .row b { color:#e7e9ee; }
  .foot { margin-top:24px; font-size:12px; color:#6b7280; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <h1>$TITLE</h1>
    <p>$MESSAGE</p>
    $extra
    <p class="foot">HTTP 503 — Service Temporarily Unavailable</p>
  </div>
</body>
</html>
HTMLDOC
  chmod 644 "$HTML"
}

# ── The nginx snippet for this level ─────────────────────────────────────────
write_conf() {
  {
    echo "# Managed by Orchestrator billing — do not edit by hand."
    echo "# domain: $DOMAIN   level: $LEVEL   generated: $(date -Is)"

    if [ "$LEVEL" = "restrict" ] || [ "$LEVEL" = "suspend" ] || [ "$LEVEL" = "archived" ]; then
      # 598 is internal-only: the app can never emit it, so this page is shown
      # for OUR blocked requests exclusively (app 503s pass through).
      cat <<NGX
    error_page 598 =503 /__oc_suspended.html;
    location = /__oc_suspended.html {
        internal;
        alias $HTML;
        default_type text/html;
        add_header Retry-After 86400 always;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }
NGX
    fi

    case "$LEVEL" in
      banner)
        if has_sub_module; then
          cat <<NGX
    sub_filter_once on;
    sub_filter_types text/html;
    sub_filter '</body>' '<div style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#b42318;color:#fff;font:14px/1.5 system-ui,sans-serif;padding:10px 16px;text-align:center">${BANNER_TEXT}</div></body>';
NGX
        else
          echo "    # nginx built without http_sub_module — banner skipped, site untouched."
        fi
        ;;
      restrict)
        cat <<NGX
    if (\$request_uri ~* "^/(${RESTRICT_PATHS})") { return 598; }
NGX
        ;;
      suspend|archived)
        # Everything blocked EXCEPT the ACME challenge, so certbot can still renew.
        cat <<NGX
    if (\$request_uri !~* "^/\\.well-known/acme-challenge/") { return 598; }
NGX
        ;;
      none)
        echo "    # billing enforcement: none"
        ;;
    esac
  } > "$CONF"
  chmod 644 "$CONF"
}

write_html
write_conf

# ── Ensure the vhost includes the snippet (edits the vhost only once) ────────
if ! grep -qF "include $CONF;" "$VHOST"; then
  cp -f "$VHOST" "$VHOST.billing-bak"
  awk -v inc="$INCLUDE_LINE" '{ print } /server_name/ { print inc }' "$VHOST.billing-bak" > "$VHOST.tmp"
  mv -f "$VHOST.tmp" "$VHOST"
  if ! nginx -t 2>/tmp/oc-nginx-bill.$$; then
    cp -f "$VHOST.billing-bak" "$VHOST"     # ← restore: site untouched
    echo "nginx -t failed while adding the billing include — reverted." >&2
    cat /tmp/oc-nginx-bill.$$ >&2; rm -f /tmp/oc-nginx-bill.$$
    exit 1
  fi
  rm -f /tmp/oc-nginx-bill.$$
fi

# ── Validate the new snippet; if bad, blank it so the site keeps serving ─────
if ! nginx -t 2>/tmp/oc-nginx-bill2.$$; then
  : > "$CONF"
  echo "nginx -t failed on the billing snippet — cleared it to keep the site up." >&2
  cat /tmp/oc-nginx-bill2.$$ >&2; rm -f /tmp/oc-nginx-bill2.$$
  systemctl reload nginx || true
  exit 1
fi
rm -f /tmp/oc-nginx-bill2.$$

systemctl reload nginx
echo "billing enforcement for $DOMAIN set to: $LEVEL"
