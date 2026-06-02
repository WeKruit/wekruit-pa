/**
 * cutover.test.ts — DUP-SEND GUARD regression.
 *
 * Root cause (2026-06-02): with thin Claire ON for everyone, ONE signup fired TWO
 * onboarding openers. The kickoff is enqueued by enqueueRuntimeEventHandoff as a
 * SYNTHETIC inbound doc — body is a "[system-event:…]" directive, rawMeta.runtimeEvent
 * === true. The cutover seam read rawMeta but never branched on it, so thin answered the
 * synthetic directive AS IF it were a candidate message → opener #1; the candidate's real
 * broker "Hello, WeKruit!" handshake → opener #2.
 *
 * The guard (cutover.ts, just after rawMeta is read): rawMeta.runtimeEvent === true →
 * log("thin_claire.defer_runtime_event") + return false, so the LEGACY runtime-aware
 * composer (handleSharedOnboardingRuntimeEvent / index.ts runtimeEvent branch) owns
 * synthetic kickoffs and exactly ONE opener is sent.
 *
 * These tests drive the real maybeRunThinClaire against an in-memory Firestore stub:
 *  1. runtimeEvent=true  → returns false AND logs the defer (RED before guard, GREEN after).
 *  2. runtimeEvent absent + flag OFF → returns false WITHOUT the defer log (guard is narrow,
 *     it does not swallow real candidate turns).
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/cutover.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { maybeRunThinClaire } from "./cutover.js"

const INBOUND_COLLECTION = "pa-inbound-events"
const FLAG_COLLECTION = "pa-feature-flags"
const THIN_FLAG_KEY = "paThinClaireEnabled"

/**
 * Minimal Firestore stub: serves the inbound-event doc + (optionally) a thin-flag doc
 * whose perUser allowlist enables the test user. Only .collection(c).doc(id).get() is used
 * by the code path under test up to (and including) the guard.
 */
function makeDb(opts: {
  eventId: string
  inboundDoc: Record<string, unknown>
  thinEnabledForUser?: string // when set, the flag doc allowlists this uid → isThinClaireEnabled=true
}) {
  const docs: Record<string, Record<string, Record<string, unknown> | undefined>> = {
    [INBOUND_COLLECTION]: { [opts.eventId]: opts.inboundDoc },
    [FLAG_COLLECTION]: opts.thinEnabledForUser
      ? {
          [THIN_FLAG_KEY]: {
            key: THIN_FLAG_KEY,
            value: false,
            type: "bool",
            scope: "perUser",
            allowlist: [opts.thinEnabledForUser],
            blocklist: [],
          },
        }
      : {},
  }
  return {
    collection(name: string) {
      return {
        doc(id: string) {
          return {
            async get() {
              const data = docs[name]?.[id]
              return { exists: data !== undefined, data: () => data }
            },
          }
        },
      }
    },
  } as never
}

function spyLog() {
  const events: string[] = []
  return {
    events,
    log: (e: string) => {
      events.push(e)
    },
  }
}

test("runtime-event handoff (rawMeta.runtimeEvent=true) is DEFERRED to legacy — returns false + logs the defer", async () => {
  const eventId = "evt_runtime_kickoff"
  const userId = "u_dup_send"
  // Unique uid so getFlag's module cache (keyed by flag+userId) is fresh for this test.
  const uid = `${userId}_${Date.now()}_a`
  const db = makeDb({
    eventId,
    thinEnabledForUser: uid,
    inboundDoc: {
      userId: uid,
      sessionId: "ses_runtime",
      // The synthetic kickoff body buildRuntimeEventBody emits (truthy → passes the early guards).
      body: "[system-event:shared_onboarding:onboarding_started]\nAn external product event arrived.",
      fromNumber: "+14243201960",
      rawMeta: {
        source: "runtime_event_handoff",
        runtimeEvent: true,
        runtimeEventSource: "shared_onboarding",
        runtimeEventKind: "onboarding_started",
      },
    },
  })
  const { events, log } = spyLog()

  const handled = await maybeRunThinClaire(db, eventId, { log })

  assert.equal(handled, false, "thin must DEFER the synthetic runtime kickoff to legacy")
  assert.ok(
    events.includes("thin_claire.defer_runtime_event"),
    `expected defer log; got ${JSON.stringify(events)}`
  )
})

test("real candidate turn (no rawMeta.runtimeEvent) does NOT hit the runtime-event guard", async () => {
  const eventId = "evt_real_turn"
  const userId = "u_real_turn"
  // Flag OFF for this uid → returns false at the flag gate (BEFORE the heavy agent path),
  // so the test stays fast while still proving the guard did not fire for a non-runtime doc.
  const uid = `${userId}_${Date.now()}_b`
  const db = makeDb({
    eventId,
    // thinEnabledForUser omitted → flag doc absent → isThinClaireEnabled=false.
    inboundDoc: {
      userId: uid,
      sessionId: "ses_real",
      body: "hey, what kinds of roles do you have?",
      fromNumber: "+14243201960",
      rawMeta: { source: "sendblue_webhook" }, // no runtimeEvent marker
    },
  })
  const { events, log } = spyLog()

  const handled = await maybeRunThinClaire(db, eventId, { log })

  assert.equal(handled, false, "flag OFF → defer to legacy (unrelated to the runtime guard)")
  assert.equal(
    events.includes("thin_claire.defer_runtime_event"),
    false,
    "the runtime-event guard MUST NOT fire for a normal candidate message"
  )
})
