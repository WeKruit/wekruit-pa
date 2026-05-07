# Wave 2 P7 Task Prompts (DRAFT — P10 will spawn after Wave 1 deliverables land)

> Wave 1 dependencies (must exist before Wave 2 spawns):
> - `packages/pa-orchestrator/src/onboarding/questions.ts` — exported
>   `Q_COUNTRY`, refactored `Q_LOCATION` `Q_VISA`, `ONBOARDING_QUESTIONS_V2`
> - `packages/pa-orchestrator/src/onboarding/judges/guided-open.ts` — `GuidedOpenJudge`
> - `packages/pa-orchestrator/src/onboarding/discussion-phase.ts` — abstract
> - `packages/pa-orchestrator/src/onboarding/discussion-resume.ts` — `ResumeDiscussionPhase`

---

## P7-4: Main dispatcher rewire (REPLACE legacy if/else with pipeline.runTurn)

P7-4 Senior Engineer. Adam directive: 删 1700-line if/else dispatcher in
`onboarding-deterministic.ts`. Replace with `pipeline.runTurn(QUESTIONS_V2,
state, reply)`. Hand off to ResumeDiscussionPhase when state hits processing.

### MUST READ
1. `.planning/GOAL-onboarding-refactor.md` (full spec)
2. `packages/pa-orchestrator/src/onboarding-deterministic.ts` (1900 lines, the legacy you're replacing)
3. `packages/pa-orchestrator/src/onboarding/pipeline.ts` (existing `pipeline.runTurn` — leverage)
4. `packages/pa-orchestrator/src/onboarding/questions.ts` (Wave 1 P7-1 deliverable — your input)
5. `packages/pa-orchestrator/src/onboarding/discussion-resume.ts` (Wave 1 P7-3 deliverable — your input)
6. `packages/pa-orchestrator/src/onboarding.ts` (legacy — DELETE: `userAnsweredStep`, `canonicalize*`, `parse*Answer`, `LOCATION_CANONICAL_MAP`)

### Task scope
1. Rewrite `runDeterministicOnboardingTurn(input)` body:
   - load `ONBOARDING_QUESTIONS_V2` from questions.ts
   - construct `ResumeDiscussionPhase` with deps wired from `store`
   - dispatch:
     - if state in phase.processingState → `phase.onMessageWhileProcessing(input)`
     - if event has attachment → `phase.onArtifactReceived(input)`
     - else → `pipeline.runTurn(QUESTIONS_V2, state, reply, ctx)`
2. Migrate `cv-parsed` synthetic event handler → `phase.onWorkComplete(input, result)`
3. DELETE legacy regex parsers from `onboarding.ts`:
   - `userAnsweredStep`, `canonicalizeRole`, `canonicalizeLocations`,
     `canonicalizeStartupPref`, `parseVisaAnswer`, `parseLocationAnswer`,
     `parseRoleAnswer`, `parseYoeAnswer`, `LOCATION_CANONICAL_MAP`
   - Keep type re-exports if needed (tests may still import `CanonicalLocation` etc — replace with new types from questions.ts)
4. DELETE 600+ lines of regex dispatch in `onboarding-deterministic.ts`

### DOD
1. ✅ tsc compiles 0 errors across pa-orchestrator + apps/functions
2. ✅ existing onboarding-deterministic.test.ts pass (refactor existing tests if API changes)
3. ✅ no `userAnsweredStep` symbol exists in repo (verify: `grep -r userAnsweredStep src/`)
4. ✅ no `canonicalize` symbol in onboarding.ts (verify: `grep canonicalize onboarding.ts | wc -l` returns 0)
5. ✅ Bug A v2 (Firestore tx dedup) preserved via DiscussionPhase pattern
6. ✅ State machine extended: q_resume_processing + q_resume_done in OnboardingState

---

## P7-5: Layer 1 unit tests (per-Q isolated, LLM stubbed)

P7-5 Senior Engineer. Adam directive: each Q gets unit test, ≥110 cases total.

### MUST READ
1. `.planning/GOAL-onboarding-refactor.md` Layer 1 section
2. `packages/pa-orchestrator/src/onboarding/questions.ts` (Wave 1 P7-1)
3. `packages/pa-orchestrator/src/onboarding/judges/guided-open.ts` (Wave 1 P7-2)
4. existing `judges/__tests__/email-judge.test.ts` (pattern to follow)

### Task scope
CREATE 11 test files in `packages/pa-orchestrator/src/onboarding/__tests__/`:
- `q-lang.test.ts` ≥10 cases (exact_match: english/chinese/mixed + variants)
- `q-email.test.ts` ≥10 cases (valid email + typo + decline + nonsense)
- `q-email-verify.test.ts` ≥6 cases (6-digit code exact + variant)
- `q-tos.test.ts` ≥8 cases (agree/decline + nuanced "yes" / "no thanks")
- `q-role.test.ts` ≥12 cases (engineer/PM/data/ml/free-form/typo)
- `q-yoe.test.ts` ≥10 cases (number/fresh/typo/range/zh)
- `q-visa.test.ts` ≥12 cases (citizen/GC/OPT→sponsor/H1B→sponsor/decline)
- `q-startup-pref.test.ts` ≥8 cases (startup/bigtech/either)
- `q-country.test.ts` ≥10 cases (USA/中国/anywhere/multi/typo)
- `q-location.test.ts` ≥15 cases — INCLUDES Adam pain points:
  - "Bay Area" → ["sf"]
  - "sfran or nYC works" → ["sf","nyc"] (typo + multi)
  - "Everywhere is fine" → ["anywhere"]
  - "都行" → ["anywhere"]
  - "SF or NYC or remote" → ["sf","nyc","remote"]
  - "看机会" → unclear
- `q-resume.test.ts` ≥4 cases (gate logic)

LLM stubbed via `clientFactory` injection. Real LLM only in Layer 3.

### DOD
1. ✅ ≥110 cases total (count via `grep -c "test(" __tests__/q-*.test.ts | awk -F: '{s+=$2} END {print s}'`)
2. ✅ All Adam pain-point fixtures included with correct expected values
3. ✅ 100% pass — `pnpm --filter pa-orchestrator test`
4. ✅ NO real LLM calls in Layer 1 (stub only)

---

## P7-6: Layer 2 simulation tests (state machine real, LLM stubbed)

P7-6 Senior Engineer. Adam directive: simulate full conversation segments,
verify state transitions + re-ask rotation + DiscussionPhase async hold.

### MUST READ
1. `.planning/GOAL-onboarding-refactor.md` Layer 2 section
2. `packages/pa-orchestrator/src/onboarding/pipeline.ts`
3. `packages/pa-orchestrator/src/onboarding/discussion-resume.ts` (Wave 1 P7-3)
4. existing `pipeline.test.ts` (pattern)

### Task scope
CREATE 8 sim test files in `packages/pa-orchestrator/src/onboarding/__tests__/sim/`:

1. `sim-cold-start.test.ts` — pending → first_mes → q_lang_asked
2. `sim-q-chain-happy.test.ts` — full chain happy path: lang → email → email_verify → tos → role → yoe → visa → startup → country → location → resume_asked
3. `sim-q-chain-typo.test.ts` — each Q gets 1 typo'd reply, must auto-recover via LLM intent (mocked)
4. `sim-q-chain-invalid.test.ts` — each Q gets 1 nonsense reply, must re-ask + advance after retry
5. `sim-tos-decline.test.ts` — decline path
6. `sim-resume-async.test.ts` — attachment → ack → wait msg "稍等" → cv-parsed → analysis → handover
7. `sim-discussion-hold.test.ts` — while q_resume_processing, user msg → hold reply (NOT duplicate ack — Bug A regression)
8. `sim-country-then-location.test.ts` — q_country=USA → q_location must NOT offer China in re-ask hints

### DOD
1. ✅ 8 sim files compile + pass
2. ✅ Re-ask rotation verified: ≥3 distinct phrasings used across 3 retries (no repeat)
3. ✅ q_country=USA → q_location hints filtered (no Shanghai/Beijing in re-ask)
4. ✅ DiscussionPhase: ack-then-async-then-analysis sequence asserted; mid-process user msg → "稍等" hold (not duplicate ack)
5. ✅ State transitions verified per acceptance criteria #6, #7, #8, #9 in GOAL
