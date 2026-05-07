# TASK_PROMPTS — Onboarding Refactor (6 P7 fan-out)

> P9 → P7 task prompts. Drafted 2026-05-07.
> Feeds GOAL-onboarding-refactor.md (G1-G6, L1-L10, 17 acceptance).
> 6 P7s parallel, file-domain isolated, interface-contract gated.

## Topology + integration contract (read first)

```
P7-1 question.ts + questions-table.ts
        │ exports DeterministicQuestion class + 11 instances
        │ exports QuestionId, AnswerResult, Lang, ResolveCtx
        ▼
P7-2 resolve-answer.ts ─── (used INSIDE DeterministicQuestion.resolve())
        │ exports resolveAnswer(q, reply, lang, ctx) → AnswerResult
        ▼
P7-3 discussion-phase.ts + discussion-resume.ts ─── (handles q_resume_*)
        │ exports DiscussionPhase abstract, ResumeDiscussionPhase impl
        ▼
P7-4 onboarding-deterministic.ts rewire (consumes 1+2+3)
        │ delete legacy regex, route everything through DQ + ResumeDP
        ▼
P7-5 Layer-1 unit tests (depends on 1+2 interfaces)
P7-6 Layer-2 sim tests (depends on 1+2+3+4)
```

## Existing code map (P7s read first, do NOT re-invent)

- **`packages/pa-orchestrator/src/onboarding/question.ts`** — old `Question<T>` interface with Judge/Rephraser pattern (iter34 P1). **Replace with new `DeterministicQuestion` class** per GOAL G1.
- **`packages/pa-orchestrator/src/onboarding/questions.ts`** — 11 Q via Judge/Rephraser. **Delete + replace** with `questions-table.ts` (per GOAL G5).
- **`packages/pa-orchestrator/src/onboarding/judges/`** + **`rephrasers/`** — old pattern. P7-4 deletes consumers, P7-1 supersedes. Files DELETED at end (P7-4 owns delete).
- **`packages/pa-orchestrator/src/onboarding/pipeline.ts`** — `OnboardingPipeline` class operating on `Question<unknown>[]`. **Reuse philosophy** (state machine + halt + emit), refactor to consume new `DeterministicQuestion[]` + `DiscussionPhase[]`.
- **`packages/pa-orchestrator/src/onboarding/runtime-bridge.ts`** — production wiring (FirestoreStateProvider, applyOnboarding hooks). **Reuse**, swap construction call to new questions-table.
- **`packages/pa-orchestrator/src/onboarding/cv-poll.ts`** — kept; called from `ResumeDiscussionPhase`.
- **`packages/pa-orchestrator/src/onboarding/state-firestore.ts`** — kept (PipelineState provider).
- **`packages/pa-orchestrator/src/onboarding-deterministic.ts`** — 2097 LOC legacy dispatcher. **Reduce to ~400 LOC** thin wrapper that delegates to new pipeline + ResumeDiscussionPhase.
- **`packages/pa-orchestrator/src/onboarding.ts`** — 1486 LOC. **Delete** `canonicalize*`, `parseXxxAnswer`, `userAnsweredStep`, `LOCATION_CANONICAL_MAP`, `parseTosAnswer`, `parseEmailVerificationCode`. **Keep** type re-exports + step-name enum + first-mes config.
- **`packages/pa-resume-parser/src/router.ts:callWithFallback`** — 3-tier OpenAI/Anthropic chain. **NOT used for resolver** — Adam locked SiliconFlow Qwen-7B as resolver primary (L1). Pattern only — P7-2 builds a Qwen-first chain mirroring callWithFallback shape.
- **`apps/functions/src/orchestrator-deps.ts:makeExtractAnswerIntent`** (lines 920-1100) — current SiliconFlow Qwen call site for extract intent. **Pattern source** for P7-2 LLM client.
- **`packages/core-types/src/index.ts:OnboardingStateSchema`** — 13-state enum. **MUST extend** with `q_country_asked`, `q_resume_processing`, `q_resume_done` (P7-3 owns the schema add; P7-1 references the enum).

## Acceptance criteria mapping

| Criterion | Owner |
|---|---|
| 1-3 (≥110 unit cases, per-Q files, Adam-pain-points) | P7-5 |
| 4 (100% pass) | P7-5 |
| 5-6 (8 sim files, state transitions) | P7-6 |
| 7 (re-ask ≥3 variants, no repeat) | P7-1 (variants pool) + P7-6 (sim verify) |
| 8 (q_country=USA → q_location no China) | P7-3 (state propagation) + P7-6 (sim verify) |
| 9 (DiscussionPhase ack→async→analysis + hold) | P7-3 + P7-6 |
| 10 (legacy regex deleted) | P7-4 |
| 11 (all 11 Qs route through DQ.resolve) | P7-1 + P7-4 |
| 12-13 (E2E smoke + 20-iter) | P9 (post-integration) |
| 14-17 (real machine + Bug regression + nuanced_reason + logs) | P9 / P10 |

---

## P7-1 — DeterministicQuestion class + questions-table.ts (11 instances)

### WHAT — 交付物

- [ ] **`packages/pa-orchestrator/src/onboarding/question.ts`** REWRITTEN
  - export `class DeterministicQuestion<TValue>` per GOAL G1 (id, askedState, nextStateOnAnswered, prompts {en,zh,mixed}, reAsks {en,zh,mixed}: ≥3 variants, mode: exact_match | guided_open, examples, bloomRegex?, async resolve(reply, lang, ctx) → AnswerResult, applyToPrefs(value, prefs) → prefs, applyToTags(value, tags) → tags)
  - export type `QuestionId = "q_lang"|"q_email"|"q_email_verify"|"q_tos"|"q_role"|"q_yoe"|"q_visa"|"q_startup_pref"|"q_country"|"q_location"|"q_resume"`
  - export type `Lang = "en"|"zh"|"mixed"`
  - export type `AnswerResult<TValue> = { intent:"provided", value:TValue, source:"exact"|"bloom"|"llm" } | { intent:"unclear", clarifyingQuestion?:string } | { intent:"declined" } | { intent:"noise" }`
  - export interface `ResolveCtx { userId:string; turnId:string; rawPayload?:unknown; db?:unknown; log?(event,payload):void; resolveAnswer:typeof resolveAnswer (P7-2 import) }`
  - The `.resolve()` method MUST delegate to `ctx.resolveAnswer(this, reply, lang, ctx)` — DQ class is data, P7-2 owns LLM calls
  - `applyToPrefs` + `applyToTags` are pure functions returning new objects; per-Q implementation maps canonical value → `StatedPreferences` field (e.g. q_role: targetRole=[value], q_visa: visaStatus=mapTo4Enum(value), q_country: persist to tags.targetCountry, q_location: targetLocations=value as string[])
- [ ] **`packages/pa-orchestrator/src/onboarding/questions-table.ts`** NEW
  - export `function questionsTable(deps?: QuestionsTableDeps): readonly DeterministicQuestion<unknown>[]` returning 11 instances in order: q_lang, q_email, q_email_verify, q_tos, q_role, q_yoe, q_visa, q_startup_pref, **q_country**, q_location, q_resume
  - **Order matters** — pipeline asks Q[0] first
  - Each Q includes:
    - prompts: copy from existing `questions.ts` (zh/en) + add `mixed` variant (zh primary with en sprinkles)
    - reAsks: ≥4 variants per lang (so attempt 1-4 are different phrasings)
    - mode: `exact_match` only for q_email_verify (6-digit code) and q_tos (`agree`/`disagree`/`同意`/`不同意` keywords). All other 9 = `guided_open`
    - examples: ≥4 fixture rows per Q for LLM few-shot
    - bloomRegex: cheap quick wins ONLY (e.g. q_yoe `/^\d+$/`, q_visa `/citizen/i`, q_lang `/zh|english|中文/`). **Optimistic — never blocks** (L2). DO NOT add multi-token regex for location/role.
  - export `type QuestionsTableDeps = {}` placeholder (currently empty; runtime injection happens via `ResolveCtx.resolveAnswer`)

### WHERE — 文件域

ONLY edit:
- `packages/pa-orchestrator/src/onboarding/question.ts` (rewrite, replace old Judge/Rephraser interface)
- `packages/pa-orchestrator/src/onboarding/questions-table.ts` (new file)

Do NOT touch:
- `packages/pa-orchestrator/src/onboarding/judges/` or `rephrasers/` (P7-4 deletes those)
- `packages/pa-orchestrator/src/onboarding/questions.ts` (P7-4 deletes)
- pipeline.ts, runtime-bridge.ts, cv-poll.ts, state-firestore.ts (P7-4 owns wiring changes)
- onboarding-deterministic.ts, onboarding.ts (P7-4 owns)
- `packages/core-types/` (P7-3 owns OnboardingState extension)

You MAY read everything in `packages/pa-orchestrator/src/` for context.

### Interface contract (consumed by P7-2/4/5)

```ts
// question.ts public surface — DO NOT change shape after handoff
export class DeterministicQuestion<TValue = unknown> {
  readonly id: QuestionId
  readonly askedState: OnboardingState  // from core-types (P7-3 ensures q_country_asked exists)
  readonly nextStateOnAnswered: OnboardingState
  readonly prompts: Record<Lang, string>
  readonly reAsks: Record<Lang, readonly string[]>  // ≥3
  readonly mode:
    | { kind: "exact_match", values: readonly string[] }
    | { kind: "guided_open", hints: readonly string[] }
  readonly examples: readonly { reply: string; value: TValue }[]
  readonly bloomRegex?: readonly { pattern: RegExp; value: TValue }[]
  resolve(reply: string, lang: Lang, ctx: ResolveCtx): Promise<AnswerResult<TValue>>
  applyToPrefs(value: TValue, prefs: StatedPreferences): StatedPreferences
  applyToTags(value: TValue, tags: Record<string, unknown>): Record<string, unknown>
}
export function questionsTable(deps?: QuestionsTableDeps): readonly DeterministicQuestion<unknown>[]
```

### DONE — 完成标准

- `pnpm --filter @pa/pa-orchestrator build` 0 errors
- `pnpm --filter @pa/pa-orchestrator typecheck` 0 errors
- `node -e "import('./packages/pa-orchestrator/dist/onboarding/questions-table.js').then(m=>console.log(m.questionsTable().map(q=>q.id)))"` prints all 11 ids in order including `q_country`
- Every DeterministicQuestion has ≥3 reAsk variants per lang AND ≥4 examples
- bloomRegex present on q_yoe, q_visa, q_lang, q_country (others optional)

### DON'T

- DO NOT call LLM directly — `resolve()` delegates to `ctx.resolveAnswer` which is owned by P7-2
- DO NOT import from `judges/` or `rephrasers/` (those files die)
- DO NOT modify state machine (q.askedState/nextStateOnAnswered are just data references)
- DO NOT include OPT/CPT/H1B as separate visa enum values — per L8 / D4: `OPT/CPT/H1B → sponsor_needed`. Visa enum values: `citizen | permanent_resident | sponsor_needed | other` (4-enum).
- DO NOT use abbreviations in canonical values (D5) — `software_engineering` not `swe`, except where existing `StatedPreferences` schema has lowercase compact values (targetRole keeps free-form lowercase tokens for back-compat; document why in code comments)

### Suggested attack plan (P7-1 should follow)

1. Phase analysis of existing `questions.ts` to extract zh/en strings → reuse verbatim for prompts + first 3-4 reAsks
2. Add `mixed` variant for prompts + reAsks (zh-primary code-switch)
3. Add bloomRegex for the 4 cheap-match Qs
4. Implement `applyToPrefs`/`applyToTags` per Q (cribbed from existing `runtime-bridge.ts:onXxxAccepted` mapping logic)
5. Stub `resolve()` body to: noise filter → if exact_match handle inline → else delegate to `ctx.resolveAnswer(this, reply, lang, ctx)`
6. Build + typecheck loop until clean

---

## P7-2 — resolve-answer.ts (LLM resolver + bloom orchestrator)

### WHAT — 交付物

- [ ] **`packages/pa-orchestrator/src/onboarding/resolve-answer.ts`** NEW
  - export `async function resolveAnswer<T>(q: DeterministicQuestion<T>, reply: string, lang: Lang, ctx: ResolveCtx): Promise<AnswerResult<T>>` per GOAL G1 resolve order:
    1. **noise filter** — empty string / pure punctuation `/^[\s\p{P}]+$/u` / `__PA_RESET__` / `__PA_FIND_MATCH__` → `{intent:"noise"}`
    2. If `q.mode.kind === "exact_match"` → case-insensitive trim+compare against `q.mode.values`, return `provided` with source=`exact` or `unclear` (no LLM)
    3. If `q.mode.kind === "guided_open"`:
       a. Try `q.bloomRegex` patterns — first hit returns `{intent:"provided", value, source:"bloom"}`
       b. Else call LLM via `callQwenIntent({systemPrompt, userText, schema})` (built into this file, NOT calling existing `extractAnswerIntent`)
       c. Parse LLM JSON `{intent, value, confidence, clarifyingQuestion?}`. If confidence ≥ 0.6 + value matches schema → `{intent:"provided", value, source:"llm"}`. Else → `{intent:"unclear", clarifyingQuestion}`
       d. On LLM error/timeout → return `{intent:"unclear"}` with no clarifyingQuestion (caller falls through to next reAsk variant)
  - export `interface QwenClient { callJson(args: {systemPrompt:string; userText:string; schemaName:string; schema:unknown; timeoutMs?:number}): Promise<{rawJson:string} | null> }`
  - export `function makeSiliconFlowQwenClient(opts: {apiKey:()=>string|undefined; model?:string; baseUrl?:string; logger?:Logger}): QwenClient` — calls `https://api.siliconflow.cn/v1/chat/completions` with `Qwen/Qwen2.5-7B-Instruct`, JSON mode, 6s timeout, returns `{rawJson}` or null on failure
  - export `function buildResolveSystemPrompt<T>(q: DeterministicQuestion<T>, lang: Lang): string` — constructs prompt from `q.id`, `q.mode.hints`, `q.examples`. Schema asks LLM to emit JSON `{intent: "provided"|"unclear", value?, confidence?, clarifyingQuestion?}`. Lang directive ensures clarifyingQuestion is in user's lang.
  - **Logging hook**: every step emits via `ctx.log` — `pa.onboarding.resolve.noise` / `.exact` / `.bloom_hit` / `.llm_call` / `.llm_ok` / `.llm_fail` / `.unclear` with `{userId, qId, lang}`.

- [ ] Resolver MUST be **bound into questionsTable construction**, not at runtime — i.e. `runtime-bridge.ts` (P7-4 territory) constructs `ctx.resolveAnswer = resolveAnswer.bind(null, qwenClient)` once at boot. Document this contract in resolve-answer.ts header.

### WHERE — 文件域

ONLY edit:
- `packages/pa-orchestrator/src/onboarding/resolve-answer.ts` (new file)

You MAY read:
- `apps/functions/src/orchestrator-deps.ts:920-1100` (existing Qwen call pattern)
- `packages/pa-resume-parser/src/router.ts` (callWithFallback shape — pattern reference, not used)
- P7-1's `question.ts` + `questions-table.ts` interfaces (depend on these)

Do NOT touch:
- question.ts, questions-table.ts (P7-1 owns)
- runtime-bridge.ts (P7-4 owns wiring)
- existing extract intent in orchestrator-deps.ts (legacy; P7-4 cleanup decides if it stays for back-compat)

### DONE — 完成标准

- `pnpm --filter @pa/pa-orchestrator build` 0 errors
- A small ad-hoc test (delete after verify): import resolveAnswer + a stub Q with `mode: exact_match values:["yes","no"]` → calling `resolveAnswer(q, "YES", "en", {log:console.log, resolveAnswer:undefined as any, ...})` returns `{intent:"provided", value:"yes", source:"exact"}`. Don't ship the test file; verify by running ts-node or copying into a sandbox `node -e`.
- bloom path verified: stub `Q.bloomRegex = [{pattern:/^\d+$/, value:5}]`, reply="5" → returns source="bloom"
- LLM path NOT exercised in P7-2 done check (P7-5 owns LLM-stubbed unit tests)

### DON'T

- DO NOT use `callWithFallback` from pa-resume-parser — that's the parser chain (gpt-5.4-nano). Resolver uses Qwen-7B per L1.
- DO NOT block on LLM failure — fall through to `unclear` so pipeline re-asks with next variant
- DO NOT cache LLM responses (out of scope)
- DO NOT add 2nd-pass / retry inside resolveAnswer — single LLM call per turn (caller manages re-ask cadence)

---

## P7-3 — DiscussionPhase abstract + ResumeDiscussionPhase + state schema extension

### WHAT — 交付物

- [ ] **`packages/core-types/src/index.ts`** — extend `OnboardingStateSchema` enum
  - ADD: `"q_country_asked"` (insert between q_startup_pref_asked and q_location_asked)
  - ADD: `"q_resume_processing"` (insert between q_resume_asked and q_cv_analyzing)
  - ADD: `"q_resume_done"` (insert between q_resume_processing and q_cv_analyzing)
  - Keep all existing values; preserve order semantics
  - Run `pnpm --filter @pa/core-types build` to ensure schema export is regenerated
- [ ] **`packages/pa-orchestrator/src/onboarding/discussion-phase.ts`** NEW per GOAL G2
  - export `abstract class DiscussionPhase` with:
    - readonly `phaseId: "resume" | "linkedin_url"`
    - readonly `entryStates: readonly OnboardingState[]`
    - readonly `processingState: OnboardingState`
    - readonly `completeState: OnboardingState`
    - `async onArtifactReceived(input: PhaseInput): Promise<void>` — calls sendImmediateAck → setState(processingState) → kickoffAsyncWork
    - `async onMessageWhileProcessing(input: PhaseInput): Promise<void>` — calls sendHoldMessage
    - `async onWorkComplete(input: PhaseInput, result: AsyncResult): Promise<void>` — calls persistAnalysis → sendAnalysis → setState(completeState)
    - abstract `sendImmediateAck(input)` / `kickoffAsyncWork(input)` / `persistAnalysis(userId, result)` / `sendAnalysis(input, result)` / `sendHoldMessage(input)`
  - export interface `PhaseInput { userId:string; turnId:string; lang:Lang; phoneE164:string; rawPayload?:unknown; db?:unknown; log:(event,payload)=>void; emit:(text,meta)=>Promise<void>; setState:(userId, state:OnboardingState)=>Promise<void>; }`
  - export interface `AsyncResult { kind:"resume"|"linkedin_url"; payload:unknown }`

- [ ] **`packages/pa-orchestrator/src/onboarding/discussion-resume.ts`** NEW
  - export `class ResumeDiscussionPhase extends DiscussionPhase`
  - phaseId: "resume", entryStates: ["q_resume_asked"], processingState: "q_resume_processing", completeState: "q_resume_done"
  - `sendImmediateAck`: emits one of 3 lang-keyed variants (zh/en/mixed) — "OK 让我看一下你简历, 等我一下下" pattern (use existing `composeInterimResumeAck` from `onboarding-deterministic.ts` as reference; you MAY import it)
  - `kickoffAsyncWork`: existing logic — caller's `applyOnboarding` enqueues cv-ingest. P7-3 wires the call to `pollParsedCandidateResume` (`cv-poll.ts`) using `db` + `userId` + injected `cvPollOpts?` for tests
  - `sendHoldMessage`: emits "稍等, 我还在看你简历" zh / "give me a sec — still reading your resume" en / mixed variant. ≥3 variants per lang randomized.
  - `persistAnalysis`: writes summary tag via existing `formatCvSummaryForUser` + uses `applyToTags` no-op (resume tags persisted by cv-ingest worker, not phase). Phase logs `pa.onboarding.discussion.resume.analyzed`.
  - `sendAnalysis`: emits CV summary tag (use `formatCvSummaryForUser` from `cv-summary.ts`); on poll timeout emits "简历还在分析, 我先按你聊的方向找..." per existing `runResumeAcceptedFlow` logic
  - **CRITICAL**: ResumeDiscussionPhase IS the replacement for `runResumeAcceptedFlow` in `runtime-bridge.ts`. Code in `runtime-bridge.ts:runResumeAcceptedFlow` (lines 356-417) is the spec — port to class methods.

### WHERE — 文件域

ONLY edit:
- `packages/core-types/src/index.ts` (just the OnboardingStateSchema enum addition)
- `packages/pa-orchestrator/src/onboarding/discussion-phase.ts` (new)
- `packages/pa-orchestrator/src/onboarding/discussion-resume.ts` (new)

You MAY read:
- `packages/pa-orchestrator/src/onboarding-deterministic.ts:composeInterimResumeAck` (helper reuse)
- `packages/pa-orchestrator/src/cv-summary.ts:formatCvSummaryForUser` (helper reuse)
- `packages/pa-orchestrator/src/onboarding/cv-poll.ts:pollParsedCandidateResume` (helper reuse — call from kickoffAsyncWork)
- `packages/pa-orchestrator/src/onboarding/runtime-bridge.ts:runResumeAcceptedFlow` (port spec)

Do NOT touch:
- runtime-bridge.ts itself (P7-4 swaps in `new ResumeDiscussionPhase().onArtifactReceived()`)
- onboarding-deterministic.ts (P7-4 owns)
- pipeline.ts (state machine extension by adding states is enough; P7-4 wires phase routing)
- question.ts / questions-table.ts (P7-1 only references new state names — coordinate via state-name string literal contract below)

### Interface contract (consumed by P7-1/4/6)

State name additions (locked):
- `q_country_asked` — between q_startup_pref_asked and q_location_asked
- `q_resume_processing` — between q_resume_asked and q_cv_analyzing  
- `q_resume_done` — between q_resume_processing and q_cv_analyzing

Class shape (locked):
```ts
export abstract class DiscussionPhase {
  readonly phaseId: "resume" | "linkedin_url"
  readonly entryStates: readonly OnboardingState[]
  readonly processingState: OnboardingState
  readonly completeState: OnboardingState
  onArtifactReceived(input: PhaseInput): Promise<void>
  onMessageWhileProcessing(input: PhaseInput): Promise<void>
  onWorkComplete(input: PhaseInput, result: AsyncResult): Promise<void>
}
export class ResumeDiscussionPhase extends DiscussionPhase {
  constructor(opts?: { cvPollOpts?: PollParsedResumeOpts })
}
```

### DONE — 完成标准

- `pnpm --filter @pa/core-types build` 0 errors, schema regenerated includes new states
- `pnpm --filter @pa/pa-orchestrator build` 0 errors
- `node -e "import('./packages/core-types/dist/index.js').then(m=>{const e=m.OnboardingStateSchema; console.log(e.options.includes('q_country_asked'), e.options.includes('q_resume_processing'), e.options.includes('q_resume_done'))})"` prints `true true true`
- Class export verified: `node -e "import('./packages/pa-orchestrator/dist/onboarding/discussion-resume.js').then(m=>console.log(typeof m.ResumeDiscussionPhase))"` prints `function`

### DON'T

- DO NOT delete `runResumeAcceptedFlow` from runtime-bridge.ts (P7-4 owns deletion after wiring)
- DO NOT add LinkedIn phase impl (out of scope; abstract class + comment "future: class LinkedInDiscussionPhase" only)
- DO NOT change `cv-poll.ts` API (just consume it)
- DO NOT bump cv-ingest worker code (orchestrator-deps.ts cv-ingest stays as-is)

---

## P7-4 — onboarding-deterministic.ts rewire + delete legacy regex

### WHAT — 交付物

- [ ] **`packages/pa-orchestrator/src/onboarding/runtime-bridge.ts`** REWRITE
  - Replace `defaultQuestions(deps)` import with `questionsTable(deps?)` (P7-1's export)
  - Construct `qwenClient = makeSiliconFlowQwenClient({apiKey:()=>SILICONFLOW_API_KEY.value(), logger})` and `resolveAnswerBound = (q,reply,lang,ctx)=>resolveAnswer(q,reply,lang,{...ctx,resolveAnswer:resolveAnswerBound, qwenClient})` for each turn
  - Construct `resumePhase = new ResumeDiscussionPhase({cvPollOpts: deps.cvPollOpts})`
  - Pipeline turn handler: BEFORE pipeline.startTurn, check if state ∈ resumePhase.entryStates AND attachment present → `resumePhase.onArtifactReceived(input)`. Else if state === resumePhase.processingState → `resumePhase.onMessageWhileProcessing(input)`. Else → `pipeline.startTurn(input)` as before.
  - When pipeline accepts q_resume → trigger `resumePhase.onArtifactReceived` (still entry path; could also be: pipeline doesn't own q_resume any more, ResumeDiscussionPhase handles all q_resume_* states. Pick ONE design and document.)
  - **Decision required**: ResumeDP fully owns q_resume_asked/processing/done OR pipeline handles q_resume_asked entry, ResumeDP only handles processing/done. **Recommended**: pipeline owns q_resume_asked entry (it's deterministic — "got attachment? yes/no/declined"); ResumeDP owns q_resume_processing + q_resume_done. Document at top of file.

- [ ] **`packages/pa-orchestrator/src/onboarding-deterministic.ts`** REWRITE
  - Reduce from 2097 LOC to ≤500 LOC
  - Keep only: `composeInterimResumeAck` (used by ResumeDP), top-level `runDeterministicOnboardingTurn` thin wrapper that delegates to `runOnboardingPipelineTurn`, `pickPromptText` helper if used externally
  - DELETE: regex-parser dispatch, 4-path duplication, all `if (priorAskedStep === ...) parseXxxAnswer` ladders, all `applyOnboardingStep` direct calls (delegate to runtime-bridge)
  - DELETE imports of: `parseTosAnswer`, `parseEmailVerificationCode`, `parseUserAnswerForStep`, `userAnsweredStep`
  - Feature flag: keep `paOnboardingPipelineEnabled` flag check so legacy stub remains for emergency rollback (1-2 days). Default ON for stage; gradual ramp prod.

- [ ] **`packages/pa-orchestrator/src/onboarding.ts`** TRIM
  - Reduce from 1486 LOC to ≤400 LOC
  - DELETE: `canonicalizeRole`, `canonicalizeLocations`, `canonicalizeStartupPref`, `parseRoleAnswer`, `parseYoeAnswer`, `parseVisaAnswer`, `parseStartupPrefAnswer`, `parseLocationAnswer`, `parseTosAnswer`, `parseEmailVerificationCode`, `userAnsweredStep`, `LOCATION_CANONICAL_MAP`, `parseUserAnswerForStep`
  - KEEP: type re-exports (`OnboardingStep`, `CanonicalRole` if used elsewhere outside onboarding flow), first-message constants if any, `applyOnboardingStep` (until P7-4 confirms downstream callers can shed it)

- [ ] **DELETE** files:
  - `packages/pa-orchestrator/src/onboarding/questions.ts` (superseded by questions-table.ts)
  - `packages/pa-orchestrator/src/onboarding/judges/code.ts`
  - `packages/pa-orchestrator/src/onboarding/judges/email.ts`
  - `packages/pa-orchestrator/src/onboarding/judges/lang.ts`
  - `packages/pa-orchestrator/src/onboarding/judges/llm-relevance.ts`
  - `packages/pa-orchestrator/src/onboarding/judges/resume.ts`
  - `packages/pa-orchestrator/src/onboarding/judges/yesno.ts`
  - `packages/pa-orchestrator/src/onboarding/rephrasers/hybrid.ts`
  - `packages/pa-orchestrator/src/onboarding/rephrasers/llm.ts`
  - `packages/pa-orchestrator/src/onboarding/rephrasers/variants.ts`
  - All co-located `*.test.ts` for the above (P7-5 doesn't need them; P7-5 writes new ones)

- [ ] Update `packages/pa-orchestrator/src/index.ts` exports — remove deleted re-exports
- [ ] Update `packages/pa-orchestrator/src/onboarding/index.ts` if exists

### WHERE — 文件域

EDIT:
- `packages/pa-orchestrator/src/onboarding-deterministic.ts`
- `packages/pa-orchestrator/src/onboarding.ts`
- `packages/pa-orchestrator/src/onboarding/runtime-bridge.ts`
- `packages/pa-orchestrator/src/onboarding/index.ts` (if exists)
- `packages/pa-orchestrator/src/index.ts`

DELETE:
- `packages/pa-orchestrator/src/onboarding/questions.ts`
- All files in `packages/pa-orchestrator/src/onboarding/judges/`
- All files in `packages/pa-orchestrator/src/onboarding/rephrasers/`
- Co-located `*.test.ts` for the above

Do NOT touch:
- question.ts, questions-table.ts (P7-1)
- resolve-answer.ts (P7-2)
- discussion-phase.ts, discussion-resume.ts (P7-3)
- core-types schema (P7-3)
- pipeline.ts (state machine generic — only update if absolutely needed for new phase routing; document why)
- cv-poll.ts, state-firestore.ts (kept)
- existing tests OUTSIDE onboarding/ folder (e.g. `packages/pa-orchestrator/src/__tests__/`, `onboarding-deterministic.test.ts`, `onboarding.test.ts`, `onboarding-iter31.test.ts`, `onboarding-workflow.test.ts`, `onboarding-deterministic-interim.test.ts`)
  - **HOWEVER**: those tests will break because they import deleted symbols. P7-4 MUST update those tests to either: (a) skip with clear `it.skip("legacy regex parser deleted; superseded by P7-1 unit tests in onboarding/__tests__/q-*.test.ts", ...)`, or (b) update imports to use new DQ resolver if the test asserts behavior still relevant. Goal: orchestrator test suite stays green.

### Coordination

- WAIT for P7-1 + P7-2 + P7-3 to ship interfaces (read their files in real-time during P7-4 execution)
- If P7-1/2/3 interfaces don't match this prompt: P7-4 escalates via `[PUA-ESCALATION]` to P9 — do NOT silently change P7-1/2/3 code

### DONE — 完成标准

- `pnpm --filter @pa/pa-orchestrator build` 0 errors
- `pnpm --filter @pa/pa-orchestrator typecheck` 0 errors
- `pnpm --filter @pa/pa-orchestrator test` — entire existing test suite green (legacy tests either skip-marked or rewritten); 0 failures
- `wc -l packages/pa-orchestrator/src/onboarding.ts packages/pa-orchestrator/src/onboarding-deterministic.ts` shows ≤400 / ≤500 lines respectively
- `grep -rn "canonicaliz\|userAnsweredStep\|parseLocationAnswer\|parseRoleAnswer\|parseYoeAnswer\|parseVisaAnswer\|parseStartupPrefAnswer\|parseTosAnswer\|parseEmailVerificationCode\|LOCATION_CANONICAL_MAP\|parseUserAnswerForStep" packages/pa-orchestrator/src/` returns 0 hits
- Deleted files confirmed gone via `ls packages/pa-orchestrator/src/onboarding/judges/ packages/pa-orchestrator/src/onboarding/rephrasers/ 2>&1 | grep -i 'no such'`
- `pnpm --filter functions build` (downstream consumer) 0 errors

### DON'T

- DO NOT skip the legacy test cleanup — failing tests = red build = no PR
- DO NOT add new behavior — this is a delete + rewire prompt
- DO NOT `--no-verify` to bypass pre-deploy (red lines)
- DO NOT touch `applyOnboardingStep` semantics — it's still the persistence boundary; just call it with `parsedAnswer` from new pipeline (already wired in runtime-bridge)
- DO NOT reuse `extractAnswerIntent` from orchestrator-deps.ts inside the new resolver — leave it for legacy stub if flag rolls back

---

## P7-5 — Layer-1 unit tests (per-Q, ≥110 cases, LLM stubbed)

### WHAT — 交付物

11 test files in `packages/pa-orchestrator/src/onboarding/__tests__/`:

- [ ] `q-lang.test.ts` ≥10 cases (zh/en/mixed/各种说法)
- [ ] `q-email.test.ts` ≥10 cases (clean/typo/multiple emails/declined)
- [ ] `q-email-verify.test.ts` ≥6 cases (6-digit + variants like "code is 123456" / "我的码是 123456")
- [ ] `q-tos.test.ts` ≥8 cases (agree/decline/nuanced "I'm not sure" / unclear)
- [ ] `q-role.test.ts` ≥12 cases (engineer/PM/free-form/typo/multi-role)
- [ ] `q-yoe.test.ts` ≥10 cases (number/fresh/typo/range "3-5 years")
- [ ] `q-visa.test.ts` ≥12 cases — **CRITICAL** OPT/CPT/H1B all → `sponsor_needed`. Cases: citizen/PR/OPT/CPT/H1B/F1/J1/sponsor needed/decline/unclear/"I'm Chinese"/"work auth fine"
- [ ] `q-startup-pref.test.ts` ≥8 cases (startup/bigtech/either/depends/unclear)
- [ ] `q-country.test.ts` ≥10 cases — NEW Q (USA/China/Anywhere/multi/typo/code-switch)
- [ ] `q-location.test.ts` ≥15 cases — **MUST INCLUDE** Adam-pain-point fixtures:
  - `["Everywhere is fine", "anywhere"]`
  - `["In USA is good", "usa_anywhere"]` (post-q_country=USA implied; test in isolation just checks it parses to "usa_anywhere" or similar canonical)
  - `["sfran or nYC works", ["sf","nyc"]]`
  - `["都行", "anywhere"]`
  - `["Bay Area, NYC, or remote", ["sf","nyc","remote"]]`
  - Plus 10 more covering city/region/typo/multi/anywhere
- [ ] `q-resume.test.ts` ≥4 cases (gate logic only — has-attachment / no-attachment / declined / "later")

### Test scaffolding

Each test file:
```ts
import { describe, it, expect, vi } from "vitest"
import { questionsTable } from "../questions-table.js"
import type { ResolveCtx, AnswerResult } from "../question.js"
import { resolveAnswer } from "../resolve-answer.js"

const Q = questionsTable().find(q => q.id === "q_role")!  // per-file Q

const stubLlm = vi.fn(async (args: { systemPrompt: string; userText: string }) => ({
  rawJson: JSON.stringify({ intent: "provided", value: "swe", confidence: 0.9 }),
}))

const ctx = (over: Partial<ResolveCtx> = {}): ResolveCtx => ({
  userId: "u1", turnId: "t1", log: () => {},
  resolveAnswer: (q, reply, lang, c) => resolveAnswer(q, reply, lang, { ...c, qwenClient: { callJson: stubLlm } as any }),
  ...over,
})

describe("q_role", () => {
  it("clean: 'i'm an engineer'", async () => {
    stubLlm.mockResolvedValueOnce({ rawJson: JSON.stringify({ intent:"provided", value:"swe", confidence:0.92 }) })
    const r = await Q.resolve("i'm an engineer", "en", ctx())
    expect(r.intent).toBe("provided")
    if (r.intent === "provided") expect(r.value).toBe("swe")
  })
  // ... ≥11 more
})
```

Each fixture row should declare `{ reply, lang, expectedIntent, expectedValue?, llmStub? }` so test bodies stay 1-line.

### WHERE — 文件域

ONLY create:
- `packages/pa-orchestrator/src/onboarding/__tests__/q-lang.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/q-email.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/q-email-verify.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/q-tos.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/q-role.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/q-yoe.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/q-visa.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/q-startup-pref.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/q-country.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/q-location.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/q-resume.test.ts`

You MAY read:
- All P7-1/2 source files (interface contracts)
- Existing test files for vitest / mock patterns

Do NOT touch:
- Source files (P7-1/2/3/4 own them)
- Sim tests (P7-6 owns)

### DONE — 完成标准

- `pnpm --filter @pa/pa-orchestrator test -- src/onboarding/__tests__/q-` runs all 11 files
- `≥110` test cases total (sum across files; verify with `grep -c "it(" packages/pa-orchestrator/src/onboarding/__tests__/q-*.test.ts`)
- 100% pass, 0 skipped
- LLM stubbed everywhere — `grep -rn "siliconflow\.cn\|api\.openai\.com\|api\.anthropic" packages/pa-orchestrator/src/onboarding/__tests__/` returns 0 hits
- Adam-pain-point fixtures literally present in q-location.test.ts: `grep -c 'sfran or nYC' packages/pa-orchestrator/src/onboarding/__tests__/q-location.test.ts` ≥ 1, same for "Everywhere is fine", "都行"

### DON'T

- DO NOT call real LLM — use vi.fn stubs
- DO NOT use Firestore — pure unit
- DO NOT use state machine — call `Q.resolve()` directly
- DO NOT skip Adam-pain-points — those are the bug fixtures Adam personally found

---

## P7-6 — Layer-2 simulation tests (8 sim files, state machine + re-ask rotation + DiscussionPhase async)

### WHAT — 交付物

8 sim files in `packages/pa-orchestrator/src/onboarding/__tests__/sim/`:

- [ ] `sim-cold-start.test.ts` — pending → first_mes → q_lang_asked. Verify pipeline emits first prompt.
- [ ] `sim-q-chain-happy.test.ts` — full chain q_lang → q_email → q_email_verify → q_tos → q_role → q_yoe → q_visa → q_startup_pref → **q_country** → q_location → q_resume. Stub LLM to return canonical "provided". Assert each Q advances to nextStateOnAnswered.
- [ ] `sim-q-chain-typo.test.ts` — each Q gets 1 typo'd reply, must auto-recover via bloom or LLM stub with "provided" canonical
- [ ] `sim-q-chain-invalid.test.ts` — each Q gets 1 nonsense reply ("the cat sat"), assert pipeline emits reAsks[0] (variant 1) → next nonsense → reAsks[1] (variant 2). On 2nd valid reply Q advances.
- [ ] `sim-tos-decline.test.ts` — TOS decline path; verify state advances to q_role with TOS decline logged (no halt).
- [ ] `sim-resume-async.test.ts` — attachment received in q_resume_asked → ResumeDiscussionPhase.onArtifactReceived → ack emitted → state=q_resume_processing. Stub `pollParsedCandidateResume` to resolve with a fake CV doc → onWorkComplete → analysis emitted → state=q_resume_done.
- [ ] `sim-discussion-hold.test.ts` — while state=q_resume_processing, user sends message → ResumeDiscussionPhase.onMessageWhileProcessing fires → "稍等" emitted, state stays q_resume_processing.
- [ ] `sim-country-then-location.test.ts` — Adam-pain-point coupling. Sequence: q_country reply "USA" → state=q_location_asked, collected.q_country="usa". Then q_location LLM stub returns "unclear". Assert reAsk variant emitted does NOT contain "China" / "上海" / "Beijing" / "Shanghai" — re-ask must be USA-scoped or country-agnostic. (Implementation hint: reAsks for q_location should not list specific China cities; if they currently do per existing prompt content, P7-6 documents this as a P7-1 follow-up — but at minimum verify NEW q_country state is read by something, even if just collected.q_country in ResolveCtx.)

### Test scaffolding (sim style)

```ts
import { describe, it, expect, vi } from "vitest"
import { OnboardingPipeline } from "../../pipeline.js"
import { questionsTable } from "../../questions-table.js"
import type { PipelineState } from "../../pipeline.js"

class MemState {
  store = new Map<string, PipelineState>()
  async load(uid: string) { return this.store.get(uid) ?? emptyPipelineState() }
  async save(uid: string, s: PipelineState) { this.store.set(uid, s) }
}

const emitted: Array<{text:string; meta:{qId:string|null; kind:string}}> = []
const pipeline = new OnboardingPipeline({
  questions: questionsTable() as any,
  state: new MemState(),
  haltMessageDefault: { zh: "halt", en: "halt", mixed: "halt" } as any,
  emit: async (t, m) => { emitted.push({text:t, meta:m}) },
  log: () => {},
})

describe("sim-cold-start", () => {
  it("first turn emits q_lang prompt", async () => {
    const r = await pipeline.startTurn({userId:"u1", turnId:"t1", reply:""})
    expect(r.currentQId).toBe("q_lang")
    expect(emitted[0].meta.kind).toBe("first_prompt")
  })
})
```

### WHERE — 文件域

ONLY create:
- `packages/pa-orchestrator/src/onboarding/__tests__/sim/sim-cold-start.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/sim/sim-q-chain-happy.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/sim/sim-q-chain-typo.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/sim/sim-q-chain-invalid.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/sim/sim-tos-decline.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/sim/sim-resume-async.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/sim/sim-discussion-hold.test.ts`
- `packages/pa-orchestrator/src/onboarding/__tests__/sim/sim-country-then-location.test.ts`

Do NOT touch:
- Source files (P7-1/2/3/4 own)
- Layer-1 unit tests (P7-5 owns)

### DONE — 完成标准

- `pnpm --filter @pa/pa-orchestrator test -- src/onboarding/__tests__/sim/` runs all 8
- 100% pass with mock LLM
- `grep -c "it(" packages/pa-orchestrator/src/onboarding/__tests__/sim/sim-*.test.ts` ≥ 8 (≥1 case per file; many will have several)
- LLM stubbed (no real network)
- sim-resume-async verifies sequence: ack → state=processing → analysis → state=done. Use `expect(emitted.map(e=>e.meta.kind))` to assert order.
- sim-discussion-hold verifies state stays q_resume_processing after mid-process user msg
- sim-country-then-location asserts q_location reAsk variant does NOT contain China-only city tokens

### DON'T

- DO NOT call real LLM
- DO NOT use Firestore — use in-memory MemState provider
- DO NOT skip — all 8 files required

---

## P9 integration plan (post P7 delivery)

After all 6 P7s ship `[P7-COMPLETION]`:
1. Verify P7-1/2/3 deliverable files compile (`pnpm --filter @pa/pa-orchestrator build`)
2. Verify P7-4 build + test suite green
3. Verify P7-5 + P7-6 tests pass
4. Sum LOC delta + files added/deleted
5. Bug A/B/D regression check: re-run e2e-bug-* scripts (kept on disk in repo)
6. Compose `[P9-INTEGRATION-COMPLETE]` report → P10

