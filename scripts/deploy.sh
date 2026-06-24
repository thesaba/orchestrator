#!/usr/bin/env bash
# Usage: deploy.sh <site_dir> <repo_url> <branch> <php_version>
#
# Zero-downtime deploy via symlink swap (Deployer-style).
# Shared files (.env, storage/) are preserved across releases.
set -euo pipefail

SITE_DIR="${1:?site_dir required}"
REPO_URL="${2:?repo_url required}"
BRANCH="${3:-main}"
PHP_VER="${4:-8.2}"
TIMESTAMP=$(date +%Y%m%d%H%M%S)
RELEASE_DIR="$SITE_DIR/releases/$TIMESTAMP"
SHARED_DIR="$SITE_DIR/shared"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "=== Deploying branch '$BRANCH' to $SITE_DIR ==="

# Guard: shared/.env must exist and be non-empty
if [ ! -s "$SHARED_DIR/.env" ]; then
  log "ERROR: $SHARED_DIR/.env is empty or missing."
  log "       Populate it with APP_KEY, DB_* and other Laravel config before deploying."
  exit 1
fi

# ── 1. Clone ─────────────────────────────────────────────────────────────────
log "[1/7] Cloning repository..."
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$RELEASE_DIR"
cd "$RELEASE_DIR"
COMMIT=$(git rev-parse --short HEAD)
log "  Commit: $COMMIT"

# ── 2. Link shared files ─────────────────────────────────────────────────────
log "[2/7] Linking shared files..."
rm -rf storage
ln -sf "$SHARED_DIR/storage" storage
ln -sf "$SHARED_DIR/.env" .env

# ── 3. Composer ──────────────────────────────────────────────────────────────
log "[3/7] Installing PHP dependencies..."
composer install \
  --no-dev \
  --no-interaction \
  --prefer-dist \
  --optimize-autoloader \
  --quiet

# ── 4. Artisan caches ────────────────────────────────────────────────────────
log "[4/7] Caching Laravel config, routes, views..."
php${PHP_VER} artisan config:cache
php${PHP_VER} artisan route:cache
php${PHP_VER} artisan view:cache

# ── 5. Migrations ────────────────────────────────────────────────────────────
log "[5/7] Running migrations..."
php${PHP_VER} artisan migrate --force

# ── 6. Atomic symlink swap ───────────────────────────────────────────────────
log "[6/7] Activating release (symlink swap)..."
ln -sfn "$RELEASE_DIR" "$SITE_DIR/current"
log "  current -> $RELEASE_DIR"

# ── 7. Cleanup ───────────────────────────────────────────────────────────────
log "[7/7] Restarting queues and cleaning old releases..."
php${PHP_VER} artisan queue:restart

KEPT=5
ls -dt "$SITE_DIR/releases"/*/ 2>/dev/null | tail -n +$((KEPT + 1)) | xargs rm -rf || true
TOTAL=$(ls -d "$SITE_DIR/releases"/*/ 2>/dev/null | wc -l | tr -d ' ')
log "  Kept $TOTAL most recent releases (max $KEPT)"

log "=== Deploy complete! ==="
echo "__COMMIT__:${COMMIT}"
