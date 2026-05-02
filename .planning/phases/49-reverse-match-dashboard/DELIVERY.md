# Phase 49 — Reverse-Match Dashboard

**Stream**: H (v1.5) · **Spec**: D9 in `MILESTONE-v1.5-friend-companion.md` · **Status**: D1+D2+D3+D4+D5 ship.

> Adam directive verbatim: *"when there's a proper job, on the dashboard, we should be able to reuse our match interface by inputing job description and tags and then get a list of candidate, we also need to score the matching accordingly and tag the user properly. and after that we can trigger an outbound for connected user telling them we have certain jobs."*

## TL;DR

Operator pastes JD + tags → top-K connected users ranked against the JD → per-row Notify or Bulk Notify Top 5 → enqueues `pa-outbound` (existing abuse-event chain). Mirrors daily-batch architecture but reverses the pivot: 1 JD × N users instead of 1 user × N jobs.

```
┌────────────────────────┐    ┌──────────────────────┐    ┌────────────────────────┐
│ /match/candidates page │───▶│ paReverseMatch CF     │───▶│ pa-outbound (existing) │
│ (textarea + tags + UI) │    │ (admin auth + flag)   │    │ Sendblue outbox picks  │
└────────────────────────┘    └──────────────────────┘    └────────────────────────┘
                                          │
                                          ▼
                              ┌────────────────────────────┐
                              │ runReverseMatch (job-rec)   │
                              │  1. embed JD                │
                              │  2. cosine vs CV pool       │
                              │  3. cross-encoder rerank    │
                              │  4. apply hard filter (rev) │
                              │  5. take topK               │
                              └────────────────────────────┘
```

## Architecture (forward + reverse symmetry)

| | Forward (existing daily-batch) | Reverse (this phase) |
|---|---|---|
| Trigger | Cron 09:00 PT | HTTP POST from operator |
| Pivot | 1 user × N jobs | 1 JD × N users |
| Embedding cache source | `parsedCandidateResumes/{id}.embedding` | (same) |
| Cosine top-N | 50 jobs per user | 50 users per JD |
| Cross-encoder | `BAAI/bge-reranker-v2-m3` (SiliconFlow) | (same model, A/B swapped) |
| Hard filter | `applyHardFilters(profile, jobs[])` | `applyHardFilters(profile, [synthJob])` per user |
| Output | top-K jobs → daily push body | top-K users → operator table |
| Notify channel | Sendblue → user phone | (same) via `pa-outbound` source=`reverse-match` |

## Files shipped

**Cloud Function (D1)**
- `apps/functions/src/paReverseMatch.ts` — admin-token-gated HTTP CF; actions `match` / `notify` / `bulkNotify`
- `apps/functions/src/index.ts` — `export { paReverseMatch }` registered after `paJobRecDaily`

**Domain logic**
- `apps/job-rec/src/reverse-match.ts` — pure logic: `runReverseMatch`, `synthesizeJobFromJd`, `buildMatchedReasons`, `buildNotifyMessage`, `buildUserCandidateText`, `passesReverseHardFilter`
- `apps/job-rec/src/index.ts` — added exports for the above + `applyHardFilters`/`HardFilterUserProfile` (newly public)

**Dashboard (D2)**
- `apps/dashboard-web/src/pages/MatchCandidates.tsx` — operator page with form + result table + per-row & bulk Notify
- `apps/dashboard-web/src/pages/MatchCandidates.helpers.ts` — pure helpers (`parseTagsInput`, `validateMatchForm`, `formatMatchScore`, `filterOptedInOnly`, `INDUSTRY_OPTIONS`)
- `apps/dashboard-web/src/App.tsx` — wired route `/match/candidates` + nav section "Match"

**Tests (D4)**
- `apps/functions/src/__tests__/paReverseMatch.test.ts` — **6 backend tests** (rank correctness, hard-filter drop, opted-in surface, topK, admin auth, outbound enqueue path)
- `apps/dashboard-web/src/pages/__tests__/MatchCandidates.test.ts` — **4 frontend tests** (parse tags, validate form, format score, filter opted-in)

## Operator runbook

### When to use

Use this dashboard when:
1. **A "proper job" lands** — internal hire signed; recruiter has the JD + role title.
2. **You want to reach out to users we already know** — they have a phone number, paJobRecEnabled, and a parsed CV.
3. **You're willing to send <50 outbound notifies for this JD today** — there's no automatic enforcement; abuse the budget and you'll show up in Sendblue rate metrics + abuse panel.

Do NOT use this dashboard for:
- Cold outbound to never-connected users (CF can't resolve their phones — by design).
- High-frequency JD spam — the same connected user shouldn't see >1 reverse-match notify per week. We do not enforce this in code today; treat it as operator discipline.

### Step-by-step

1. Visit https://wekruit-pa.web.app/match/candidates (admin Google sign-in required for the dashboard layer).
2. Paste the full JD into the textarea (≥30 chars; <8000 chars truncated for embed).
3. Add tags as comma/semicolon-separated keywords (skills, technologies, role types). Example: `python, kafka, llm, fastapi`.
4. Pick **industry** from the dropdown (6-enum: tech / fintech / healthtech / consumer / b2b / any). Matches `pa-job-profiles.profile.industry`.
5. Optional: location (e.g. `san francisco`, `nyc`, `remote`). Drives the hard-filter location rule for users whose `statedPreferences.targetLocations` is set.
6. Optional: **Job Title + Company** — required ONLY before sending notifies (the Notify button alerts you if missing).
7. Optional: top K (default 20, hard cap 1000).
8. Click **▶ Find candidates** → paste your `PA_ADMIN_TOKEN` once. Token is not stored.
9. Inspect the results: `score / why / lang / opted-in / notify`.
10. Per-row **Notify** or aggregate **📨 Notify top 5 (opted-in: N)**.

### What counts as "opted in"

A candidate is `hasOptedIn === true` iff:
- `pa-users/{userId}.phoneE164` is non-empty (we know how to reach them); AND
- The `paJobRecEnabled` feature flag returns `true` for that userId (allowlisted into our daily-rec system).

In other words: "**connected**" per Adam's directive = they've opted into the WeKruit PA loop, we have a phone number, and we're already authorized to push them daily recs. The Bulk Notify gates strictly on this — the per-row Notify button is disabled when `hasOptedIn=false`.

### Rate-limit guidance

- **Hard cap: 50 candidates/JD/day** (operator discipline; not enforced in code).
- **Bulk Notify cap: 5 users per click** (enforced in CF — `REVERSE_MATCH_BULK_NOTIFY_CAP=5`, returns `bulk_cap_exceeded` over).
- **Same user, ≤1 reverse-match notify per week** (operator discipline). If you want to enforce this, add a check against `pa-outbound where userId=X and source=reverse-match and createdAt>now-7d` before clicking Notify.
- **Abuse signal** — if the user marks the message as spam in Sendblue, the existing abuse-event chain logs it under `pa_abuse_events` and the Abuse panel surfaces it.

### Cost

| Item | Per-call | Notes |
|---|---|---|
| OpenAI text-embedding-3-small | ~$0.0001 | 1536-d, 8000 tokens cap |
| SiliconFlow BAAI/bge-reranker-v2-m3 | $0 | free tier |
| Firestore reads | ~1k pa-job-profiles + N parsedCandidateResumes + N pa-users + N pa-feature-flags | dominated by N (cosine top 50 + hard-filter pool) |
| Outbound (Sendblue) | per-user iMessage cost | governed by existing Sendblue billing |

Daily cost ceiling (50 JDs/day with full pool): ~$0.005/day. Safely below v1.5's $5/mo explainer ceiling.

## Flag rollout plan

`paReverseMatchEnabled` (default: **OFF**)

```
Stage 1 (now)       : default off, admin-only access. Cassie tests with 1 JD/day.
Stage 2 (week 1)    : default off; 3 operators allowlisted via /admin/flags.
Stage 3 (week 2)    : enabled globally for admin role only (still admin-token-gated CF).
Stage 4 (TBD)       : surface to recruiter clients with per-tenant flag (NOT in scope this phase).
```

Flip via `/admin/flags` page → `paReverseMatchEnabled` → ON. CF re-checks per request, no restart needed.

## Auth + safety

1. **Admin token** — every request must carry `x-admin-token` matching `PA_ADMIN_TOKEN` secret. Same pattern as `paAdminBootstrap`.
2. **Flag gate** — when `paReverseMatchEnabled === false`, CF returns `503 {error: "flag_disabled"}`.
3. **Opt-in gate (Notify)** — per-row Notify is disabled in UI for `hasOptedIn=false`. Bulk Notify pre-filters to opted-in only and caps at 5.
4. **Outbound discipline** — every notify writes a `pa-outbound` row with `source: "reverse-match"`. NO bypass of Sendblue outbox or the Phase 23 abuse-event chain. Abuse signals from these messages will appear in `pa_abuse_events` like any other outbound.
5. **Synth job has `sponsorship: null`** — operator can't easily declare "this role sponsors visa" via the form. Conservative default. Users with `visaStatus: "sponsorship_needed"` are NOT auto-dropped (they'd be dropped only if synth carries `sponsorship: false`, which we never set). When you know the role doesn't sponsor, **don't notify users with `visaStatus: sponsorship_needed`** — surface in the table; operator inspects.

## Verification (zero regression)

- `apps/job-rec` tests: **161/161 pass** (was 161; unchanged — phase did not add tests there)
- `apps/functions` tests: **351/351 pass** (was 345; +6 new in `paReverseMatch.test.ts`)
- `apps/dashboard-web` tests: **11/11 pass** (was 7; +4 new in `MatchCandidates.test.ts`)
- `pa-functions` typecheck: clean
- `pa-job-rec` typecheck: clean
- `pa-dashboard-web` typecheck: clean

```bash
cd apps/job-rec && npm test            # 161 ok
cd apps/functions && npm test          # 351 ok
cd apps/dashboard-web && npx tsx --test src/pages/__tests__/MatchCandidates.test.ts src/pages/toolCallSummary.test.ts  # 11 ok

cd apps/functions && npx tsc --noEmit  # clean
cd apps/job-rec && npx tsc --noEmit    # clean
cd apps/dashboard-web && npx tsc --noEmit  # clean
```

## Latency budget

| Stage | Time | Notes |
|---|---|---|
| 1. Embed JD | ~200-500ms | OpenAI text-embedding-3-small |
| 2. Pool query (1k cap) | ~200ms | single Firestore where + limit |
| 3. Per-user signal load (50 cosine top) | ~600ms | 50 × parsedCandidateResumes + pa-users |
| 4. Cross-encoder rerank | ~800ms | SiliconFlow free tier |
| 5. Hard filter | <50ms | pure CPU |
| **Total** | **<2.5s p50** | < **3s** brief target |

Bottleneck is N parallel reads at step 3 (sequential today; could parallelize if needed). Acceptable for operator-driven flow.

## Out-of-scope follow-ups

- **Rate-limiting in CF**: per-JD, per-user, per-operator caps enforced server-side (today: operator discipline only).
- **Per-tenant flag**: surface to non-WeKruit recruiter clients with their own flag bucket (Stage 4 above).
- **Notify history**: surface "you already sent a reverse-match notify to this user N days ago" in the table.
- **Batch CV cache invalidation**: if a user updates their CV, the reverse-match might still rank them on the previous embedding. Not new — same staleness semantics as forward path; embeddings are recomputed lazily on next forward-path miss.
- **Outbound dedup by user×JD**: today, two operators clicking Notify for the same userId+JD will send 2 messages. Not enforced.

These belong in v1.6 hardening; current phase ships the user-visible flow.
