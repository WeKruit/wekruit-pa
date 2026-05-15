# Unified Claire Candidate Product Current-State Audit

Date: 2026-05-15
Branch: `codex/unified-claire-candidate-product`
Firebase project: `wekruit-5f89b`

## Identity And User Pool Boundary

`pa-users` is currently serving two distinct product roles:

- Real candidate accounts / SMS candidates, for example `pa-users/U7AwKT8nLDRa35DkuBxq`.
- External-supply prospects created from operator imports, for example manual CSV rows linked by LinkedIn handles.

Live Firestore evidence:

- `indolencorlol@gmail.com` resolves to exactly one profile: `pa-users/U7AwKT8nLDRa35DkuBxq`.
- That profile has `phoneE164 = +14243201960`, `latestResumeArtifactId = candidate_upload_U7AwKT8nLDRa35DkuBxq_e0f213bf9fcb83c33328e2f133b31c7f`, and active historical job prescreen sessions.
- `+13054507715` is not a candidate phone. It is the active Sendblue sender in `pa-config/sendblue-pool` with label `Pool A (305)`.
- Recent UUID `pa-users` rows around `2026-05-14T23:54:44Z` through `2026-05-15T00:58:27Z` were created by external supply batch `81395d47-3da9-4485-8025-fcdc79a4aa93`, source `manual_csv`, via `pa-candidate-source-links`.
- Older phone-backed `pa-users` rows include many synthetic E2E/QA profiles (`e2e-*`, `p9-*`, `qa*`, `recheck-*`, `synthetic*`, `*reset*`, `*smoke*`, `*test*`, `+19999...`, `+1888...`, `*@example.com`, `*@local`). These are also not real candidate accounts and must be excluded from user-wise acceptance checks.

Root cause of the "many users" confusion:

- Sendblue allowlist gates iMessage traffic by the inbound sender phone (`from_number`).
- External supply imports do not pass through the Sendblue allowlist. They create or merge `pa-users` profiles through the LinkedIn-first identity resolver.
- Therefore a global `pa-users` count is not a valid user-wise prescreen test signal.

Required fix boundary:

- Job prescreen, logged-in candidate pages, and live iMessage tests must always use the canonical candidate id resolved from auth/email/phone: `U7AwKT8nLDRa35DkuBxq` for `indolencorlol@gmail.com`.
- Dashboard and admin views must visually separate real candidate accounts/SMS candidates from external-supply prospects.
- Dashboard and admin views must visually separate synthetic test profiles from real candidate accounts.
- External-supply prospects may remain in the shared candidate pool, but they must not pollute user-wise onboarding/prescreen verification.

## Code Paths Observed

### iMessage Allowlist And Phone Resolution

- `apps/functions/src/sendblue/allowlist.ts`
  - Uses `IMESSAGE_PEERS`, `IMESSAGE_PEER`, and `IMESSAGE_DEFAULT_PEER`.
  - Normalizes phone-like handles to E.164.
  - Fails closed unless `IMESSAGE_DM_ALLOWLIST=0`.

- `apps/functions/src/sendblue/webhook.ts`
  - Checks allowlist against `normalized.fromNumber`.
  - Looks up `pa-users` with `where("phoneE164", "==", fromNumber)`.
  - Creates `pa-inbound-events` after allowlist passes.

- `apps/functions/src/sendblue/triggers/prescreen.ts`
  - Handles `WeKruit_<jobId>_<userId>_Job`.
  - Requires sender phone to resolve to the parsed user, an admin, or a valid pending-invite binding.

### Candidate Auth And Resume Upload

- `apps/functions/src/identity/claim-api.ts`
  - Claims a candidate profile using Firebase Auth email and browser uid.
  - Current live auth for `indolencorlol@gmail.com` points to `pa-users/U7AwKT8nLDRa35DkuBxq`.

- `apps/functions/src/public-cv-ingest.ts`
  - Public CV ingest accepts a caller-provided `userId`.
  - This must only be used after canonical profile resolution on logged-in candidate pages.

### External Supply User Creation

- `packages/pa-persistence/src/external-supply-upsert.ts`
  - `create_new` mints `pa-users/{uuid}` for LinkedIn-anchored external prospects.
  - Writes `pa-candidate-handles`, `pa-candidate-source-links`, and `pa-candidate-identity-events`.
  - This bypasses Sendblue allowlist by design.

## Immediate Gaps

- Dashboard language still encourages reading `pa-users` as "users" instead of a candidate pool with source classes.
- User-wise test acceptance must filter to the canonical candidate id or a real candidate account subset.
- The unified candidate product needs an explicit source taxonomy in dashboard and test scripts:
  - `candidate_account`
  - `sms_candidate`
  - `external_supply_prospect`
  - `synthetic_test_profile`
  - `layoff_candidate`
  - `ats_candidate`

## 2026-05-15 Fix Verification

- `apps/dashboard-web/src/pages/Candidates.tsx` now defaults to "Candidate accounts only" and separately counts candidate accounts, external prospects, and synthetic tests.
- `paCandidateClaimProfile` and `paCandidateResumeGateStatus` now reject `@wekruit.com` operator emails on the candidate app, so admin logins cannot create new candidate profiles.
- Node 24 verification:
  - `node --import tsx --test apps/functions/src/identity/claim-api.test.ts apps/functions/src/identity/candidate-resume-gate.test.ts` passed 11/11.
  - `npm run typecheck --workspace=@pa/functions` passed.
  - `npm run build --workspace=@pa/functions` passed.
  - Firebase deploy predeploy ran the full functions test suite: 1451 passed, 0 failed.
- Deployment:
  - `paCandidateClaimProfile` updated as Node.js 24, callable, us-central1.
  - `paCandidateResumeGateStatus` updated as Node.js 24, callable, us-central1.
  - `hosting:pa-dashboard` released to `https://wekruit-pa.web.app`.
- Live Firestore recheck:
  - `indolencorlol@gmail.com` still resolves to exactly `pa-users/U7AwKT8nLDRa35DkuBxq`.
  - `pa-config/sendblue-pool` active number is `+13054507715`.
  - Latest 500 `pa-users` classify as 5 candidate accounts, 28 external prospects, and 467 synthetic tests.
