# Conversation Experience Harness

Stateful Firestore-state-diff harness for the Claire conversation runtime. Built in response to the May 2026 regression chain (PRs #237, #238, #239) where eval scored what Claire **said** rather than what she **did** — the canonical `pa-users.tags` field never mutated even though the LLM judge passed.

## Why this exists

Anthropic's 2026 ["Demystifying Evals for AI Agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) post calls out the failure mode: *"Agents lie in the transcript — grade the database, not the words."* This harness grades the database.

## Run

```bash
node apps/eval/conversation-experience/runner.mjs
```

Exit code `0` on green, `1` on any failed assertion, `2` on runtime crash.

The runner imports the compiled arbiter from `packages/pa-orchestrator/dist` when present, falling back to the TypeScript source via `tsx` for local dev. CI should build orchestrator before invoking.

## What it asserts

Per turn:
- arbiter owner decision matches `expect.owner`
- arbiter action decision matches `expect.action`
- `buildConversationEvidenceWrites` emits the kinds listed in `expect.evidence_kinds`
- the in-memory Firestore mock matches every dotted path in `expect.firestore_after`

The mock is seeded from `initial_state`. Each turn pushes:
- the arbiter's `pa-turn-traces` row (status `owner_arbitrated`, then `completed` when a simulated matcher / extractor runs)
- a simulated extractor patch into `pa-users/{uid}.tags` when `extractor_simulated_patch` is set
- a simulated `pa-tool-calls` row + completed `pa-turn-traces` row when `matcher_simulated_result` is set

## What it does NOT assert (yet)

- Full handler replay through `onPaInbound`. That requires mocking Firebase Admin, OpenAI, Anthropic, mem0, and Sendblue — out of scope.
- Real LLM extraction correctness. Fixtures pre-declare the patch the extractor would produce; LLM regression is covered separately by `packages/pa-orchestrator/src/__tests__/conversation-extractor.test.ts` and the live iMessage smoke at `+1 (717) 491-9939`.
- Voice / continuity / human-feel grading. Those stay in the LLM-judge layer (`apps/eval/intent-matrix-results`).

## Fixture shape

`apps/eval/conversation-experience/fixtures/*.json`. Schema:

```jsonc
{
  "name": "short-slug",
  "description": "what this canary protects against",
  "user_id": "test_user_x",
  "session_id": "test_session_x",
  "initial_state": {
    "pa-users/{user_id}": { /* seed doc */ }
  },
  "turns": [
    {
      "inbound": "user text",
      "shared_onboarding_active": false,
      "extractor_simulated_patch": { /* what runExtraction would emit */ },
      "matcher_simulated_result": {
        "recCount": 0,
        "v16Counters": { "total": 500, "dropped": 500, "hardFilter": { "visa": 500 } }
      },
      "expect": {
        "owner": "durable_preference_update",
        "action": "micro_ack",
        "evidence_kinds": ["durable_preference"],
        "firestore_after": {
          "pa-users/{user_id}.tags.targetRoleFunction": ["product_management"]
        }
      }
    }
  ]
}
```

`{user_id}` and `{session_id}` placeholders are expanded throughout the fixture.

## Canary fixtures

- **`avoid-swe-after-onboarding.json`** — The May 2026 Adam-bug regression case. Onboarded as SWE intern, user says "actually avoid pure SWE, product strategy only, SF or remote", then asks for recommendations. Asserts:
  - turn 1 arbiter routes to `durable_preference_update` + `micro_ack`
  - turn 1 mutates `pa-users.tags.targetRoleFunction` from `["software_engineering"]` to `["product_management"]`
  - turn 2 arbiter routes to `job_search` + `status_then_async_tool`
  - turn 2 emits a `pa-tool-calls/tool-2` row whose `input.userTagsSnapshot.targetRoleFunction === ["product_management"]` — proving the matcher saw the post-reducer tags, not the stale onboarding tags
  - turn 2 closes `pa-turn-traces/turn-2.status` as `completed`

## Real LLM-in-loop harness (`llm-runner.mjs`)

`runner.mjs` (above) asserts deterministic arbiter decisions against hand-written `extractor_simulated_patch` mocks — useful but it does NOT prove the real model produces the right patch. `llm-runner.mjs` does.

```bash
node apps/eval/conversation-experience/llm-runner.mjs
```

It loads the repo `.env` (walks up from the worktree to the main checkout), runs the production `runExtraction` with the production OpenAI-primary / Anthropic-fallback caller, and — critically — **does not pre-write the tag patch**. The real `gpt-5.4-nano` must extract the canonical delta from the candidate's chat. `writeUserTags` is captured into memory so the harness asserts the exact patch the model produced.

Two-layer verdict per [Anthropic's "Demystifying Evals for AI Agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (code-grader > model-grader):
- **Deterministic gate** (authoritative, sets exit code): `expect.final_tags` subset match after the real extraction + merge.
- **LLM grader** (advisory, never blocks): a second `gpt-5.4-nano` call scores semantic faithfulness — catches "schema validated but meaning wrong" cases. Non-deterministic even at temp 0, so it informs follow-ups rather than failing CI.

### The receipt this harness produced (2026-05-27)

Run against the **then-current** extractor, the canary failed with `ran=false reason=parse_error`. Raw model output:

```json
{"tagPatch":{"targetRoleFunction":"product_management","targetJobType":"full_time"}, ...}
```

The model was semantically correct (confidence 0.86, good evidence) but emitted **scalars** where `ConversationExtractResultSchema` demanded **arrays**. The strict `z.array(...)` rejected it → `parse_error` → the extractor silently returned `{ran:false}` → canonical `pa-users.tags` never updated → V16 kept reading the stale `software_engineering` / `internship` tags → 0 matches → the generic "I did not find a strong fresh match" reply Adam saw on the live test.

**This is the actual Adam-bug root cause** — not the trigger wiring, not the trace closure. The unit-test wall passed only because it hand-wrote arrays into the mock. The fix: `coerceArray` (`z.preprocess` scalar→single-element array) on the array fields + stop silently swallowing `parse_error` (log the raw output). Post-fix, the same canary passes the deterministic gate with `targetRoleFunction:["product_management"]` and no surviving `software_engineering`.

### LLM fixture shape (`llm-fixtures/*.json`)

```jsonc
{
  "name": "avoid-swe-real-extraction",
  "user_id": "test_user_x",
  "initial_tags": { "targetRoleFunction": ["software_engineering"], "targetJobType": ["internship"] },
  "turns": [ { "inbound": "...", "assistant": "optional placeholder" } ],
  "expect": {
    "final_tags": { "targetRoleFunction": ["product_management"] },  // deterministic gate (subset)
    "grade_criteria": "plain-English faithfulness rubric for the advisory grader"
  }
}
```

## Roadmap

- Wire into `firebase.json` predeploy gate (currently runs manually).
- Add side-effect simulation for shared-onboarding completion turns.
- Add a fixture exercising the `composeNoMatchReply` counter narration end-to-end.
- Add an LLM-judge advisory layer for voice / continuity (non-blocking, separate from this deterministic gate).
