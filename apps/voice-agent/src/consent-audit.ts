/**
 * v2.1 S5 — Consent-spoken audit-log emitter.
 *
 * Lock L8 (recording consent prompt at call start) is satisfied by S2's
 * `consent-prompt.ts` + `worker.ts` first-utterance `session.say(...)`. S5
 * adds this thin helper to emit a **structured audit log** the moment the
 * consent line is spoken, so the TCPA compliance trail captures:
 *
 *   { event: "voice.tcpa.consent_spoken",
 *     bookingId, paUserId, lang, voiceMode, spokenAt, promptHash }
 *
 * This is purely a log-emit; no Firestore write, no behavior change. The
 * S5 audit collection (`voice-tcpa-checks/{bookingId}_<runId>`) captures
 * the prior-consent verification; this log captures the in-call disclosure
 * delivery. Together they give us both sides of the consent record.
 *
 * No agent-runtime imports — this is voice-agent-only.
 */

import type { VoiceCallContext } from "./voice-context-types.js"

export interface ConsentSpokenAuditPayload {
  bookingId: string
  paUserId: string
  lang: "en" | "zh"
  voiceMode: "casual_onboarding" | "professional_prescreen"
  spokenAt: string
  /** First 12 chars of a stable hash of the prompt text, for change-detection. */
  promptHash: string
}

/**
 * Deterministic 12-char hash (FNV-1a 32-bit, hex). Stable across V8 runs,
 * no crypto dep needed for a forensic fingerprint.
 */
function fnv1aHex12(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  // Render 8 hex chars + 4 length-derived chars for 12-char stable id.
  const hex = h.toString(16).padStart(8, "0")
  const tail = (s.length % 65536).toString(16).padStart(4, "0")
  return `${hex}${tail}`
}

/**
 * Build the audit payload for the consent-spoken event. Pure function —
 * caller picks how to log (firebase logger, console.log, etc).
 */
export function buildConsentSpokenAudit(
  ctx: VoiceCallContext,
  promptText: string,
  spokenAt: Date = new Date(),
): ConsentSpokenAuditPayload {
  const lang: "en" | "zh" = ctx.userProfile.preferredLang === "zh" ? "zh" : "en"
  const voiceMode =
    ctx.purpose === "onboarding"
      ? "casual_onboarding"
      : ctx.prescreenConfig.voiceMode ?? "professional_prescreen"
  return {
    bookingId: ctx.bookingId,
    paUserId: ctx.userProfile.userId,
    lang,
    voiceMode,
    spokenAt: spokenAt.toISOString(),
    promptHash: fnv1aHex12(promptText),
  }
}

/**
 * Convenience: build payload and emit through a caller-supplied log fn.
 *
 *   emitConsentSpokenAudit(ctx, promptText, log)
 *   // → log("voice.tcpa.consent_spoken", { ... })
 */
export function emitConsentSpokenAudit(
  ctx: VoiceCallContext,
  promptText: string,
  log: (event: string, payload: Record<string, unknown>) => void,
  spokenAt: Date = new Date(),
): ConsentSpokenAuditPayload {
  const payload = buildConsentSpokenAudit(ctx, promptText, spokenAt)
  log("voice.tcpa.consent_spoken", payload as unknown as Record<string, unknown>)
  return payload
}
