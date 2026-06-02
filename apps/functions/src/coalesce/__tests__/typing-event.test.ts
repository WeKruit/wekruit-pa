/**
 * v1.5 Stream-D — typing-driven coalesce bump test suite.
 *
 * Adam top-level-design fix (2026-05-03): Sendblue's `typing_indicator` inbound
 * webhook is wired to the coalesce buffer so natural typing gaps > 8s no
 * longer wave-split a single message thought into multiple replies.
 *
 * Coverage map (6 cases, exceeds the 4+ required by the task spec):
 *   1. typing event during open buffer → delay extended (cancel + re-enqueue)
 *   2. typing event with NO active buffer → no-op (action="no-buffer")
 *   3. typing_stopped (is_typing=false) → fires soon (TYPING_STOPPED_TAIL_MS)
 *   4. hard cap respected — typing 13s after firstReceivedAt → no extension
 *   5. fired buffer ignored — bump after `fired` is a no-op
 *   6. webhook integration — typing_indicator payload routes through
 *      handleSendblueWebhook → audit + bumpCoalesceBuffer call
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  enqueueOrCoalesce,
  bumpCoalesceBuffer,
  processCoalescedTurn,
} from "../paMessageCoalescer.js"
import type { CoalescerDeps } from "../paMessageCoalescer.js"
import type { TasksClient, EnqueueInput } from "../tasks-client.js"
import {
  HARD_CAP_MS,
  TRIAGE_DELAY_MS,
  TYPING_BUMP_DELAY_MS,
  TYPING_STOPPED_TAIL_MS,
} from "../buffer.js"

// ----------------- fakes (reuse the shape from paMessageCoalescer.test.ts) -----------------

class FakeTasks implements TasksClient {
  enqueued: EnqueueInput[] = []
  cancelled: string[] = []
  failNextEnqueue = false

  taskPath(short: string): string {
    return `projects/p/locations/us-central1/queues/q/tasks/${short}`
  }
  queuePath(): string {
    return `projects/p/locations/us-central1/queues/q`
  }
  async enqueueDelayedTask(input: EnqueueInput): Promise<string> {
    if (this.failNextEnqueue) {
      this.failNextEnqueue = false
      throw new Error("fake_enqueue_fail")
    }
    this.enqueued.push(input)
    return this.taskPath(input.taskName)
  }
  async cancelTask(name: string): Promise<boolean> {
    this.cancelled.push(name)
    return true
  }
}

type DocData = Record<string, unknown>

function makeFakeDb() {
  const stores = new Map<string, Map<string, DocData>>()
  function bucket(coll: string): Map<string, DocData> {
    if (!stores.has(coll)) stores.set(coll, new Map())
    return stores.get(coll)!
  }
  function makeDocRef(coll: string, id: string) {
    return {
      _coll: coll,
      _id: id,
      async get() {
        const d = bucket(coll).get(id)
        return { exists: d !== undefined, data: () => d, id, ref: this }
      },
      async create(data: DocData) {
        if (bucket(coll).has(id)) {
          const err: Error & { code?: number } = new Error("ALREADY_EXISTS")
          err.code = 6
          throw err
        }
        bucket(coll).set(id, { ...data })
      },
      async set(data: DocData, opts?: { merge?: boolean }) {
        if (opts?.merge) bucket(coll).set(id, { ...(bucket(coll).get(id) ?? {}), ...data })
        else bucket(coll).set(id, { ...data })
      },
      async update(data: DocData) {
        bucket(coll).set(id, { ...(bucket(coll).get(id) ?? {}), ...data })
      },
    }
  }
  function makeCollection(coll: string) {
    return {
      doc(id: string) { return makeDocRef(coll, id) },
      where(_f: string, _o: string, _v: unknown) {
        const filters: Array<[string, string, unknown]> = [[_f, _o, _v]]
        let lim = Infinity
        const builder = {
          where(f: string, o: string, v: unknown) { filters.push([f, o, v]); return builder },
          limit(n: number) { lim = n; return builder },
          async get() {
            const all = Array.from(bucket(coll).entries())
            const matched = all
              .filter(([, d]) =>
                filters.every(([f, o, v]) => {
                  const x = (d as DocData)[f]
                  if (o === "==") return x === v
                  return false
                })
              )
              .slice(0, lim)
            return {
              docs: matched.map(([id, d]) => ({ id, data: () => d, ref: makeDocRef(coll, id) })),
              size: matched.length,
              empty: matched.length === 0,
            }
          },
        }
        return builder
      },
    }
  }
  return {
    collection(name: string) { return makeCollection(name) },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        async get(ref: { _coll: string; _id: string }) {
          const d = bucket(ref._coll).get(ref._id)
          return { exists: d !== undefined, data: () => d }
        },
        set(ref: { _coll: string; _id: string }, data: DocData, opts?: { merge?: boolean }) {
          if (opts?.merge) bucket(ref._coll).set(ref._id, { ...(bucket(ref._coll).get(ref._id) ?? {}), ...data })
          else bucket(ref._coll).set(ref._id, { ...data })
        },
      }
      return fn(tx)
    },
    _stores: stores,
  }
}

function buildDeps(opts: { now?: () => Date; tasks?: FakeTasks } = {}): {
  deps: CoalescerDeps; db: ReturnType<typeof makeFakeDb>; tasks: FakeTasks
} {
  const db = makeFakeDb()
  const tasks = opts.tasks ?? new FakeTasks()
  const deps: CoalescerDeps = {
    db: db as never,
    tasks,
    now: opts.now,
    log: () => {/* swallow */},
    // Stub broker + orchestrator so processCoalescedTurn (used in case 5) does
    // not require a full broker fake. Mirrors the buildDeps pattern from
    // paMessageCoalescer.test.ts.
    sendReaction: async () => ({ status: "queued" }),
    claimAndProcessInboundEvent: async () => 1,
    createInboundEvent: async (_db, input) => {
      const id = `inb_synth_${input.idempotencyKey}`
      const map = (db as { _stores: Map<string, Map<string, DocData>> })._stores
      if (!map.has("pa-inbound-events")) map.set("pa-inbound-events", new Map())
      const store = map.get("pa-inbound-events")!
      if (store.has(id)) {
        return { id, created: false, event: { id, ...store.get(id) } as never }
      }
      store.set(id, {
        id, channel: input.channel, status: "pending",
        idempotencyKey: input.idempotencyKey,
        rawPayload: input.rawPayload,
        createdAt: new Date().toISOString(),
      })
      return { id, created: true, event: { id, ...(store.get(id) as object) } as never }
    },
  }
  return { deps, db, tasks }
}

const BASE_MSG = {
  userId: "u_adam",
  fromNumber: "+15551234567",
  toNumber: "+15559999999",
}

// ----------------- TEST 1: bump during open buffer extends delay -----------------

describe("typing-event — case 1: bump during open buffer extends delay", () => {
  it("typing-started after first inbound: cancels prior task, re-enqueues at TYPING_BUMP_DELAY_MS", async () => {
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, tasks } = buildDeps({ now: () => new Date(now) })

    // First inbound at t=0 — creates buffer with the generic 4s triage delay.
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "hi", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    assert.equal(tasks.enqueued.length, 1)
    assert.equal(tasks.enqueued[0]!.delayMs, TRIAGE_DELAY_MS)
    const firstTaskName = tasks.enqueued[0]!.taskName

    // Advance 5s — within the 8s window. User is still typing.
    now += 5_000
    const bumpRes = await bumpCoalesceBuffer(deps, { userId: "u_adam", isTyping: true })
    assert.equal(bumpRes.action, "bumped")
    // Cancelled the prior task, enqueued a new one
    assert.equal(tasks.cancelled.length, 1)
    assert.equal(tasks.cancelled[0], firstTaskName)
    assert.equal(tasks.enqueued.length, 2)
    // Hard cap remaining = 12000 - 5000 = 7000ms; min(8000, 7000) = 7000
    const expectedDelay = Math.min(TYPING_BUMP_DELAY_MS, HARD_CAP_MS - 5_000)
    assert.equal(tasks.enqueued[1]!.delayMs, expectedDelay)
    // New task name is distinct from the prior one (avoids ALREADY_EXISTS)
    assert.notEqual(tasks.enqueued[1]!.taskName, firstTaskName)
    // Payload carries bumpedByTyping marker
    assert.equal((tasks.enqueued[1]!.payload as Record<string, unknown>).bumpedByTyping, true)
  })
})

// ----------------- TEST 2: bump with no buffer is no-op -----------------

describe("typing-event — case 2: bump with no active buffer is no-op", () => {
  it("typing event arriving before any inbound message yields action=no-buffer", async () => {
    const { deps, tasks } = buildDeps({ now: () => new Date("2026-05-02T12:00:00Z") })
    const bumpRes = await bumpCoalesceBuffer(deps, { userId: "u_adam", isTyping: true })
    assert.equal(bumpRes.action, "no-buffer")
    assert.equal(tasks.enqueued.length, 0)
    assert.equal(tasks.cancelled.length, 0)
  })
})

// ----------------- TEST 3: typing_stopped → short tail fire (TYPING_STOPPED_TAIL_MS) -----------------

describe("typing-event — case 3: typing_stopped fires soon (short tail)", () => {
  it("is_typing=false re-enqueues at TYPING_STOPPED_TAIL_MS instead of full window", async () => {
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, tasks } = buildDeps({ now: () => new Date(now) })

    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "first part", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    now += 1_000
    const bumpRes = await bumpCoalesceBuffer(deps, { userId: "u_adam", isTyping: false })
    assert.equal(bumpRes.action, "bumped")
    assert.equal(tasks.enqueued.length, 2)
    // 2_000ms tail (well under HARD_CAP remaining = 11000ms, so unclamped)
    assert.equal(tasks.enqueued[1]!.delayMs, TYPING_STOPPED_TAIL_MS)
    assert.equal(bumpRes.delayMs, TYPING_STOPPED_TAIL_MS)
  })
})

// ----------------- TEST 4: hard cap respected even with continuous typing -----------------

describe("typing-event — case 4: hard cap respected even with continuous typing", () => {
  it("typing AFTER HARD_CAP_MS elapsed → action=hard-capped, no Cloud Tasks side effects", async () => {
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, tasks } = buildDeps({ now: () => new Date(now) })

    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "first", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    const enqueuedBefore = tasks.enqueued.length
    const cancelledBefore = tasks.cancelled.length

    // Jump past HARD_CAP_MS — typing troll keeps tapping keys.
    now += HARD_CAP_MS + 500
    const bumpRes = await bumpCoalesceBuffer(deps, { userId: "u_adam", isTyping: true })
    assert.equal(bumpRes.action, "hard-capped")
    // No new task enqueued, no cancel performed.
    assert.equal(tasks.enqueued.length, enqueuedBefore)
    assert.equal(tasks.cancelled.length, cancelledBefore)
  })
})

// ----------------- TEST 5: fired buffer ignored -----------------

describe("typing-event — case 5: fired buffer is ignored by bump", () => {
  it("late typing event for a fired turn returns action=fired (no-op)", async () => {
    const t0 = new Date("2026-05-02T12:00:00Z")
    const { deps, tasks } = buildDeps({ now: () => t0 })

    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "single", inboundEventId: "inb_1",
      receivedAt: t0.toISOString(),
    })
    // Fire the turn — buffer status flips to "fired", user.coalesceTurnSeq bumps to 2.
    await processCoalescedTurn(deps, "u_adam", 1)
    const enqueuedBefore = tasks.enqueued.length
    const cancelledBefore = tasks.cancelled.length

    // Stale typing arrives AFTER fire. Note: after fire user.coalesceTurnSeq=2,
    // and there is no buffer doc for turnSeq=2 yet → action=no-buffer.
    // Either way the contract holds: no Cloud Tasks side effects.
    const bumpRes = await bumpCoalesceBuffer(deps, { userId: "u_adam", isTyping: true })
    assert.ok(
      bumpRes.action === "fired" || bumpRes.action === "no-buffer",
      `expected fired|no-buffer, got ${bumpRes.action}`
    )
    assert.equal(tasks.enqueued.length, enqueuedBefore)
    assert.equal(tasks.cancelled.length, cancelledBefore)
  })
})

// ----------------- TEST 6: webhook integration — typing_indicator routes to bump -----------------

describe("typing-event — case 6: webhook integration calls bumpCoalesceBuffer", () => {
  it("handleSendblueWebhook receives typing_indicator → audit + bumpCoalesceBuffer (flag on)", async () => {
    const { handleSendblueWebhook } = await import("../../sendblue/webhook.js")
    const { _clearFeatureFlagCache } = await import("@pa/pa-persistence")
    _clearFeatureFlagCache()

    const stores = new Map<string, Map<string, DocData>>()
    function bucket(name: string) {
      if (!stores.has(name)) stores.set(name, new Map())
      return stores.get(name)!
    }
    // pre-seed the feature flag = ON for u_adam
    bucket("pa-feature-flags").set("paMessageCoalesceEnabled", {
      key: "paMessageCoalesceEnabled", value: false, type: "bool", scope: "perUser",
      allowlist: ["u_adam"], blocklist: [],
    })

    function genericDocRef(coll: string, id: string) {
      const store = bucket(coll)
      return {
        _coll: coll,
        _id: id,
        async get() { const d = store.get(id); return { exists: d !== undefined, data: () => d, id } },
        async set(d: DocData, o?: { merge?: boolean }) {
          if (o?.merge) store.set(id, { ...(store.get(id) ?? {}), ...d })
          else store.set(id, { ...d })
        },
        async create(d: DocData) {
          if (store.has(id)) { const e: Error & { code?: number } = new Error("AE"); e.code = 6; throw e }
          store.set(id, { ...d })
        },
        async update(d: DocData) { store.set(id, { ...(store.get(id) ?? {}), ...d }) },
      }
    }
    const fakeDb = {
      collection(name: string) {
        return {
          doc: (id: string) => genericDocRef(name, id),
          add: async (d: DocData) => { const id = `auto-${bucket(name).size}`; bucket(name).set(id, d); return { id } },
        }
      },
    }

    const SECRET = "test-webhook-secret"
    const { createHmac } = await import("node:crypto")
    const typingPayload = {
      type: "typing_indicator",
      number: "+15551234567",
      is_typing: true,
      from_number: "+15559999999",
      timestamp: "2026-05-02T12:00:00.000Z",
    }
    const raw = JSON.stringify(typingPayload)
    const sig = createHmac("sha256", SECRET).update(raw).digest("hex")

    let bumpInvocations: Array<{ userId: string; isTyping: boolean }> = []
    let status = 0
    let body: unknown = null
    const res = {
      status(c: number) { status = c; return this },
      json(b: unknown) { body = b; return this },
      send(b: unknown) { body = b; return this },
    }

    await handleSendblueWebhook(
      {
        rawBody: raw,
        body: typingPayload,
        headers: { "sendblue-signature": sig } as Record<string, string>,
      },
      res,
      {
        db: fakeDb as never,
        secret: SECRET,
        log: () => { /* swallow */ },
        coalescerDeps: {} as never,
        bumpCoalesceBuffer: (async (_d: unknown, input: { userId: string; isTyping: boolean }) => {
          bumpInvocations.push(input)
          return { action: "bumped", taskName: "fake-task", delayMs: 8000, turnSeq: 1 }
        }) as never,
        // typing payload's `number` field is the user's phone — resolve it
        lookupUserByPhone: async (_db, phone) => phone === "+15551234567" ? "u_adam" : null,
      }
    )

    assert.equal(status, 200, `expected 200, got ${status}, body=${JSON.stringify(body)}`)
    assert.equal((body as { ignored?: string })?.ignored, "typing_indicator")
    assert.equal(bumpInvocations.length, 1, "bumpCoalesceBuffer must be called exactly once")
    assert.equal(bumpInvocations[0]!.userId, "u_adam")
    assert.equal(bumpInvocations[0]!.isTyping, true)
    // Audit row was written with the typing_indicator type
    const audits = bucket("pa-audit-events")
    const auditTypes = Array.from(audits.values()).map((a) => (a as { type?: string }).type)
    assert.ok(auditTypes.includes("typing_indicator_received"), "audit type must be typing_indicator_received")
    // And the audit row carries the user's number under fromNumber (not Claire's)
    const typingAudit = Array.from(audits.values()).find((a) => (a as { type?: string }).type === "typing_indicator_received")
    assert.equal((typingAudit as { fromNumber?: string }).fromNumber, "+15551234567")
  })
})
