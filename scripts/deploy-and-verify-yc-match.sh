#!/usr/bin/env bash
#
# Phase A+B deploy + verify runner for GOAL-company-tier-yc-match.md.
#
# Sequenced steps:
#   1. Workspace tests (shared-tags, core-types, pa-orchestrator, job-rec, functions)
#   2. Firebase deploy: rules + indexes, functions, hosting
#   3. Manual YC scrape on macmini (kicks off background)
#   4. Run paEnrichCompaniesAdHoc to populate ≥200 enriched companies
#   5. Verify done criteria #2, #4, #5 (Adam pastes evidence for #1, #3, #6)
#
# Usage: bash scripts/deploy-and-verify-yc-match.sh [--skip-tests] [--skip-deploy]
#
# Environment: must be run from the worktree root with GOOGLE_APPLICATION_CREDENTIALS
# set OR a .env file containing FIREBASE_SERVICE_ACCOUNT_JSON.

set -euo pipefail

SKIP_TESTS=0
SKIP_DEPLOY=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --skip-deploy) SKIP_DEPLOY=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

# ─── 1. Workspace tests ──────────────────────────────────────────────────
if [[ $SKIP_TESTS -eq 0 ]]; then
  echo "=== [1/5] Workspace tests ==="
  pnpm --filter @wekruit/shared-tags test
  pnpm --filter @pa/core-types build
  pnpm --filter pa-orchestrator test
  pnpm --filter @pa/job-rec test
  pnpm --filter @pa/functions test
fi

# ─── 2. Firebase deploy ──────────────────────────────────────────────────
if [[ $SKIP_DEPLOY -eq 0 ]]; then
  echo "=== [2/5] Firebase deploy ==="

  # Source service-account credentials.
  if [[ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]] && [[ -f .env ]]; then
    GOOGLE_APPLICATION_CREDENTIALS="$(mktemp)"
    grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
    export GOOGLE_APPLICATION_CREDENTIALS
  fi

  # Rules + indexes (cheap, idempotent).
  firebase deploy --only firestore:rules,firestore:indexes \
    --project wekruit-5f89b --non-interactive

  # Functions (predeploy auto-runs build/smoke/typecheck/test).
  ( cd apps/functions && pnpm run deploy )

  # Dashboard hosting.
  pnpm run deploy:hosting
fi

# ─── 3. macmini YC scrape ────────────────────────────────────────────────
echo "=== [3/5] macmini YC scrape ==="
echo "Kicking off pipeline on wekruit-mini (background) ..."
ssh wekruit-mini "nohup /Users/Shared/wekruit/run-pipeline.sh > /tmp/wekruit-yc-scrape-$(date -u +%Y%m%d-%H%M%S).log 2>&1 &"

# ─── 4. Run ad-hoc enrichment ────────────────────────────────────────────
echo "=== [4/5] paEnrichCompaniesAdHoc bulk run ==="
echo "Invoking paEnrichCompaniesAdHoc with limit=300 to overshoot the 200 threshold."
firebase functions:call paEnrichCompaniesAdHoc \
  --data '{"companyNames":"all_stale","limit":300}' \
  --project wekruit-5f89b || echo "(callable returned non-zero; check Cloud Functions logs)"

# ─── 5. Verify done criteria ─────────────────────────────────────────────
echo "=== [5/5] Done-criteria verification ==="
echo ""
echo "Done #2: pa-companies ≥200 enriched"
node scripts/verify-pa-companies-enriched.mjs

echo ""
echo "Done #5: V16 honors targetCompanyTags"
node scripts/verify-match-company-tags.mjs

echo ""
echo "Manual checks Adam should run:"
echo "  Done #1: ssh wekruit-mini \"cd /Users/wekruitclaw1/Desktop/WeKruit/wekruit-matching && .venv/bin/python -c 'from wekruit_matching.config import get_settings; from wekruit_matching.db.connection import _sqlalchemy_url_to_libpq; import psycopg; c = psycopg.connect(_sqlalchemy_url_to_libpq(get_settings().database_url)); cur = c.cursor(); cur.execute(\\\"select count(*) from jobs where source_repo like 'yc:%'\\\"); print(cur.fetchone())'\""
echo "  Done #3: Open https://wekruit-pa.web.app/admin/companies, verify list + inline edit + bulk re-enrich."
echo "  Done #6: node tests/scenarios/runner.mjs tests/scenarios/laid-off.yaml (assert pa-users.{uid}.tags.urgentlySeeking === true)"
