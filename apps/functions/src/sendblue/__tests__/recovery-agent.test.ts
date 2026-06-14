import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { inboundEventDocId } from "@pa/pa-broker"

import { paConversationRecoverySweepHandler, sweepUnansweredInboundForOperatorReview } from "../recovery-agent.js"

type DocData = Record<string, unknown>

const WEKRUIT = "+17174919939"

function rawDoc(input: {
  id: string
  from: string
  to: string
  content: string
  handle: string
  dateSent: string
  outbound?: boolean
}): [string, DocData] {
  return [
    input.id,
    {
      receivedAt: input.dateSent,
      bodyText: JSON.stringify({
        content: input.content,
        is_outbound: input.outbound === true,
        status: input.outbound ? "DELIVERED" : "RECEIVED",
        message_handle: input.handle,
        date_sent: input.dateSent,
        from_number: input.from,
        number: input.outbound ? input.to : input.from,
        to_number: input.to,
        sendblue_number: input.outbound ? null : WEKRUIT,
        service: "iMessage",
      }),
    },
  ]
}

function makeFakeDb(initial: Record<string, Record<string, DocData>> = {}) {
  const stores = new Map<string, Map<string, DocData>>()
  for (const [name, rows] of Object.entries(initial)) {
    stores.set(name, new Map(Object.entries(rows)))
  }
  const writes: Array<{ collection: string; id: string; data: DocData }> = []

  function storeFor(name: string): Map<string, DocData> {
    let store = stores.get(name)
    if (!store) {
      store = new Map()
      stores.set(name, store)
    }
    return store
  }

  function docRef(collection: string, id: string) {
    const store = storeFor(collection)
    return {
      id,
      async get() {
        const data = store.get(id)
        return { id, exists: data !== undefined, data: () => data }
      },
      async set(data: DocData, options?: { merge?: boolean }) {
        const next = options?.merge ? { ...(store.get(id) ?? {}), ...data } : { ...data }
        store.set(id, next)
        writes.push({ collection, id, data: next })
      },
      async create(data: DocData) {
        if (store.has(id)) {
          const err = new Error("already exists") as Error & { code?: number }
          err.code = 6
          throw err
        }
        store.set(id, { ...data })
        writes.push({ collection, id, data: { ...data } })
      },
      async update(data: DocData) {
        const next = { ...(store.get(id) ?? {}), ...data }
        store.set(id, next)
        writes.push({ collection, id, data: next })
      },
    }
  }

  function query(collection: string, filters: Array<[string, string, unknown]> = []) {
    let orderField: string | null = null
    let orderDir: "asc" | "desc" = "asc"
    let max = Number.POSITIVE_INFINITY
    return {
      where(field: string, op: string, value: unknown) {
        filters.push([field, op, value])
        return this
      },
      orderBy(field: string, dir: "asc" | "desc" = "asc") {
        orderField = field
        orderDir = dir
        return this
      },
      limit(n: number) {
        max = n
        return this
      },
      async get() {
        let rows = [...storeFor(collection).entries()]
        for (const [field, op, value] of filters) {
          rows = rows.filter(([, data]) => {
            if (op === "==") return data[field] === value
            if (op === ">=") return String(data[field] ?? "") >= String(value)
            return true
          })
        }
        if (orderField) {
          rows.sort(([, a], [, b]) => {
            const av = String(a[orderField!] ?? "")
            const bv = String(b[orderField!] ?? "")
            return orderDir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv)
          })
        }
        rows = rows.slice(0, max)
        const docs = rows.map(([id, data]) => ({
          id,
          ref: docRef(collection, id),
          data: () => data,
        }))
        return { docs, empty: docs.length === 0, size: docs.length }
      },
    }
  }

  const db = {
    collection(name: string) {
      return {
        doc(id: string) { return docRef(name, id) },
        where(field: string, op: string, value: unknown) { return query(name, [[field, op, value]]) },
        orderBy(field: string, dir: "asc" | "desc" = "asc") { return query(name).orderBy(field, dir) },
        limit(n: number) { return query(name).limit(n) },
        async get() { return query(name).get() },
      }
    },
  }

  return { db, stores, writes }
}

describe("paConversationRecoverySweepHandler", () => {
  it("replays an existing pending inbound event for true silent ordinary inbound", async () => {
    const phone = "+15550001001"
    const handle = "h-ordinary-1"
    const eventId = inboundEventDocId(`sendblue-${handle}`)
    const { db, stores } = makeFakeDb({
      "pa-sendblue-webhook-raw": Object.fromEntries([
        rawDoc({
          id: "raw-out",
          from: WEKRUIT,
          to: phone,
          content: "How did those roles feel?",
          handle: "h-out",
          dateSent: "2026-05-24T02:07:15.000Z",
          outbound: true,
        }),
        rawDoc({
          id: "raw-in",
          from: phone,
          to: WEKRUIT,
          content: "Product engineer",
          handle,
          dateSent: "2026-05-24T02:08:00.000Z",
        }),
      ]),
      "pa-inbound-events": {
        [eventId]: {
          id: eventId,
          status: "pending",
          idempotencyKey: `sendblue-${handle}`,
          createdAt: "2026-05-24T02:08:00.000Z",
        },
      },
    })
    const replayed: string[] = []

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:00:00.000Z"),
      processInboundEventById: async (id) => { replayed.push(id) },
      log: () => {},
    })

    assert.equal(result.recovered, 1)
    assert.deepEqual(replayed, [eventId])
    const cases = stores.get("pa-recovery-cases")!
    assert.equal(cases.size, 1)
    const recovery = [...cases.values()][0]!
    assert.equal(recovery.className, "true_silent_inbound")
    assert.equal(recovery.action, "replay_inbound_event")
    assert.equal(recovery.status, "verification_pending")
  })

  it("reconstructs a missing inbound event from raw Sendblue before replaying it", async () => {
    const phone = "+15550001002"
    const handle = "h-missing-event"
    const eventId = inboundEventDocId(`sendblue-${handle}`)
    const { db, stores } = makeFakeDb({
      "pa-sendblue-webhook-raw": Object.fromEntries([
        rawDoc({
          id: "raw-missing-event",
          from: phone,
          to: WEKRUIT,
          content: "I need roles which require 1-2 years.",
          handle,
          dateSent: "2026-05-24T02:08:00.000Z",
        }),
      ]),
    })
    const replayed: string[] = []

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:00:00.000Z"),
      processInboundEventById: async (id) => { replayed.push(id) },
      log: () => {},
    })

    assert.equal(result.recovered, 1)
    assert.deepEqual(replayed, [eventId])
    const event = stores.get("pa-inbound-events")!.get(eventId)!
    assert.equal(event.status, "pending")
    assert.equal(event.coalescing, false)
    assert.equal(event.recoveryCreatedFromRaw, true)
    assert.equal((event.rawPayload as DocData).text, "I need roles which require 1-2 years.")
    const recovery = [...stores.get("pa-recovery-cases")!.values()][0]!
    assert.equal(recovery.className, "true_silent_inbound")
    assert.equal(recovery.action, "create_and_replay_inbound_event")
    assert.equal(recovery.status, "verification_pending")
  })

  it("sends an identity notice for a prescreen token tied to another profile phone", async () => {
    const { db, stores } = makeFakeDb({
      "pa-sendblue-webhook-raw": Object.fromEntries([
        rawDoc({
          id: "raw-id-mismatch",
          from: "+15550002002",
          to: WEKRUIT,
          content: "WeKruit_hs-abc_user123_Job",
          handle: "h-identity",
          dateSent: "2026-05-24T02:08:00.000Z",
        }),
      ]),
      "pa-users": {
        user123: {
          phoneE164: "+15559999999",
        },
      },
    })

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:00:00.000Z"),
      log: () => {},
    })

    assert.equal(result.recovered, 1)
    const outbounds = [...stores.get("pa-outbound")!.values()]
    assert.equal(outbounds.length, 1)
    assert.equal(outbounds[0]!.toE164, "+15550002002")
    assert.equal(outbounds[0]!.runtimeSource, "pa_identity_notice")
    assert.match(String(outbounds[0]!.body), /different WeKruit profile number/)
  })

  it("starts a valid prescreen trigger when idempotency exists but no session or outbound exists", async () => {
    const phone = "+15550003003"
    const { db, stores } = makeFakeDb({
      "pa-sendblue-webhook-raw": Object.fromEntries([
        rawDoc({
          id: "raw-prescreen",
          from: phone,
          to: WEKRUIT,
          content: "WeKruit_hs-abc_user456_Job",
          handle: "h-prescreen",
          dateSent: "2026-05-24T02:08:00.000Z",
        }),
      ]),
      "pa-users": {
        user456: {
          phoneE164: phone,
        },
      },
      "pa-prescreen-trigger-idempotency": {
        "hs-abc_user456_h-prescreen": {
          jobId: "hs-abc",
          userId: "user456",
        },
      },
    })
    const started: Array<{ jobId: string; userId: string; toE164: string }> = []

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:00:00.000Z"),
      startPrescreen: async (input) => {
        started.push(input)
        return { ok: true, sessionId: "ps-1" }
      },
      log: () => {},
    })

    assert.equal(result.recovered, 1)
    assert.deepEqual(started, [{ jobId: "hs-abc", userId: "user456", toE164: phone }])
    const recovery = [...stores.get("pa-recovery-cases")!.values()][0]!
    assert.equal(recovery.className, "prescreen_idempotent_no_session_or_outbound")
    assert.equal(recovery.action, "start_prescreen")
    assert.equal(recovery.prescreenSessionId, "ps-1")
  })

  it("verifies a prior outbound recovery case once Sendblue delivery is recorded", async () => {
    const { db, stores } = makeFakeDb({
      "pa-recovery-cases": {
        "case-1": {
          status: "verification_pending",
          outboundId: "out-1",
          createdAt: "2026-05-26T00:00:00.000Z",
        },
      },
      "pa-outbound": {
        "out-1": {
          status: "sent",
          sendblueStatus: "DELIVERED",
          sendblueDeliveredAt: "2026-05-27T00:00:00.000Z",
        },
      },
    })

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:05:00.000Z"),
      log: () => {},
    })

    assert.equal(result.verified, 1)
    assert.equal(stores.get("pa-recovery-cases")!.get("case-1")!.status, "verified")
    assert.equal(stores.get("pa-recovery-cases")!.get("case-1")!.verifiedAt, "2026-05-27T00:05:00.000Z")
  })

  it("verifies a replay recovery case from later Sendblue outbound raw delivery", async () => {
    const phone = "+15550005005"
    const { db, stores } = makeFakeDb({
      "pa-recovery-cases": {
        "case-raw-outbound": {
          status: "verification_pending",
          action: "replay_inbound_event",
          phone,
          latestInboundAt: "2026-05-24T02:08:00.000Z",
        },
      },
      "pa-sendblue-webhook-raw": Object.fromEntries([
        rawDoc({
          id: "raw-in",
          from: phone,
          to: WEKRUIT,
          content: "Product engineer",
          handle: "h-in",
          dateSent: "2026-05-24T02:08:00.000Z",
        }),
        rawDoc({
          id: "raw-out",
          from: WEKRUIT,
          to: phone,
          content: "Got it. I will look for product engineering roles.",
          handle: "h-out",
          dateSent: "2026-05-24T02:09:00.000Z",
          outbound: true,
        }),
      ]),
    })

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:05:00.000Z"),
      log: () => {},
    })

    assert.equal(result.verified, 1)
    const recovery = stores.get("pa-recovery-cases")!.get("case-raw-outbound")!
    assert.equal(recovery.status, "verified")
    assert.equal(recovery.sendblueStatus, "DELIVERED")
    assert.equal(recovery.messageHandle, "h-out")
  })

  it("does not rerun action for an already recovered case", async () => {
    const phone = "+15550004004"
    const handle = "h-dedupe"
    const caseId = "sendblue_raw-in"
    const { db } = makeFakeDb({
      "pa-sendblue-webhook-raw": Object.fromEntries([
        rawDoc({
          id: "raw-in",
          from: phone,
          to: WEKRUIT,
          content: "Hello?",
          handle,
          dateSent: "2026-05-24T02:08:00.000Z",
        }),
      ]),
      "pa-recovery-cases": {
        [caseId]: {
          status: "recovered",
          className: "true_silent_inbound",
        },
      },
    })
    let replayed = 0

    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => new Date("2026-05-27T00:00:00.000Z"),
      processInboundEventById: async () => { replayed++ },
      log: () => {},
    })

    assert.equal(result.skippedExisting, 1)
    assert.equal(replayed, 0)
  })
})

// ---------------------------------------------------------------------------
// 2026-06-10 trust audit (fix 11) — unanswered-inbound ops queue.
// ---------------------------------------------------------------------------

describe("sweepUnansweredInboundForOperatorReview", () => {
  const NOW = new Date("2026-06-10T12:00:00.000Z")
  const HOUR = 60 * 60 * 1000
  const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()

  it("queues a needs_operator_review case for a user whose latest inbound is >6h old with no outbound after — deduped on re-run", async () => {
    const { db, stores } = makeFakeDb({
      "pa-inbound-events": {
        inb_old: {
          userId: "u-silent",
          createdAt: iso(8 * HOUR),
          body: "hey did my screen go through?",
          from: "+15550001001",
          status: "completed",
        },
        // a different user, answered: outbound exists after their inbound.
        inb_answered: {
          userId: "u-answered",
          createdAt: iso(9 * HOUR),
          body: "any update?",
          from: "+15550001002",
          status: "completed",
        },
      },
      "pa-outbound": {
        out_answered: {
          userId: "u-answered",
          createdAt: iso(7 * HOUR),
          status: "sent",
          body: "yes! here's the update",
        },
        // an OLD outbound for the silent user (BEFORE their inbound) does not count.
        out_stale: {
          userId: "u-silent",
          createdAt: iso(20 * HOUR),
          status: "sent",
          body: "earlier message",
        },
      },
    })

    const queued = await sweepUnansweredInboundForOperatorReview({
      db: db as never,
      now: () => NOW,
      log: () => {},
    })
    assert.equal(queued, 1, "only the silent user is queued")

    const cases = stores.get("pa-recovery-cases")!
    const row = cases.get("unanswered_u-silent_inb_old") as DocData
    assert.ok(row, "deterministic (userId, latest-inbound-id) case id")
    assert.equal(row.className, "unanswered_inbound_needs_operator_review")
    assert.equal(row.status, "needs_operator_review")
    assert.equal(row.userId, "u-silent")
    assert.equal(row.inboundEventId, "inb_old")
    assert.equal(row.phone, "+15550001001")
    assert.ok(!cases.has("unanswered_u-answered_inb_answered"), "answered user not queued")

    // Dedup: second sweep writes nothing new.
    const again = await sweepUnansweredInboundForOperatorReview({
      db: db as never,
      now: () => NOW,
      log: () => {},
    })
    assert.equal(again, 0, "dedup per (userId, latest-inbound-id)")
  })

  it("a RECENT latest inbound (<6h) is never queued, and the LATEST inbound wins over older ones", async () => {
    const { db, stores } = makeFakeDb({
      "pa-inbound-events": {
        inb_older: {
          userId: "u-1",
          createdAt: iso(10 * HOUR),
          body: "first message",
          from: "+15550001003",
        },
        inb_latest: {
          userId: "u-1",
          createdAt: iso(1 * HOUR),
          body: "second message",
          from: "+15550001003",
        },
      },
    })
    const queued = await sweepUnansweredInboundForOperatorReview({
      db: db as never,
      now: () => NOW,
      log: () => {},
    })
    assert.equal(queued, 0, "latest inbound is fresh → the user is not stale")
    assert.equal((stores.get("pa-recovery-cases") ?? new Map()).size, 0)
  })

  it("the full sweep handler surfaces unansweredQueued and stays fail-soft", async () => {
    const { db } = makeFakeDb({
      "pa-inbound-events": {
        inb_old: {
          userId: "u-silent",
          createdAt: iso(7 * HOUR),
          body: "hello?",
          from: "+15550001004",
        },
      },
    })
    const result = await paConversationRecoverySweepHandler({
      db: db as never,
      now: () => NOW,
      log: () => {},
    })
    assert.equal(result.unansweredQueued, 1)
  })

  // ── Feature 1: ALERT + ack/tapback exclusion ──────────────────────────────

  it("fires ONE batched alert for newly-queued users, idempotent on re-run", async () => {
    const { db, stores } = makeFakeDb({
      "pa-inbound-events": {
        inb_a: { userId: "u-a", createdAt: iso(8 * HOUR), body: "did my screen go through?", from: "+15550001010" },
        inb_b: { userId: "u-b", createdAt: iso(9 * HOUR), body: "what's the salary range?", from: "+15550001011" },
      },
    })
    const alerts: Array<Record<string, unknown>> = []
    const postSlackAlert = async (input: Record<string, unknown>) => {
      alerts.push(input)
      return { posted: true }
    }

    const queued = await sweepUnansweredInboundForOperatorReview({
      db: db as never,
      now: () => NOW,
      log: () => {},
      unansweredAlertEnabled: true,
      postSlackAlert: postSlackAlert as never,
    })
    assert.equal(queued, 2, "both substantive users queued")
    assert.equal(alerts.length, 1, "exactly ONE batched alert, not one-per-user")
    const alert = alerts[0]!
    assert.equal((alert as { level?: string }).level, "warn")
    assert.match(String((alert as { title?: string }).title), /2 candidate texts unanswered/)

    // alertedAt stamped on each case.
    const cases = stores.get("pa-recovery-cases")!
    assert.ok((cases.get("unanswered_u-a_inb_a") as DocData)?.alertedAt, "alertedAt stamped")

    // Re-run: cases already exist → nothing re-queued, no new alert.
    const again = await sweepUnansweredInboundForOperatorReview({
      db: db as never,
      now: () => NOW,
      log: () => {},
      unansweredAlertEnabled: true,
      postSlackAlert: postSlackAlert as never,
    })
    assert.equal(again, 0, "deduped on (userId, eventId)")
    assert.equal(alerts.length, 1, "no second alert on re-run")
  })

  it("EXCLUDES a thread whose last inbound is a pure ack ('thanks') — no queue, no alert", async () => {
    const { db, stores } = makeFakeDb({
      "pa-inbound-events": {
        // pure-ack user: a prior outbound exists (followsClaireMessage = true).
        inb_ack: { userId: "u-ack", createdAt: iso(8 * HOUR), body: "thanks!", from: "+15550001020" },
      },
      "pa-outbound": {
        out_prior: { userId: "u-ack", createdAt: iso(9 * HOUR), status: "sent", body: "here are your matches" },
      },
    })
    const alerts: unknown[] = []
    const queued = await sweepUnansweredInboundForOperatorReview({
      db: db as never,
      now: () => NOW,
      log: () => {},
      unansweredAlertEnabled: true,
      postSlackAlert: (async (i: unknown) => { alerts.push(i); return { posted: true } }) as never,
    })
    assert.equal(queued, 0, "a 'thanks' ack owes no reply → not queued")
    assert.equal(alerts.length, 0, "no alert for an ack")
    assert.equal((stores.get("pa-recovery-cases") ?? new Map()).size, 0)
  })

  it("EXCLUDES a thread acknowledged via tapback (pa-inbound-acks marker exists)", async () => {
    const { db, stores } = makeFakeDb({
      "pa-inbound-events": {
        // substantive-looking text, but Claire tapbacked it (durable marker).
        inb_tb: { userId: "u-tb", createdAt: iso(8 * HOUR), body: "sounds great see you then", from: "+15550001030" },
      },
      "pa-inbound-acks": {
        inb_tb: { inboundEventId: "inb_tb", userId: "u-tb", via: "tapback", acknowledgedAt: iso(8 * HOUR) },
      },
    })
    const alerts: unknown[] = []
    const queued = await sweepUnansweredInboundForOperatorReview({
      db: db as never,
      now: () => NOW,
      log: () => {},
      unansweredAlertEnabled: true,
      postSlackAlert: (async (i: unknown) => { alerts.push(i); return { posted: true } }) as never,
    })
    assert.equal(queued, 0, "tapbacked inbound is handled → not queued")
    assert.equal(alerts.length, 0)
    assert.equal((stores.get("pa-recovery-cases") ?? new Map()).size, 0)
  })

  it("does NOT exclude a real pending QUESTION → it IS queued and alerted (fired once)", async () => {
    const { db } = makeFakeDb({
      "pa-inbound-events": {
        inb_q: { userId: "u-q", createdAt: iso(7 * HOUR), body: "wait can you re-send the link?", from: "+15550001040" },
      },
    })
    const alerts: unknown[] = []
    const queued = await sweepUnansweredInboundForOperatorReview({
      db: db as never,
      now: () => NOW,
      log: () => {},
      unansweredAlertEnabled: true,
      postSlackAlert: (async (i: unknown) => { alerts.push(i); return { posted: true } }) as never,
    })
    assert.equal(queued, 1, "a real pending question awaits a reply → queued")
    assert.equal(alerts.length, 1, "alert fired once")
  })

  it("does NOT alert when opt-in is disabled, but STILL queues the ops-review case", async () => {
    const { db, stores } = makeFakeDb({
      "pa-inbound-events": {
        inb_off: { userId: "u-off", createdAt: iso(8 * HOUR), body: "any update on my application?", from: "+15550001050" },
      },
    })
    const alerts: unknown[] = []
    const queued = await sweepUnansweredInboundForOperatorReview({
      db: db as never,
      now: () => NOW,
      log: () => {},
      unansweredAlertEnabled: false,
      postSlackAlert: (async (i: unknown) => { alerts.push(i); return { posted: true } }) as never,
    })
    assert.equal(queued, 1, "ops-queue row always writes regardless of alert opt-in")
    assert.equal(alerts.length, 0, "alert suppressed when not opted in")
    assert.ok((stores.get("pa-recovery-cases")!.get("unanswered_u-off_inb_off")))
  })

  it("a STOP/opt-out latest inbound is excluded from the alert (terminal)", async () => {
    const { db } = makeFakeDb({
      "pa-inbound-events": {
        inb_stop: { userId: "u-stop", createdAt: iso(8 * HOUR), body: "STOP", from: "+15550001060" },
      },
    })
    const alerts: unknown[] = []
    const queued = await sweepUnansweredInboundForOperatorReview({
      db: db as never,
      now: () => NOW,
      log: () => {},
      unansweredAlertEnabled: true,
      postSlackAlert: (async (i: unknown) => { alerts.push(i); return { posted: true } }) as never,
    })
    assert.equal(queued, 0, "STOP is terminal → not an unanswered case")
    assert.equal(alerts.length, 0)
  })
})
