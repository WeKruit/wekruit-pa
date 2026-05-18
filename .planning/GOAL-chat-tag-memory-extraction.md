# GOAL — chat → tag + memory extraction hook (cross-session enrichment)

**Owner:** Adam
**Status:** PLAN only — NOT executed yet
**Created:** 2026-05-18

---

## Why (the gap audit exposed)

Audit on 2026-05-18 of pa-users tag fill on real production users
(WeKruit_Laid_Off candidate flow, indolencorlol@gmail.com sample):

- ✓ CV upload → `parsedCandidateResumes` → `user.tags` via `mergeUserTags` +
  `applyPartialUserTags`: **works**
- ✓ Onboarding question answers (q_role, q_yoe, q_visa, q_location) →
  `user.tags` via `writeOnboardingTags`: **works**
- ✓ L1 PII confirm post-prescreen-pass → `user.tags`: **works**
- ✓ CV-discussion confirmation (Claire "I see you — correct?") → `user.tags`
  via `persistUserTagsFromResumeDiscussionData`: **works**
- ❌ **Free-form chat after onboarding** → `user.tags`: **NO HOOK**

The free-form chat gap means once a user finishes onboarding/CV/L1, every
subsequent piece of preference signal they share with Claire (e.g.
"actually I'd consider fintech too", "I'm flexible on LA", "I want at
least 140k now") flows into Qdrant `pa_memory` (mem0) but never gets
mirrored as structured fields in `user.tags`. The match engine reads
`user.tags` (not mem0 free-text), so chat-evolved preferences never
influence ranking. Match score for these users decays toward the
post-onboarding snapshot.

V16 also has no signal back to Claire when `targetRoleFunction` /
`targetLocations` are empty — falls back silently to firstSeenAt-desc-500.
Claire keeps chatting but never knows to re-ask onboarding questions for
underspecified users.

Adam directive (2026-05-18):

> "2. 这个更新应该 context window 到一个地步 compact 的时候更新？？或者每过一个 time windows"
> "3. yea"
> "4. ya 没有这个的话就要重新 onboard"
> "只要是聊天中能加 tag & memory 来做 matching 就行"

---

## Two deliverables

### Deliverable 1 — Chat extraction hook (writes both `user.tags` + Qdrant)

LLM extractor that periodically scans recent user messages, extracts
preference delta as structured `PartialUserTags`, dual-writes to:

1. `pa-users.tags.*` via `applyPartialUserTags` (drives match engine)
2. Qdrant `pa_memory_entities` (drives Claire context recall)

Trigger on whichever fires first:

| Trigger | Threshold | Rationale |
|---|---|---|
| **Compact-time** | Conversation transcript estimated tokens approaches Claire's context window limit (e.g. ≥ 75% of model's input cap) | Aligned with existing memory compaction path; cheapest reuse |
| **Time-window** | ≥ 30 min since last extraction AND ≥ 3 user messages since | Catches active users who haven't compacted yet |
| **Turn-count** | Every N=10 user turns since last extraction | Floor guarantee for noisy chatters |

These three conditions OR'd. Whichever is true → run extractor once. Skip
if last extraction ran < 5 min ago (debounce).

### Deliverable 2 — V16 `needsOnboarding` signal back to Claire

When `runV16Query` skips the role filter because `targetRoleFunction.length === 0`,
emit a flag in the response payload telling the Claire conversation runtime
to re-enter onboarding for the missing axes.

---

## Architecture

### Where the hook lives

Looking at existing call graph:

- `coalesce/buffer.ts` flushes a batch of user messages → routes to
  orchestrator turn handler
- `prescreen-turn-handler.ts` and the main turn handler post-process turns
- `packages/memory/src/compaction.ts` already exists for memory-side compaction

Pick **`packages/pa-orchestrator/src/conversation-extractor.ts`** (new file)
called from the turn-handler post-processing hook. Reasons:

- Symmetric to `compaction.ts` (which already exists in memory pkg)
- Avoids polluting `coalesce/buffer.ts` with LLM calls
- One central caller from turn-handler keeps trigger logic in one place

### Schema

```ts
export interface ConversationExtractRequest {
  userId: string;
  recentMessages: Array<{ role: 'user' | 'assistant'; body: string; createdAt: string }>;
  existingTags: UserTags;  // current pa-users.tags snapshot
  trigger: 'compact' | 'time_window' | 'turn_count';
}

export interface ConversationExtractResult {
  /** Delta-only PartialUserTags suitable for applyPartialUserTags */
  tagPatch: PartialUserTags;
  /** Free-form entity facts for Qdrant pa_memory_entities */
  memoryEntities: Array<{ entityKind: string; value: string; confidence: number; evidence: string }>;
  /** Confidence + rationale for audit */
  confidence: number;
  rationale: string;
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
}

export interface ConversationExtractorDeps {
  llm: (prompt: string, schema: unknown) => Promise<unknown>;
  writeUserTags: (userId: string, patch: PartialUserTags) => Promise<void>;
  writeMemoryEntities: (userId: string, ents: Array<...>) => Promise<void>;
  log: (event: string, payload?: Record<string, unknown>) => void;
  now: () => Date;
}
```

### Trigger evaluator

```ts
export function shouldRunExtractor(state: {
  lastExtractedAt: string | null;
  lastExtractedTurnCount: number;
  currentTurnCount: number;
  estimatedTranscriptTokens: number;
  modelContextLimit: number;
  userMsgsSinceLast: number;
  nowMs: number;
}): { run: boolean; trigger?: 'compact' | 'time_window' | 'turn_count'; reason: string } {
  if (state.lastExtractedAt) {
    const lastMs = Date.parse(state.lastExtractedAt);
    if (state.nowMs - lastMs < 5 * 60 * 1000) {
      return { run: false, reason: 'debounce_5min' };
    }
  }
  if (state.estimatedTranscriptTokens / state.modelContextLimit >= 0.75) {
    return { run: true, trigger: 'compact', reason: 'transcript_75pct_of_ctx' };
  }
  if (state.lastExtractedAt) {
    const lastMs = Date.parse(state.lastExtractedAt);
    const elapsedMin = (state.nowMs - lastMs) / 60_000;
    if (elapsedMin >= 30 && state.userMsgsSinceLast >= 3) {
      return { run: true, trigger: 'time_window', reason: '>30min_>3msgs' };
    }
  }
  const turnsSinceLast = state.currentTurnCount - state.lastExtractedTurnCount;
  if (turnsSinceLast >= 10) {
    return { run: true, trigger: 'turn_count', reason: '10_turns_floor' };
  }
  return { run: false, reason: 'no_trigger_yet' };
}
```

### LLM prompt skeleton

```
SYSTEM:
You are an extraction agent. Read recent conversation between a job-seeker
("user") and an assistant ("Claire"). Output structured updates to the
user's preference profile using canonical WeKruit vocabularies.

Canonical vocab (closed enums):
- roleFunction:      [list from packages/shared-tags/src/canonical/role-function.ts]
- industrySector:    [list from packages/shared-tags/src/canonical/industry-sector.ts]
- visaStatus:        citizen | permanent_resident | sponsor_needed | other
- careerStage:       [list from canonical/career-stage.ts]
- jobType:           [list from canonical/job-type.ts]
- targetLocations:   [list from canonical/location.ts] (allow "anywhere")

EXISTING USER TAGS (do not duplicate; only emit DELTAS or new values):
{{ JSON.stringify(existingTags) }}

RECENT CONVERSATION (last 20 user/assistant turns):
{{ formatted }}

OUTPUT JSON only, matching ConversationExtractResult schema. If no new
signal extractable, return empty tagPatch + empty memoryEntities + reason.
```

Model: `gpt-5.4-nano` primary (matches CV parse), `claude-sonnet-4-6`
fallback (already in PA chain).

### Dual-write contract

```ts
async function runExtraction(req: ConversationExtractRequest, deps: Deps) {
  const result = await deps.llm(buildPrompt(req), ResultSchema);
  if (Object.keys(result.tagPatch).length > 0) {
    await deps.writeUserTags(req.userId, result.tagPatch);
    // writeUserTags wraps applyPartialUserTags(...source:'chat')
  }
  if (result.memoryEntities.length > 0) {
    await deps.writeMemoryEntities(req.userId, result.memoryEntities);
    // writes to Qdrant pa_memory_entities with payload
    // { user_id, entity_kind, value, confidence, evidence, extractedAt }
  }
  // Audit row to pa-extraction-runs collection
  await deps.writeAudit({
    userId: req.userId,
    trigger: req.trigger,
    tagFieldsChanged: Object.keys(result.tagPatch),
    memoryEntitiesAdded: result.memoryEntities.length,
    confidence: result.confidence,
    modelUsed: result.modelUsed,
    runAt: deps.now().toISOString(),
  });
}
```

### V16 needsOnboarding signal

In `apps/job-rec/src/tools/query-matching-jobs-v16.ts` near line 1052:

```ts
if (targetRoleFunction.length === 0) {
  log("pa.match.role_function_filter_skipped", {
    reason: "empty_target_role_function",
  });
  // NEW:
  matchPayload.needsOnboarding = true;
  matchPayload.missingAxes = [];
  if (!user.targetRoleFunction?.length) matchPayload.missingAxes.push('targetRoleFunction');
  if (!user.targetLocations?.length)    matchPayload.missingAxes.push('targetLocations');
  if (!user.visaStatus)                  matchPayload.missingAxes.push('visaStatus');
  if (!user.careerStage)                 matchPayload.missingAxes.push('careerStage');
}
```

Then conversation runtime (turn handler in pa-orchestrator) reads
`needsOnboarding`, injects into Claire's system prompt:

> "User profile incomplete — missing: {missingAxes.join(', ')}.
>  Naturally weave these questions into your next 2-3 replies."

---

## State persistence

Track per-user extraction state in `pa-users`:

```ts
{
  tags: { ... },
  extractionState: {
    lastExtractedAt: '2026-05-18T...',
    lastExtractedTurnCount: 47,
    lastTransform: 'gpt-5.4-nano',
    cumulativeExtractions: 12,
  }
}
```

---

## Test plan

Unit:
- `shouldRunExtractor` — 6 cases (debounce, compact, time_window, turn_count, no trigger, edge cases)
- `runExtraction` mocked LLM — empty patch path + non-empty patch path + memory-only path
- Dual-write idempotency — running twice with same input writes once (idempotency key on audit row)

Integration:
- Seed user with mid-conversation transcript ("I'm flexible on LA now")
- Run extractor
- Assert: `user.tags.targetLocations` includes `los_angeles`
- Assert: Qdrant `pa_memory_entities` has new point with value matching

Regression (V16):
- User with empty `targetRoleFunction` → match payload has `needsOnboarding: true` + correct missingAxes
- User with full tags → no flag

Scenarios:
- `tests/scenarios/chat-extract-delta.yaml` — multi-turn conversation
  where user reveals new preference; assert tag delta lands in 1 turn

---

## Done criteria

| # | Check | Pass condition |
|---|---|---|
| 1 | New file `packages/pa-orchestrator/src/conversation-extractor.ts` lands | Compiles + exported from index |
| 2 | Unit tests | 100% pass |
| 3 | Turn-handler integration | Calls `shouldRunExtractor` per turn, runs extractor when true |
| 4 | Live test on 1 real user (Adam's account) | After a "I want fintech" message, `user.tags.industrySector` includes `financial_technology` within 1 extraction cycle |
| 5 | Qdrant `pa_memory_entities` write | New point lands for that user with correct payload |
| 6 | V16 `needsOnboarding` flag | Returns true for empty-tag user; false for fully-tagged user |
| 7 | Claire reads flag + asks | System prompt injection visible in next assistant reply; user re-onboards |
| 8 | Predeploy gate green | Tests + typecheck + smoke pass |
| 9 | Match recall improvement | After extraction, match output for the test user has hard-filter survivors > 0 and top-2 align with extracted preferences |
| 10 | Cost budget | < $0.005 per extraction (10 turns × ~500 tokens × $0.00025/1K = $0.001). Daily cost cap: $5/user/day. |

---

## Risks

| Risk | Mitigation |
|---|---|
| LLM hallucinates tags user didn't say | Strict canonical-enum schema + confidence threshold (skip if < 0.7) |
| Conflicts with existing CV-derived tags | `applyPartialUserTags` already handles merge (source priority: chat < cv < explicit) — verify in unit tests |
| Extractor fires too often → cost explosion | Debounce 5min + daily cap + cost ledger like Phase 65 backfill |
| Trigger fires when user is mid-onboarding (would override q_role answer) | Skip extractor when `onboardingState !== 'complete'` |
| V16 `needsOnboarding` injected prompt confuses Claire mid-prescreen | Suppress signal when `prescreenSessionId` is active |
| Qdrant write latency adds to user-facing turn latency | Dual-write fire-and-forget (Promise.allSettled, log failures) |

---

## Followup (separate goals)

- Phase-by-phase rollback (extractor behind feature flag, can disable per-user)
- Backfill: one-time job runs extractor over historical messages for the 3
  real users to seed initial tags (cheap since N=3)
- Dashboard panel: per-user extraction stats + correction-events review

---

## NON-GOALS

- No change to onboarding-deterministic flow (q_role / q_visa etc still drive primary signal)
- No removal of CV-derived tag wire-up
- No new vocabulary axes (only fills existing canonical enums)
- No memory compaction logic change (separate module)
- No prescreen flow change
- Does NOT replace explicit onboarding — only fills gaps when user volunteers info

---

## Dependencies on cleanup goal

Should ship AFTER `.planning/GOAL-pa-users-cleanup.md` step 1 (source-label
enforcement) so the new extractor's `applyPartialUserTags(source: 'chat')`
calls don't pollute test users. If ordering reversed, run a one-time
backfill to set `source` on the 3 KEEP_LIST users.
