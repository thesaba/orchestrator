#!/usr/bin/env bash
# bootstrap-server.sh — prepare a clean Ubuntu host to run Orchestrator sites.
#
# Installs the full LEMP stack: PHP 8.1–8.5 (fpm+cli) with every extension a
# Laravel/Filament app typically needs, nginx, MariaDB, Composer, Supervisor,
# Certbot and Redis. Idempotent: safe to re-run. A missing/unreleased PHP
# version is skipped (logged), never fatal. Must run as root.
set -uo pipefail

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "[$(date '+%H:%M:%S')] ✓ $*"; }
warn() { echo "[$(date '+%H:%M:%S')] ⚠ $*"; }

export DEBIAN_FRONTEND=noninteractive
# Fully suppress needrestart's interactive "which services to restart?" prompt
# (Ubuntu 22.04+) — otherwise apt hangs forever over a non-interactive session.
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

if [ "$(id -u)" != "0" ]; then
  echo "ERROR: bootstrap-server.sh must run as root." >&2
  exit 1
fi

# Belt-and-suspenders: pin needrestart to auto-restart via config too.
if [ -d /etc/needrestart ]; then
  mkdir -p /etc/needrestart/conf.d
  echo '$nrconf{restart} = "a";' > /etc/needrestart/conf.d/orchestrator.conf 2>/dev/null || true
fi

# apt with non-interactive defaults + keep existing config files (never prompt).
apti() { apt-get install -y -q -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef "$@"; }

PHP_VERSIONS=(8.1 8.2 8.3 8.4 8.5)
# Extensions installed per PHP version (php{ver}-{ext}). Covers Laravel + Filament.
PHP_EXTS=(fpm cli common mysql mbstring xml curl zip bcmath gd intl gmp soap \
          readline opcache redis sqlite3 pgsql tokenizer imap)

log "=== Orchestrator server bootstrap starting ==="
log "Target: $(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME") · $(uname -m)"

# ── 1. Base packages + PHP PPA ────────────────────────────────────────────────
log "[1/7] Updating apt & installing prerequisites…"
apt-get update -y -q
apti software-properties-common ca-certificates curl gnupg lsb-release \
  apt-transport-https unzip zip git acl >/dev/null 2>&1
ok "Prerequisites installed"

log "[2/7] Adding ondrej/php PPA (multi-version PHP)…"
if ! grep -rq "ondrej/php" /etc/apt/sources.list.d/ 2>/dev/null; then
  add-apt-repository -y ppa:ondrej/php >/dev/null 2>&1 && ok "PPA added" || warn "Could not add PPA (may be preinstalled)"
else
  ok "PPA already present"
fi
apt-get update -y -q

# ── 2. PHP versions + extensions ──────────────────────────────────────────────
log "[3/7] Installing PHP versions ${PHP_VERSIONS[*]} with extensions…"
INSTALLED_PHP=()
for v in "${PHP_VERSIONS[@]}"; do
  if ! apt-cache show "php${v}-cli" >/dev/null 2>&1; then
    warn "PHP ${v} not available in apt yet — skipping"
    continue
  fi
  pkgs=()
  for e in "${PHP_EXTS[@]}"; do pkgs+=("php${v}-${e}"); done
  log "  → PHP ${v}: installing ${#pkgs[@]} packages…"
  if apti "${pkgs[@]}" >/dev/null 2>&1; then
    INSTALLED_PHP+=("$v"); ok "PHP ${v} installed"
  else
    # Retry with only the core set if the full set failed (some exts vary by version)
    core=("php${v}-fpm" "php${v}-cli" "php${v}-common" "php${v}-mysql" "php${v}-mbstring" \
          "php${v}-xml" "php${v}-curl" "php${v}-zip" "php${v}-bcmath" "php${v}-gd" "php${v}-intl")
    if apti "${core[@]}" >/dev/null 2>&1; then
      INSTALLED_PHP+=("$v"); warn "PHP ${v} installed with CORE extensions only (some optional exts unavailable)"
    else
      warn "PHP ${v} failed to install — skipping"
    fi
  fi
  systemctl enable --now "php${v}-fpm" >/dev/null 2>&1 || true
done
ok "PHP versions ready: ${INSTALLED_PHP[*]:-none}"

# ── 3. Web server ─────────────────────────────────────────────────────────────
log "[4/7] Installing nginx…"
apti nginx >/dev/null 2>&1
systemctl enable --now nginx >/dev/null 2>&1
ok "nginx installed & running"

# ── 4. Database ───────────────────────────────────────────────────────────────
log "[5/7] Installing MariaDB…"
apti mariadb-server >/dev/null 2>&1
systemctl enable --now mariadb >/dev/null 2>&1
ok "MariaDB installed & running (root via unix_socket)"

# ── 5. Tooling: Composer, Node.js, Supervisor, Certbot, Redis ─────────────────
log "[6/7] Installing Composer, Node.js, Supervisor, Certbot, Redis…"
apti supervisor redis-server certbot python3-certbot-nginx >/dev/null 2>&1
systemctl enable --now supervisor redis-server >/dev/null 2>&1 || true

# Node.js 20 LTS — deploy.sh builds front-end assets (npm ci && npm run build).
if ! command -v npm >/dev/null 2>&1; then
  log "  → Installing Node.js 20 LTS (npm)…"
  if curl -fsSL --max-time 60 https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1; then
    apti nodejs >/dev/null 2>&1 || true
  fi
  # Fall back to the distro packages if NodeSource is unreachable.
  command -v npm >/dev/null 2>&1 || apti nodejs npm >/dev/null 2>&1 || true
  if command -v npm >/dev/null 2>&1; then
    ok "Node.js installed ($(node -v 2>/dev/null), npm $(npm -v 2>/dev/null))"
  else
    warn "Node.js/npm could not be installed — sites needing a front-end build will fail at that step"
  fi
else
  ok "Node.js already installed ($(node -v 2>/dev/null), npm $(npm -v 2>/dev/null))"
fi

if ! command -v composer >/dev/null 2>&1; then
  EXPECTED="$(curl -s --max-time 30 https://composer.github.io/installer.sig)"
  curl -sS --max-time 60 https://getcomposer.org/installer -o /tmp/composer-setup.php
  ACTUAL="$(php -r "echo hash_file('sha384', '/tmp/composer-setup.php');" 2>/dev/null || echo x)"
  if [ "$EXPECTED" = "$ACTUAL" ] || [ -z "$EXPECTED" ]; then
    php /tmp/composer-setup.php --quiet --install-dir=/usr/local/bin --filename=composer && ok "Composer installed"
  else
    warn "Composer installer checksum mismatch — skipped (install manually)"
  fi
  rm -f /tmp/composer-setup.php
else
  ok "Composer already installed ($(composer --version 2>/dev/null | head -1))"
fi

# ── 6. Site directory + firewall ──────────────────────────────────────────────
log "[7/7] Final setup (site dir, log dir, firewall)…"
mkdir -p /var/www/sites && chown -R www-data:www-data /var/www/sites
mkdir -p /var/log/orchestrator
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22 >/dev/null 2>&1 || true
  ufw allow 'Nginx Full' >/dev/null 2>&1 || { ufw allow 80 >/dev/null 2>&1; ufw allow 443 >/dev/null 2>&1; }
  ok "Firewall rules ensured (SSH + HTTP/HTTPS)"
fi

echo
log "=== Bootstrap complete ==="
log "PHP versions installed: ${INSTALLED_PHP[*]:-none}"
for v in "${INSTALLED_PHP[@]}"; do
  ver="$(php${v} -v 2>/dev/null | head -1)"
  echo "    • ${ver}"
done
log "Services: nginx=$(systemctl is-active nginx 2>/dev/null) mariadb=$(systemctl is-active mariadb 2>/dev/null) redis=$(systemctl is-active redis-server 2>/dev/null) supervisor=$(systemctl is-active supervisor 2>/dev/null)"
log "This server is ready to host Orchestrator sites."
