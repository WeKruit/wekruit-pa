# Phase 30 — Firestore TTL Policy for `pa-trigger-fires`

The connector writes one audit-bearing doc to `pa-trigger-fires/{triggerId}_{sha1(userId)[:16]}` per fire. These docs serve two purposes:

1. **Cooldown enforcement** — `checkCooldown` reads the row and compares `lastFiredAt + cooldownSec` to now.
2. **Operator visibility** — the dashboard's Fires drawer lists recent rows.

Without TTL, the collection grows unboundedly. Apply a Firestore TTL policy on the document level via the Google Cloud Console (the SDK does not write `ttlExpiresAt` per the locked schema, but the Firestore TTL feature can also expire on `lastFiredAt + N days` via a deferred custom field — this runbook chooses the simpler doc-level TTL).

## Recommended policy: 30 days

The longest practical cooldown we ship by default is 24h (`mentioned_layoff`, `mentioned_salary_research`). 30 days = 30x longest cooldown — comfortably long enough for operators to review fires, short enough that storage stays bounded.

## Apply via Cloud Console

1. Open the Firestore console: https://console.cloud.google.com/firestore/databases
2. Pick the default database for the `wekruit-5f89b` project.
3. Navigate to **Time-to-live (TTL)** in the left nav.
4. **Create policy**:
   - Collection group: `pa-trigger-fires`
   - Timestamp field: `lastFiredAt` *(Firestore parses any ISO 8601 string as a timestamp for TTL eligibility; the SDK writes `lastFiredAt` as `new Date().toISOString()`.)*
5. Click **Create**.

**Note:** TTL deletes happen on a best-effort basis within 24-72h after `lastFiredAt + 30 days`. The cooldown check uses `lastFiredAt` directly so accidentally-living rows past TTL still enforce cooldown correctly until they're swept.

## Apply via gcloud (alternative)

```bash
gcloud firestore fields ttls update lastFiredAt \
  --collection-group=pa-trigger-fires \
  --enable-ttl
```

## Verify

```bash
gcloud firestore fields ttls list \
  --collection-group=pa-trigger-fires
```

Expected output includes `state: ACTIVE` and `valueMode: ASCENDING` (timestamp parser).

## Cost note

Firestore TTL deletes count as regular delete operations against billing. At 1 fire/user/day × 30-day retention × 10K active users = 300K deletes/month, well under the daily free tier (20K/day = 600K/month).

## Related

- `pa-audit-events` (write-once) is **not** TTL'd — Phase 32 added a separate retention policy for it (90 days).
- `pa-downstream-triggers` is config — never TTL'd, never auto-deleted.
