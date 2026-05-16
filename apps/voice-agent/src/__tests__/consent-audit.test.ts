/**
 * v2.1 S5 — consent-audit emitter tests.
 *
 * Confirms the audit payload shape + that emit calls the supplied log fn
 * with the canonical event name. No Firestore, no behavior change.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { buildConsentSpokenAudit, emitConsentSpokenAudit } from "../consent-audit.js"
import type { VoiceCallContext } from "../voice-context-types.js"

function ctx(opts: { lang?: "en" | "zh"; mode?: "casual_onboarding" | "professional_prescreen" } = {}): VoiceCallContext {
  return {
    bookingId: "bk_test",
    userProfile: { userId: "u_test", preferredLang: opts.lang, missingFields: [] },
    jobBrief: { jobId: "j_test", jobTitle: "T", companyName: "C", missingFields: [] },
    prescreenConfig: {
      jobId: "j_test",
      version: 1,
      jobTitle: "T",
      threshold: 0.5,
      confidenceThreshold: 0.5,
      maxClarifyRounds: 2,
      voiceMode: opts.mode ?? "professional_prescreen",
      questions: [],
      parsedFromZod: true,
      missingFields: [],
    },
  }
}

const SPOKEN_AT = new Date("2026-05-15T19:00:00Z")

test("buildConsentSpokenAudit: en/professional → expected shape", () => {
  const p = buildConsentSpokenAudit(ctx({ lang: "en" }), "Hi, this is Claire from WeKruit...", SPOKEN_AT)
  assert.equal(p.bookingId, "bk_test")
  assert.equal(p.paUserId, "u_test")
  assert.equal(p.lang, "en")
  assert.equal(p.voiceMode, "professional_prescreen")
  assert.equal(p.spokenAt, SPOKEN_AT.toISOString())
  assert.match(p.promptHash, /^[0-9a-f]{12}$/)
})

test("buildConsentSpokenAudit: zh", () => {
  const p = buildConsentSpokenAudit(ctx({ lang: "zh", mode: "casual_onboarding" }), "你好...", SPOKEN_AT)
  assert.equal(p.lang, "zh")
  assert.equal(p.voiceMode, "casual_onboarding")
})

test("buildConsentSpokenAudit: undefined lang → defaults to en", () => {
  const p = buildConsentSpokenAudit(ctx(), "text", SPOKEN_AT)
  assert.equal(p.lang, "en")
})

test("buildConsentSpokenAudit: promptHash is deterministic + sensitive to prompt change", () => {
  const a = buildConsentSpokenAudit(ctx({ lang: "en" }), "text-A", SPOKEN_AT)
  const b = buildConsentSpokenAudit(ctx({ lang: "en" }), "text-A", SPOKEN_AT)
  const c = buildConsentSpokenAudit(ctx({ lang: "en" }), "text-B", SPOKEN_AT)
  assert.equal(a.promptHash, b.promptHash, "same input → same hash")
  assert.notEqual(a.promptHash, c.promptHash, "different prompt → different hash")
})

test("emitConsentSpokenAudit: invokes log with canonical event name", () => {
  const calls: Array<{ event: string; payload: Record<string, unknown> }> = []
  const log = (event: string, payload: Record<string, unknown>) => calls.push({ event, payload })
  emitConsentSpokenAudit(ctx({ lang: "en" }), "test prompt", log, SPOKEN_AT)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.event, "voice.tcpa.consent_spoken")
  assert.equal(calls[0]!.payload.bookingId, "bk_test")
  assert.equal(calls[0]!.payload.paUserId, "u_test")
  assert.equal(calls[0]!.payload.lang, "en")
  assert.equal(calls[0]!.payload.spokenAt, SPOKEN_AT.toISOString())
})
