#!/usr/bin/env bash
# starter-install.sh — install a FRESH application into a newly provisioned site.
#
# Usage: starter-install.sh <domain> <php_version> <db_name> <db_user> <db_pass> <starter>
#   starter ∈ laravel | wordpress | static | node
#
# Optional values are passed via ENVIRONMENT (not argv) so titles/passwords with
# spaces can never be mis-split, and are validated below before any use:
#   APP_URL          e.g. https://example.com         (all starters)
#   WP_TITLE         site title                        (wordpress)
#   WP_ADMIN_USER    admin username                    (wordpress)
#   WP_ADMIN_EMAIL   admin email                       (wordpress)
#   WP_ADMIN_PASS    admin password                    (wordpress)
#   NODE_PORT        loopback port for the Node app    (node)
#
# SAFETY / ISOLATION — this is the whole contract of this script:
#   * It writes ONLY under /var/www/sites/<domain> and that site's own MySQL DB.
#   * It never touches any other site, the panel, or shared system config except
#     for ONE supervisor program file scoped to this domain (node starter only).
#   * It is invoked AFTER provision.sh (dirs + DB + vhost already exist).
#
# Required sudoers entry on the server:
#   deployer ALL=(ALL) NOPASSWD: /opt/orchestrator/scripts/starter-install.sh
set -euo pipefail

DOMAIN="${1:?domain required}"
PHP_VER="${2:?php_version required}"
DB_NAME="${3:?db_name required}"
DB_USER="${4:?db_user required}"
DB_PASS="${5:?db_pass required}"
STARTER="${6:?starter required}"

APP_URL="${APP_URL:-https://$DOMAIN}"
WP_TITLE="${WP_TITLE:-$DOMAIN}"
WP_ADMIN_USER="${WP_ADMIN_USER:-admin}"
WP_ADMIN_EMAIL="${WP_ADMIN_EMAIL:-}"
WP_ADMIN_PASS="${WP_ADMIN_PASS:-}"
NODE_PORT="${NODE_PORT:-0}"

# ── Validation (defense in depth; the API validates too) ──────────────────────
# Identifiers must be well-formed; secrets/titles must not contain characters
# that could break out of a shell/SQL context in the commands below.
reject_shell_meta() { # $1=label $2=value — forbid " ' \ ` $ (and newline)
  case "$2" in
    *['"'\''\\\`\$']* | *$'\n'*) echo "ERROR: $1 contains forbidden characters (\" ' \\ \` \$)" >&2; exit 1 ;;
  esac
}
if ! printf '%s' "$DOMAIN" | grep -qE '^[A-Za-z0-9][A-Za-z0-9.\-]+[A-Za-z0-9]$'; then
  echo "ERROR: invalid domain '$DOMAIN'" >&2; exit 1
fi
if ! printf '%s' "$DB_NAME" | grep -qE '^[A-Za-z0-9_]+$'; then echo "ERROR: invalid db name" >&2; exit 1; fi
if ! printf '%s' "$DB_USER" | grep -qE '^[A-Za-z0-9_]+$'; then echo "ERROR: invalid db user" >&2; exit 1; fi
if ! printf '%s' "$PHP_VER" | grep -qE '^[0-9]+\.[0-9]+$'; then echo "ERROR: invalid php version" >&2; exit 1; fi
reject_shell_meta "db password" "$DB_PASS"
reject_shell_meta "app url" "$APP_URL"
case "$STARTER" in laravel|wordpress|static|node) ;; *) echo "ERROR: invalid starter '$STARTER'" >&2; exit 1 ;; esac

SITE_DIR="/var/www/sites/$DOMAIN"
RELEASES="$SITE_DIR/releases"
SHARED="$SITE_DIR/shared"
CURRENT="$SITE_DIR/current"

if [ ! -d "$SITE_DIR" ]; then echo "ERROR: $SITE_DIR does not exist — run provision first" >&2; exit 1; fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Rewrite or append a KEY=value line in a .env-style file (value passed safely).
set_env() { # $1=file $2=key $3=value
  local file="$1" key="$2" val="$3"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    # Use a non-/ delimiter and escape &,\ for sed replacement safety.
    local esc; esc=$(printf '%s' "$val" | sed -e 's/[&\\]/\\&/g' -e 's/|/\\|/g')
    sed -i "s|^${key}=.*|${key}=${esc}|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
}

log "=== 1-click install: $STARTER → $DOMAIN ==="

case "$STARTER" in

# ── Laravel ───────────────────────────────────────────────────────────────────
laravel)
  command -v composer >/dev/null 2>&1 || { echo "ERROR: composer not installed (run server Prepare)" >&2; exit 1; }
  TS="$(date +%Y%m%d%H%M%S)"
  REL="$RELEASES/$TS"
  log "[1/6] composer create-project laravel/laravel (this can take a minute)…"
  sudo -u www-data COMPOSER_NO_INTERACTION=1 composer create-project --prefer-dist --no-progress laravel/laravel "$REL"

  log "[2/6] Wiring shared/.env with database credentials…"
  # create-project already copied .env.example → .env and ran key:generate.
  [ -f "$REL/.env" ] || sudo -u www-data cp "$REL/.env.example" "$REL/.env"
  cp "$REL/.env" "$SHARED/.env"
  set_env "$SHARED/.env" APP_URL        "$APP_URL"
  set_env "$SHARED/.env" DB_CONNECTION  "mysql"
  set_env "$SHARED/.env" DB_HOST        "127.0.0.1"
  set_env "$SHARED/.env" DB_PORT        "3306"
  set_env "$SHARED/.env" DB_DATABASE    "$DB_NAME"
  set_env "$SHARED/.env" DB_USERNAME    "$DB_USER"
  set_env "$SHARED/.env" DB_PASSWORD    "$DB_PASS"

  log "[3/6] Linking shared storage + .env (deploy-compatible layout)…"
  # Merge Laravel's default storage skeleton into the shared/ one provision.sh
  # created, then replace the release copies with symlinks — exactly how deploy.sh
  # expects a release to look, so a later git deploy keeps working.
  cp -rn "$REL/storage/." "$SHARED/storage/" 2>/dev/null || true
  rm -rf "$REL/storage"; ln -s "$SHARED/storage" "$REL/storage"
  rm -f  "$REL/.env";    ln -s "$SHARED/.env"    "$REL/.env"

  chown -R www-data:www-data "$SITE_DIR"
  ln -sfn "$REL" "$CURRENT"

  log "[4/6] php artisan key:generate…"
  sudo -u www-data "php${PHP_VER}" "$CURRENT/artisan" key:generate --force
  log "[5/6] php artisan migrate --force…"
  sudo -u www-data "php${PHP_VER}" "$CURRENT/artisan" migrate --force
  log "[6/6] php artisan storage:link…"
  sudo -u www-data "php${PHP_VER}" "$CURRENT/artisan" storage:link || true

  log "✓ Laravel installed and migrated. Visit $APP_URL"
  ;;

# ── WordPress ─────────────────────────────────────────────────────────────────
wordpress)
  [ -n "$WP_ADMIN_EMAIL" ] || { echo "ERROR: WP_ADMIN_EMAIL required" >&2; exit 1; }
  if ! printf '%s' "$WP_ADMIN_USER" | grep -qE '^[A-Za-z0-9_.@ -]{1,60}$'; then echo "ERROR: invalid admin user" >&2; exit 1; fi
  if ! printf '%s' "$WP_ADMIN_EMAIL" | grep -qE '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then echo "ERROR: invalid admin email" >&2; exit 1; fi
  [ -n "$WP_ADMIN_PASS" ] || { echo "ERROR: WP_ADMIN_PASS required" >&2; exit 1; }
  reject_shell_meta "admin password" "$WP_ADMIN_PASS"
  reject_shell_meta "site title" "$WP_TITLE"

  # wp-cli — install once if missing (to /usr/local/bin/wp).
  if ! command -v wp >/dev/null 2>&1; then
    log "[1/5] Installing wp-cli…"
    curl -sSL --max-time 120 https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar -o /usr/local/bin/wp
    chmod +x /usr/local/bin/wp
  fi
  WP="sudo -u www-data wp --path=$CURRENT"

  mkdir -p "$CURRENT"; chown -R www-data:www-data "$CURRENT"
  log "[2/5] Downloading WordPress core…"
  $WP core download --locale=en_US
  log "[3/5] Creating wp-config.php…"
  $WP config create --dbname="$DB_NAME" --dbuser="$DB_USER" --dbpass="$DB_PASS" --dbhost=127.0.0.1 --force
  log "[4/5] Installing WordPress (admin: $WP_ADMIN_USER)…"
  $WP core install --url="$APP_URL" --title="$WP_TITLE" \
      --admin_user="$WP_ADMIN_USER" --admin_email="$WP_ADMIN_EMAIL" --admin_password="$WP_ADMIN_PASS" \
      --skip-email
  chown -R www-data:www-data "$CURRENT"
  log "[5/5] ✓ WordPress installed."
  log "    URL:   $APP_URL/wp-admin"
  log "    User:  $WP_ADMIN_USER"
  log "    Pass:  $WP_ADMIN_PASS"
  ;;

# ── Static ────────────────────────────────────────────────────────────────────
static)
  mkdir -p "$CURRENT"
  cat > "$CURRENT/index.html" <<HTML
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>$DOMAIN</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.card{text-align:center}h1{margin:0 0 .25rem;font-size:1.6rem}p{color:#94a3b8;margin:.25rem 0}</style>
</head><body><div class="card"><h1>$DOMAIN</h1><p>Your static site is live.</p>
<p>Replace <code>current/index.html</code> or deploy from Git.</p></div></body></html>
HTML
  chown -R www-data:www-data "$CURRENT"
  log "✓ Static starter page created. Visit $APP_URL"
  ;;

# ── Node / Express ────────────────────────────────────────────────────────────
node)
  command -v npm >/dev/null 2>&1 || { echo "ERROR: npm not installed (run server Prepare)" >&2; exit 1; }
  if ! printf '%s' "$NODE_PORT" | grep -qE '^[0-9]{2,5}$'; then echo "ERROR: invalid NODE_PORT '$NODE_PORT'" >&2; exit 1; fi
  mkdir -p "$CURRENT" "$SHARED/logs"

  log "[1/4] Scaffolding Express app…"
  cat > "$CURRENT/package.json" <<JSON
{
  "name": "$(printf '%s' "$DOMAIN" | tr '.' '-')",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": { "start": "node index.js" },
  "dependencies": { "express": "^4.19.2" }
}
JSON
  cat > "$CURRENT/index.js" <<'JS'
const express = require('express')
const app = express()
const port = process.env.PORT || 3000
app.get('/', (_req, res) => res.send('<h1>Node app is live</h1><p>Edit current/index.js and restart via supervisor.</p>'))
app.get('/healthz', (_req, res) => res.json({ ok: true }))
app.listen(port, '127.0.0.1', () => console.log('listening on ' + port))
JS

  log "[2/4] npm install…"
  ( cd "$CURRENT" && npm install --no-audit --no-fund --loglevel=error )
  chown -R www-data:www-data "$SITE_DIR"

  log "[3/4] Creating supervisor program (node-$DOMAIN on 127.0.0.1:$NODE_PORT)…"
  cat > "/etc/supervisor/conf.d/node-$DOMAIN.conf" <<SUP
[program:node-$DOMAIN]
command=/usr/bin/env node $CURRENT/index.js
directory=$CURRENT
user=www-data
autostart=true
autorestart=true
environment=PORT="$NODE_PORT",NODE_ENV="production"
stdout_logfile=$SHARED/logs/node.out.log
stderr_logfile=$SHARED/logs/node.err.log
stopasgroup=true
killasgroup=true
SUP

  log "[4/4] Starting app under supervisor…"
  supervisorctl reread   >/dev/null 2>&1 || true
  supervisorctl update   >/dev/null 2>&1 || true
  supervisorctl restart "node-$DOMAIN" >/dev/null 2>&1 || supervisorctl start "node-$DOMAIN" >/dev/null 2>&1 || true
  log "✓ Node/Express running behind Nginx. Visit $APP_URL"
  ;;

esac

log "=== 1-click install done ($STARTER) ==="
