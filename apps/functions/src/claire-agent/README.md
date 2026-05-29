# claire-agent — thin Claire (@openai/agents rebuild)

Replaces the ~12k LOC regex-router + post-gen-voice Claire with a thin agent:
LLM + description-routed tools + SDK `Session` memory + delivery reflexes +
reducer-owned onboarding/prescreen flows + guardrails.

The three POCs in `.planning/thin-claire/poc/` are the proven runnable spec.
Every production tool/reducer mirrors a POC tool/reducer.

## KEYSTONE (never violate)

The LLM only **PROPOSES** (answer text, a judge score, a tool choice).
Deterministic **REDUCER** code **DECIDES** every state transition (next question,
PASS/FAIL rollup, commit-once, dedup, out-of-order rejection).
Reducer = code; the judgement it consumes (did they answer / how good) = LLM in a tool.

## File ownership (swarm workstreams — disjoint write scope)

| File | Owner | Mirrors POC | Status |
|---|---|---|---|
| `types.ts` | Wave 0 | — (shared contract) | real |
| `session.ts` | Wave 0 | `MemorySession` → Firestore | real (reuses `@pa/agent-runtime` `FirestoreSession`) |
| `flags.ts` | Wave 0 | — | real (`paThinClaireEnabled`) |
| `reducers/matching-profile-reducer.ts` | Wave 0 | poc-v1 only/avoid/replace | **real (RC1 headline fix)** |
| `reducers/onboarding-fsm.ts` | WS-process | poc-v3 C onboarding | stub |
| `reducers/prescreen-fsm.ts` | WS-process | poc-v3 C prescreen + rollup | stub |
| `reducers/candidate-job-state.ts` | WS-process | (wraps `reduceCandidateJobState`) | stub |
| `tools/index.ts` | WS-tools | `buildTools` | stub |
| `tools/set-matching-preferences.ts` | WS-tools | poc set_matching_preferences | stub |
| `tools/find-match.ts` | WS-tools | poc find_match | stub |
| `tools/remember.ts` `schedule-interview.ts` `privacy.ts` `save-job-profile.ts` `set-daily-subscription.ts` `cv-parse.ts` `match-collab.ts` | WS-tools | poc B tools | stub |
| `tools/onboarding.ts` `tools/prescreen.ts` | WS-process | poc-v3 C tools | stub |
| `tools/delivery.ts` (react/status/no-reply) | WS-delivery | poc-v2 delivery tools | stub |
| `transport.ts` | WS-delivery | fake channel → Sendblue | stub |
| `delivery.ts` | WS-delivery | mark-read + typing reflex | stub |
| `guardrails.ts` | WS-guardrail | poc-v3 D + normalizer | stub |
| `proactive.ts` | WS-proactive | (new — outbound-initiated) | stub |
| `compaction.ts` | Wave 0/WS-proactive | (reuse mem0 compaction) | stub |
| `prompt.ts` | Wave B | poc INSTRUCTIONS | stub |
| `agent.ts` | Wave B | `new Agent({...})` + assembly + cutover | stub |

## Eval stack (replaces unit suites — see THIN-CLAIRE-SWARM-GOAL.md)

- **L1** reducer/schema code-asserts — `*.test.ts` next to each reducer (no LLM).
- **L2** trajectory / tool-choice — agentevals (offline, no model at grade time).
- **L3** side-effect / outcome — `apps/eval/thin-claire/` poc-style, real `gpt-5.4-nano`,
  isolated stub db/channel, assert environment end-state. `pass^k` for core flows.
- **L4** process-adherence — state-machine asserts on the event ledger.
- **L5** simulated-user multi-turn (nightly).
- **L6** judge quality + online (advisory, never a hard gate).

Design-spec regression contract: `apps/eval/thin-claire/poc-v{1,2,3}.mjs` (copied from
`.planning/thin-claire/poc/`). These MUST stay green.

## Backend seams (KEEP — wrap, do not rewrite)

- `applyPartialUserTags` / `mergeUserTags` (`@pa/pa-orchestrator`) — sole writer to `pa-users.tags`.
- `queryMatchingJobsV16` (`@pa/job-rec`) — find-match backend (reads post-reducer tags; #269 negative subtraction).
- mem0 add/search (`@pa/memory`) — enrich-only, never gates matching.
- `SHARED_ONBOARDING_QUESTIONS` (`@pa/pa-orchestrator`) — onboarding slots.
- prescreen config + `prescreenSessionToEvaluationAttempt` (`@pa/pa-orchestrator`) — prescreen playbook + judge.
- `reduceCandidateJobState` (`@pa/pa-persistence`) — candidate×job FSM + terminal idempotency.
- `detectCrisisInInput` (`@pa/pa-safety`) — input guardrail.
- `normalizeForIMessage` (`@pa/pa-orchestrator/output-normalizer`) — the ONE kept post-processor.
- Sendblue `sendImessage` / `sendTypingIndicator` / `sendReaction` (`apps/functions/src/sendblue/`).
  NOTE: Sendblue has **no read-receipt endpoint** — `markRead` reflex fires an immediate typing
  indicator as the read signal (honest gap, AGENTIC-ARCHITECTURE §7).
- Cutover seam: `claimAndProcessInboundEvent` (legacy ~12k path) at `index.ts` / `paMessageCoalescer.ts`,
  gated by `paThinClaireEnabled` (default OFF).
