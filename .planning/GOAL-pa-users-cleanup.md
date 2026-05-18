# GOAL — pa-users cleanup + FK cascade + Qdrant + typo fix

**Owner:** Adam
**Status:** PLAN only — NOT executed yet
**Created:** 2026-05-18

---

## Why

Pre-launch state. Only 3 real WeKruit admin users exist; everything else in
`pa-users` is dev/QA/E2E/synthetic pollution accumulated through
self-testing. Tag-fill audits + matching debugging are unreliable because
99.8% of `pa-users` rows have no `source` label and are indistinguishable
from production data.

Adam directive (2026-05-18):

> "现在真实用户只有这三个email" + "其他的可以cleanup，但是先计划好"

Plus a separately-discovered bug: `voice/realtime-tagger.ts:192` writes to
`pa_users` (underscore) instead of `pa-users` (dash) — created a 312-doc
shadow collection.

---

## KEEP_LIST (verified real)

| Email | uid | Notes |
|---|---|---|
| `indolencorlol@gmail.com` | `U7AwKT8nLDRa35DkuBxq` | source=WeKruit_Laid_Off, fully tagged |
| `adam.ylol@wekruit.com` | `UThMpnAGzjaWnxDsKEMH` | source=(none), partial tags |
| `admin1@wekruit.com` | `itYEwzaJjVPjWbN01fzk` | source=(none), shell-only tags |

Everything else in `pa-users` (624 docs) is delete-candidate.

---

## Out-of-scope (DO NOT touch)

| Collection | Why keep |
|---|---|
| `users` (558 docs, no `pa-` prefix) | Different product (coding-interview app — `systemDesignProblems`, `ongoingInterviews`, `interviewCount`). Not WeKruit. |
| `pa-jobs` (33 docs) | Adam: 不动. Employer-created jobs, may have real data. |
| `pa-canonical-tags` (39 docs) | Vocabulary registry. Config, not user data. |
| `pa-onboarding-questions` (10 docs) | Onboarding question templates. Config. |
| `matching-jobs` (127k+ docs) | Job inventory. Already cleaned via apply-url goal. |
| `pa-companies` series | Company-tier data. Separate scope. |
| `pa-employer-visible-profiles` (2 docs) | 2/2 are real `KEEP_LIST` candidateId — keep both. |

---

## Cleanup scope (FK cascade from pa-users)

### A — userId-FK collections

| Collection | total | keep (real) | delete | filter |
|---|---|---|---|---|
| `pa-users` | 627 | 3 (by doc id) | 624 | doc id NOT IN KEEP_LIST |
| `pa-sessions` | 1195 | 2 | 1193 | `userId` NOT IN KEEP_LIST |
| `pa-messages` | 6742 | 370 | 6372 | `userId` NOT IN KEEP_LIST |
| `pa-turns` | 3190 | 109 | 3081 | `userId` NOT IN KEEP_LIST |
| `pa-outbound` | 335 | 137 | 198 | `userId` NOT IN KEEP_LIST |
| `pa-inbound-events` | 3714 | 336 | 3378 | `userId` NOT IN KEEP_LIST |
| `pa-prescreen-sessions` | 204 | 153 | 51 | `userId` NOT IN KEEP_LIST |
| `pa-audit-events` | 3121 | 127 | 2994 | `userId` NOT IN KEEP_LIST |
| `parsedCandidateResumes` | 75 | 2 | 73 | `userId` NOT IN KEEP_LIST |
| `pa-tool-calls` | 178 | 0 | 178 | full wipe |
| `pa-job-clicks` | 32 | 0 | 32 | full wipe |
| `pa-feedback-events` | 1 | 0 | 1 | full wipe |
| `pa-pii-confirm-state` | 1 | 0 | 1 | full wipe |

### B — candidateId-FK collections (`candidateId == pa-users.id`)

| Collection | total | keep (real) | delete | filter |
|---|---|---|---|---|
| `pa-candidate-handles` | 39 | 8 | 31 | `candidateId` NOT IN KEEP_LIST |
| `pa-candidate-self-profiles` | 5 | 3 | 2 | `candidateId` NOT IN KEEP_LIST |
| `pa-candidate-auth` | 4 | 3 | 1 | `candidateId` NOT IN KEEP_LIST |
| `pa-resume-artifacts` | 6 | 3 | 3 | `candidateId` NOT IN KEEP_LIST |

### C — Shadow / typo collections (full wipe)

| Collection | total | reason |
|---|---|---|
| `pa_users` (underscore) | 312 | Typo from `voice/realtime-tagger.ts:192`. Not read by anything. |

### D — Qdrant memory (separate store)

| Qdrant collection | points | filter |
|---|---|---|
| `pa_memory` | 627 | `user_id` payload NOT IN KEEP_LIST → delete |
| `pa_memory_entities` | 2588 | `user_id` payload NOT IN KEEP_LIST → delete |
| `memory_migrations` | 1 | keep (schema metadata) |

### E — Needs Adam decision before delete

| Collection | total | question |
|---|---|---|
| `candidates` | 51 | Is this external-supply sourced candidate data (keep) or dev/QA (delete)? Inspect a sample first. |
| `pa-candidate-source-links` | 50 | Companion to `candidates` — answer same way. |
| `pa-beta-participants` | ? (not yet measured) | Beta program records — likely keep. |

---

## Execution order (when shipping)

```
Step 0  Confirm:
        - admin1@wekruit.com IS Adam dev account → keep 3rd uid
        - candidates (51) → real or dev? inspect first
        - Snapshot full Firestore export to gs://wekruit-5f89b-backups/
          before any delete

Step 1  Fix code FIRST so deletes don't repopulate:
        - voice/realtime-tagger.ts:192: pa_users → pa-users
        - Add source-label policy: every new pa-users doc MUST set
          source ∈ {candidate, layoff, admin, dev_test_*, e2e_run, qa_run}
        - Test writers (admin-bootstrap, e2e scripts) use distinct sources
        - Deploy via small PR

Step 2  Firestore delete (one collection at a time, paginated batchWrite):
        - pa_users (typo) full wipe                          312 docs
        - pa-tool-calls / pa-job-clicks / pa-feedback-events /
          pa-pii-confirm-state full wipe                     ~212 docs
        - pa-messages by userId NOT IN KEEP_LIST              6,372 docs
        - pa-turns                                            3,081
        - pa-sessions                                         1,193
        - pa-inbound-events                                   3,378
        - pa-outbound                                           198
        - pa-prescreen-sessions                                   51
        - pa-audit-events                                     2,994
        - parsedCandidateResumes                                 73
        - pa-resume-artifacts / pa-candidate-handles /
          pa-candidate-self-profiles / pa-candidate-auth        ~40
        - pa-users (LAST — after all FK rows drained)          624

Step 3  Qdrant delete:
        - pa_memory: scroll all points, filter user_id NOT IN KEEP_LIST,
          batch delete by point IDs
        - pa_memory_entities: same pattern
        - Use Qdrant REST /points/delete

Step 4  Verify:
        - Re-run pa-users + FK count audit
        - All collections should equal real-user-only counts
        - Match engine smoke test: send a job-rec request for each of
          the 3 keep_list uids; confirm no errors, no orphan FK lookups

Step 5  Lock down so it stays clean:
        - Add firestore.rules guard requiring `source` field on
          pa-users writes (reject writes missing source)
        - Add CI / predeploy check: scan codebase for any
          db.collection("pa_users") with underscore (fail build)
        - Document KEEP_LIST in CLAUDE.md under "production identity
          allowlist" so future cleanup is one-line update
```

---

## Risks

| Risk | Mitigation |
|---|---|
| Delete before backup → data lost | Firestore export to GCS bucket BEFORE step 2 |
| pa-jobs / candidates dirty too but Adam unsure | Sample them first, ask before delete |
| Qdrant point-id format mismatch | Test on 1 point first, verify delete actually drops it |
| `voice/realtime-tagger.ts` re-creates `pa_users` after wipe | Step 1 ships code fix FIRST |
| Forgot a FK collection | Re-grep `userId\|candidateId` after step 2, find any new total != expected |
| Admin1 isn't actually real Adam → over-keep | Cheap mistake; can re-delete later if confirmed |
| Production traffic during delete → race | Pre-launch; no real users. Safe window. |

---

## Done criteria

| # | Check | Pass condition |
|---|---|---|
| 1 | `pa-users` count | == 3 |
| 2 | `pa_users` (typo) count | == 0 |
| 3 | All FK collections | rows only reference KEEP_LIST uids |
| 4 | Qdrant `pa_memory` | points only reference KEEP_LIST user_id |
| 5 | `voice/realtime-tagger.ts:192` | reads `"pa-users"` not `"pa_users"` |
| 6 | Source-label policy ships | new write without source → reject (firestore.rules) |
| 7 | Match engine smoke for 3 real users | 0 errors, candidates pool > 0 |
| 8 | Firestore export snapshot | persisted in GCS bucket before any delete |

---

## Followup (separate goal)

- `pa-users.source` field backfill for any future real users (label every entry-point)
- Periodic "pa-users hygiene" CF that flags entries with `source=(none)` > 7 days old

---

## NON-GOALS

- No schema migration on tags / matching-jobs
- No touch to `users` (other product)
- No touch to `pa-jobs` (Adam: 不动)
- No new product features
