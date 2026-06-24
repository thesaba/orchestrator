#!/usr/bin/env bash
# Usage: REPO_URL=<repo_url> deploy.sh <site_dir> <branch> <php_version>
#
# REPO_URL is passed via environment (not argv) so it never appears in
# `ps`/process listings — this matters when it has a Git access token
# embedded for private-repo clones (https://<token>@host/owner/repo.git).
#
# Zero-downtime deploy via symlink swap (Deployer-style).
# Shared files (.env, storage/) are preserved across releases.
set -euo pipefail

SITE_DIR="${1:?site_dir required}"
BRANCH="${2:-main}"
PHP_VER="${3:-8.2}"
REPO_URL="${REPO_URL:?REPO_URL env var required}"
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
log "[1/8] Cloning repository..."
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$RELEASE_DIR"
cd "$RELEASE_DIR"
COMMIT=$(git rev-parse --short HEAD)
log "  Commit: $COMMIT"

# ── 2. Link shared files ─────────────────────────────────────────────────────
log "[2/8] Linking shared files..."
rm -rf storage
ln -sf "$SHARED_DIR/storage" storage
ln -sf "$SHARED_DIR/.env" .env

# ── 3. Composer ──────────────────────────────────────────────────────────────
# Note: deliberately NOT --quiet — when composer's dependency solver fails
# (e.g. lock file out of sync, missing PHP extension), --quiet hides the
# detailed "Problem 1 - ..." reasoning and only the generic summary line
# survives, which makes the deploy log useless for debugging.
log "[3/8] Installing PHP dependencies..."
composer install \
  --no-dev \
  --no-interaction \
  --prefer-dist \
  --optimize-autoloader

# ── 4. Front-end assets (Vite/Inertia, React/Vue/Blade+Vite projects) ─────────
# Only runs if the repo actually has a JS build step. Without this, any
# Laravel project using Vite (resources/js + vite.config.js) deploys fine but
# crashes at runtime with "Vite manifest not found" — public/build/manifest.json
# is only produced by `npm run build`, which composer install never touches.
if [ -f package.json ] && grep -q '"build"[[:space:]]*:' package.json; then
  log "[4/8] Installing JS dependencies and building front-end assets..."
  if [ -f pnpm-lock.yaml ]; then
    command -v pnpm >/dev/null 2>&1 || npm install -g pnpm --silent
    pnpm install --frozen-lockfile
    pnpm run build
  elif [ -f yarn.lock ]; then
    command -v yarn >/dev/null 2>&1 || npm install -g yarn --silent
    yarn install --frozen-lockfile
    yarn build
  else
    npm ci
    npm run build
  fi
  # node_modules is only needed to produce the build output — drop it from the
  # release to save disk across kept releases.
  rm -rf node_modules
else
  log "[4/8] No JS build step detected (no package.json/build script) — skipping."
fi

# ── 5. Artisan caches ────────────────────────────────────────────────────────
log "[5/8] Caching Laravel config, routes, views..."
php${PHP_VER} artisan config:cache
php${PHP_VER} artisan route:cache
php${PHP_VER} artisan view:cache

# ── 6. Migrations ────────────────────────────────────────────────────────────
log "[6/8] Running migrations..."
php${PHP_VER} artisan migrate --force

# ── 7. Atomic symlink swap ───────────────────────────────────────────────────
log "[7/8] Activating release (symlink swap)..."
ln -sfn "$RELEASE_DIR" "$SITE_DIR/current"
log "  current -> $RELEASE_DIR"

# ── 8. Cleanup ───────────────────────────────────────────────────────────────
log "[8/8] Restarting queues and cleaning old releases..."
php${PHP_VER} artisan queue:restart

KEPT=5
ls -dt "$SITE_DIR/releases"/*/ 2>/dev/null | tail -n +$((KEPT + 1)) | xargs rm -rf || true
TOTAL=$(ls -d "$SITE_DIR/releases"/*/ 2>/dev/null | wc -l | tr -d ' ')
log "  Kept $TOTAL most recent releases (max $KEPT)"

log "=== Deploy complete! ==="
echo "__COMMIT__:${COMMIT}"
