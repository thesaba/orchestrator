#!/usr/bin/env bash
# Usage: provision.sh <domain> <php_version> <db_name> <db_user> <db_pass>
#
# Required sudoers entry on the server:
#   deployer ALL=(ALL) NOPASSWD: /opt/orchestrator/scripts/provision.sh
set -euo pipefail

DOMAIN="${1:?domain required}"
PHP_VER="${2:?php_version required}"
DB_NAME="${3:?db_name required}"
DB_USER="${4:?db_user required}"
DB_PASS="${5:?db_pass required}"

# Defense in depth (the API already validates these). Guarantees no SQL/shell
# injection even if this privileged script is ever invoked directly:
#   - domain / db name / db user must be plain, well-formed identifiers
#   - the db password must not contain ' " \ ` — the exact characters that
#     could break out of the single-quoted SQL string literal (IDENTIFIED BY '…')
if ! printf '%s' "$DOMAIN" | grep -qE '^[A-Za-z0-9][A-Za-z0-9.\-]+[A-Za-z0-9]$'; then
  echo "ERROR: invalid domain '$DOMAIN'" >&2; exit 1
fi
if ! printf '%s' "$DB_NAME" | grep -qE '^[A-Za-z0-9_]+$'; then
  echo "ERROR: invalid db name '$DB_NAME'" >&2; exit 1
fi
if ! printf '%s' "$DB_USER" | grep -qE '^[A-Za-z0-9_]+$'; then
  echo "ERROR: invalid db user '$DB_USER'" >&2; exit 1
fi
case "$DB_PASS" in
  *[\'\"\\\`]*) echo "ERROR: db password contains forbidden characters (' \" \\ \`)" >&2; exit 1 ;;
esac

SITE_DIR="/var/www/sites/$DOMAIN"
NGINX_CONF="/etc/nginx/sites-available/$DOMAIN"

# Stack template (optional 6th arg): shapes the generated Nginx vhost.
TEMPLATE="${6:-laravel}"
INDEX="index.php index.html"
case "$TEMPLATE" in
  laravel)
    WEB_ROOT="$SITE_DIR/current/public"
    MAIN_LOCATION='location / { try_files $uri $uri/ /index.php?$query_string; }'
    ERROR_PAGE='error_page 404 /index.php;'
    INCLUDE_PHP=1
    ;;
  wordpress)
    WEB_ROOT="$SITE_DIR/current"
    MAIN_LOCATION='location / { try_files $uri $uri/ /index.php?$args; }'
    ERROR_PAGE=''
    INCLUDE_PHP=1
    ;;
  static)
    WEB_ROOT="$SITE_DIR/current"
    MAIN_LOCATION='location / { try_files $uri $uri/ =404; }'
    ERROR_PAGE=''
    INDEX="index.html index.htm"
    INCLUDE_PHP=0
    ;;
  *)
    echo "ERROR: invalid template '$TEMPLATE' (expected laravel|wordpress|static)" >&2; exit 1 ;;
esac

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "=== Provisioning $DOMAIN (PHP $PHP_VER, template: $TEMPLATE) ==="

# ── 1. Directory structure ───────────────────────────────────────────────────
log "[1/4] Creating directory structure..."
mkdir -p "$SITE_DIR/releases"
mkdir -p "$SITE_DIR/shared/storage/app/public"
mkdir -p "$SITE_DIR/shared/storage/framework/"{sessions,views,cache}
mkdir -p "$SITE_DIR/shared/storage/logs"
mkdir -p "$SITE_DIR/shared/logs"
touch "$SITE_DIR/shared/.env"
chown -R www-data:www-data "$SITE_DIR"
chmod 750 "$SITE_DIR/shared"
log "  Root: $SITE_DIR"

# ── 2. MySQL ─────────────────────────────────────────────────────────────────
log "[2/4] Creating MySQL database and user..."
sudo mysql -e "CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
# Both 'localhost' (unix socket) and '127.0.0.1' (TCP) hosts are needed —
# MySQL treats them as distinct grantees. The panel (and phpMyAdmin) connect
# over TCP to 127.0.0.1, so a 'localhost'-only grant silently fails those.
sudo mysql -e "CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';"
sudo mysql -e "CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';"
sudo mysql -e "GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';"
sudo mysql -e "GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'127.0.0.1';"
sudo mysql -e "FLUSH PRIVILEGES;"
log "  DB: $DB_NAME  User: $DB_USER"

# ── 3. Nginx config ──────────────────────────────────────────────────────────
log "[3/4] Writing Nginx config ($TEMPLATE)..."
{
  # ${MAIN_LOCATION}/${ERROR_PAGE} hold literal $uri/$args (single-quoted on
  # assignment), so they pass through this unquoted heredoc unchanged.
  cat <<NGINX
server {
    listen 80;
    listen [::]:80;
    # The www. alias is included so a request for www.<domain> matches THIS site.
    # Without it nginx finds no matching server_name and falls through to the
    # default server — which is another customer's site.
    server_name ${DOMAIN} www.${DOMAIN};
    root ${WEB_ROOT};

    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";

    index ${INDEX};
    charset utf-8;

    ${MAIN_LOCATION}

    location = /favicon.ico { access_log off; log_not_found off; }
    location = /robots.txt  { access_log off; log_not_found off; }
    ${ERROR_PAGE}
NGINX

  if [ "$INCLUDE_PHP" = "1" ]; then
    cat <<NGINX

    location ~ \.php\$ {
        fastcgi_pass unix:/var/run/php/php${PHP_VER}-fpm.sock;
        fastcgi_param SCRIPT_FILENAME \$realpath_root\$fastcgi_script_name;
        include fastcgi_params;
        fastcgi_hide_header X-Powered-By;
    }
NGINX
  fi

  cat <<NGINX

    location ~ /\.(?!well-known).* {
        deny all;
    }
}
NGINX
} > "$NGINX_CONF"

ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$DOMAIN"

# ── 4. Nginx reload ───────────────────────────────────────────────────────────
log "[4/4] Testing and reloading Nginx..."
nginx -t
systemctl reload nginx

log "=== Done! $DOMAIN is ready ==="
log "Next step: set DNS A record → this server, then enable SSL."
