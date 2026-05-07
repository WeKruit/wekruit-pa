# Onboarding Refactor — GOAL Document

> **P10 CTO directive 2026-05-07** — Adam ask: 整体重构 deterministic
> question class + discussion phase pattern. NO patches. Sub-agent team
> parallel work. All-in-one PR.

---

## Why we're rewriting

Current code has 4 parallel paths doing the same thing:

1. `userAnsweredStep(regex)` — bool gate (is reply valid?)
2. `parseUserAnswerForStep(regex)` — extract value
3. `canonicalizeRole/Locations/...(regex array)` — map to canonical token
4. `extractAnswerIntent(LLM)` — fallback when regex fails

Every new user phrasing breaks one of the regex paths and we patch it. Real
example bugs found today:
- `"Everywhere is fine"` → `userAnsweredStep` returns false → re-ask
- `"In USA is good"` → falls through to `["other"]` → re-ask, China listed
- `"sfran or nYC works"` (typo + multi-city) → can't parse → re-ask
- `OPT` listed as separate visa option from `sponsorship` even though
  D4 says `OPT/CPT/H1B → sponsorship_needed`

**Adam's bottom line: regex is bloom filter only. LLM must be primary.**

---

## What we ship (Goals)

### G0. EXISTING INFRASTRUCTURE — REUSE, do NOT duplicate

**iter34 P1 already shipped** (`packages/pa-orchestrator/src/onboarding/question.ts` 175 lines, `questions.ts` 440 lines):
- `Question<TAnswer>` interface with: Judge / Rephraser / onAccepted / onDeclined / maxAttempts / haltMessage
- `makeQuestion<TAnswer>(spec)` factory
- `JudgeResult<TAnswer>` discriminated union: accept | irrelevant | unclear | declined | typo
- `pipeline.ts` orchestrator with re-ask rotation, attempt cap, halt-at-N
- Existing judges: `EmailJudge`, `CodeJudge`, `LLMRelevanceJudge`, `YesNoJudge`, `ResumeJudge`
- Existing rephrasers: `StaticVariantsRephraser`, `LLMRephraser`, `HybridRephraser`

**Status**: class abstraction exists but NOT wired into main dispatcher — `onboarding-deterministic.ts` still has 1700-line if/else legacy.

**P10 directive for P9**:
1. **EXTEND existing `Question<TAnswer>`** — don't write a parallel "DeterministicQuestion" class
2. **ADD a `GuidedOpenJudge`** to `judges/` — LLM-first with optional bloom regex (Adam directive: bloom only for cost-skip, never blocks)
3. **EXTEND `questions.ts`** — add `q_country`, refactor `q_location` (drop OPT-as-separate from q_visa per D4)
4. **WIRE `pipeline.runTurn()` into `onboarding-deterministic.ts`** main dispatcher — REPLACE the legacy if/else flow
5. **DELETE legacy regex** in `onboarding.ts`: `userAnsweredStep`, `canonicalize*`, `parseXxxAnswer`, `LOCATION_CANONICAL_MAP`

### G1. `Question<TAnswer>` (REUSE — extended for new Qs)

Class shape already in place. Add 2 new question instances + 1 new judge type:

```ts
class DeterministicQuestion<TValue> {
  // identity
  readonly id: QuestionId
  readonly askedState: OnboardingState
  readonly nextStateOnAnswered: OnboardingState

  // prompts (lang variants)
  readonly prompts: Record<"en"|"zh"|"mixed", string>
  readonly reAsks: Record<"en"|"zh"|"mixed", readonly string[]>  // ≥3 variants

  // answer contract — only TWO modes
  readonly mode:
    | { kind: "exact_match", values: readonly string[] }      // verify_code, TOS only
    | { kind: "guided_open", hints: readonly string[] }       // everything else

  // few-shot for LLM (used in guided_open mode)
  readonly examples: readonly { reply: string, value: TValue }[]

  // bloom filter — OPTIMISTIC ONLY (Adam: "击中 OK 没击中 LLM 不能卡")
  readonly bloomRegex?: readonly { pattern: RegExp, value: TValue }[]

  // single resolver entry
  async resolve(reply: string, lang: Lang, ctx: ResolveCtx): Promise<AnswerResult<TValue>>

  // persistence — single contract, no duplicate writers
  applyToPrefs(value: TValue, prefs: StatedPreferences): StatedPreferences
  applyToTags(value: TValue, tags: UserTags): UserTags
}
```

`resolve()` execution order:
1. **noise filter** (empty / pure punctuation / `__PA_RESET__`) → skip LLM
2. **`exact_match`** mode: case-insensitive trim+compare. No LLM.
3. **`guided_open`** mode:
   - try `bloomRegex` for cheap match → return early if 100% confident
   - else call LLM (`callWithFallback` Qwen primary) with `mode.hints` + `examples` + reply
   - confidence ≥ 0.6 + value parses → `{intent: "provided", value, source: "llm"}`
   - else → `{intent: "unclear", clarifyingQuestion}`

### G2. `DiscussionPhase` pattern (NEW — for resume + LinkedIn URL)

Adam directive: resume / LinkedIn URL are NOT deterministic questions.
They're **DiscussionPhase**: long-running async work + state=processing
gate + analysis-then-discuss flow.

```ts
abstract class DiscussionPhase {
  readonly phaseId: "resume" | "linkedin_url"  // extensible
  readonly entryStates: OnboardingState[]      // states that can enter this phase
  readonly processingState: OnboardingState    // e.g. q_resume_processing
  readonly completeState: OnboardingState      // e.g. q_resume_done

  // step 1: user provided artifact (PDF, URL) — kick async work + send wait message
  async onArtifactReceived(input: PhaseInput): Promise<void> {
    await this.sendImmediateAck(input)               // "got it, reading through..."
    await this.setState(input.userId, this.processingState)
    await this.kickoffAsyncWork(input)               // cv-ingest worker, LinkedIn scraper, etc
  }

  // step 2: while processing, user sends another message → polite hold
  async onMessageWhileProcessing(input: PhaseInput): Promise<void> {
    await this.sendHoldMessage(input)                // "稍等，一会就好"
  }

  // step 3: async work complete — send analysis + transition
  async onWorkComplete(input: PhaseInput, result: AsyncResult): Promise<void> {
    await this.persistAnalysis(input.userId, result) // memory + tags update
    await this.sendAnalysis(input, result)           // free-form discussion turn
    await this.setState(input.userId, this.completeState)
    // hand off to general agent runtime for further chat
  }

  // overrides per phase
  protected abstract sendImmediateAck(input): Promise<void>
  protected abstract kickoffAsyncWork(input): Promise<void>
  protected abstract persistAnalysis(userId, result): Promise<void>
  protected abstract sendAnalysis(input, result): Promise<void>
}

class ResumeDiscussionPhase extends DiscussionPhase { ... }
// future: class LinkedInDiscussionPhase extends DiscussionPhase
```

State machine extension (currently single `q_resume_asked`):
```
q_resume_asked      ← awaiting PDF (deterministic gate)
q_resume_processing ← PDF received, ack sent, cv-ingest running
q_resume_done       ← analysis sent, in chat mode
complete
```

### G3. `q_country` split from `q_location` (Adam directive 4)

Currently `q_location_asked` mashes country + region. Adam: 拆开。

New flow:
```
q_country_asked → user picks country (USA/China/Anywhere/multi)
q_location_asked → user picks city/region within that country
```

Each is its own `DeterministicQuestion`.

### G4. Files DELETED

These regex hells go away:
- `packages/pa-orchestrator/src/onboarding.ts`:
  - `canonicalizeRole`, `canonicalizeLocations`, `canonicalizeStartupPref`
  - `parseVisaAnswer`, `parseLocationAnswer`, `parseRoleAnswer`, `parseYoeAnswer`
  - `userAnsweredStep`
  - `LOCATION_CANONICAL_MAP`
- `packages/pa-orchestrator/src/onboarding-deterministic.ts`:
  - regex parser dispatch (~ lines 1100-1900)
  - 4-path duplication

### G5. Files CREATED + EXTENDED

CREATED (new):
- `packages/pa-orchestrator/src/onboarding/judges/guided-open.ts` — GuidedOpenJudge (LLM-first + bloom regex)
- `packages/pa-orchestrator/src/onboarding/discussion-phase.ts` — DiscussionPhase abstract base
- `packages/pa-orchestrator/src/onboarding/discussion-resume.ts` — ResumeDiscussionPhase impl
- `packages/pa-orchestrator/src/onboarding/__tests__/q-*.test.ts` (11 unit files)
- `packages/pa-orchestrator/src/onboarding/__tests__/sim/sim-*.test.ts` (8 sim files)

EXTENDED (existing):
- `packages/pa-orchestrator/src/onboarding/questions.ts` — add q_country, refactor q_location, update q_visa hints (no OPT-as-separate per D4)
- `packages/pa-orchestrator/src/onboarding/pipeline.ts` — add DiscussionPhase hand-off when state enters processing
- `packages/pa-orchestrator/src/onboarding-deterministic.ts` — REPLACE legacy if/else dispatch with `pipeline.runTurn()` call

DELETED (legacy):
- `packages/pa-orchestrator/src/onboarding.ts` regex parsers (canonicalizeRole/Locations/StartupPref, parseVisaAnswer, parseLocationAnswer, parseRoleAnswer, parseYoeAnswer, userAnsweredStep, LOCATION_CANONICAL_MAP)
- ~600 lines of regex-based dispatch in `onboarding-deterministic.ts`

### G6. Test contract — 3-LAYER PYRAMID (Adam directive)

**Layer 1 — Unit per Q (isolated, LLM stubbed)**

Each of the 11 questions gets ITS OWN test file. Test parsing in isolation:
feed `{q, reply, lang}`, assert `{intent, value, source}`. NO state machine,
NO Firestore, NO real LLM (stub returns canned). ≥10 fixture rows per Q
covering: clean cases / edge / typo / multi-value / declined / unclear.

```
src/onboarding/__tests__/
├─ q-lang.test.ts            ≥10 cases
├─ q-email.test.ts           ≥10 cases
├─ q-email-verify.test.ts    ≥6 cases (exact_match — 6-digit + variants)
├─ q-tos.test.ts             ≥8 cases (agree/decline + nuanced)
├─ q-role.test.ts            ≥12 cases (engineer/PM/free-form/typo)
├─ q-yoe.test.ts             ≥10 cases (number/fresh/typo/range)
├─ q-visa.test.ts            ≥12 cases (citizen/GC/OPT/CPT/H1B/sponsor/decline)
├─ q-startup-pref.test.ts    ≥8 cases
├─ q-country.test.ts         ≥10 cases (USA/China/Anywhere/multi)
├─ q-location.test.ts        ≥15 cases (city/region/typo/multi/anywhere — Adam pain points)
└─ q-resume.test.ts          ≥4 cases (gate logic)
```

Adam-verified pain points fixture (location):
```ts
["Everywhere is fine",        "anywhere"]
["In USA is good",            "usa_anywhere"]   // post-q_country=USA
["sfran or nYC works",        ["sf", "nyc"]]    // typo + multi
["都行",                      "anywhere"]
["Bay Area, NYC, or remote",  ["sf", "nyc", "remote"]]
```

**Layer 2 — Simulation per flow segment (LLM stubbed but state machine real)**

Walk multi-turn conversation segments. Test state transitions + value
persistence + re-ask rotation. Real `DeterministicQuestion` + `resolveAnswer`,
mock LLM, mock Firestore.

```
src/onboarding/__tests__/sim/
├─ sim-cold-start.test.ts          pending → first_mes → q_lang_asked
├─ sim-q-chain-happy.test.ts       q_lang → q_email → ... → q_location → q_resume
├─ sim-q-chain-typo.test.ts        each Q gets 1 typo'd reply, must auto-recover
├─ sim-q-chain-invalid.test.ts     each Q gets 1 nonsense reply, must re-ask + advance after retry
├─ sim-tos-decline.test.ts         decline path
├─ sim-resume-async.test.ts        attachment → ack → wait msg "稍等" → cv-parsed → analysis
├─ sim-discussion-hold.test.ts     while q_resume_processing, user msg → hold reply
└─ sim-country-then-location.test.ts q_country=USA → q_location must NOT offer China in re-ask
```

**Layer 3 — E2E (real LLM + real Firestore + deployed CF)**

```
apps/functions/scripts/e2e-onboarding-20-iter-v3.mjs (existing, extended)
  ITER=20 against deployed wekruit-5f89b
  randomly inject invalid replies at positions 2/4/6 of 1/4 iters
  measures: reset/onboard/mem/chat/recs/nuanced_reason_ok all green

apps/functions/scripts/e2e-real-machine-checklist.md (NEW)
  Adam manually iMessage:
    1. PA_RESET → English → "engineer" → "5" → "Need sponsorship" → "either" → "USA"
    2. q_location → "Everywhere is fine" → must accept (no re-ask)
    3. q_location reply 2 → "sfran or nYC works" → must extract sf+nyc
    4. PDF upload → ack → analysis → recs personalized to Tesla/projects
    5. CV-confirm reply "yeah looks right" → state advances + chat mode
```

**Coverage gate**:
- Layer 1: 100% pass, 0 skipped
- Layer 2: 100% pass with mock LLM
- Layer 3: 20/20 e2e + 5/5 real-machine checklist

**No PR ships unless all 3 layers green.**

---

## Org topology (sub-agent team)

```
P10 (me) — strategy + review only, NO code
  │
  ▼
P9 (tech-lead) — task prompts + integration coordination
  │
  ├─▶ P7-1 — class + table       (G1 questions-table.ts + question.ts)
  ├─▶ P7-2 — resolver             (G1 resolve-answer.ts + LLM via callWithFallback)
  ├─▶ P7-3 — DiscussionPhase      (G2 discussion-phase.ts + ResumeDiscussionPhase)
  ├─▶ P7-4 — main dispatcher      (G4 delete legacy + onboarding-deterministic.ts rewire)
  ├─▶ P7-5 — Layer-1 unit tests   (G6 11 test files, ≥110 cases, LLM stubbed)
  └─▶ P7-6 — Layer-2 sim tests    (G6 8 sim files, state machine + re-ask rotation)
  │
  ▼
P10 — verify integration + deploy + real-machine smoke
```

P7 sub-agents work in **parallel**. P9 ensures interfaces line up. P10 only
inspects final integration.

---

## Decisions LOCKED (no re-litigation)

| # | Decision | Source |
|---|---|---|
| L1 | LLM provider for resolve = **SiliconFlow Qwen-7B** (`callWithFallback` chain) | Adam yes |
| L2 | regex = **bloom filter only**, never blocks | Adam directive |
| L3 | `exact_match` mode = ONLY `q_email_verify`, `q_tos`. Tell user how to reply, case-insensitive | Adam directive |
| L4 | `q_country` split from `q_location` | Adam yes #2 |
| L5 | `DiscussionPhase` for resume; LinkedIn future case | Adam yes #3 |
| L6 | DiscussionPhase processing-state hold pattern: state=processing, user msg → "稍等" | Adam directive |
| L7 | All-in-one PR | Adam yes #4 |
| L8 | `OPT/CPT/H1B → sponsorship_needed` per CLAUDE.md D4 (visa prompt drops "OPT" listing) | Adam D4 |
| L9 | Sub-agent team parallel, P10 lead | Adam directive |
| L10 | Resume Discussion sends ack → async parse → analysis → matching probe → free chat | Adam directive |

---

## Acceptance criteria — 3-layer test pyramid (P10 won't sign off until ALL green)

### Layer 1 — Unit per Q (isolated)
1. ✅ ≥110 unit cases total (per-Q breakdown in G6)
2. ✅ Each Q has dedicated test file with declared fixture table
3. ✅ Adam-pain-point fixtures included: "Everywhere is fine", "In USA is good", "sfran or nYC works", "都行", multi-city
4. ✅ 100% pass, 0 skipped

### Layer 2 — Simulation per flow segment
5. ✅ 8 sim test files (cold-start, happy chain, typo chain, invalid chain, TOS decline, resume async, discussion hold, country→location coupling)
6. ✅ State machine transitions verified: each Q advances to `nextStateOnAnswered` only on valid answer
7. ✅ Re-ask rotation verified: ≥3 variants used across 3 retries (no repeat of same phrasing)
8. ✅ q_country=USA propagation: q_location re-ask never lists China when country locked to USA
9. ✅ DiscussionPhase resume: ack-then-async-then-analysis sequence verified; mid-process user msg → "稍等" hold

### Layer 3 — E2E + real-machine
10. ✅ All current legacy regex parsers deleted (no `userAnsweredStep`, no `canonicalize*`, no `parseLocationAnswer` etc)
11. ✅ All 11 questions route through `DeterministicQuestion` + `resolveAnswer`
12. ✅ E2E smoke 2/2 PASS post-deploy (existing v3 script extended)
13. ✅ E2E 20-iter PASS (real LLM, real Firestore, 1/4 iters with injected invalid replies)
14. ✅ Adam real-machine checklist 5/5 (per G6 Layer 3)
15. ✅ No regression on Bug A (dedup), Bug B (lang), Bug D (env-aliasing) — existing fixtures still pass
16. ✅ `nuanced_reason_ok` continues firing post-deploy (no env regression)
17. ✅ Production logs post-deploy: 0 `pa.match.nuanced_reason_failed`, 0 `pa.onboarding.deterministic.cv_wait` >1 per attachment

---

## Adam ACK gates

P10 will pause and ask Adam at:

1. **Now**: this GOAL doc — review, edit, lock
2. **After P9 design draft** (TASK_PROMPTS.md): review task prompts before P7 spawn
3. **After P7s deliver code, before deploy**: code review + tests pass demo
4. **After deploy + smoke**: real-machine test by Adam (PA_RESET → English → CV → "Everywhere is fine" → recs → personalized reasoning citing Tesla)

---

## File structure (final state)

```
packages/pa-orchestrator/src/
├─ onboarding/
│  ├─ question.ts              [NEW] DeterministicQuestion class
│  ├─ questions-table.ts       [NEW] 11 Q instances + closed type registry
│  ├─ resolve-answer.ts        [NEW] LLM-first resolver + bloom filter
│  ├─ discussion-phase.ts      [NEW] DiscussionPhase abstract base
│  ├─ discussion-resume.ts     [NEW] ResumeDiscussionPhase impl
│  ├─ pipeline.ts              [keep] state machine
│  ├─ runtime-bridge.ts        [keep]
│  ├─ state-firestore.ts       [keep]
│  ├─ cv-poll.ts               [refactor] called from ResumeDiscussionPhase
│  └─ questions.ts             [DELETE — superseded by questions-table.ts]
├─ onboarding.ts               [refactor — delete regex parsers, keep type re-exports]
├─ onboarding-deterministic.ts [refactor — main dispatcher uses new resolver]
└─ ...
```

---

## Cost / risk

- **Cost**: each user reply now triggers 1 SiliconFlow Qwen call (~$0/call free tier). Bloom filter saves ~30% (cheap matches skip LLM).
- **Risk** (mitigated): LLM latency ~1-3s per reply → user perceives slight delay vs current regex (instant). Mitigation: keep bloom filter for trivial cases (`yes`/`no`/`5 years`/`sf`).
- **Rollback**: feature flag `paOnboardingV2Enabled` (default ON in stage, gradual ramp in prod).

---

## Estimate (fresh from sub-agent team)

| Phase | Owner | Time |
|---|---|---|
| 1. Spec lock + GOAL ACK | P10 + Adam | 15 min |
| 2. P9 task prompts | P9 | 30 min |
| 3a. P7-1..5 parallel impl | 5× P7 | 60 min wall |
| 3b. P7-tests parallel impl | 1× P7 (own context) | 60 min wall (concurrent w/ 3a) |
| 4. P9 integration + Layer 1+2 tests pass | P9 | 45 min |
| 5. P10 review + deploy | P10 | 30 min |
| 6. Layer 3 E2E + Adam real-machine | P10 + Adam | 45 min |
| **Total** | | **~3.5 hr wall** |

---

## P10 next action

Adam locks GOAL → P10 spawns `pua:tech-lead-p9` agent with this doc as input + task prompt template. P9 then spawns 5× P7. P10 watches.
