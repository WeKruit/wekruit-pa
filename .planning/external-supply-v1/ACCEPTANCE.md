# External Supply V1 — Acceptance Ledger

> Filled progressively as waves complete. Final pass/fail captured here. All artifacts go in `.planning/external-supply-v1/artifacts/`.

## Required Checks

| # | Check | Command or action | Expected | Actual | Status |
|---|---|---|---|---|---|
| 1 | core-types contract tests | `pnpm --filter @pa/core-types test` | All schemas Zod-parse round-trip green; new external-supply.test.ts green; marketplace.test.ts still green | | pending |
| 2 | pa-persistence identity + upsert | `pnpm --filter @pa/pa-persistence test` | identity, upsert, marketplace tests green | | pending |
| 3 | external-supply pkg unit tests | `pnpm --filter @pa/external-supply test` | normalize / rubric / outreach / agent-prompt / agent-parse / instantly-client tests green | | pending |
| 4 | functions tests incl. external-supply | `pnpm --filter functions test` | all existing + new external-supply/* tests green | | pending |
| 5 | dashboard build | `pnpm --filter dashboard-web build` | Vite build succeeds; no missing route | | pending |
| 6 | repo-wide build | `pnpm -r build` | success | | pending |
| 7 | v1.9 regression | `pnpm --filter pa-orchestrator test` | green | | pending |
| 8 | Fixture batch import (100+) | E2E test runs against in-memory Firestore + mocks | row stats: validLinkedIn ≥ 70, validEmail ≥ 90, duplicates < 10, needsReview = 30 ± 5, readyToProfile = 50 ± 5 | | pending |
| 9 | Identity resolution determinism | E2E asserts | Same fixture re-run produces identical per-record statuses | | pending |
| 10 | Profile create / merge | E2E asserts | 50 new `pa-users` rows + 20 enriched existing rows; no stronger-fact overwrite | | pending |
| 11 | Identity conflict review | E2E asserts | LinkedIn-email mismatch + fuzzy-only land in `pa-candidate-identity-conflicts` with correct kind | | pending |
| 12 | Real evaluation | Run against fixture company / job | Per-candidate Tier 1/2/3/retain-only/blocked output with hard-gate / soft / explanation | | pending |
| 13 | Agent research round-trip | Generate prompt → mock paste → parse → approve | Prompt schema-aware; parser rejects malformed JSON | | pending |
| 14 | Tier-to-payload mapping | E2E asserts | Tier 1 → personal_linkedin task + personal_email payload; Tier 2 → personal_email; Tier 3 → general_email or retain_only | | pending |
| 15 | Suppression gates | E2E asserts | opt-out / bounce / cooldown / duplicate / invalid email → blocked from sync | | pending |
| 16 | Instantly dry-run | E2E asserts | Dry-run payload golden test passes; no network call | | pending |
| 17 | Instantly live-mode gate | E2E asserts | Live mode requires `INSTANTLY_API_KEY` + `EXTERNAL_SUPPLY_LIVE_OUTREACH_ENABLED=true`; absent → throws config error | | pending |
| 18 | Webhook idempotency | E2E asserts | Replaying same `(provider, providerEventId)` writes one `pa-outreach-events` doc | | pending |
| 19 | Reply event back to PA | E2E asserts | Instantly reply event lands `pa-outreach-events` + `pa-feedback-events` + updates plan + sync record | | pending |
| 20 | Dashboard end-to-end manual | Walk all `/admin/external-supply/*` routes in dev server | Operator can: import batch → resolve identity → approve profile → run evaluation → generate Agent prompt → import result → review/edit outreach copy → approve sync → see reply event | | pending |
| 21 | No candidate-domain bleed | Grep `apps/pa-landing` | Zero external-supply references | | pending |
| 22 | No raw PII doc ids | Grep new collection writes | All doc ids are hashes or uuids; no raw email/phone/LinkedIn | | pending |
| 23 | Audit / correction events | E2E asserts | Tier override, agent finding approval, identity conflict resolution each write `pa-correction-events` | | pending |
| 24 | LinkedIn manual-only | Grep new code | No automated LinkedIn POST / write to `linkedin.com` | | pending |

## Hard Fail Conditions (auto-stop)

- Candidate route appears on candidate domain.
- LinkedIn auto-send code path exists.
- Live Instantly sync without explicit env flag.
- Raw PII used as Firestore document id.
- `pa-users` overwritten with weaker external fact.
- First interview blocked by external-supply tier (Claire continues regardless).

## Evidence

Captured in `artifacts/`:

- `wave-a-tests.log`
- `wave-b-tests.log`
- `wave-c-tests.log`
- `wave-d-build.log`
- `wave-d-screenshots/` (one per dashboard route)
- `wave-e-end-to-end.log`
- `wave-e-instantly-dry-run-payload.json`

## Remaining Risks (filled at SUMMARY time)

- Instantly live credentials (`INSTANTLY_API_KEY`) + campaign/list ids — Adam-action.
- Rubric weights for Tier mapping — iterate after first real run.
- Agent research prompt fidelity — eval needs real ChatGPT Agent output before next milestone.
- Source-quality metrics dashboard graphs — V1 ships counts only.
