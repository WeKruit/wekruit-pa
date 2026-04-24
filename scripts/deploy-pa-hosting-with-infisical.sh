#!/usr/bin/env bash
# Deploy PA Dashboard to Firebase Hosting (wekruit-pa) with secrets from Infisical.
# Same WeKruit instance as other repos: https://infisical-wekruit.fly.dev
#
# Prereq: `infisical login` and (once) a folder with the 6 VITE_FIREBASE_* keys.
# See config/WEKRUIT-INFISICAL.md
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${WEKRUIT_PA_INFISICAL_PATH:=/jobless/pa-dashboard}"
: "${INFISICAL_ENV:=prod}"

if ! command -v infisical &>/dev/null; then
  echo "error: infisical CLI not found. Install: https://infisical.com/docs/cli/installation" >&2
  exit 1
fi

echo "[deploy] infisical run --env=${INFISICAL_ENV} --path=${WEKRUIT_PA_INFISICAL_PATH} -- npm run deploy:hosting"
exec infisical run --env "${INFISICAL_ENV}" --path "${WEKRUIT_PA_INFISICAL_PATH}" -- npm run deploy:hosting
