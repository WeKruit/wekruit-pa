# Ranking eval — precision@k / recall@k / NDCG@k (both directions)

Offline, deterministic, **$0** ranking-quality eval for the WeKruit matcher, in
**both** marketplace directions:

| Direction | Production seam driven | File |
|---|---|---|
| candidate → jobs | `queryMatchingJobsV16` (V16 single-source matcher) | `apps/job-rec/src/tools/query-matching-jobs-v16.ts` |
| job → candidates | `rankCandidatesForJob` (S5 two-way match) | `apps/job-rec/src/two-way-match.ts` |

It closes the "ranking metrics, both directions" eval gap: previously the only
quantitative match signal was the weekly QA's binary `top3Acceptable`
(candidate→jobs only).

## How it works

- A small **versioned golden dataset** of hand-authored personas + mock corpora
  lives in `goldens/`. Each query carries `relevantIds` — the result ids a
  human reviewer would consider a plausible top hit.
- candidate→jobs seeds an **in-memory Firestore** (`mock-firestore.mjs`, ported
  from the V16 unit-test mock) with the job corpus + the persona's
  `pa-users/{uid}.tags`, then runs the **real** `queryMatchingJobsV16`.
- job→candidates runs the **real** `rankCandidatesForJob` over the mock
  candidate pool.
- Cost is **$0** and the result is **deterministic**: the LLM rerank / jd-rel
  caches are simply absent, so the matchers degrade gracefully
  (`llmMatch=0`, `jdRel=1.0`) and ranking is driven entirely by the hard
  filters + the weighted skill/industry/relevant-tag/salary blend. `nowMs` is
  pinned so the `firstSeenAt < 20d` freshness window never drifts.
- `metrics.mjs` is a pure, dependency-free precision@k / recall@k / NDCG@k
  module (binary relevance) with its own unit tests in `metrics.test.mjs`.

### Metric semantics

- **precision@k** — relevant-in-top-k / **k** (denominator is always `k`, so a
  matcher that returns fewer than `k` results is penalised for empty slots).
- **recall@k** — relevant-in-top-k / total-relevant (1.0 when a query has no
  relevant items — nothing to find).
- **NDCG@k** — DCG@k / ideal-DCG@k with the standard `log2(rank+1)` discount;
  rewards ranking relevant items higher.

The job→candidates retrieval set = candidates surviving the deterministic hard
filters (`hardFilterResult !== "hard_block"`), ranked by `finalScore`. Hard-
blocked candidates (role / location / visa mismatch, opted-out) are correctly
suppressed and never count as a hit. We rank survivors by score rather than by
`recommendedAction` because the auto-outbound / hitl thresholds are calibrated
for the LLM-**present** production path; in this offline eval the LLM weight
(0.40) contributes 0, so an action-based cut would understate recall.

## Run it

```bash
source ~/.zshrc && nvm use 24

# Human report + pass/fail vs thresholds (informational; exits 0)
node apps/eval/ranking/run-ranking-eval.mjs

# Same, but exit 1 on any threshold violation (local gate / CI strict mode)
node apps/eval/ranking/run-ranking-eval.mjs --strict

# Machine-readable JSON (for dashboards / artifacts)
node apps/eval/ranking/run-ranking-eval.mjs --json

# Metrics unit tests
pnpm --filter @pa/ranking-eval test       # or: node --test apps/eval/ranking/metrics.test.mjs
```

The package also exposes scripts: `eval:ranking`, `eval:ranking:strict`,
`eval:ranking:json`. The root `pnpm eval:ranking` shortcut runs the strict gate.

### Thresholds

Macro-averaged (mean over queries) per direction. Defaults live in
`run-ranking-eval.mjs`; override per-metric via env, e.g.:

```bash
PA_RANKING_MIN_RECALL_5=0.95 PA_RANKING_MIN_NDCG_3=0.95 \
  node apps/eval/ranking/run-ranking-eval.mjs --strict
```

## Growing the dataset

The dataset is intentionally small (high-signal, fully labeled) so it stays
cheap to maintain and review. To grow it:

1. **Add a corpus item.** Append a job to `goldens/corpus-jobs.json`
   (`jobs[]`) and/or a candidate to `goldens/corpus-candidates.json`
   (`candidates[]`). Match the existing field shapes exactly — they mirror the
   real `matching-jobs` projection / `MatchingCandidateRow`. Use canonical
   vocab from `@wekruit/shared-tags` only (no abbreviations — D5). Use the
   `"{{FRESH}}"` / `"{{STALE}}"` placeholders for `firstSeenAt` (substituted by
   the runner relative to the pinned `nowMs`).
2. **Add a labeled query.** Append to `goldens/candidate-to-jobs.json`
   (a persona `tags` block + `relevantIds`) or `goldens/job-to-candidates.json`
   (an inline `job` + `relevantIds`).
3. **Keep judgments honest.** A `relevantId` must be a candidate that the
   deterministic hard filters will *survive* — role family, work authorization,
   location, career-stage (±1 ordinal window), freshness, and a present non-
   jobright ATS URL. If you label something relevant that the hard filter
   correctly drops, the eval will (rightly) show a recall miss. Either fix the
   judgment or fix the matcher — do not relax the metric to paper over it.
4. **Bump the version.** When you change goldens, update `datasetVersion`
   (currently `ranking-golden-2026-05-29`) in all four JSON files and the runner
   so report artifacts are attributable to a dataset snapshot.
5. **Re-run** `--strict` and re-tune thresholds in `run-ranking-eval.mjs` if
   the macro-average shifts for a legitimate reason (document why in the commit).

## CI

`.github/workflows/ranking-eval.yml` runs this as a **non-blocking,
informational** job (mirroring `eval.yml` style) on PRs touching matcher /
eval code, nightly, and on demand. It uploads the JSON report as an artifact.
It is intentionally not a required merge check.
