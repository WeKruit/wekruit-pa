# S1B — Voice Context Loaders — AGENT PLAN

Owner: P8 (this worktree)
Branch: `claude/v21-S1B-context-loaders` (from `claude/v21-S0-foundation`)
Worktree: `.claude/worktrees/v21-S1B-context-loaders`

## Objective (recap)

Provide three read-only typed Firestore loaders the S2 voice bridge will use to assemble per-turn context, without writing or recomputing anything owned by other services.

- `loadUserProfileForVoice(userId): Promise<VoiceUserProfile>`
- `loadJobBriefForVoice(jobId): Promise<VoiceJobBrief>`
- `loadPrescreenConfigForVoice(jobId): Promise<VoicePrescreenConfig>`

All three throw `NotFoundError(kind, id)` on missing docs and return a `missingFields: string[]` array when partial data is found.

## Sources of truth (verified by inspection)

| Loader | Firestore source | Why this source |
|---|---|---|
| `loadUserProfileForVoice` | `pa-users/{userId}` (top-level fields + `tags` map) | D8 single-user-tag-source. Top-level adds displayName, contactPII consent flag, candidate lifecycle. |
| `loadJobBriefForVoice` | `matching-jobs/{jobId}` (canonical match-side job doc) | `admin-match-debug.ts` projectMatchingJob is the existing reader pattern. Same fields. |
| `loadPrescreenConfigForVoice` | `pa-jobs/{jobId}.prescreenConfig` parsed via `safeParsePrescreenConfig` | Same as `prescreen-session-start.ts:78–107`. Reuses canonical Zod schema in `@pa/pa-orchestrator`. |

## Field membership (load-only what voice needs)

### `VoiceUserProfile` (from `pa-users/{uid}`)
Identity / display:
- `userId` (from doc id)
- `displayName?` — Claire personalization
- `preferredLang?` — `tags.preferredLang` (`zh|en`) drives TTS language
- `phoneE164?` (top-level) — dial target; voice agent confirms it matches the call leg
- `email?` (top-level) — fallback identity hint, NOT spoken
- `lifecycleState?` — `candidateLifecycleState` (v2.0 state machine); informs Claire's tone (`prospect` vs `claimed`)
- `piiConsentAt?` — derived `piiConsentAt ?? contactPII.consentedAt`; controls whether PII reveals are permitted in-call

From `tags` (durable candidate facts the voice path actually uses):
- `targetRoleFunction?` — for Claire to acknowledge the role family
- `skills?` — Claire's "I see you have…" mirror line (capped, names only)
- `recentRoleTitle?` / `recentCompany?` / `workHistorySummary?` — opening warm-context
- `yoeRange?` — seniority talking points
- `visaStatus?` — Claire avoids re-asking; flagged to PII gate
- `targetLocations?` — preference echo
- `minSalary?` — never spoken; passed only for downstream policy decisions
- `industrySector?` / `relevantIndustry?` — Claire's contextual reference

Bookkeeping:
- `tagsUpdatedAt?` — staleness signal for HITL
- `missingFields: string[]` — fields present in canonical schema but absent on this doc

### `VoiceJobBrief` (from `matching-jobs/{jobId}`)
Identity:
- `jobId` (from doc id)
- `jobTitle` — `jobTitle ?? title ?? roleTitle`
- `companyName` — `companyName ?? companyDisplayName`

Role/industry shape (Claire's job-brief opener):
- `roleFunction?: string[]`
- `industrySector?: string[]`
- `seniorityLevel?` — Claire targets her language at this band

Compensation & location (informational only — never auto-revealed):
- `salaryMin?` / `salaryMax?`
- `locationRaw?` — what the JD literally says
- `locationBuckets?` — canonical bucket overlap

Other:
- `jobType?` — full_time / contract / intern (closed enum)
- `sponsorship?: boolean | null` — visa fit check
- `requiredSkills?: string[]` — Claire can paraphrase what the role needs
- `atsApplyUrl?` — for Level 1 reveal post-PASS (voice path will SMS this, not speak)
- `firstSeenAt?` / `dead?` — freshness / liveness for caller telemetry

Bookkeeping:
- `missingFields: string[]`

### `VoicePrescreenConfig` (from `pa-jobs/{jobId}.prescreenConfig`)
This is the contract `PreScreenPipeline.runTurn` consumes. Reuses canonical schema — no new shape.

- `jobId` (from doc id; convenience)
- `version` — schema version for forward-compat
- `jobTitle` — already on JobBrief but mirrored here so the screen flow is self-contained
- `company?`
- `threshold` — pass T
- `confidenceThreshold` — τ_c
- `maxClarifyRounds`
- `voiceMode` — `casual_onboarding | professional_prescreen` (S2 reads this to pick TTS persona)
- `questions: PrescreenQuestionConfig[]` (canonical from `@pa/pa-orchestrator`)
- `level1Reveal?` — PASS-only fields (applyUrl/salaryRange/nextStepEta)

Bookkeeping:
- `parsedFromZod: true` — flag confirming Zod validation succeeded
- `missingFields: string[]` — when `level1Reveal` or `company` absent

## Errors

```ts
export class NotFoundError extends Error {
  constructor(public readonly kind: "user" | "job" | "prescreen-config", public readonly id: string) {
    super(`${kind} not found: ${id}`)
    this.name = "NotFoundError"
  }
}
```

Loaders also throw when the source doc exists but the embedded payload fails Zod validation (only for `loadPrescreenConfigForVoice`). User profile + job brief are tolerant — they return partial shape + `missingFields` rather than throwing on partial data.

## File layout (new dir)

```
apps/functions/src/voice/
  context-loaders/
    types.ts                       # VoiceUserProfile, VoiceJobBrief, VoicePrescreenConfig, NotFoundError
    load-user-profile.ts           # loadUserProfileForVoice
    load-job-brief.ts              # loadJobBriefForVoice
    load-prescreen-config.ts       # loadPrescreenConfigForVoice
    index.ts                       # barrel re-exports
    __tests__/
      load-user-profile.test.ts    # 3 tests
      load-job-brief.test.ts       # 3 tests
      load-prescreen-config.test.ts# 3 tests
```

## Tests (9 total)

Each loader gets:
1. **happy path** — fully-populated doc → all fields returned, `missingFields.length === 0`
2. **missing doc** — `MockFirestore` has no entry → `NotFoundError` thrown with correct `kind` + `id`
3. **partial doc** — only required fields present → loader returns shape with present fields filled, `missingFields` lists what's absent

For `loadPrescreenConfigForVoice`, the "missing doc" case covers both:
- doc absent entirely
- doc present but `prescreenConfig` field absent (same `NotFoundError` because the contract is "prescreenConfig not found")

A separate ZodError case is covered by a 4th test in `load-prescreen-config.test.ts` (config present but invalid → `NotFoundError("prescreen-config", id, { cause: zodError })` style). On second thought, to stay at the 9-test mandate, the invalid-Zod case will be folded into the partial-doc test (a partial that fails validation must throw `NotFoundError` since the loader cannot safely return partial config — it has Zod-bounded fields). The 9-test count: 3 happy, 3 missing, 3 partial.

Test harness: reuses `MockFirestore` + `asFirestore` from `src/job-rec/__tests__/mock-firestore.ts`. Same `node:test` + `node:assert/strict` style as `admin-match-debug.test.ts`.

## Test-script wiring

`apps/functions/package.json` `test` script enumerates test files explicitly. We must append:

```
src/voice/context-loaders/__tests__/*.test.ts
```

This is the only edit outside the new dir.

## Commit plan (atomic)

1. **`feat(voice): S1B types + NotFoundError for voice context loaders`** — `types.ts` only
2. **`feat(voice): loadUserProfileForVoice + tests`** — `load-user-profile.ts` + `__tests__/load-user-profile.test.ts` + index barrel update
3. **`feat(voice): loadJobBriefForVoice + tests`** — `load-job-brief.ts` + test + barrel update
4. **`feat(voice): loadPrescreenConfigForVoice + tests`** — `load-prescreen-config.ts` + test + barrel update
5. **`chore(functions): include voice context-loader tests in test script`** — package.json
6. **`docs(v2.1): S1B context-loaders SUMMARY`** — `.planning/v2.1/sprints/S1B-context-loaders/SUMMARY.md`

(Steps 2-4 each contain code + test in one commit since they implement a single unit. This is acceptable atomicity per repo norms.)

## Verification

Per task prompt:

```bash
pnpm --filter pa-orchestrator test
pnpm --filter pa-functions test
node tests/scenarios/runner-prescreen.mjs pass.yaml
node tests/scenarios/runner-prescreen.mjs fail.yaml
node tests/scenarios/runner-prescreen.mjs hard-stop.yaml
node tests/scenarios/runner-prescreen.mjs pause.yaml
```

All must be green. New loaders only add new files (zero edits to existing modules), so regression risk is bounded to the new test files compiling and the `package.json` test-script edit.

## Anti-scope

- NO writes to Firestore
- NO Cloud Function exports
- NO LLM calls
- NO additions to `index.ts` (CF barrel) — these are internal libs S2 imports directly
- NO mutation of `PreScreenPipeline`, `mergeUserTags`, or any orchestrator code
- NO new Firestore collections, new fields, or schema migrations
- NO duplication of canonical schemas — `VoicePrescreenConfig.questions` reuses the `@pa/pa-orchestrator` type
