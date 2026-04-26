# Phase 11 Plan — Persona + Identity / Memory Injection

P9-B owner. Output is task prompts; production code is P8 territory.

## Architecture context (locked, do not relitigate)

- A1 OpenAI Agents SDK is the agent runtime.
- A2 WeKruit owns identity, canonical memory (Firestore + Mem0/Qdrant),
  outbound, audit. Agents SDK never reaches Firestore directly.
- A3 Identity injection is hybrid: Firestore facts → PA-assembled persona
  card → injected as a system message to the Agents SDK turn.
- A4 Mem0/Qdrant + Memory Admin remain primary memory; OpenAI vectorStores
  are at most a Phase 13 secondary provider.

## Code-shape ground truth (verified before planning)

The 11-CONTEXT.md charter refers to `packages/agent-runtime/src/stacked.ts`
and `FirestorePersonaProvider`. Those names do not match current source:

- `stacked.ts` lives at `packages/memory/src/stacked.ts`. It exports
  `loadPersonalizationContext` and `afterAssistantTurn`, both consumed by
  `packages/pa-orchestrator/src/index.ts` (the live orchestrator turn).
- `FirestorePersonaProvider` does not exist as a class. The repo only has
  a stale compiled artifact `packages/memory/dist/firestore-persona.js`
  (functions: `listConfirmedMemoryFacts`, `buildPersonaCard`,
  `loadFirestorePersonaCard`). The corresponding `.ts` source has been
  removed. The dist also references obsolete `MemoryFact` fields
  (`fact.key`, `fact.value`, `fact.sensitivity`) that no longer exist on
  the current `MemoryFactSchema` (`content`, `status`, `source`).
- `mem0UserId` is declared as advisory in `packages/memory/src/types.ts`
  and on `UserSchema` / broker payloads, but `loadPersonalizationContext`
  + `afterAssistantTurn` both use `input.userId` for Mem0 search/add. The
  Qdrant payload key for scoping is `user_id` (see
  `packages/memory/src/admin.ts` `clearQdrantForUser`).
- The orchestrator already injects a `Confirmed user facts:` block via
  `memoryBlockWithFacts(...)` in `packages/pa-orchestrator/src/index.ts`,
  but it is NOT a deterministic persona card — it is a flat fact dump
  concatenated with Mem0 results. There is no system-message-level
  persona card today.

The plan below uses the real symbol names. If a task prompt says
"`stacked.ts` in `@pa/memory`" or "`pa-orchestrator/index.ts` turn path",
that is the verified location.

## Goal-backward task breakdown

Each success criterion in 11-CONTEXT.md maps to one or more tasks.
Verification for each task closes one criterion.

### Criterion 1 — Live agent turns include a deterministic persona card from Firestore confirmed facts

**Task 11.1 — Re-introduce live `firestore-persona.ts` source module.**
- Goal: Provide a single canonical builder for the persona card, in TS
  source (not a stale dist), aligned with the current `MemoryFact` shape
  (`content`, `source`, `status`).
- Inputs: `packages/memory/src/facts.ts`,
  `packages/core-types/src/index.ts` (`MemoryFactSchema`),
  `packages/memory/dist/firestore-persona.js` (reference only — the API
  shape is right; the field names are stale).
- Scope: `packages/memory/src/firestore-persona.ts` (new),
  `packages/memory/src/index.ts` (export). No orchestrator edits.
- Contract: export `buildPersonaCard(facts: MemoryFact[]): string | null`
  and `loadFirestorePersonaCard(db, userId): Promise<string | null>`.
  Empty / all-deleted facts return `null`. Output starts with a stable
  prefix `Persona facts (confirmed):` so downstream prompts can match
  deterministically. Sort by `createdAt` ascending so identical fact sets
  produce identical cards across runs.
- Verification: `npm test -w @pa/memory` covers a unit test that asserts
  (a) empty facts → null, (b) two facts in scrambled createdAt order
  produce a stable string, (c) deleted facts are excluded. This closes
  the deterministic half of Criterion 1.
- Red lines: do NOT read from Mem0/Qdrant in this module. Persona card is
  Firestore-only by A3. Do not leak high-sensitivity classes if/when
  added later — gate behind explicit fact `source` / `status` only.

**Task 11.2 — Inject persona card into the live orchestrator turn.**
- Goal: Wire the persona card into the system-message surface of the
  Agents SDK turn; replace the current ad-hoc `Confirmed user facts:`
  block.
- Inputs: `packages/pa-orchestrator/src/index.ts`
  (`loadHistory` → `loadPersonalizationContext` → `runAgentTurn` path,
  lines ~334–428), `packages/agent-runtime/src/run.ts` and
  `openai-agents-adapter.ts` (the runtime that consumes
  `systemPrompt` + `memoryBlock`).
- Scope: `packages/pa-orchestrator/src/index.ts`,
  `packages/memory/src/stacked.ts` if the loader needs the card surfaced
  alongside `memoryBlock`. Do not edit the Agents SDK adapter signature;
  keep the persona card on the existing `systemPrompt` / `memoryBlock`
  surface.
- Contract: orchestrator MUST call `loadFirestorePersonaCard(db, userId)`
  before `runAgentTurn`. The card is concatenated as a separate, labeled
  block ahead of the Mem0 memory block, never inside `agent.systemPrompt`
  itself (so persona is data, not prompt config). When the card is
  `null`, the runtime behaves exactly as today.
- Verification:
  1. New unit test in `packages/pa-orchestrator/src/index.test.ts`:
     stub `listConfirmedMemoryFacts` to return two facts, assert that the
     `runAgentTurn` mock receives a system-side block containing
     `Persona facts (confirmed):` and both fact contents.
  2. Update `tests/scenarios/scenarios/memory-recall-zh.yaml` (or add the
     new persona scenario in 11.5) to assert reply tone constraints from
     a seeded fact.
- Red lines: do NOT bypass the orchestrator and inject from inside the
  Agents SDK adapter (A2 violation). Do not break the
  `Confirmed user facts:` block contract until 11.5 scenarios prove the
  persona card path is enough.
- Dependencies: 11.1.

### Criterion 2 — `mem0UserId` is authoritative for memory recall, Memory Admin reflects same scope

**Task 11.3 — Make `mem0UserId` authoritative end-to-end.**
- Goal: Remove the "advisory" regression. Whichever key is canonical for
  Mem0/Qdrant payload `user_id` MUST be used by both reads (search) and
  writes (add) AND by Memory Admin clear/list. Identity drift between
  Firestore `User.id` and `User.mem0UserId` is detected, not silently
  ignored.
- Inputs:
  - `packages/memory/src/types.ts` (`mem0UserId` advisory comments,
    lines 7–15, 44–45)
  - `packages/memory/src/stacked.ts`
    (`loadPersonalizationContext`, `afterAssistantTurn` — currently use
    `input.userId`)
  - `packages/memory/src/admin.ts` (`clearQdrantForUser` filter is
    `user_id == userId` — must use the same canonical key)
  - `packages/core-types/src/index.ts` (`UserSchema.mem0UserId`)
  - `packages/core-types/src/broker.ts` (broker payload `mem0UserId`)
  - `packages/pa-orchestrator/src/index.ts` (call sites for
    `loadPersonalizationContext` and `afterAssistantTurn`, plus the
    Memory Admin reset path).
- Scope: same files. No dashboard code.
- Contract:
  - Define one helper `resolveMem0PartitionKey(user)` in
    `packages/memory/src/identity.ts` (new) that returns
    `user.mem0UserId ?? user.id`. Single source of truth.
  - `LoadContextInput` and `AfterTurnInput` keep `mem0UserId?: string`
    as the partition; if unset, callers MUST resolve via the helper
    before calling. `stacked.ts` switches from `input.userId` to
    `input.mem0UserId ?? input.userId` for `mem0Search` /  `mem0Add`.
    Update the JSDoc to remove "advisory, ignored" language.
  - `clearUserMemory` accepts an optional explicit partition key in its
    options; the orchestrator's reset path passes the resolved key. The
    Firestore-side scope still uses `userId` (Firestore docs are keyed
    by `userId`), so the helper distinguishes the two surfaces.
  - On identity drift (caller passes both `userId` and `mem0UserId`
    where `mem0UserId !== userId` AND no `User.mem0UserId` is set in
    Firestore), emit a structured log line and continue using the
    explicit override. Do not throw — production turns must not regress
    on a stale field.
- Verification:
  1. Unit tests in `packages/memory/src/stacked.test.ts` that assert
     `mem0Search` and `mem0Add` are called with `mem0UserId` when the
     caller supplies one different from `userId`.
  2. Unit test in `packages/memory/src/admin.test.ts` that
     `clearUserMemory` passes the resolved partition into the Qdrant
     filter when `mem0UserId` differs from `userId`.
  3. Manual trace: confirm Memory Admin dashboard list/delete uses the
     same resolved key (no code change in dashboard expected; the HTTP
     wrapper already calls `clearUserMemory`).
- Red lines: do NOT add a third identity key. Do NOT swap
  Firestore-keyed collections (`pa_memory_facts`, `pa_messages`) onto
  `mem0UserId` — those remain `userId`-scoped. Do NOT silently fall back
  when both keys disagree without logging.
- Dependencies: none (parallelizable with 11.1, but serializes against
  11.2 because both edit `pa-orchestrator`).

### Criterion 3 — Documented identity contract for Phase 12/13

**Task 11.4 — Author `11-IDENTITY-CONTRACT.md`.**
- Goal: Single document Phase 12 (proactive outreach) and Phase 13
  (matching) read once and ship without questions.
- Scope: `.planning/phases/11-persona-identity-injection/11-IDENTITY-CONTRACT.md`.
- Contract: see file. Field-level table + flow diagrams in markdown.
- Verification: P9-B self-review against the "consumer-facing" rubric:
  Phase 12 must answer (a) which key to use for outbound throttling and
  cooldowns, (b) which key to use when querying memory before composing
  a proactive nudge, (c) what happens when a user record is reseated.
  Phase 13 must answer (a) which key the matching connector receives,
  (b) where match rationale facts get stored.
- Dependencies: must be drafted in parallel with 11.3 because 11.3
  decisions about drift handling need to be reflected in the contract.

### Criterion 4 — Production scenario harness covers a persona-injection regression

**Task 11.5 — Add persona-injection scenario.**
- Goal: A YAML scenario the existing harness runner can execute without
  any harness changes.
- Inputs: `tests/scenarios/scenarios/memory-recall-zh.yaml` (template
  shape), `packages/pa-orchestrator/src/index.test.ts` (scenario style),
  the test participant range in 11-CONTEXT (reserved test handles).
- Scope: `tests/scenarios/scenarios/persona-injection-zh.yaml` (new).
  Stub structure listed below — full YAML is the P8 deliverable.
- Contract: scenario seeds two confirmed memory facts via the existing
  `__PA_RESET__` + `记住 …` flow (or a direct seeding helper if available
  in the runner), then sends a constraint-style probe. Assertions must
  prove the persona card is in the prompt: e.g., a tone constraint fact
  ("说话风格简短直接") seeded as a fact, then a probe that verifies the
  reply does not run long. Hard cap on `pa_outbound` count must remain
  0 — `suppressOutbound` is the harness default (Phase 9 hardening) and
  this scenario must not flip it.
- Verification: harness run prints `pa_outbound=0`, persona facts appear
  in `pa_agent_turns` debug payload, replies satisfy `reply_max_length`
  and a `reply_contains_any` tone token assertion.
- Red lines: harness MUST suppress outbound. No real iMessage send. Do
  not introduce new fields on the scenario YAML schema; reuse existing
  `assert.reply_*` matchers (extend the runner only if absolutely
  required, in a separate task with its own prompt).
- Dependencies: 11.1, 11.2 (the persona card must actually be wired
  before the scenario can prove it).

### Criterion 5 — Harness `pa_outbound` stays 0

Covered by 11.5 verification + existing Phase 9 harness defaults. No
separate task. P9-B's verification gate at the end of the phase runs the
full scenario suite and asserts cumulative `pa_outbound=0` for harness
events.

## Wave plan

Wave A (parallelizable, no shared file domain):
- 11.1 (new file `packages/memory/src/firestore-persona.ts`)
- 11.4 (new doc `11-IDENTITY-CONTRACT.md`)

Wave B (serial — both edit `packages/pa-orchestrator/src/index.ts`):
- 11.2 (depends on 11.1)
- 11.3 (depends on 11.4 contract being drafted, and on the new identity
  helper module)
  Run 11.2 first, then 11.3, on the same branch. Do not parallelize.

Wave C:
- 11.5 (depends on 11.2 + 11.3 merged).

## Persona-injection scenario stub (referenced by 11.5)

```yaml
id: persona_injection_zh_tone_constraint
description: |
  Verifies the deterministic persona card from Firestore confirmed facts
  reaches the live Agents SDK turn. Seeds a tone-constraint fact, then
  probes a free-form question; assertion proves the reply respects the
  constraint.
locale: zh-CN
agentId: default
participant: "+19999990002"   # reserved harness handle
chatId: "iMessage;+19999990002"
turnTimeoutMs: 30000
suppressOutbound: true        # harness default; explicit for this file
turns:
  - user: "__PA_RESET__"
    assert:
      reply_contains_any: ["测试记忆已清空"]
  - user: "记住 我喜欢极简的回答，不超过两句话"
    assert:
      reply_min_length: 1
  - user: "今天天气怎么样适合出门吗"
    assert:
      reply_min_length: 1
      # Tone constraint check — persona card must shape the reply.
      reply_max_length: 120
      reply_not_contains_any: ["error", "undefined"]
```

(P8 fills in the final assertion thresholds against a real harness run.)

## Phase-exit verification

P9-B closes the phase when:
1. `npm test` passes across `@pa/memory`, `@pa/pa-orchestrator`,
   `@pa/agent-runtime`.
2. `npm run build:all` passes.
3. Scenario suite (memory-recall, current-info-live, reset-integration,
   persona-injection) reports `pa_outbound=0` for harness events.
4. `11-IDENTITY-CONTRACT.md` is reviewed by Phase-12 owner and Phase-13
   owner with sign-off comments.
