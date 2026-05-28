# P8 — Safety guardrails · CONTEXT

**Goal (V3-AGENTIC-GOAL-PROMPT.md):** "Move crisis/injection/privacy-stop into
`@openai/agents` `inputGuardrails`; retire the equivalent hand-written
pre-filters. Voice stays in prompt." Architecture §8: guardrails are safety
tripwires (run before the agent, can reject), NOT voice/business logic.

## State found (off P0 tip `02c3e826`)
- A full guardrail framework already exists in `pa-orchestrator/src/guardrails/`:
  - input: `crisis-detector`, `prompt-injection-detector`, `pii-scanner`,
    `length-input`, `openai-moderation`; `INPUT_GUARDRAIL_CHAIN` + `runInputChain`.
  - output: ab-strip, advice-repeat, crisis-trailer, length-cap, mirror-score, …
- BUT `INPUT_GUARDRAIL_CHAIN` runs **shadow-only** today
  (`PA_GUARDRAIL_INPUT_CHAIN_SHADOW`): telemetry, does NOT gate. Legacy
  `checkInboundSafety` (crisis + injection) is authoritative; PII enforcement is
  a hidden gap (the SSN/CC scanner never gates).
- The `@openai/agents` adapter (`agent-runtime/openai-agents-adapter.ts`) had
  **no** `inputGuardrails` wiring — the SDK-native safety seam the architecture
  mandates did not exist.

## Key implementation facts
- SDK (`@openai/agents-core@0.8.5`): `Agent({ inputGuardrails: InputGuardrail[] })`;
  `InputGuardrail = { name, execute(args)→{tripwireTriggered,outputInfo}, runInParallel? }`.
  A trip throws `InputGuardrailTripwireTriggered` (carries `.result.guardrail.name`
  + `.result.output.outputInfo`).
- `runInParallel: false` is REQUIRED for safety — the guardrail must complete
  (and can halt) BEFORE the model runs; it must not race the LLM.
- Crisis is **annotate-only** on the input side (sets `ctx.crisisTripped`, never
  hard-trips) — its hotline trailer is an OUTPUT guardrail. The hard INPUT trips
  are prompt-injection / PII / length / moderation.

## Decision
Wire SDK-native `inputGuardrails` into the adapter (the architecture's mandated
seam) as a NET-NEW capability on the agentic path → zero regression to the live
legacy path. Bridge the existing `INPUT_GUARDRAIL_CHAIN` into it.

Retiring legacy `checkInboundSafety` is **Adam-gated** (CLAUDE.md: production-
Claire safety change) — it requires the agentic path to be the live conversation
path AND a parity proof first. Deleting authoritative safety without that proof
would violate both the safety lock and "don't delete a hand-written layer until
the eval proves the replacement covers it."
