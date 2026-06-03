/**
 * gmail-nudge.test.ts — WS-3(b) deterministic Gmail-nudge gate (structured-field reducer, no regex).
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/gmail-nudge.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { shouldNudgeGmail, GMAIL_NUDGE_COOLDOWN_MS } from "./gmail-nudge.js"
import { buildClaireTurnContext } from "./prompt.js"

const NOW = Date.parse("2026-06-03T12:00:00.000Z")

test("eligible: canary, no email on file, not opted out, cooldown elapsed", () => {
  assert.equal(shouldNudgeGmail({ user: {}, isCanary: true, now: NOW }), true)
})

test("not eligible: non-canary", () => {
  assert.equal(shouldNudgeGmail({ user: {}, isCanary: false, now: NOW }), false)
})

test("not eligible: email already on file", () => {
  assert.equal(shouldNudgeGmail({ user: { email: "a@b.com" }, isCanary: true, now: NOW }), false)
  assert.equal(shouldNudgeGmail({ user: { normalizedEmail: "a@b.com" }, isCanary: true, now: NOW }), false)
})

test("not eligible: opted out / deleted", () => {
  assert.equal(shouldNudgeGmail({ user: { candidateState: "opted_out" }, isCanary: true, now: NOW }), false)
  assert.equal(shouldNudgeGmail({ user: { outreachOptedOut: true }, isCanary: true, now: NOW }), false)
})

test("not eligible: inside the cooldown window; eligible once past it", () => {
  const recent = { lastGmailNudgeAt: new Date(NOW - 60_000).toISOString() }
  assert.equal(shouldNudgeGmail({ user: recent, isCanary: true, now: NOW }), false)
  const old = { lastGmailNudgeAt: new Date(NOW - GMAIL_NUDGE_COOLDOWN_MS - 1_000).toISOString() }
  assert.equal(shouldNudgeGmail({ user: old, isCanary: true, now: NOW }), true)
})

test("not eligible: mid-onboarding question (don't interrupt the wall)", () => {
  assert.equal(
    shouldNudgeGmail({ user: {}, isCanary: true, onboardingAwaitingAnswer: true, now: NOW }),
    false,
  )
})

test("turn context: gmailNudge emits an optional-clause directive with the login link", () => {
  const ctx = buildClaireTurnContext({ mode: "triage", lang: "en", gmailNudge: true })
  assert.match(ctx, /GMAIL CONNECT/)
  assert.match(ctx, /\bwekruit\.com\/login/)
  assert.match(ctx, /optional/i)
})

test("turn context: NO gmail directive by default", () => {
  const ctx = buildClaireTurnContext({ mode: "triage", lang: "en" })
  assert.equal(/GMAIL CONNECT/.test(ctx), false)
})
