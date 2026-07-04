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
HOOKS_DIR="$SITE_DIR/hooks"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

run_hook() {
  local hook_file="$HOOKS_DIR/$1"
  if [ -f "$hook_file" ] && [ -s "$hook_file" ]; then
    log "  Running hook: $1"
    bash "$hook_file" || { log "  ERROR: hook $1 failed (exit $?)"; exit 1; }
    log "  Hook $1 complete."
  fi
}

log "=== Deploying branch '$BRANCH' to $SITE_DIR ==="

# Guard: shared/.env must exist and be non-empty
if [ ! -s "$SHARED_DIR/.env" ]; then
  log "ERROR: $SHARED_DIR/.env is empty or missing."
  log "       Populate it with APP_KEY, DB_* and other Laravel config before deploying."
  exit 1
fi

# ── PRE-DEPLOY HOOK ──────────────────────────────────────────────────────────
run_hook "pre-deploy.sh"

# ── 1. Clone ─────────────────────────────────────────────────────────────────
log "[1/8] Cloning repository..."
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$RELEASE_DIR"
cd "$RELEASE_DIR"
# Optional: deploy a specific ref (tag/branch/commit) instead of branch HEAD.
# Additive — when REF is unset the clone above is used exactly as before.
if [ -n "${REF:-}" ]; then
  log "  Checking out ref: $REF"
  git fetch --depth 1 origin "$REF" 2>&1 \
    && git checkout --quiet FETCH_HEAD 2>&1 \
    || git checkout --quiet "$REF" 2>&1 \
    || { log "  ✗ ref '$REF' not found"; exit 1; }
fi
COMMIT=$(git rev-parse --short HEAD)
log "  Commit: $COMMIT"
# Machine-readable commit metadata for the deploy notifier (parsed by deploy.ts).
# %s = subject (single line), %an = author name. Best-effort; empty if git errors.
echo "__COMMIT_MSG__:$(git log -1 --pretty=%s 2>/dev/null | tr -d '\r\n')"
echo "__COMMIT_AUTHOR__:$(git log -1 --pretty=%an 2>/dev/null | tr -d '\r\n')"

# ── 2. Link shared files ─────────────────────────────────────────────────────
log "[2/8] Linking shared files..."
rm -rf storage
ln -sf "$SHARED_DIR/storage" storage
ln -sf "$SHARED_DIR/.env" .env

# Laravel needs bootstrap/cache to exist and be writable before composer runs
# its post-install `package:discover`. Some repos don't commit this directory.
mkdir -p bootstrap/cache
chmod -R ug+rwX bootstrap/cache

# ── 3. Composer ──────────────────────────────────────────────────────────────
# Run composer through the site's configured PHP binary explicitly — the bare
# `composer` command uses whatever `php` resolves to on PATH (the system
# default CLI version), which can silently diverge from $PHP_VER and break
# platform-requirement checks (e.g. composer.lock pinned to packages that
# don't support the newer default PHP).
log "[3/8] Installing PHP dependencies..."
php${PHP_VER} "$(command -v composer)" install \
  --no-dev \
  --no-interaction \
  --prefer-dist \
  --optimize-autoloader

# ── 3b. PHP tests (optional gate) ─────────────────────────────────────────────
# Runs ONLY when RUN_TESTS=1 (set per site in Deploy Settings). Executes before
# migrations and the symlink swap, so a failing test never reaches the live
# site — the previous release keeps serving. Existing sites don't set RUN_TESTS,
# so this block is skipped entirely and their deploys are byte-for-byte unchanged.
#
# NOTE: --no-dev above omits PHPUnit/Pest. When tests are enabled we install dev
# dependencies just for the test run (they're pruned from the release afterwards
# so production autoloading is unaffected).
if [ "${RUN_TESTS:-0}" = "1" ]; then
  TEST_CMD="${TEST_COMMAND:-php artisan test}"
  log "[3b/8] Tests enabled — installing dev dependencies..."
  php${PHP_VER} "$(command -v composer)" install \
    --no-interaction --prefer-dist --optimize-autoloader

  log "[3b/8] Running tests: ${TEST_CMD}"

  # Make the site's PHP the default `php` for the test run so both
  # `php artisan test` and `./vendor/bin/pest|phpunit` use the configured
  # version rather than whatever the system `php` resolves to.
  TEST_BIN="$(mktemp -d)"
  ln -sf "$(command -v php${PHP_VER})" "$TEST_BIN/php"

  # By default force an isolated in-memory SQLite DB + APP_ENV=testing so tests
  # can NEVER read or wipe the production database. Passed as real env vars
  # scoped to the test process only — they do not leak into the prod migrate below.
  TEST_ENV=(APP_ENV=testing)
  if [ "${TEST_USE_SQLITE:-1}" = "1" ]; then
    TEST_ENV+=(DB_CONNECTION=sqlite DB_DATABASE=:memory:)
  fi

  set +e
  env "${TEST_ENV[@]}" PATH="$TEST_BIN:$PATH" \
    timeout "${TEST_TIMEOUT:-300}" bash -c "cd '$RELEASE_DIR' && ${TEST_CMD}"
  TEST_EXIT=$?
  set -e
  rm -rf "$TEST_BIN"

  if [ "$TEST_EXIT" -eq 0 ]; then
    log "  ✓ Tests passed."
    echo "__TESTS__:passed"
  else
    echo "__TESTS__:failed"
    if [ "${TEST_FAILURE_MODE:-block}" = "warn" ]; then
      log "  ⚠ Tests FAILED (exit $TEST_EXIT) — continuing anyway (warn mode)."
    else
      log "  ✗ Tests FAILED (exit $TEST_EXIT) — aborting deploy. Live site unchanged."
      exit 1
    fi
  fi

  # Re-prune dev dependencies so the release matches a normal production install.
  log "[3b/8] Pruning dev dependencies..."
  php${PHP_VER} "$(command -v composer)" install \
    --no-dev --no-interaction --prefer-dist --optimize-autoloader
fi

# ── 4. Front-end assets ──────────────────────────────────────────────────────
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
    # Try a strict install first; if peer-dependency conflicts prevent it
    # (e.g. mismatched tiptap/other monorepo packages), fall back to
    # --legacy-peer-deps so the deploy isn't blocked by upstream version skew.
    if ! npm ci 2>&1; then
      log "[4/8] npm ci failed (peer dep conflict?) — retrying with --legacy-peer-deps"
      npm ci --legacy-peer-deps
    fi
    npm run build
  fi
  rm -rf node_modules
else
  log "[4/8] No JS build step detected — skipping."
fi

# ── 5. Artisan caches ────────────────────────────────────────────────────────
log "[5/8] Caching Laravel config, routes, views..."
php${PHP_VER} artisan config:cache
php${PHP_VER} artisan route:cache
php${PHP_VER} artisan view:cache

# ── 6. Migrations ────────────────────────────────────────────────────────────
log "[6/8] Running migrations..."
php${PHP_VER} artisan migrate --force

# ── 6b. Hand the release to the web/worker user ──────────────────────────────
# The Supervisor queue worker runs as www-data and must be able to write
# bootstrap/cache (compiled package manifest) and storage. The release was
# created by the deploy user, so transfer ownership now — otherwise the worker
# fails with "bootstrap/cache must be present and writable".
#
# Best-effort and NON-FATAL: a permission failure only logs a warning and never
# aborts an otherwise-successful build (matching the previous behaviour).
WEB_USER="www-data"
log "[6b/8] Setting web-server ownership ($WEB_USER)..."
if [ "$(id -u)" = "0" ]; then
  chown -R "$WEB_USER:$WEB_USER" "$RELEASE_DIR" || log "  WARN: chown failed (continuing)"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo chown -R "$WEB_USER:$WEB_USER" "$RELEASE_DIR" || log "  WARN: sudo chown failed (continuing)"
else
  # Not root and no passwordless sudo — fall back to group access (works when the
  # deploy user belongs to the www-data group). Never fatal.
  chgrp -R "$WEB_USER" bootstrap/cache storage 2>/dev/null || true
  chmod -R g+rwX bootstrap/cache 2>/dev/null || true
  log "  NOTE: not root and no passwordless sudo — applied group-based fallback."
  log "        If the worker still can't write bootstrap/cache, run once:"
  log "        sudo chown -R $WEB_USER:$WEB_USER $RELEASE_DIR"
fi

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

# ── POST-DEPLOY HOOK ─────────────────────────────────────────────────────────
run_hook "post-deploy.sh"

log "=== Deploy complete! ==="
echo "__COMMIT__:${COMMIT}"
