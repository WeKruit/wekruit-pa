# S1B Context Loaders — SUMMARY (P10 transcription)

> Sub-agent harness blocked direct write. P10 transcribed final report.

**Branch:** `claude/v21-S1B-context-loaders` (rebased on `claude/v21-S0-foundation` @ `b09dce7`, pushed)

## Commits

| SHA | Subject |
|---|---|
| `8c473e2` | docs(v2.1): S1B AGENT_PLAN |
| `5aca6c2` | feat(voice): S1B types + NotFoundError |
| `8dede83` | feat(voice): loadUserProfileForVoice + tests |
| `b47832b` | feat(voice): loadJobBriefForVoice + tests |
| `c35945c` | feat(voice): loadPrescreenConfigForVoice + tests + barrel |
| `2b471f9` | chore(functions): include voice context-loader tests in test script |

## Files added

`apps/functions/src/voice/context-loaders/{types,load-user-profile,load-job-brief,load-prescreen-config,index}.ts` + 3 `__tests__` files.

## Locked contract (S2 reads from this barrel)

```ts
import {
  loadUserProfileForVoice, loadJobBriefForVoice, loadPrescreenConfigForVoice,
  NotFoundError,
  type VoiceUserProfile, type VoiceJobBrief, type VoicePrescreenConfig,
} from "../voice/context-loaders/index.js";
```

### `VoiceUserProfile` ← `pa-users/{userId}`
Identity: `userId`, `displayName`, `phoneE164`, `email`, `lifecycleState`, `piiConsentAt`.
Durable facts from `tags.*`: `preferredLang` (zh|en), `targetRoleFunction[]`, `skills[]`, `recentRoleTitle`, `recentCompany`, `workHistorySummary`, `yoeRange`, `visaStatus`, `targetLocations[]`, `minSalary`, `industrySector[]`, `relevantIndustry[]`.
Bookkeeping: `tagsUpdatedAt`, `missingFields[]`.

### `VoiceJobBrief` ← `matching-jobs/{jobId}`
Mirrors `admin-match-debug.ts:projectMatchingJob` field-source chains. Fields: `jobId`, `jobTitle`, `companyName`, `roleFunction[]`, `industrySector[]`, `seniorityLevel`, `salaryMin/Max`, `locationRaw`, `locationBuckets[]`, `jobType`, `sponsorship` (bool or null = "known unknown"), `requiredSkills[]`, `atsApplyUrl`, `firstSeenAt`, `dead`, `missingFields[]`.

### `VoicePrescreenConfig` ← `pa-jobs/{jobId}.prescreenConfig`
Validated via canonical `safeParsePrescreenConfig` from `@pa/pa-orchestrator`. Reuses canonical `PrescreenQuestionConfig` — no parallel schema. Fields: `jobId`, `version`, `jobTitle`, `company?`, `threshold`, `confidenceThreshold`, `maxClarifyRounds`, `voiceMode` (`casual_onboarding | professional_prescreen`), `questions[]`, `level1Reveal?`, `parsedFromZod: true`, `missingFields[]`.

### Error contract
```ts
class NotFoundError extends Error { kind: "user"|"job"|"prescreen-config"; id: string }
```
- User/Job/PrescreenConfig: throw on missing doc.
- PrescreenConfig: additionally throws on Zod failure (matches iMessage `prescreen-session-start.ts` contract).
- User profile + Job brief tolerate partial; return `missingFields: string[]`.

## Test summary

- 12/12 voice context-loader tests
- `@pa/pa-orchestrator` 1498/1498
- `@pa/functions` 1530/1530
- runner-prescreen pass.yaml + pause.yaml ✓; fail.yaml + hard-stop.yaml pre-existing baseline failures (per task #11)

## S2 watch-outs

1. **`piiConsentAt` is PII gate** — when `undefined`, voice agent MUST NOT speak email / phone / apply URL / salary (lock L6).
2. **`preferredLang` may be `undefined`** for mixed-register users — fall back to runtime STT-language detection.
3. **`sponsorship: null` ≠ missing** — it's "known unknown". `missingFields` excludes when null.
4. **`dead === true` blocks voice dial** — daily liveness sweep marks 404 jobs.
5. **`missingFields` is telemetry**, not error. Voice path logs + continues; only fatal absence = the doc itself.
6. **`PrescreenQuestionConfig` is canonical** — re-exported from `@pa/pa-orchestrator` via `types.ts`. Replicate the `KeywordSetJudge`/`PreScreenPipeline` wiring pattern in `prescreen-turn-handler.ts:441-460`.

## Blockers for S2

None. S1B is self-contained read-only path under a new directory; no edits to existing modules (single 1-line test-script append in `apps/functions/package.json`).
