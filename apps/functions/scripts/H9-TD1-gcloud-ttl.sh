#!/bin/bash
# Stream H9 TD1 — gcloud commands to point Firestore TTL at the new
# `expiresAtTs` Timestamp field on three collections.
#
# Run AFTER deploying the H9 fix (so writers have already started populating
# the new field). Existing rows without expiresAtTs are not GC'd, but that's
# fine — they'll get the field on next mutation, OR the TTL sweeper will
# leave them and they'll just sit (acceptable; small volume).
#
# Each `update` is idempotent — re-running is safe.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-wekruit-5f89b}"

echo "[H9-TD1] Pointing Firestore TTL at expiresAtTs (Timestamp) field…"
echo "[H9-TD1] Project: $PROJECT_ID"
echo

# pa-outbound — 30-day retention
gcloud firestore fields ttls update expiresAtTs \
  --collection-group=pa-outbound \
  --enable-ttl \
  --project="$PROJECT_ID"

# pa-inbound-events — 60-day retention
gcloud firestore fields ttls update expiresAtTs \
  --collection-group=pa-inbound-events \
  --enable-ttl \
  --project="$PROJECT_ID"

# pa-trigger-fires — 30-day retention
gcloud firestore fields ttls update expiresAtTs \
  --collection-group=pa-trigger-fires \
  --enable-ttl \
  --project="$PROJECT_ID"

echo
echo "[H9-TD1] Done. Verify with:"
echo "  gcloud firestore fields ttls list --project=$PROJECT_ID"
