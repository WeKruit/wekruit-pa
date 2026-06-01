/**
 * STOP / START opt-out CONTROL capture tests.
 *
 * Covers the recovery-campaign safety lock: a candidate who texts a bare "STOP"
 * (or an explicit opt-out phrase) must be durably + reversibly PAUSED so the
 * outbound suppression gate (functions pending-outbound/suppression.ts reads
 * `pa-users.outreach.status === "paused"`) never re-pings them. "START" must
 * reverse the pause. Conservative detection must NOT pause a happy candidate
 * who merely uses the word "stop" in an unrelated sentence.
 *
 * These tests drive the REAL `detectPrivacyIntent` / `handlePrivacyIntent`
 * (exported from index.ts) against the in-memory map-db fake, so the assertions
 * are over the actual production write shape — not a stand-in.
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { InboundEvent } from "@pa/core-types"
import {
  detectPrivacyIntent,
  detectStopIntent,
  detectResumeIntent,
  handlePrivacyIntent,
  processInboundEvent,
  type OrchestratorStore,
} from "../index.js"

const NOW = "2026-06-01T12:00:00.000Z"

const baseEvent: InboundEvent = {
  id: "evt-stop-1",
  userId: "u-stop-1",
  sessionId: "s-1",
  channel: "imessage",
  externalChatId: "+13125550123",
  from: "+13125550123",
  body: "STOP",
  status: "pending",
  createdAt: NOW,
  idempotencyKey: "imessage-in-stop-1",
}

/** Map-db fake supporting collection().doc().set({merge})/get() — same shape the
 * production Firestore store exposes via `store.db`. */
function makeMapDb(docs: Map<string, Record<string, unknown>>): FirebaseFirestore.Firestore {
  return {
    collection(name: string) {
      return {
        doc(id: string) {
          const path = `${name}/${id}`
          return {
            async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
              const existing = opts?.merge ? (docs.get(path) ?? {}) : {}
              docs.set(path, { ...existing, ...data })
            },
            async get() {
              const data = docs.get(path)
              return { exists: Boolean(data), data: () => data }
            },
          }
        },
      }
    },
  } as unknown as FirebaseFirestore.Firestore
}

type Reply = { body: string }

function makeStore(
  docs: Map<string, Record<string, unknown>>,
  opts: { withPrivacyRequest?: boolean; replies?: Reply[] } = {},
): OrchestratorStore {
  const replies = opts.replies ?? []
  const store: Partial<OrchestratorStore> = {
    db: makeMapDb(docs),
    nowIso: () => NOW,
    updateTurn: async () => undefined,
    appendMessage: async (message: { body: string }) => {
      replies.push({ body: message.body })
    },
    enqueueOutbound: async () => undefined,
    listMemoryFacts: async () => [],
    recordMemoryAction: async () => undefined,
    log: () => undefined,
  }
  if (opts.withPrivacyRequest) {
    store.createPrivacyRequest = async (input) => ({
      requestId: "privacy_request_stop__test",
      kind: input.kind,
      created: true,
      existingOpen: false,
    })
  }
  return store as OrchestratorStore
}

// ---------------------------------------------------------------------------
// (a) bare "STOP" → pause is written in the exact shape the gate reads
// ---------------------------------------------------------------------------

test("REQUIRED(a): bare 'STOP' is detected as stop_outreach", () => {
  assert.deepEqual(detectPrivacyIntent("STOP"), { kind: "request", requestKind: "stop_outreach" })
  assert.equal(detectStopIntent("STOP"), true)
  assert.equal(detectStopIntent("stop."), true)
  assert.equal(detectStopIntent("Stop!"), true)
  assert.equal(detectStopIntent("please stop"), true)
  assert.equal(detectStopIntent("UNSUBSCRIBE"), true)
  assert.equal(detectStopIntent("cancel"), true)
  assert.equal(detectStopIntent("stop texting me"), true)
  assert.equal(detectStopIntent("take me off your list"), true)
})

test("REQUIRED(a): handling a bare 'STOP' durably PAUSES pa-users.outreach in the shape the suppression gate reads", async () => {
  const docs = new Map<string, Record<string, unknown>>()
  // seed a clean reachable user
  docs.set("pa-users/u-stop-1", { id: "u-stop-1", phoneE164: "+14243201960" })
  const replies: Reply[] = []
  const store = makeStore(docs, { withPrivacyRequest: true, replies })

  const intent = detectPrivacyIntent("STOP")
  assert.ok(intent)
  const handled = await handlePrivacyIntent(baseEvent, store, "turn-1", intent!)
  assert.equal(handled, true)

  const user = docs.get("pa-users/u-stop-1")!
  const outreach = user.outreach as Record<string, unknown>
  // EXACT shape isSuppressed() reads: outreach.status === "paused"
  assert.equal(outreach.status, "paused")
  assert.equal(outreach.source, "inbound_stop_keyword")
  assert.equal(outreach.pausedAt, NOW)
  assert.equal(outreach.lastStopText, "STOP")
  // confirm reply tells the candidate how to come back
  assert.ok(replies.some((r) => /stop texting/i.test(r.body) && /START/i.test(r.body)))
})

test("REQUIRED(a)+suppression: the paused doc that the handler wrote is what isSuppressed treats as suppressed", async () => {
  // The functions suppression gate has its own unit test proving
  // `outreach.status === "paused"` suppresses; here we assert the WRITTEN doc
  // matches that exact contract so the two halves connect.
  const docs = new Map<string, Record<string, unknown>>()
  docs.set("pa-users/u-stop-1", { id: "u-stop-1", phoneE164: "+14243201960" })
  const store = makeStore(docs, { withPrivacyRequest: true })
  await handlePrivacyIntent(baseEvent, store, "turn-1", { kind: "request", requestKind: "stop_outreach" })
  const outreach = (docs.get("pa-users/u-stop-1")!.outreach ?? {}) as { status?: string }
  // suppression.ts: `if (outreach?.status === "opted_out" || outreach?.status === "paused")`
  assert.equal(outreach.status === "paused", true)
})

// ---------------------------------------------------------------------------
// (b) false positive guard — happy candidate using "stop" in a sentence
// ---------------------------------------------------------------------------

test("REQUIRED(b): 'I cannot stop thinking about this job' does NOT pause (no false positive)", async () => {
  assert.equal(detectStopIntent("I cannot stop thinking about this job"), false)
  assert.equal(detectPrivacyIntent("I cannot stop thinking about this job"), null)
  // sanity: other innocuous uses of the substring are also safe
  assert.equal(detectStopIntent("the non-stop flights are brutal"), false)
  assert.equal(detectStopIntent("we shipped a stopgap fix"), false)
  assert.equal(detectStopIntent("can't stop won't stop, love this role"), false)

  // And driving the handler path: the user doc must be untouched.
  const docs = new Map<string, Record<string, unknown>>()
  docs.set("pa-users/u-stop-1", { id: "u-stop-1", phoneE164: "+14243201960" })
  const store = makeStore(docs, { withPrivacyRequest: true })
  const intent = detectPrivacyIntent("I cannot stop thinking about this job")
  assert.equal(intent, null) // never even routes to the privacy handler
  assert.equal(docs.get("pa-users/u-stop-1")!.outreach, undefined)
})

// ---------------------------------------------------------------------------
// (c) "START" after a pause resumes
// ---------------------------------------------------------------------------

test("REQUIRED(c): 'START' after a pause clears the pause (status back to active)", async () => {
  assert.equal(detectResumeIntent("START"), true)
  assert.deepEqual(detectPrivacyIntent("START"), { kind: "resume" })

  const docs = new Map<string, Record<string, unknown>>()
  // user is currently PAUSED
  docs.set("pa-users/u-stop-1", {
    id: "u-stop-1",
    phoneE164: "+14243201960",
    outreach: { status: "paused", pausedAt: NOW, source: "inbound_stop_keyword" },
  })
  const replies: Reply[] = []
  const store = makeStore(docs, { replies })

  const handled = await handlePrivacyIntent(
    { ...baseEvent, id: "evt-start-1", body: "START" },
    store,
    "turn-2",
    { kind: "resume" },
  )
  assert.equal(handled, true)
  const outreach = docs.get("pa-users/u-stop-1")!.outreach as Record<string, unknown>
  assert.equal(outreach.status, "active")
  assert.equal(outreach.resumedAt, NOW)
  assert.ok(replies.some((r) => /back in/i.test(r.body)))
})

test("RESUME never reactivates a true opted_out/deleted candidate", async () => {
  const docs = new Map<string, Record<string, unknown>>()
  docs.set("pa-users/u-stop-1", {
    id: "u-stop-1",
    phoneE164: "+14243201960",
    candidateLifecycleState: "opted_out",
    outreach: { status: "opted_out" },
  })
  const store = makeStore(docs)
  await handlePrivacyIntent(
    { ...baseEvent, body: "START" },
    store,
    "turn-3",
    { kind: "resume" },
  )
  // status must remain opted_out — START only clears a reversible "paused".
  const outreach = docs.get("pa-users/u-stop-1")!.outreach as Record<string, unknown>
  assert.equal(outreach.status, "opted_out")
})

test("STOP never downgrades an existing opted_out lifecycle to the weaker paused", async () => {
  const docs = new Map<string, Record<string, unknown>>()
  docs.set("pa-users/u-stop-1", {
    id: "u-stop-1",
    phoneE164: "+14243201960",
    candidateLifecycleState: "opted_out",
    outreach: { status: "opted_out" },
  })
  const store = makeStore(docs, { withPrivacyRequest: true })
  await handlePrivacyIntent(baseEvent, store, "turn-4", {
    kind: "request",
    requestKind: "stop_outreach",
  })
  const outreach = docs.get("pa-users/u-stop-1")!.outreach as Record<string, unknown>
  // stronger state preserved; only the stop text/timestamp recorded for audit
  assert.equal(outreach.status, "opted_out")
  assert.equal(outreach.lastStopText, "STOP")
})

// ---------------------------------------------------------------------------
// legacy narrow phrases still classify (back-compat)
// ---------------------------------------------------------------------------

test("legacy 'stop texting' / 'pause messages' still route to stop_outreach", () => {
  assert.deepEqual(detectPrivacyIntent("stop texting"), {
    kind: "request",
    requestKind: "stop_outreach",
  })
  assert.deepEqual(detectPrivacyIntent("please pause messages"), {
    kind: "request",
    requestKind: "stop_outreach",
  })
})

// ---------------------------------------------------------------------------
// FALSE-POSITIVE GUARD (audit high-finding): "remove me" / "take me off" are
// ONLY a global opt-out when bound to an outreach target. An engaged candidate
// declining a SINGLE role/list must NOT be globally silenced.
// ---------------------------------------------------------------------------

test("REQUIRED(false-positive): declining ONE role does NOT pause outreach", () => {
  for (const msg of [
    "please remove me from the Google role, location doesn't work",
    "Can you remove me from the data engineer one, not interested",
    "take me off the waitlist for the Stripe job",
    "take me off the night shift list",
    "remove me from the senior backend posting",
    "no, take me off if relocation is required",
  ]) {
    assert.equal(detectStopIntent(msg), false, `should NOT stop: ${msg}`)
    assert.equal(detectPrivacyIntent(msg), null, `should NOT route to privacy: ${msg}`)
  }
})

test("REQUIRED(outreach-bound): 'remove me' / 'take me off' bound to outreach DOES stop", () => {
  for (const msg of [
    "remove me from your list",
    "take me off the list",
    "remove me from all texts",
    "take me off your outreach",
    "remove me from everything",
    "take me off your list",
  ]) {
    assert.equal(detectStopIntent(msg), true, `should stop: ${msg}`)
  }
})

// ---------------------------------------------------------------------------
// INTEGRATION (audit high-finding): drive the REAL processInboundEvent so the
// inbound router ORDERING is exercised — not detectPrivacyIntent in isolation.
// Before the ordering fix, a lone "STOP"/"cancel"/"unsubscribe" was intercepted
// by detectJobRecommendationSubscriptionCancel and never reached the durable
// pause, so isSuppressed (which reads outreach.status) returned suppressed:false
// and the recovery campaign would re-ping. These tests assert the write shape
// the functions suppression gate reads (`outreach.status === "paused"`).
// ---------------------------------------------------------------------------

/** Full-enough OrchestratorStore fake to drive processInboundEvent through the
 * early control-keyword routing (markEvent* / createTurn / appendMessage /
 * safety-allow / privacy intent), backed by the same map-db used above so
 * applyOutreachPause's merge write lands in `docs`. */
function makeInboundStore(
  docs: Map<string, Record<string, unknown>>,
  capture: {
    assistantBodies: string[]
    enqueued: string[]
    recCancelInvoked: { value: boolean }
  },
): OrchestratorStore {
  const store: Partial<OrchestratorStore> = {
    db: makeMapDb(docs),
    nowIso: () => NOW,
    log: () => undefined,
    markEventRunning: async () => undefined,
    markEventSucceeded: async () => undefined,
    createTurn: async () => "turn-int",
    updateTurn: async () => undefined,
    appendMessage: async (message: { role?: string; body?: string }) => {
      if (message.role === "assistant" && typeof message.body === "string") {
        capture.assistantBodies.push(message.body)
      }
    },
    enqueueOutbound: async (_userId, _to, body: string) => {
      capture.enqueued.push(body)
    },
    maybeHandleResetCommand: async () => ({ handled: false }),
    checkInboundSafety: async () => ({ allow: true }),
    cancelAllPendingProactiveJobs: async () => 0,
    writeProactiveCancelAudit: async () => undefined,
    listMemoryFacts: async () => [],
    recordMemoryAction: async () => undefined,
    // If the rec-cancel path is wrongly taken, this flips true AND would write
    // only jobRecommendationSubscription.status (NOT the suppression-readable
    // outreach.status) — the exact bug the ordering fix prevents.
    pauseJobRecommendationSubscription: async () => {
      capture.recCancelInvoked.value = true
      return { paused: true }
    },
    resumeJobRecommendationSubscription: async () => ({ resumed: false }),
    createPrivacyRequest: async (input) => ({
      requestId: "pr-int",
      kind: input.kind,
      created: true,
      existingOpen: false,
    }),
  }
  return store as OrchestratorStore
}

for (const keyword of ["STOP", "cancel", "UNSUBSCRIBE", "stop."]) {
  test(`REQUIRED(integration): inbound '${keyword}' routes to the durable pause, NOT the rec-cancel path`, async () => {
    // Disable the humanize runtime so the reply text is the verbatim template
    // and no flag read is attempted against the minimal map-db.
    const prev = process.env.PA_HUMANIZE_RUNTIME_DISABLED
    process.env.PA_HUMANIZE_RUNTIME_DISABLED = "true"
    try {
      const docs = new Map<string, Record<string, unknown>>()
      docs.set("pa-users/u-stop-1", { id: "u-stop-1", phoneE164: "+14243201960" })
      const capture = {
        assistantBodies: [] as string[],
        enqueued: [] as string[],
        recCancelInvoked: { value: false },
      }
      const store = makeInboundStore(docs, capture)
      await processInboundEvent({ ...baseEvent, id: `evt-${keyword}`, body: keyword }, store)

      // 1. durable pause written in the shape isSuppressed reads
      const outreach = (docs.get("pa-users/u-stop-1")!.outreach ?? {}) as Record<string, unknown>
      assert.equal(outreach.status, "paused", `'${keyword}' must write outreach.status=paused`)
      assert.equal(outreach.source, "inbound_stop_keyword")
      // 2. the rec-cancel path must NOT have been taken (it does not suppress)
      assert.equal(
        capture.recCancelInvoked.value,
        false,
        `'${keyword}' must NOT be swallowed by the rec-subscription cancel path`,
      )
      // 3. carrier-standard confirm reply (mentions START), not the rec-cancel copy
      const replyText = [...capture.assistantBodies, ...capture.enqueued].join(" ")
      assert.match(replyText, /START/i, "reply must tell the candidate to text START")
      assert.doesNotMatch(
        replyText,
        /job recommendations/i,
        "must NOT use the rec-cancel reply copy",
      )
    } finally {
      if (prev === undefined) delete process.env.PA_HUMANIZE_RUNTIME_DISABLED
      else process.env.PA_HUMANIZE_RUNTIME_DISABLED = prev
    }
  })
}

test("REQUIRED(integration): noun-qualified 'cancel my job recs' still routes to the rec-cancel path", async () => {
  const prev = process.env.PA_HUMANIZE_RUNTIME_DISABLED
  process.env.PA_HUMANIZE_RUNTIME_DISABLED = "true"
  try {
    const docs = new Map<string, Record<string, unknown>>()
    docs.set("pa-users/u-stop-1", { id: "u-stop-1", phoneE164: "+14243201960" })
    const capture = {
      assistantBodies: [] as string[],
      enqueued: [] as string[],
      recCancelInvoked: { value: false },
    }
    const store = makeInboundStore(docs, capture)
    await processInboundEvent(
      { ...baseEvent, id: "evt-cancel-recs", body: "cancel my job recommendations" },
      store,
    )
    // This is NOT a carrier opt-out → it should take the rec-cancel path and
    // must NOT write the durable outreach pause.
    assert.equal(capture.recCancelInvoked.value, true)
    assert.equal(docs.get("pa-users/u-stop-1")!.outreach, undefined)
  } finally {
    if (prev === undefined) delete process.env.PA_HUMANIZE_RUNTIME_DISABLED
    else process.env.PA_HUMANIZE_RUNTIME_DISABLED = prev
  }
})

// ---------------------------------------------------------------------------
// RESUME falls through when NOT paused (audit medium-finding): a lone "START"
// from a never-paused user must NOT dead-end with "you're already active"; the
// turn should fall through to normal handling.
// ---------------------------------------------------------------------------

test("REQUIRED(resume-passthrough): 'START' on a never-paused user does NOT consume the turn", async () => {
  const docs = new Map<string, Record<string, unknown>>()
  // user exists but is NOT paused (no outreach.status, or status active)
  docs.set("pa-users/u-stop-1", { id: "u-stop-1", phoneE164: "+14243201960" })
  const replies: Reply[] = []
  const store = makeStore(docs, { replies })

  const handled = await handlePrivacyIntent(
    { ...baseEvent, id: "evt-start-passthrough", body: "START" },
    store,
    "turn-pass",
    { kind: "resume" },
  )
  // false → caller falls through to normal onboarding/handling
  assert.equal(handled, false)
  // no dead-end "already active" reply emitted
  assert.equal(replies.length, 0)
  // state untouched
  assert.equal(docs.get("pa-users/u-stop-1")!.outreach, undefined)
})
