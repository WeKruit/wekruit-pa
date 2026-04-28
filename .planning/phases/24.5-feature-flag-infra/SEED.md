# Phase 24.5 — `pa_feature_flags` Seed Runbook (Adam)

This is the runbook for first-deploy seeding of the 6 initial flags from
`CONTEXT.md`. The script is **idempotent** — re-running never overwrites
operator edits made via `/admin/flags`.

## 1. Dry-run (preview only — no credentials needed)

```bash
cd /Users/adam/Desktop/WeKruit/wekruit-pa
npx tsx apps/functions/scripts/seed-feature-flags.ts --dry-run
```

Expected output: a 6-row plan showing `CREATE` for each seed flag with its
canonical default value and scope. No Firestore reads or writes occur in
dry-run mode, so this is safe to run in any environment (including CI).

## 2. Live run (writes to Firestore)

```bash
# 1. Set service-account credentials (skip if already on Cloud Shell / GCE)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/wekruit-5f89b-firebase-adminsdk.json

# 2. (Optional) point paRateLimitPerUserEnabled blocklist at your test number
#    user-id from `pa_users`. If unset the seed writes a placeholder you must
#    fix via /admin/flags before Phase 26 enforcement lands.
export PA_ADMIN_USER_ID=<your-pa_users-doc-id>

# 3. Run the seed
npx tsx apps/functions/scripts/seed-feature-flags.ts
```

Expected output: same plan, then `Live seed complete. N flag(s) created, M
skipped.` Each `flag.create` write also lands a row in `pa_audit_events`
(actor = `p9-infra-seed@wekruit.com`, reason = "Phase 24.5 initial seed").

Re-run is safe — already-present flags are skipped (the in-transaction
re-check guards against concurrent runs creating duplicates).

## 3. Emergency env-var override (hot kill switch)

The SDK consults `process.env[<flag-key>]` BEFORE Firestore. Setting the env
var to `"1"` or `"true"` short-circuits to legacy `true` without any network
call. Use this when the Firestore flag is wrong AND you can't wait for the
30s TTL cache to expire.

| Scenario | Command (CF runtime / shell) |
|---|---|
| Force CF to release outbound to macOS worker (rollback) | `firebase functions:config:set runtime.PA_CHANNEL_LEGACY=1` then `firebase deploy --only functions:paSendblueOutbox` |
| Stop all proactive-sweep dispatches | `PA_PROACTIVE_DISABLED=1` in CF runtime config |
| Disable voice-mirror snippet injection (D-07) | `PA_VOICE_MIRROR_DISABLED=true` in CF runtime config |

After the incident, **clear the env override** and adjust the Firestore flag
via `/admin/flags`. Leaving env vars set masks the dashboard value and makes
debugging confusing.

## 4. Verifying the Adam-test-number bypass (`paRateLimitPerUserEnabled`)

CONTEXT.md success criterion #6 requires the per-user blocklist to take
precedence over allowlist and default. To verify after seeding:

1. Open the Firestore console at
   `pa_feature_flags/paRateLimitPerUserEnabled` and confirm the document has:
   - `scope: "perUser"`
   - `value: true` (default for everyone else)
   - `blocklist: ["<your-pa_users-doc-id>"]`
2. From a Node REPL with credentials set, run:
   ```ts
   import { getFirestore } from "firebase-admin/firestore"
   import { initializeApp, applicationDefault } from "firebase-admin/app"
   import { getFlag } from "@pa/pa-persistence"
   initializeApp({ credential: applicationDefault() })
   const db = getFirestore()
   await getFlag(db, "paRateLimitPerUserEnabled", { userId: "<your-doc-id>" })
   // → false   (blocklist beat the default value=true)
   await getFlag(db, "paRateLimitPerUserEnabled", { userId: "any-other-user" })
   // → true    (default)
   ```
3. If the blocklist contained the placeholder `ADAM_TEST_USER_ID_TBD`, fix it
   now via `/admin/flags`: open the flag, edit blocklist chip input, replace
   with your real `pa_users` doc-id, save. The audit drawer should show the
   `flag.update` row immediately.

## 5. Rollback

If a seed write goes wrong:

- **Single-flag bad value:** open `/admin/flags`, click "Revert to previous"
  — the dashboard reads the last `pa_audit_events` row and writes back the
  prior value (≤30s TTL propagation).
- **Whole-collection rollback:** Firestore export-restore is the nuclear
  option; the seed script will not delete documents you didn't create.

Risks tracked in CONTEXT.md (R1: 30s TTL perceived slow → use env override;
R2: perUser flag explosion → schema requires explicit lists, no wildcards).
