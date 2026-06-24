#!/usr/bin/env bash
# Usage: ssl.sh <domain> <email>
set -euo pipefail

DOMAIN="${1:?domain required}"
EMAIL="${2:?email required}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "=== Enabling SSL for $DOMAIN ==="
log "Running Certbot (Let's Encrypt)..."

certbot --nginx \
  --non-interactive \
  --agree-tos \
  --redirect \
  -m "$EMAIL" \
  -d "$DOMAIN"

log "=== SSL enabled for $DOMAIN ==="
