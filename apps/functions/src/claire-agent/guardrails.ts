/**
 * guardrails.ts — WS-guardrail owns this file.
 *
 * - inputGuardrail: crisis / prompt-injection tripwire via `detectCrisisInInput`
 *   (@pa/pa-safety) + an injection corpus. Tripwire bypasses the agent (poc-v3 D).
 * - outputGuardrail: a lightweight long-context VOICE-DRIFT detector (flags, does not
 *   hard-fail normal replies) — the ONLY voice guardrail kept.
 * - normalizer: `normalizeForIMessage` (@pa/pa-orchestrator/output-normalizer) — the
 *   ONE kept post-processor (markdown/URL strip + iMessage length). Everything else in
 *   voice/ is deleted, replaced by prompt+few-shot.
 *
 * WS-guardrail: implement. `buildClaireGuardrails()` returns the SDK guardrail arrays;
 * `normalizeReply()` wraps normalizeForIMessage.
 */
import { notImplemented } from "./types.js"

export function buildClaireGuardrails() {
  // returns { input: InputGuardrail[], output: OutputGuardrail[] } (let TS infer once filled)
  return notImplemented("WS-guardrail", "guardrails.buildClaireGuardrails")
}

/** The one kept post-processor: markdown/url strip + iMessage length. */
export function normalizeReply(text: string): string {
  return notImplemented("WS-guardrail", "guardrails.normalizeReply")
}
