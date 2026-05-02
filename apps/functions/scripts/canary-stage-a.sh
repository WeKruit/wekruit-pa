#!/bin/bash
# v1.5 Stage A canary — flip 9 flags to perUser scope with allowlist=[adamUid].
# Uses Firestore REST API + gcloud user-creds bearer token (no ADC needed).
# Idempotent: re-running just bumps version + writes a fresh audit row.

set -euo pipefail

PROJECT="wekruit-5f89b"
DB="(default)"
ADAM_UID="e5d97cd8-1e1d-439d-8672-3008f8aeef2e"
ACTOR="v1.5-canary-stage-a@wekruit.com"
REASON="v1.5 Stage A — Adam canary perUser allowlist before 10% ramp"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"

FLAGS=(
  "paOnboardingProbeV2Enabled"
  "paHardFiltersEnabled"
  "paStartupBoostEnabled"
  "paMatchExplainerEnabled"
  "paMatchingPipelineWebhookEnabled"
  "paMessageCoalesceEnabled"
  "paSafetyCheckEnabled"
  "paReverseMatchEnabled"
  "paTagClusterRecEnabled"
)

TOKEN="$(gcloud auth print-access-token 2>/dev/null)"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: gcloud auth print-access-token returned empty" >&2
  exit 1
fi

BASE="https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DB}/documents"

set_flag() {
  local KEY="$1"

  # Read current version (best-effort) to bump monotonically
  local CUR_VERSION=0
  local CUR_RESP
  CUR_RESP="$(curl -sS -H "Authorization: Bearer $TOKEN" "${BASE}/pa-feature-flags/${KEY}")" || true
  if echo "$CUR_RESP" | grep -q '"version"'; then
    CUR_VERSION="$(echo "$CUR_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get('fields',{}).get('version',{}); print(int(v.get('integerValue', 0)))" 2>/dev/null || echo 0)"
  fi
  local NEXT_VERSION=$((CUR_VERSION + 1))

  # PATCH the flag doc (creates if missing)
  local FLAG_BODY
  FLAG_BODY="$(python3 -c "
import json
print(json.dumps({
    'fields': {
        'key': {'stringValue': '$KEY'},
        'value': {'booleanValue': True},
        'type': {'stringValue': 'bool'},
        'scope': {'stringValue': 'perUser'},
        'allowlist': {'arrayValue': {'values': [{'stringValue': '$ADAM_UID'}]}},
        'blocklist': {'arrayValue': {'values': []}},
        'bucketStrategy': {'nullValue': None},
        'updatedAt': {'stringValue': '$NOW_ISO'},
        'updatedBy': {'stringValue': '$ACTOR'},
        'reason': {'stringValue': '$REASON'},
        'version': {'integerValue': $NEXT_VERSION},
    }
}))
")"
  local FLAG_HTTP
  FLAG_HTTP="$(curl -sS -o /tmp/canary-flag-resp.json -w "%{http_code}" \
    -X PATCH \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary "$FLAG_BODY" \
    "${BASE}/pa-feature-flags/${KEY}")"

  if [[ "$FLAG_HTTP" != "200" ]]; then
    echo "✗ ${KEY} flag write http=${FLAG_HTTP}: $(cat /tmp/canary-flag-resp.json)"
    return 1
  fi

  # POST a fresh audit row (auto-id). Use Python None (not JS null).
  local OLD_VAL_PY="None"
  local ACTION="flag.create"
  if [[ "$CUR_VERSION" != "0" ]]; then
    OLD_VAL_PY="False"
    ACTION="flag.update"
  fi
  local AUDIT_BODY
  AUDIT_BODY="$(python3 -c "
import json
old = $OLD_VAL_PY
old_field = {'nullValue': None} if old is None else {'booleanValue': old}
print(json.dumps({
    'fields': {
        'actor': {'stringValue': '$ACTOR'},
        'action': {'stringValue': '$ACTION'},
        'key': {'stringValue': '$KEY'},
        'oldValue': old_field,
        'newValue': {'booleanValue': True},
        'reason': {'stringValue': '$REASON'},
        'ts': {'stringValue': '$NOW_ISO'},
    }
}))
")"
  local AUDIT_HTTP
  AUDIT_HTTP="$(curl -sS -o /tmp/canary-audit-resp.json -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary "$AUDIT_BODY" \
    "${BASE}/pa-audit-events")"

  if [[ "$AUDIT_HTTP" != "200" ]]; then
    echo "⚠ ${KEY} flag set OK but audit row failed http=${AUDIT_HTTP}: $(cat /tmp/canary-audit-resp.json)"
    return 0
  fi

  echo "✔ ${KEY}  v${NEXT_VERSION}  perUser allowlist=[${ADAM_UID:0:8}…]"
}

for KEY in "${FLAGS[@]}"; do
  set_flag "$KEY" || true
done

echo
echo "Stage A canary complete. ${#FLAGS[@]} flags processed."
