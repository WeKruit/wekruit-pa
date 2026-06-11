/**
 * channel-health.test.ts — 2026-06-11 incident class (dead Sendblue sender).
 *
 * Pure verdict helpers + a runner test against a fake Firestore. The fixture
 * mirrors the real incident: +17174919939 dead/removed from the active pool
 * while users still carry it as senderNumber.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import {
  evaluateDeadSenderAssignments,
  evaluateOutboundHealth,
  evaluateInboundLiveness,
  paChannelHealthHandler,
  SAMPLE_USER_IDS_MAX,
  WINDOW_MS,
} from "./channel-health.js"

const NOW = new Date("2026-06-11T08:00:00Z")
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()
const HOUR = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// evaluateDeadSenderAssignments — the exact check that catches the incident
// ---------------------------------------------------------------------------

describe("evaluateDeadSenderAssignments", () => {
  it("flags users whose senderNumber is not in the active pool (the +17174919939 incident)", () => {
    const verdict = evaluateDeadSenderAssignments(
      ["+13054507715", "+19998887777"],
      [
        { id: "u1", senderNumber: "+17174919939" }, // dead — number left the pool
        { id: "u2", senderNumber: "+17174919939" },
        { id: "u3", senderNumber: "+13054507715" }, // healthy
        { id: "u4" }, // unassigned ≠ dead
        { id: "u5", senderNumber: "" }, // blank ≠ dead
      ],
    )
    assert.equal(verdict.zeroActivePool, false)
    assert.equal(verdict.count, 2)
    assert.deepEqual(verdict.numbers, ["+17174919939"])
    assert.deepEqual(verdict.sampleUserIds, ["u1", "u2"])
  })

  it("treats a number with non-active status as dead (paused/degraded numbers are not 'live')", () => {
    // Caller only passes ACTIVE numbers; a paused number is simply absent.
    const verdict = evaluateDeadSenderAssignments(
      ["+13054507715"],
      [{ id: "u1", senderNumber: "+17174919939" }],
    )
    assert.equal(verdict.count, 1)
    assert.deepEqual(verdict.numbers, ["+17174919939"])
  })

  it("zero active pool numbers → zeroActivePool=true and every assigned user is dead", () => {
    const verdict = evaluateDeadSenderAssignments(
      [],
      [
        { id: "u1", senderNumber: "+17174919939" },
        { id: "u2", senderNumber: "+13054507715" },
        { id: "u3" },
      ],
    )
    assert.equal(verdict.zeroActivePool, true)
    assert.equal(verdict.count, 2)
    assert.deepEqual(verdict.numbers, ["+13054507715", "+17174919939"])
  })

  it("caps sampleUserIds at 10 while count keeps the full total", () => {
    const users = Array.from({ length: 25 }, (_, i) => ({
      id: `u${i}`,
      senderNumber: "+17174919939",
    }))
    const verdict = evaluateDeadSenderAssignments(["+13054507715"], users)
    assert.equal(verdict.count, 25)
    assert.equal(verdict.sampleUserIds.length, SAMPLE_USER_IDS_MAX)
  })

  it("healthy fleet → count 0", () => {
    const verdict = evaluateDeadSenderAssignments(
      ["+13054507715"],
      [{ id: "u1", senderNumber: "+13054507715" }, { id: "u2" }],
    )
    assert.equal(verdict.zeroActivePool, false)
    assert.equal(verdict.count, 0)
    assert.deepEqual(verdict.numbers, [])
  })
})

// ---------------------------------------------------------------------------
// evaluateOutboundHealth
// ---------------------------------------------------------------------------

describe("evaluateOutboundHealth", () => {
  const rows = (sent: number, failed: number, deadLetter = 0) => [
    ...Array.from({ length: sent }, () => ({ status: "sent" })),
    ...Array.from({ length: failed }, () => ({ status: "failed" })),
    ...Array.from({ length: deadLetter }, () => ({ status: "dead_letter_rate_limited" })),
  ]

  it("no breach under both thresholds (10 failures over 200 sends = 5%)", () => {
    const v = evaluateOutboundHealth(rows(200, 10))
    assert.equal(v.sent, 200)
    assert.equal(v.failed, 10)
    assert.equal(v.breached, false)
    assert.equal(v.reason, null)
  })

  it("breaches on failure rate > 10% (12 failures / 100 sends)", () => {
    const v = evaluateOutboundHealth(rows(100, 12))
    assert.equal(v.breached, true)
    assert.equal(v.reason, "failure_rate")
  })

  it("exactly 10% does NOT breach (threshold is strict >)", () => {
    const v = evaluateOutboundHealth(rows(100, 10))
    assert.equal(v.breached, false)
  })

  it("breaches on > 20 absolute failures even at low rate (21 / 1000)", () => {
    const v = evaluateOutboundHealth(rows(1000, 15, 6))
    assert.equal(v.failed, 21)
    assert.equal(v.breached, true)
    assert.equal(v.reason, "absolute_failures")
  })

  it("exactly 20 absolute at low rate does NOT breach", () => {
    const v = evaluateOutboundHealth(rows(1000, 20))
    assert.equal(v.breached, false)
  })

  it("counts dead_letter_rate_limited as failure; delivered as sent; ignores pending", () => {
    const v = evaluateOutboundHealth([
      { status: "delivered" },
      { status: "sent" },
      { status: "dead_letter_rate_limited" },
      { status: "pending" },
      { status: "sending" },
    ])
    assert.equal(v.sent, 2)
    assert.equal(v.failed, 1)
  })

  it("zero sends + few failures → rate null, no breach until absolute threshold", () => {
    const v = evaluateOutboundHealth(rows(0, 3))
    assert.equal(v.failureRate, null)
    assert.equal(v.breached, false)
    const v2 = evaluateOutboundHealth(rows(0, 21))
    assert.equal(v2.breached, true)
    assert.equal(v2.reason, "absolute_failures")
  })
})

// ---------------------------------------------------------------------------
// evaluateInboundLiveness
// ---------------------------------------------------------------------------

describe("evaluateInboundLiveness", () => {
  it("zero inbound + outbound sends > 0 → inbound-dead CRITICAL condition", () => {
    const v = evaluateInboundLiveness(0, 42)
    assert.equal(v.inboundDead, true)
  })

  it("zero inbound + zero outbound → not flagged (quiet day, not a dead webhook)", () => {
    assert.equal(evaluateInboundLiveness(0, 0).inboundDead, false)
  })

  it("any inbound traffic → healthy", () => {
    assert.equal(evaluateInboundLiveness(1, 500).inboundDead, false)
  })
})

// ---------------------------------------------------------------------------
// Runner — fake db (supports == and > where ops + bare limit scans)
// ---------------------------------------------------------------------------

type DocData = Record<string, unknown>

function makeFakeDb(initial: Record<string, Record<string, DocData>> = {}) {
  const stores = new Map<string, Map<string, DocData>>()
  for (const [coll, docs] of Object.entries(initial)) {
    stores.set(coll, new Map(Object.entries(docs)))
  }
  function bucket(coll: string): Map<string, DocData> {
    if (!stores.has(coll)) stores.set(coll, new Map())
    return stores.get(coll)!
  }
  function snapOf(entries: Array<[string, DocData]>) {
    const docs = entries.map(([id, data]) => ({ id, data: () => data }))
    return { docs, empty: docs.length === 0, size: docs.length }
  }
  const db = {
    collection(coll: string) {
      return {
        limit(max: number) {
          return {
            async get() {
              return snapOf([...bucket(coll).entries()].slice(0, max))
            },
          }
        },
        where(field: string, op: string, value: unknown) {
          return {
            limit(max: number) {
              return {
                async get() {
                  const match = (d: DocData) =>
                    op === "==" ? d[field] === value : String(d[field] ?? "") > String(value)
                  return snapOf(
                    [...bucket(coll).entries()].filter(([, d]) => match(d)).slice(0, max),
                  )
                },
              }
            },
          }
        },
      }
    },
  } as unknown as Firestore
  return { db, stores }
}

function captureDeps() {
  const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
  const alerts: Array<Record<string, unknown>> = []
  return {
    logs,
    alerts,
    log: (event: string, payload?: Record<string, unknown>) => {
      logs.push({ event, payload })
    },
    postSlackAlert: (async (input: Record<string, unknown>) => {
      alerts.push(input)
      return { posted: true }
    }) as never,
  }
}

describe("paChannelHealthHandler (runner, fake db)", () => {
  it("replays the 2026-06-11 incident: dead number still assigned → ERROR log + Slack alert", async () => {
    const { db } = makeFakeDb({
      "pa-sendblue-numbers": {
        "+13054507715": { status: "active" },
        "+17174919939": { status: "degraded" }, // the incident number — no longer active
      },
      "pa-users": {
        u1: { senderNumber: "+17174919939" },
        u2: { senderNumber: "+17174919939" },
        u3: { senderNumber: "+13054507715" },
        u4: {},
      },
      "pa-outbound": {
        o1: { status: "sent", createdAt: iso(1 * HOUR) },
        o2: { status: "delivered", createdAt: iso(2 * HOUR) },
      },
      "pa-inbound-events": {
        i1: { createdAt: iso(3 * HOUR) },
      },
    })
    const cap = captureDeps()
    const result = await paChannelHealthHandler({ db, now: () => NOW, ...cap })

    assert.deepEqual(result.activePoolNumbers, ["+13054507715"])
    assert.equal(result.deadSender.count, 2)
    assert.deepEqual(result.deadSender.numbers, ["+17174919939"])
    assert.deepEqual(result.deadSender.sampleUserIds.sort(), ["u1", "u2"])
    assert.equal(result.errors, 0)

    const deadLog = cap.logs.find((l) => l.event === "pa.channel.dead_sender_assignment")
    assert.ok(deadLog, "expected pa.channel.dead_sender_assignment log")
    assert.equal(deadLog!.payload?.severity, "ERROR")
    assert.equal(deadLog!.payload?.count, 2)
    assert.deepEqual(deadLog!.payload?.numbers, ["+17174919939"])
    assert.equal((deadLog!.payload?.sampleUserIds as string[]).length, 2)

    assert.equal(cap.alerts.length, 1)
    assert.match(String(cap.alerts[0].title), /Dead Sendblue sender-number/)
    // Healthy outbound + inbound: no extra alerts
    assert.equal(result.outbound.breached, false)
    assert.equal(result.inbound.inboundDead, false)
  })

  it("zero active pool numbers → CRITICAL alert", async () => {
    const { db } = makeFakeDb({
      "pa-sendblue-numbers": { "+17174919939": { status: "paused" } },
      "pa-users": { u1: { senderNumber: "+17174919939" } },
    })
    const cap = captureDeps()
    const result = await paChannelHealthHandler({ db, now: () => NOW, ...cap })

    assert.equal(result.deadSender.zeroActivePool, true)
    const critical = cap.logs.find((l) => l.event === "pa.channel.zero_active_pool")
    assert.ok(critical)
    assert.equal(critical!.payload?.severity, "CRITICAL")
    assert.ok(cap.alerts.some((a) => /ZERO active numbers/.test(String(a.title))))
    // ...and the assigned user is also a dead assignment
    assert.equal(result.deadSender.count, 1)
  })

  it("inbound-dead: zero inbound in 24h while outbound sent > 0 → CRITICAL alert", async () => {
    const { db } = makeFakeDb({
      "pa-sendblue-numbers": { "+13054507715": { status: "active" } },
      "pa-users": { u1: { senderNumber: "+13054507715" } },
      "pa-outbound": {
        o1: { status: "sent", createdAt: iso(1 * HOUR) },
        o2: { status: "sent", createdAt: iso(5 * HOUR) },
        // outside the 24h window — must NOT count
        oOld: { status: "failed", createdAt: iso(WINDOW_MS + HOUR) },
      },
      "pa-inbound-events": {
        // only a stale event outside the window
        iOld: { createdAt: iso(WINDOW_MS + 2 * HOUR) },
      },
    })
    const cap = captureDeps()
    const result = await paChannelHealthHandler({ db, now: () => NOW, ...cap })

    assert.equal(result.outbound.sent, 2)
    assert.equal(result.outbound.failed, 0, "stale failed row outside window must not count")
    assert.equal(result.inbound.inboundCount, 0)
    assert.equal(result.inbound.inboundDead, true)
    const log = cap.logs.find((l) => l.event === "pa.channel.inbound_dead")
    assert.ok(log)
    assert.equal(log!.payload?.severity, "CRITICAL")
    assert.ok(cap.alerts.some((a) => /inbound-dead/.test(String(a.title))))
  })

  it("outbound failure breach (>20 absolute) alerts; healthy checks stay quiet", async () => {
    const outbound: Record<string, DocData> = {}
    for (let i = 0; i < 30; i++) outbound[`s${i}`] = { status: "sent", createdAt: iso(HOUR) }
    for (let i = 0; i < 21; i++) outbound[`f${i}`] = { status: "failed", createdAt: iso(HOUR) }
    const { db } = makeFakeDb({
      "pa-sendblue-numbers": { "+13054507715": { status: "active" } },
      "pa-users": { u1: { senderNumber: "+13054507715" } },
      "pa-outbound": outbound,
      "pa-inbound-events": { i1: { createdAt: iso(HOUR) } },
    })
    const cap = captureDeps()
    const result = await paChannelHealthHandler({ db, now: () => NOW, ...cap })

    assert.equal(result.outbound.failed, 21)
    assert.equal(result.outbound.breached, true)
    assert.equal(result.outbound.reason, "absolute_failures")
    assert.equal(cap.alerts.length, 1)
    assert.match(String(cap.alerts[0].title), /Outbound failure/)
  })

  it("all healthy → single pa.channel.health_ok log, zero alerts", async () => {
    const { db } = makeFakeDb({
      "pa-sendblue-numbers": { "+13054507715": { status: "active" } },
      "pa-users": { u1: { senderNumber: "+13054507715" }, u2: {} },
      "pa-outbound": { o1: { status: "sent", createdAt: iso(HOUR) } },
      "pa-inbound-events": { i1: { createdAt: iso(HOUR) } },
    })
    const cap = captureDeps()
    const result = await paChannelHealthHandler({ db, now: () => NOW, ...cap })

    assert.equal(result.errors, 0)
    assert.equal(cap.alerts.length, 0)
    assert.ok(cap.logs.some((l) => l.event === "pa.channel.health_ok"))
  })

  it("range-query rejection falls back to bounded scan + client-side filter", async () => {
    // Fake db whose where(createdAt, '>') throws — simulates a missing index /
    // rejected range query; runner must still produce correct window counts.
    const base = makeFakeDb({
      "pa-sendblue-numbers": { "+13054507715": { status: "active" } },
      "pa-users": { u1: { senderNumber: "+13054507715" } },
      "pa-outbound": {
        o1: { status: "sent", createdAt: iso(HOUR) },
        oOld: { status: "sent", createdAt: iso(WINDOW_MS + HOUR) },
      },
      "pa-inbound-events": { i1: { createdAt: iso(HOUR) } },
    })
    const db = {
      collection(coll: string) {
        const real = (base.db as unknown as { collection: (c: string) => any }).collection(coll)
        return {
          ...real,
          where(field: string, op: string, value: unknown) {
            if (op === ">") {
              return {
                limit() {
                  return {
                    async get() {
                      throw new Error("FAILED_PRECONDITION: query requires an index")
                    },
                  }
                },
              }
            }
            return real.where(field, op, value)
          },
        }
      },
    } as unknown as Firestore
    const cap = captureDeps()
    const result = await paChannelHealthHandler({ db, now: () => NOW, ...cap })

    assert.equal(result.errors, 0)
    assert.equal(result.outbound.sent, 1, "stale row must be filtered client-side")
    assert.equal(result.inbound.inboundCount, 1)
    assert.equal(cap.alerts.length, 0)
  })

  it("Slack alert failure is fail-soft (run completes, errors not inflated by alert)", async () => {
    const { db } = makeFakeDb({
      "pa-sendblue-numbers": {},
      "pa-users": { u1: { senderNumber: "+17174919939" } },
    })
    const logs: Array<{ event: string }> = []
    const result = await paChannelHealthHandler({
      db,
      now: () => NOW,
      log: (event) => logs.push({ event }),
      postSlackAlert: (async () => {
        throw new Error("slack down")
      }) as never,
    })
    assert.equal(result.deadSender.zeroActivePool, true)
    assert.equal(result.deadSender.count, 1)
    assert.equal(result.alertsSent, 0)
    assert.ok(logs.some((l) => l.event === "pa.channel.dead_sender_assignment"))
  })
})
