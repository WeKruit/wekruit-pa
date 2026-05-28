# P8 — Safety guardrails (SDK-native inputGuardrails) · SUMMARY

**Branch:** `claude/agentic-P8-safety-guardrails`, stacked on P0.
Implements V3-AGENTIC-GOAL-PROMPT.md P8 + AGENTIC-ARCHITECTURE.md §8: safety via
`@openai/agents` `inputGuardrails` (run-before-agent tripwires), NOT hand-written
pre-filters; voice stays in the prompt.

## What shipped
1. **agent-runtime adapter — SDK-native `inputGuardrails`** (the mandated seam,
   which did not exist):
   - `AgentTurnContext.inputGuardrails?: AgentInputGuardrailSpec[]` +
     `RunAgentTurnResult.tripwire?: { name, outputInfo }` (types.ts).
   - `buildInputGuardrails(ctx)` maps each spec → an SDK `inputGuardrail` with
     **`runInParallel: false`** (safety must complete/halt BEFORE the model, never
     race it). `mapTripwire(err)` detects `InputGuardrailTripwireTriggered`
     (by class + constructor-name, robust across the dual-package boundary) and
     surfaces `{name, outputInfo}`; non-tripwire errors rethrow.
   - `runDefaultAgent` passes `inputGuardrails` to `new Agent(...)` and catches a
     tripwire → returns `{ text: "", usage, tripwire }`. Empty array = SDK no-op,
     so every existing caller is **byte-identical** (zero regression).
2. **Orchestrator bridge** `guardrails/sdk-input-guardrails.ts`:
   `buildSafetyInputGuardrails(ctxFactory)` adapts the existing, already-tested
   `INPUT_GUARDRAIL_CHAIN` (crisis-annotate → prompt-injection → PII → length)
   into a single SDK spec via `runInputChain`. A HARD trip surfaces
   `{trippedBy, cannedReply}`; fail-open on a guardrail crash is preserved.

## Receipts
- **agent-runtime:** 62/62 pass, 0 fail (was 50→62; +5 new guardrail tests:
  buildInputGuardrails maps/no-op/fallback, mapTripwire detect/null).
- **pa-orchestrator:** 1807/1807 pass, 0 fail (+4 new `sdk-input-guardrails`
  tests: one-spec, PII-SSN HARD-trips with canned reply, benign abstains, crisis
  annotate-only does NOT hard-trip the input chain).
- **process-intact:** 5/5 green (prescreen FSM all-asked/no-skip/terminal-once,
  onboarding no-skip, trigger parse, candidate×job idempotency+dedup).
- Builds: @pa/core-types, @pa/agent-runtime, @pa/pa-orchestrator green.

## SELF-REVIEW
- [x] **Safety as SDK inputGuardrails, not hand-written?** Yes — the adapter now
      has the native seam; `runInParallel:false` = real tripwire before the model. ✔
- [x] **Voice NOT pushed into guardrails?** Correct — only crisis/injection/PII/
      length (safety). The voice stack is untouched (that was P6). ✔
- [x] **Zero regression?** Empty `inputGuardrails` is an SDK no-op; the live legacy
      path (`processInboundEvent` + `checkInboundSafety`) is untouched. ✔
- [x] **Lock honored (no premature deletion)?** Legacy `checkInboundSafety` is NOT
      deleted — see Honest gaps. We added the SDK capability; we did not rip out
      authoritative safety without a parity proof + Adam approval. ✔
- [x] **Real seam?** The orchestrator bridge runs the REAL `INPUT_GUARDRAIL_CHAIN`
      (real PII scanner trips on a real SSN), not a stand-in. ✔

### Honest gaps / next steps (Adam-gated)
1. **Live wiring:** `buildSafetyInputGuardrails` is built + tested but not yet
   populated onto the agentic call site's `AgentTurnContext` — that is a one-line
   wiring where the orchestrator constructs the turn context, behind a flag.
2. **Legacy retirement:** "retire the equivalent hand-written pre-filters" means
   removing legacy `checkInboundSafety` once the agentic path is the LIVE
   conversation path and an eval proves the SDK guardrails cover crisis/injection
   AND close the PII gap. That is a production-Claire **safety** change → Adam-gated
   per CLAUDE.md; not done blind. The SDK path is the forward home; the cutover is
   the gated final step.
3. Crisis on the INPUT side is annotate-only by design (hotline trailer is an
   OUTPUT guardrail) — represented faithfully in the bridge + its test.
