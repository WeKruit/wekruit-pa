/**
 * stop-gate.test.ts — deterministic SMS STOP/START compliance gate.
 *
 * RED (pre-gate): a bare "STOP" flowed through as ordinary inbound text — no
 * doNotContact write, no confirmation, the agent chatted on (audit 2026-06-01 found
 * 0 captured bare-"STOP" replies). These tests drive the real runStopGate against an
 * in-memory Firestore stub and pin the compliance contract:
 *
 *   1. "STOP"  → doNotContact=true (+At/+Source) + exactly ONE confirmation + handled
 *      (agent must not run).
 *   2. "Stop." (trailing punctuation) → same.
 *   3. "stop sending me internships" → NOT the gate (preference statement — must
 *      reach the agent): handled=false, zero writes, zero sends.
 *   4. "START" while opted out → doNotContact=false + doNotContactResumedAt + ONE
 *      welcome-back confirmation; agent does not run this turn.
 *   5. Non-START inbound while opted out → swallowed silently (handled, ZERO sends).
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/stop-gate.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyOptOutKeyword, runStopGate, STOP_CONFIRMATION_TEXT, START_CONFIRMATION_TEXT } from "./stop-gate.js"

const USERS = "pa-users"

/** Minimal Firestore stub: doc get/set with merge capture. */
function makeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map<string, Record<string, unknown>>(
    Object.entries(seed).map(([path, data]) => [path, { ...data }]),
  )
  const sets: Array<{ path: string; data: Record<string, unknown> }> = []
  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          const path = `${name}/${id}`
          return {
            async get() {
              const data = docs.get(path)
              return { exists: data !== undefined, data: () => data }
            },
            async set(data: Record<string, unknown>, _opts?: { merge?: boolean }) {
              docs.set(path, { ...(docs.get(path) ?? {}), ...data })
              sets.push({ path, data })
            },
          }
        },
      }
    },
  } as never
  return { db, docs, sets }
}

function makeInput(text: string) {
  return {
    eventId: "evt-1",
    userId: "user-1",
    sessionId: "sess-1",
    toE164: "+15551234567",
    text,
  }
}

function captureSends() {
  const sent: string[] = []
  return {
    sent,
    sendConfirmation: async (text: string) => {
      sent.push(text)
    },
  }
}

/* ── classifier: exact-match discipline ──────────────────────────────────── */

test("classifyOptOutKeyword: every carrier-grade STOP keyword, case/punctuation-insensitive", () => {
  for (const t of [
    "stop", "STOP", "Stop.", "  stop  ", "stop!", "stopall", "STOP ALL", "stop all",
    "unsubscribe", "Cancel", "end", "Quit", "revoke", "optout", "Opt Out", "opt out.",
  ]) {
    assert.equal(classifyOptOutKeyword(t), "opt_out", `expected opt_out for ${JSON.stringify(t)}`)
  }
})

test("classifyOptOutKeyword: START-class keywords", () => {
  for (const t of ["start", "START", "Start.", "unstop", "opt in", "optin"]) {
    assert.equal(classifyOptOutKeyword(t), "opt_in", `expected opt_in for ${JSON.stringify(t)}`)
  }
})

test("classifyOptOutKeyword: anything beyond the bare keyword is NOT the gate", () => {
  for (const t of [
    "stop sending me internships",
    "please stop",
    "can you stop the recs",
    "i want to stop interviewing for a while",
    "start matching me",
    "endless roles please",
    "",
    "   ",
  ]) {
    assert.equal(classifyOptOutKeyword(t), null, `expected null for ${JSON.stringify(t)}`)
  }
})

/* ── STOP: opt-out write + one confirmation + agent does not run ─────────── */

test("STOP sets doNotContact + sends exactly one confirmation + handled (agent must not run)", async () => {
  const { db, docs } = makeDb({ [`${USERS}/user-1`]: { phoneE164: "+15551234567" } })
  const { sent, sendConfirmation } = captureSends()
  const result = await runStopGate(db, makeInput("STOP"), {
    sendConfirmation,
    filePrivacyRequest: async () => {},
    now: () => new Date("2026-06-10T00:00:00Z"),
  })
  assert.equal(result.handled, true)
  assert.equal(result.action, "opt_out")
  const user = docs.get(`${USERS}/user-1`)
  assert.equal(user?.doNotContact, true)
  assert.equal(user?.doNotContactAt, "2026-06-10T00:00:00.000Z")
  assert.equal(user?.doNotContactSource, "sms_stop_keyword")
  assert.deepEqual(sent, [STOP_CONFIRMATION_TEXT])
})

test("'Stop.' (trailing period) opts out exactly like STOP", async () => {
  const { db, docs } = makeDb()
  const { sent, sendConfirmation } = captureSends()
  const result = await runStopGate(db, makeInput("Stop."), {
    sendConfirmation,
    filePrivacyRequest: async () => {},
  })
  assert.equal(result.handled, true)
  assert.equal(result.action, "opt_out")
  assert.equal(docs.get(`${USERS}/user-1`)?.doNotContact, true)
  assert.equal(sent.length, 1)
})

test("STOP files a best-effort stop_outreach privacy request (audit trail)", async () => {
  const { db } = makeDb()
  const filed: string[] = []
  const { sendConfirmation } = captureSends()
  await runStopGate(db, makeInput("stop"), {
    sendConfirmation,
    filePrivacyRequest: async (nowIso) => {
      filed.push(nowIso)
    },
  })
  assert.equal(filed.length, 1)
})

test("privacy-request failure NEVER blocks the doNotContact write or the confirmation", async () => {
  const { db, docs } = makeDb()
  const { sent, sendConfirmation } = captureSends()
  const result = await runStopGate(db, makeInput("unsubscribe"), {
    sendConfirmation,
    filePrivacyRequest: async () => {
      throw new Error("schema friction")
    },
  })
  assert.equal(result.handled, true)
  assert.equal(docs.get(`${USERS}/user-1`)?.doNotContact, true)
  assert.deepEqual(sent, [STOP_CONFIRMATION_TEXT])
})

/* ── preference statements must reach the agent ──────────────────────────── */

test("'stop sending me internships' does NOT trigger the gate (reaches the agent)", async () => {
  const { db, sets } = makeDb({ [`${USERS}/user-1`]: { doNotContact: false } })
  const { sent, sendConfirmation } = captureSends()
  const result = await runStopGate(db, makeInput("stop sending me internships"), {
    sendConfirmation,
    filePrivacyRequest: async () => {},
  })
  assert.equal(result.handled, false)
  assert.equal(result.action, undefined)
  assert.equal(sets.length, 0, "no pa-users writes on a preference statement")
  assert.equal(sent.length, 0, "no confirmation on a preference statement")
})

/* ── START: resume ───────────────────────────────────────────────────────── */

test("START while opted out resumes: doNotContact=false + ResumedAt + one confirmation, agent does not run", async () => {
  const { db, docs } = makeDb({
    [`${USERS}/user-1`]: { doNotContact: true, doNotContactSource: "sms_stop_keyword" },
  })
  const { sent, sendConfirmation } = captureSends()
  const result = await runStopGate(db, makeInput("START"), {
    sendConfirmation,
    now: () => new Date("2026-06-11T00:00:00Z"),
  })
  assert.equal(result.handled, true)
  assert.equal(result.action, "opt_in")
  const user = docs.get(`${USERS}/user-1`)
  assert.equal(user?.doNotContact, false)
  assert.equal(user?.doNotContactResumedAt, "2026-06-11T00:00:00.000Z")
  assert.deepEqual(sent, [START_CONFIRMATION_TEXT])
})

/* ── opted-out suppression: nothing but START may be processed ───────────── */

test("non-START inbound while opted out is swallowed silently (handled, ZERO sends)", async () => {
  const { db, sets } = makeDb({ [`${USERS}/user-1`]: { doNotContact: true } })
  const { sent, sendConfirmation } = captureSends()
  const result = await runStopGate(db, makeInput("hey are you still there?"), {
    sendConfirmation,
  })
  assert.equal(result.handled, true)
  assert.equal(result.action, "suppressed_opted_out")
  assert.equal(sent.length, 0, "compliance: nothing may be sent after STOP except the START confirmation")
  assert.equal(sets.length, 0)
})

test("normal inbound for a non-opted-out user falls through to the rest of the pipeline", async () => {
  const { db } = makeDb({ [`${USERS}/user-1`]: { doNotContact: false } })
  const { sent, sendConfirmation } = captureSends()
  const result = await runStopGate(db, makeInput("can you pull some roles?"), { sendConfirmation })
  assert.equal(result.handled, false)
  assert.equal(sent.length, 0)
})

test("suppression read error fails OPEN (turn proceeds) — the same outage would fail the pipeline anyway", async () => {
  const db = {
    collection() {
      return {
        doc() {
          return {
            async get() {
              throw new Error("firestore unavailable")
            },
            async set() {
              throw new Error("firestore unavailable")
            },
          }
        },
      }
    },
  } as never
  const { sent, sendConfirmation } = captureSends()
  const result = await runStopGate(db, makeInput("hello"), { sendConfirmation })
  assert.equal(result.handled, false)
  assert.equal(sent.length, 0)
})

test("STOP with a failed doNotContact write still reports handled (agent must NOT chat past an opt-out) but does NOT claim the opt-out", async () => {
  const db = {
    collection() {
      return {
        doc() {
          return {
            async get() {
              throw new Error("firestore unavailable")
            },
            async set() {
              throw new Error("firestore unavailable")
            },
          }
        },
      }
    },
  } as never
  const { sent, sendConfirmation } = captureSends()
  const result = await runStopGate(db, makeInput("stop"), {
    sendConfirmation,
    filePrivacyRequest: async () => {},
  })
  assert.equal(result.handled, true, "a STOP turn is never routed to the agent, even on a write failure")
  assert.equal(sent.length, 0, "no 'you're opted out' claim when the opt-out was not recorded (retry will land both)")
})
