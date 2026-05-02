# v1.5 Stream-I — Startup-vs-corp scoring boost (Phase 43.5)

**Status**: Shipped behind `paStartupBoostEnabled` flag (default OFF).
**Owner**: P7-I (under P8 stream-management).
**Spec**: D10 in `.planning/MILESTONE-v1.5-friend-companion.md` + Adam directive
2026-05-02 — "a user is more matched to a startup if the user prefer startup
and has start up group, and stronger than someone who doesn't have startup
experience".

---

## What ships

A pure-heuristic, multiplicative-weight boost layer applied AFTER the H10
cross-encoder rerank and BEFORE the H7 title anti-bias rerank in
`runDailyJobRecBatch`. Zero new LLM calls. Latency budget < 5ms over 100 jobs
(verified by unit test).

The boost uses two signals:

- **User signal** in `{-1.0, -0.5, 0.0, 0.5, 1.0}` derived from:
  - `pa-users/{userId}.statedPreferences.prefersStartup` (Phase 44 — v1.5
    Stream-B onboarding probe v2)
  - User's CV experiences (`parsedCandidateResumes/{latest}.experiences[]`)
    for lean-yes / strong-no fallback when stated prefs are absent.
- **Job signal** = `isStartupJob(job)` returning `true | false | null`:
  - FAANG/top-50 allowlist hit → `false` (not startup)
  - `companyEmployeeCount < 500` (Phase 39 enrichment) → `true`
  - Bilingual startup-keyword match (zh + en) on companyName/jobTitle → `true`
  - Otherwise → `null` (unknown — conservative no-boost)

---

## Tunable weights

Centralized in `apps/job-rec/src/cross-encoder-rerank.ts` as
`BOOST_WEIGHTS` CONST. Tuning requires code change + redeploy
(intentional — Adam directive: "weights are in CONST not Firestore" for
deterministic rollback).

| User signal × Job signal       | Multiplier | Constant                         |
|--------------------------------|-----------:|----------------------------------|
| Strong-yes (+1.0) × startup    | **×1.30**  | `BOOST_WEIGHTS.STRONG_YES_STARTUP` |
| Lean-yes (+0.5)  × startup     | **×1.15**  | `BOOST_WEIGHTS.LEAN_YES_STARTUP`   |
| Strong-no (-1.0) × FAANG       | **×1.20**  | `BOOST_WEIGHTS.STRONG_NO_FAANG`    |
| All other combinations          | **×1.00**  | `BOOST_WEIGHTS.NEUTRAL` (no-op)    |

**User signal derivation**:

| `statedPreferences.prefersStartup` | CV evidence                                | Resulting signal |
|------------------------------------|--------------------------------------------|-----------------:|
| `true`                             | (any)                                      | **+1.0** strong-yes |
| `false`                            | ≥1 experience at FAANG-allowlisted company | **-1.0** strong-no  |
| `false`                            | otherwise                                   | **-0.5** lean-no     |
| absent / `null`                    | ≥1 experience matching keyword OR <500 emp | **+0.5** lean-yes    |
| absent / `null`                    | no startup signal                           |  **0.0** neutral     |

---

## FAANG / top-50 allowlist

Defined as `FAANG_ALLOWLIST` (`Set<string>`, lowercased) in
`apps/job-rec/src/cross-encoder-rerank.ts`. ~80 hand-curated entries (NOT
LLM-generated — Adam directive). Categories:

- Big tech / FAANG: Google, Apple, Amazon, Meta, Microsoft, Netflix...
- Public-cap tech: Stripe, Snowflake, Databricks, OpenAI, Anthropic, Nvidia,
  Tesla, Uber, Airbnb, Shopify, Atlassian, ServiceNow, Salesforce, Coinbase...
- Legacy enterprise: IBM, Oracle, SAP, Cisco, Adobe, Intel, AMD, Qualcomm...
- Consulting / finance: McKinsey, Bain, BCG, Deloitte, Accenture,
  Goldman Sachs, JPMorgan, BlackRock, Citadel, Two Sigma...
- Other large-cap: Walmart, Disney, Comcast, AT&T, Boeing, Lockheed Martin...
- China big-tech: Alibaba, Tencent, ByteDance, Baidu, Meituan, JD.com,
  Pinduoduo, Didi, Kuaishou, Xiaomi, Huawei.

**Lookup is case-insensitive on a `.trim().toLowerCase()` companyName key**.

### How to add an entry

1. Edit `FAANG_ALLOWLIST` in `apps/job-rec/src/cross-encoder-rerank.ts`
2. Add the lowercased canonical name on its own line (no trailing comma issues
   — JS Set initializer is forgiving)
3. Add a regression test in `__tests__/cross-encoder-rerank.test.ts` if the
   entry is ambiguous (e.g. brand vs subsidiary)
4. Run `pnpm --filter @pa/job-rec test` — must stay green
5. Commit + ship behind existing flag (no flag change needed)

### Caveat — `companyEmployeeCount` enrichment

The startup detection's strong-confidence path requires
`matching-jobs/{id}.companyEmployeeCount`. This is a Phase 39 enrichment
field. **If the field is missing for a top job, only the keyword-bank path
fires** — which has lower recall. Action: when ramping the flag past 10%,
seed Phase 39 enrichment for the top-N companies in the active corpus
(consult Phase 39 owner). Until then, expect ~30-40% of jobs to fall into
the `null` (unknown) bucket, which is intentionally conservative no-boost.

---

## Bilingual startup keyword bank

Defined as `STARTUP_KEYWORDS: readonly RegExp[]`. ~20 entries:

**English** (`/i` flag, word-boundary anchored):
- `\bearly[- ]stage\b`
- `\bseries\s+(?:seed|pre[- ]?seed|a|b|c)\b`
- `\bseed\s+stage\b`
- `\bfounding\s+(?:engineer|team|member)\b`
- `\bfounder['']?s\s+office\b`
- `\bwe['']?re\s+hiring\s+our\s+first\b`
- `\bstealth\s+(?:mode|startup)\b`
- `\byc\s+w\d{2}\b` / `\byc\s+s\d{2}\b`
- `\b(?:y\s+combinator|y-combinator)\b`

**Chinese** (no `/i` — Chinese has no case):
- `创业` / `早期` / `初创` / `我们刚拿到融资`
- `种子轮` / `天使轮` / `A\s*轮` / `B\s*轮`
- `创始团队` / `创始工程师`

Matched against `companyName` and `jobTitle` fields. Cheap (~20-entry regex
bank, sub-millisecond per job).

---

## Feature-flag rollout plan

**Flag key**: `paStartupBoostEnabled` (default **OFF**).

**Ramp**:
1. Internal test cohort (1 user, you/Adam) → verify daily-push body changes
   only for stated/CV-startup-pref users
2. 1% live (Firestore `feature_flags/paStartupBoostEnabled.allowlist`) →
   monitor `boost.applied` log volume vs daily-push delivery count
3. 10% → check no spike in `startup_boost_threw_fallback`; observe whether
   click-through differs vs control
4. 50% → if metrics look good
5. 100% → canonical default

**Rollback**: flip flag OFF. The wired code at the cross-encoder→H12 boundary
short-circuits at the flag check (zero overhead added when off, byte-identical
ordering). Weights also live in code-CONST so reverting the commit is a clean
rollback path.

---

## Files modified

- `apps/job-rec/src/types.ts` — added `MatchingJobSchema.companyEmployeeCount?: number | null`
- `apps/job-rec/src/cross-encoder-rerank.ts` — appended Stream I module
  (~290 lines): `FAANG_ALLOWLIST`, `STARTUP_KEYWORDS`, `BOOST_WEIGHTS`,
  `isFaangCompany`, `isStartupJob`, `userPreferStartup`, `computeStartupBoost`,
  `applyStartupBoost`, types `UserStartupSignal`, `CvExperience`,
  `BoostExplanation`
- `apps/job-rec/src/daily-batch.ts` — wired boost between cross-encoder and
  H12 dedupe; added `STARTUP_BOOST_FLAG_KEY`; extended `DailyPushContext`
  with `boostExplanations?: BoostExplanation[]`; capture cross-encoder scores
  into `crossEncoderScores: Map<string, number|null>` to feed into the boost
  as `baseScores`
- `apps/job-rec/src/__tests__/cross-encoder-rerank.test.ts` — appended 12
  new tests (8 spec + 4 integration coverage)

## Tests

- 8 spec tests per task brief (Stream I — startup-vs-corp boost block)
- 4 integration tests (Stream I — applyStartupBoost integration block):
  flag-off identity / strong-yes reorder / baseScores integration / latency
- All 140 `@pa/job-rec` tests green; no regression
- Latency budget (< 5ms over 100 jobs) verified by unit test

## Constraints honored

| Constraint | Verified |
|------------|----------|
| ZERO new LLM calls | Yes — pure regex + Set lookup |
| Latency < 5ms over 100 jobs | Yes — unit test asserts |
| ZERO regression flag-off | Yes — flag-default OFF + zero-impact short-circuit + 140/140 tests green |
| FAANG allowlist hand-curated, ~80 entries | Yes — 80+ entries, no LLM in source |
| Allowlist + weights in CONST not Firestore | Yes — `FAANG_ALLOWLIST` Set + `BOOST_WEIGHTS` CONST |
| Bilingual zh/en symmetric | Yes — keyword bank covers both |

## Tech debt / future

- `companyEmployeeCount` Phase 39 enrichment coverage (see caveat above)
- D2 (LLM match-explainer, Phase 42) is the natural consumer of
  `DailyPushContext.boostExplanations` — formatter integration is a follow-up
  P7 task (wired but not yet rendered into push copy)
- Allowlist drift: as IPOs / acqui-hires happen, the allowlist needs
  maintenance. Recommend quarterly review by P8.
