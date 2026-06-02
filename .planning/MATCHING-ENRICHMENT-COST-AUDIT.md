The references check out. The gate is at lines 70-83, write-back at 153-157, sponsorship at 95-106, createHash precedent confirmed at job-enrichment.ts:157. I have enough to write the doc accurately.

# Matching + Job-Enrichment Cost & Dedup Audit (2026-06-01)

**Repos in scope:** `wekruit-pa` (Cloud Functions / orchestrator), `wekruit-matching` (Python scraper + Postgres), `wekruit-core-service-cloud-function` (sync receiver).
**Constraint (Adam):** every fix in this doc must be **NON-BREAKING to matching correctness** — it may only change *when* we re-enrich, never the enrichment *output*, the hard/soft filters, or any candidate-facing match result.
**Status:** READ-ONLY audit. No code changed, nothing deployed. This is a plan.

---

## 1. Finding — recurring re-enrichment burn + dedup status

### 1a. The burn (confirmed)

Firestore probe, 2026-06-01:

| Metric | Value |
|---|---|
| `matching-jobs` total docs | **174,364** |
| `status === "active"` | **26,164** |
| enriched in last 24h | **6,270** |
| of 300 sampled 24h-enriched jobs: **OLD jobs RE-enriched** (`firstSeenAt` days/weeks before `enrichedAt`) | **294 / 300** |
| of that sample: genuinely new jobs | **6 / 300** |
| active docs already at `enricherVersion = v1.9.0` | **26,164 / 26,164 (100%)** |

Every active job is already fully enriched at the current version. Yet ~6,270 jobs/day are re-enriched, and **294/300 sampled (98%) were already-enriched OLD jobs being re-processed** — not new supply. Each re-enrichment fires **two** `gpt-5.4-nano` calls (`enrichJobTags` + `inferSponsorship`), ~1.2K input tokens each. So roughly **98% of daily enrichment LLM spend (~12K nano calls/day) is recurring waste** with zero change to match results.

This is a *cost* bug, not a correctness bug. The enrichment output is identical on re-run; we are paying to recompute the same answer.

### 1b. Is dedup broken?

**Partially.** Two distinct things must not be conflated:

- **Within-source re-scrapes: dedup is CORRECT.** The Postgres upsert key and the Firestore doc id are both `job_id = sha256(source_repo | normalize_company(company) | normalize_role(title))`, fully normalized (`id_utils.py:59-87`). Re-scraping the same role from the same source `UPSERT`s one Postgres row (`upsert.py:300`, `ON CONFLICT (job_id) DO UPDATE`) and `batch.set(doc(job.id), …, {merge:true})` one Firestore doc (`matchingJobRepository.ts:137`). No phantom dupes. URL was deliberately dropped from the id hash in v2 to kill jobright URL-rotation dupes (Walgreens "Shift Lead" had 13). Good.
- **Cross-source duplicates: dedup is BROKEN (latent, secondary).** `source_repo` is *inside* the doc-id hash, so the same role at the same company scraped from two sources (e.g. `greenhouse:acme` and a `jobright` mirror) yields **two** `job_id`s → two Postgres rows → two `matching-jobs` docs → enriched twice → can surface to one candidate twice. The intended cross-source key `compute_canonical_signature()` (`id_utils.py:154`) IS computed and shipped to Firestore as `canonical_signature` (`job_sync.py:76-81`) but is a **dead field** — the receiver `buildMatchingJobRecord` never reads it (`jobSync.ts:196-249`), and grep across all of `wekruit-pa` apps/packages found **zero** consumers of `canonical_signature` / `pa-job-canonical-signature`. `dedup_multi_source()` (`dedup.py:134`) collapses cross-source dupes only within a single in-memory batch and only on the senior/VC-board paths (`daily.py:357`), not the main Simplify/JobRight/YC paths (`run.py:71,104,150`).

**Crucial separation:** the 98% re-enrichment burn is **NOT caused by the dedup gap.** It is caused by `contentHash` churn (Section 2). The dedup gap is a real but smaller, separable issue. The 148K inactive docs (`total 174K − active 26K`) are status tombstones (`upsert.py:512-519`, "Never deletes rows"); they are excluded from enrichment (gate requires `status === "active"`, `auto-enrich-matching-jobs.ts:72`) so they do **not** drive LLM cost, though they inflate Firestore storage and a share of them are cross-source phantoms.

---

## 2. Root cause — volatile `contentHash` churn

The enrichment skip-gate keys off a content hash that is **sensitive to cosmetic title drift**. The chain, end to end:

1. **Scraper computes `content_hash` from a RAW title.**
   `content_hash = sha256( normalize_company_name(company) + sep + role_title.strip() )` — `id_utils.py:212-233`.
   Company is fully normalized (emoji-stripped, lowercased); `role_title` is passed **raw** (only `.strip()`). `normalize_role_title()` exists (`id_utils.py:90-107`) but is **deliberately applied only to `compute_canonical_signature`, NOT to `compute_content_hash`** (docstring `id_utils.py:183-187`). Every scraper passes the raw title (`jobright_github.py:156`, `jobright.py:311`, `parser.py:286`, `greenhouse_direct.py:245`).
   → Any cosmetic title change (emoji, case, punctuation, whitespace) flips `content_hash`, while `job_id` (fully normalized) stays stable → **a re-write of the same doc, not a new doc.**

2. **Postgres bumps the hash + nulls the enrich/embed stamps.**
   Upsert updates `content_hash` only on `IS DISTINCT FROM` (`upsert.py:315-319`), and a flip resets `enriched_at = NULL`, `embedding = NULL`, `embedded_at = NULL` (`upsert.py:315-339`), re-admitting re-embed + re-sync. Stage 2.5 ATS-resolve also deliberately bumps `content_hash` (`daily.py:532`).

3. **Receiver re-pushes the doc → fires the trigger.**
   `shouldUpsertMatchingJob` returns true when `existing.contentHash !== incoming.contentHash` (`jobSync.ts:252-269`), passes `content_hash` through verbatim (`jobSync.ts:201-204`), and `upsertJobs` does `batch.set(doc, job, {merge:true})` (`matchingJobRepository.ts:131-142`) → **`onDocumentWritten` fires.**

4. **Trigger sees the stale stamp → re-enriches.**
   `needsEnrichment` skips **only** when `enricherVersion === v1.9.0 AND enricherContentHash === contentHash` (`auto-enrich-matching-jobs.ts:70-77`). After a cosmetic flip, `enricherContentHash` (old) `!== contentHash` (new) → it re-runs `enrichJobTags` **and** (via `needsSponsorshipInference`, `:95-106`) `inferSponsorship`, then re-stamps `enricherContentHash = after.contentHash` (`:154`).

**The asymmetry is the waste engine:** `job_id` is normalized (stable), but `content_hash` is not. Cosmetic source drift on an already-enriched active job round-trips the full enrich + embed + sync pipeline. That is the 294/300 OLD-job re-enrichment pattern.

---

## 3. Fix #1 — STABLE SEMANTIC HASH in the trigger (PRIMARY, NON-BREAKING)

**Goal:** stop gating the trigger on the volatile upstream `contentHash`. Instead compute a **stable semantic hash inside the trigger** from the LLM-relevant inputs (normalized title + normalized company + JD body) and gate on that. This changes only *when* the trigger fires — never the `enrichJobTags` / `inferSponsorship` output, and never any filter or score. Pa-side only; no scraper, receiver, or Postgres change.

**File:** `apps/functions/src/auto-enrich-matching-jobs.ts`

**Exact edits:**

**(a)** Import `createHash` (precedent: `apps/functions/src/job-enrichment.ts:157` already uses `createHash("sha256")`):
```ts
import { createHash } from "node:crypto"
```

**(b)** Add module helpers near `ENRICHER_VERSION` (`:45`):
```ts
function normSemantic(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")  // non-letter/non-digit runs → space
    .replace(/\s+/g, " ")
    .trim()
}

function computeSemanticHash(doc: MatchingJobDoc): string {
  return createHash("sha256")
    .update(
      [
        normSemantic(doc.roleTitle),
        normSemantic(doc.companyName),
        (doc.jobDescription ?? "").trim(),
      ].join("\u0001"),
    )
    .digest("hex")
}
```
> Note: `jobDescription` is intentionally compared on its *trimmed* body (not normalized away) so a genuine JD change — including a real title change that is also reflected in the JD — still re-enriches. Pure cosmetic title/company drift with an unchanged JD body no longer fires.

**(c)** Add `enricherSemanticHash?: string | null` to the `MatchingJobDoc` interface (`:47-68`).

**(d)** Replace the gate in `needsEnrichment` (`:74-77`):
```ts
// BEFORE
if (
  doc.enricherVersion === ENRICHER_VERSION &&
  doc.enricherContentHash === doc.contentHash
) {
  return false
}
// AFTER
if (
  doc.enricherVersion === ENRICHER_VERSION &&
  doc.enricherSemanticHash === computeSemanticHash(doc)
) {
  return false
}
```

**(e)** In the write-back `update` object (`:153-154`) keep `enricherContentHash` (for observability + rollback) and **add** the new stamp:
```ts
enricherContentHash: after!.contentHash ?? null,   // KEEP — rollback/observability
enricherSemanticHash: computeSemanticHash(after!),  // NEW — the real gate
```

**(f)** Apply the same `enricherSemanticHash` skip-stamp logic to sponsorship: in `needsSponsorshipInference` (`:95-106`) the dominant re-fire today is the null-sponsorship cohort (a `null` verdict never sets `sponsorshipBackfilledAt`, so it re-pays every write). Gate it on the same semantic hash: persist `sponsorshipSemanticHash = computeSemanticHash(after)` even on a `null` verdict, and in `needsSponsorshipInference` also `return false` when `doc.sponsorshipSemanticHash === computeSemanticHash(doc)`. A real JD-body change invalidates the hash and re-infers, so newly-added explicit sponsorship language is still captured.

**Behavior on first deploy:** every active doc lacks `enricherSemanticHash`, so it re-enriches **once** (a bounded, expected one-time pass over ~26,164 docs), then stops churning on cosmetic drift forever after. `enricherContentHash` remains written, so rollback = revert the gate to the old comparison with zero data migration.

**Breaking risk: NONE to matching correctness.** Only the *fire decision* changes. `enrichJobTags`/`inferSponsorship` outputs, every hard filter (role/visa/location/seniority/freshness/URL), and every soft score are untouched. A genuine title change reflected in the JD still re-enriches via the JD-body component.

**Expected impact:** daily enrichment drops from ~6,270 → ~6 genuinely-new + real-content-change jobs/day, eliminating ~98% of recurring enrichment LLM spend (and, because sponsorship is co-gated, ~2× the per-job audited cost).

---

## 4. Fix #2 — DEDUP (cross-source is broken; within-source is correct)

**Confirmed:** within-source dedup is correct (Section 1b) — no action. **Cross-source dedup is broken** and is a separate, lower-priority issue (it inflates docs and risks showing a candidate the same role twice; it is *not* the 98% burn driver).

Two options. Choose **Option B** — it is the NON-BREAKING path because `job_id`s stay stable.

- **Option A (NOT recommended now):** move `source_repo` out of the doc-id key and use `canonical_signature` (company | role | location, source-independent) as the upsert/doc key, merging `sources[]` into one row. **High risk:** doc-id change ripples to recommendations, saved jobs, and feedback FKs (the same FK pain already visible in `scripts/dedupe_jobs.py`). Defer.
- **Option B (recommended, NON-BREAKING):** build the consumer the code already promises. The receiver maintains a `pa-job-canonical-signature/{sig}` Firestore index. On write, if a signature already maps to an active `job_id`, mark the new doc `canonicalDuplicateOf = <primary jobId>` (additive field; do **not** delete or change ids). Then at match time, `query-matching-jobs-v16` de-dupes the result set by `canonical_signature` (keep the freshest/primary, drop `canonicalDuplicateOf` rows). This (i) stops a candidate seeing the same role twice and (ii) lets us skip enrichment on a doc already enriched under its canonical primary (extra enrichment savings). Additive index + read-side filter, no id change → low-medium risk.

**Sequencing note:** Option B is **independent of Fix #1** and must not block it. Ship Fix #1 first (the cost lever), then Option B.

---

## 5. Fix #3 — LAZY / ACTIVE-ONLY enrichment + daily BUDGET CAP (backstop)

Fix #1 removes the *cause* of the spike. Fix #3 is a **backstop** so cost cannot re-spike if a new churn vector appears upstream. Two parts, both non-breaking.

**5a. Active-only + lazy is already partly in place — keep and assert it.** The gate already requires `status === "active"` (`:72`), so the 148K tombstones never enrich. Match-time also has inline scoped enrichment for empty-`roleFunction` jobs (`enrich-job-tags-http.ts:46-96`, role-bucket scoped, capped 3000 — `query-matching-jobs-v16.ts:2871-2929`), so recall does not depend on the background trigger having already run. **Action:** add a unit test asserting `needsEnrichment` returns `false` for `status !== "active"` and for a doc whose `enricherSemanticHash` matches — i.e. lock the lazy/active-only contract against regression.

**5b. Daily BUDGET CAP in the trigger (backstop only).** Add a per-day counter doc (e.g. `pa-enrich-budget/{YYYY-MM-DD}` with `{count}`), incremented transactionally on each real enrichment. Past a configured ceiling (e.g. 2× the genuine new-supply baseline, ~1–2K/day), **defer** enrichment for jobs whose `roleFunction` bucket is **not** in the live-user `targetRoleFunction` union (cache the union; refresh hourly). **Always** enrich when the job's `roleFunction` intersects the active-user union, and **fail-open** on any counter/union read error (never block a genuinely-needed enrichment). This guarantees a hard ceiling on daily spend that prioritizes the buckets real users actually query, so recall for active users is unaffected.

**Breaking risk:** low — fail-open design; a stale union only *defers* (never drops) background-bucket enrichment, and match-time inline enrichment still fills `roleFunction` on demand for any job a real query touches.

---

## 6. Other LLM cost surfaces (provider + recurrence)

The audited tag call is not the only spend. Ranked by likely $/day; **the top item is the co-located dual burn fixed by Fix #1**:

| # | Surface | Provider / model | Per | Recurrence / gate | Notes |
|---|---|---|---|---|---|
| 1 | **`inferSponsorship`** (co-located in auto-enrich trigger) | Anthropic Sonnet → **OpenAI gpt-5.4-nano** → SiliconFlow Qwen | per job | **Re-fires on every re-scrape `contentHash` change AND whenever `sponsorship` is null** (`auto-enrich-matching-jobs.ts:95-106`; `lib/sponsorship-inference.ts:285-319`) | This is the **2nd** nano call/job → ~2× the audited burn. **Co-gated by Fix #1 (e).** |
| 2 | **`enrichJobTags`** (the audited call) | **OpenAI gpt-5.4-nano** → sonnet-4-6 → gpt-4.1-mini | per job | Same gate; the 98% churn (`router.ts:34-38`) | Fixed by Fix #1. |
| 3 | CV embedding at cv-ingest | **OpenAI text-embedding-3-small** | per candidate | Per-CV at ingest / re-parse (`lib/embeddings.ts:189-254`) | ~$0.0001/CV; per-candidate, **not** per-job. Not driven by job re-scrape. |
| 4 | Per-rec nuanced reason | **OpenAI gpt-5.4-nano** → sonnet-4-6 → gpt-4.1-mini | per visible rec (top-2) | Per `find_match` (`orchestrator-deps.ts:367-484`; `lib/match-nuanced-reason.ts:14`) | Scales with user activity, not job count. |
| 5 | Nightly-rerank JD-rel weight sub-step | Anthropic Sonnet → OpenAI nano → Qwen | top-10 jobs/user | Idempotent: 23h skip-fresh + 20d window (`nightly-rerank.ts:82-96`; `lib/jd-relative-weights.ts:11-22`) | Bounded. |
| 6 | Nightly-rerank main rerank | **SiliconFlow Qwen2.5-7B** (free tier) | per user batch | Nightly (`nightly-rerank.ts:51-56`) | Near-zero $. |
| 7 | Fire-and-forget `llmRerank` precompute in `find_match` | **SiliconFlow Qwen** (free) | per find_match | Lazy-imported off live path (`orchestrator-deps.ts:636-642`) | Near-zero $. |
| 8 | `enrich-companies-nightly` | Anthropic claude-sonnet-4-6 + web_search (max 3) | per distinct company | **WEEKLY** (Tue 04:00 UTC), 30d-stale gated, last-resort tier (`enrich-companies-nightly.ts:483-514,68`) | Per-company, not per-job; bounded. |
| 9 | `experience-extractor` trigger | OpenAI gpt-5.4-nano per work-entry | per work-entry | **FLAG-OFF** — `PA_EXPERIENCE_EXTRACTOR_LIVE` unset (`experience-extractor-trigger.ts:84-86`; `index.ts:270-272`) | **Zero spend** today. |
| 10 | `paReverseMatch` | OpenAI text-embedding-3-small + SiliconFlow rerank | per match | Admin flag-OFF, default 503 (`paReverseMatch.ts:70-116`) | **Zero recurring $.** |

**Takeaway:** Fix #1 addresses #1 and #2 — the only two surfaces that scale with the job-re-scrape churn — i.e. the entire ~98% waste. Everything else scales with candidate/user activity or is already gated, weekly, free-tier, or flag-off.

---

## 7. Sequenced plan (P0 / P1 / P2) + guardrail + verification

**Non-breaking guardrail (applies to every step):** a change may only alter *when* enrichment fires. It must not change `enrichJobTags`/`inferSponsorship` output, any hard filter, any soft score, or any candidate-facing result. `enricherContentHash` stays written at every step so rollback is a one-line gate revert with no data migration. All gates fail-open.

### P0 — Stable semantic hash gate (Fix #1) — the cost lever
- Implement §3 (a)–(f) in `auto-enrich-matching-jobs.ts` (single file) + co-gate sponsorship.
- Add/adjust unit tests for `needsEnrichment` and `needsSponsorshipInference`: (i) cosmetic title drift with unchanged JD body → **skip**; (ii) real JD-body change → **re-enrich**; (iii) `enricherVersion` bump → re-enrich; (iv) `status !== "active"` → skip.
- `pnpm --filter pa-orchestrator test` green, then deploy `--only functions:pa-orchestrator:paMatchingJobsAutoEnrich`.
- Expect a **one-time** re-enrich pass over ~26,164 active docs (semantic stamp backfill), then steady-state collapse.

### P1 — Budget cap + active-only assertion (Fix #3, backstop)
- Add the daily counter doc + active-user `roleFunction`-union gate (§5b), fail-open.
- Add the lazy/active-only regression test (§5a).
- Ship after P0 has demonstrably flattened the daily count, so the cap never masks a P0 regression.

### P2 — Cross-source dedup, Option B (Fix #2)
- Build `pa-job-canonical-signature/{sig}` index in the receiver + `canonicalDuplicateOf` additive field + match-time de-dupe in `query-matching-jobs-v16`. No id change.
- Optional, later, cross-repo: normalize `compute_content_hash` inputs in `id_utils.py` behind a version prefix to stop churn one layer earlier (stops re-embed/re-sync, not just re-enrich). **Do not block P0–P2 on this** — it touches Postgres invalidation chains and case-sensitivity tests (`upsert.py:315-363`).

### Verification (run after P0 deploy + one full daily pipeline cycle)
1. **Primary metric — re-run the enriched-last-24h count.** Query `matching-jobs` where `enricherEnrichedAt >= now-24h`. **Expect a steep drop** from ~6,270 toward the genuine new-supply floor (single digits to low hundreds/day) once the one-time backfill pass clears. Persisting near ~6K = gate not effective → investigate.
2. **Sample-confirm composition.** Re-sample ~300 of the post-deploy 24h-enriched docs; expect the OLD-re-enriched share to fall from 294/300 toward ~0; remaining enrichments should be genuinely new (`firstSeenAt` within 24h) or real JD-body changes.
3. **Correctness regression (must be unchanged).** For a fixed set of test candidates, run `find_match` before vs after; assert identical recommended `job_id`s, ranks, and reasons — proving the gate change did not move any match result.
4. **Backstop check (after P1).** Confirm the daily counter never trips under steady state; force a synthetic churn burst in a test and confirm active-user-bucket jobs still enrich while background buckets defer, and that a counter-read failure fails open.
5. **Cost confirmation.** Compare daily `gpt-5.4-nano` call volume (enrich + sponsorship) week-over-week; expect ~98% reduction in the enrichment surface.
