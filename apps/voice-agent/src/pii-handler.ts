/**
 * v2.1 S2 — Voice PII handler (L6 enforcement).
 *
 * Lock L6: "No PII via voice. When `VoiceUserProfile.piiConsentAt === undefined`,
 * the worker MUST NOT speak email / phone / apply URL / salary. Hand off to SMS
 * instead (mark in turn output for orchestrator-side SMS dispatch)."
 *
 * This module is the redaction step between `PreScreenPipeline.runTurn`'s
 * agent text and the TTS plugin. It is intentionally PURE (no Firestore, no
 * Sendblue, no fs). The SMS dispatch itself is S5's responsibility; we only
 * mark which slices were redacted and what kind they are.
 *
 * Behavior:
 *   - `piiConsentAt` present (any non-empty string) → passthrough.
 *   - Otherwise → 4 regex passes, replace each match with a stable token
 *     `[sms_handoff:<kind>:<index>]`, accumulate slices in
 *     `smsHandoffTokens` for downstream SMS dispatch.
 *
 * Regex notes:
 *   - We intentionally keep regexes conservative + readable. False positives
 *     are preferable to PII leakage. A future LLM-based PII detector (D15)
 *     can replace these, but the deterministic regex pass is the safe
 *     floor for v2.1 dev smoke.
 *   - URLs are matched first so phone numbers / amounts embedded inside a
 *     URL don't get double-redacted with conflicting tokens.
 */

import type { VoiceUserProfile } from "./voice-context-types.js"

export type PiiKind = "email" | "phone" | "amount" | "url"

export interface PiiHandlerInput {
  agentText: string
  profile: Pick<VoiceUserProfile, "piiConsentAt"> & Partial<VoiceUserProfile>
}

export interface PiiHandoffToken {
  /** The synthetic token inserted into `speakText`. */
  token: string
  /** Which detector flagged this slice. */
  kind: PiiKind
  /** The redacted source text (kept so S5's SMS dispatcher can emit it). */
  source: string
  /** Start offset in original `agentText`. */
  start: number
  /** End offset in original `agentText`. */
  end: number
}

export interface PiiHandlerOutput {
  /** Safe text to feed into TTS. */
  speakText: string
  /** Slices that were redacted, ordered by position. Empty when consent given. */
  smsHandoffTokens: PiiHandoffToken[]
  /** True iff at least one slice was redacted. */
  redacted: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Regex bank (case-insensitive flag handled per-detector)
// ────────────────────────────────────────────────────────────────────────────

// Order matters: URL first so embedded numbers don't get matched standalone.
const DETECTORS: Array<{ kind: PiiKind; re: RegExp }> = [
  { kind: "url", re: /\bhttps?:\/\/\S+/gi },
  { kind: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  // E.164-style or NANP. Conservative: require + or 10+ digits with optional
  // separators. Avoids matching short numeric quantities like "5 years".
  {
    kind: "phone",
    re: /(\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/g,
  },
  // Salary / dollar amounts. Two flavors:
  //   $120000, $120,000, $120.5K
  //   120k, 120K (when standalone in compensation context)
  {
    kind: "amount",
    re: /(\$\s?\d{1,3}(?:[,.\d]{2,})(?:\.\d+)?|\b\d{2,3}[kK]\b)/g,
  },
]

/**
 * Has PII consent been recorded?
 *
 * Treats any truthy non-empty string as consent. Voice bridge S2 does not
 * validate the ISO format here — `VoiceUserProfile` field is loader-typed.
 */
export function hasVoicePiiConsent(profile: { piiConsentAt?: string }): boolean {
  return typeof profile.piiConsentAt === "string" && profile.piiConsentAt.length > 0
}

/**
 * Run the PII detectors and merge their hits into a single ordered list.
 *
 * If two detectors overlap, the FIRST one (per `DETECTORS` order) wins and
 * the second's match is suppressed.
 */
function findAllHits(text: string): PiiHandoffToken[] {
  type Raw = { kind: PiiKind; start: number; end: number; source: string }
  const raw: Raw[] = []
  for (const { kind, re } of DETECTORS) {
    re.lastIndex = 0 // safety reset
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      raw.push({
        kind,
        start: m.index,
        end: m.index + m[0].length,
        source: m[0],
      })
      if (m.index === re.lastIndex) re.lastIndex++ // zero-width safety
    }
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end)

  // Suppress overlaps: keep the first; drop anything starting before the
  // current "covered" boundary.
  const merged: PiiHandoffToken[] = []
  let covered = -1
  let idx = 0
  for (const hit of raw) {
    if (hit.start < covered) continue
    merged.push({
      kind: hit.kind,
      start: hit.start,
      end: hit.end,
      source: hit.source,
      token: `[sms_handoff:${hit.kind}:${idx}]`,
    })
    covered = hit.end
    idx++
  }
  return merged
}

export function redactForVoice(input: PiiHandlerInput): PiiHandlerOutput {
  const { agentText, profile } = input

  if (hasVoicePiiConsent(profile)) {
    return {
      speakText: agentText,
      smsHandoffTokens: [],
      redacted: false,
    }
  }

  if (!agentText || agentText.length === 0) {
    return {
      speakText: "",
      smsHandoffTokens: [],
      redacted: false,
    }
  }

  const hits = findAllHits(agentText)
  if (hits.length === 0) {
    return {
      speakText: agentText,
      smsHandoffTokens: [],
      redacted: false,
    }
  }

  // Walk hits in order, copy non-hit slices verbatim, splice in tokens.
  const parts: string[] = []
  let cursor = 0
  for (const hit of hits) {
    if (hit.start > cursor) parts.push(agentText.slice(cursor, hit.start))
    parts.push(hit.token)
    cursor = hit.end
  }
  if (cursor < agentText.length) parts.push(agentText.slice(cursor))
  const speakText = parts.join("")

  return {
    speakText,
    smsHandoffTokens: hits,
    redacted: true,
  }
}
