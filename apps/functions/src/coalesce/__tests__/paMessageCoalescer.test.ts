/**
 * v1.5 Stream-D — paMessageCoalescer test suite (6 cases).
 *
 * Coverage map:
 *   1. single message — creates buffer, enqueues at delay=4000, no cancel
 *   2. 3 quick messages within 4s window — cancel + re-enqueue, single fire
 *   3. 6 messages — soft-cap (>5) triggers force-fire (delay=0)
 *   4. hard 12s cap — buffer aged 12.5s yields delay=0 + force-fire
 *   5. cancel-and-re-enqueue idempotency — duplicate Cloud Tasks fire is no-op
 *   6. flag-off bypass — webhook does NOT call coalescer when flag is false
 *
 * The first 5 cover paMessageCoalescer + buffer.ts directly. Test 6 exercises
 * the webhook integration (handleSendblueWebhook) end-to-end.
 *
 * All tests use a hand-built fake Firestore that mimics the operations the
 * coalescer touches: doc().get/set/create, runTransaction, collection().where.
 * The full sendblue webhook fake (see ../sendblue/__tests__/webhook.test.ts)
 * is reused as a reference for shape, but trimmed to coalesce-relevant ops.
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"

import {
  enqueueOrCoalesce,
  processCoalescedTurn,
} from "../paMessageCoalescer.js"
import type { CoalescerDeps } from "../paMessageCoalescer.js"
import type { TasksClient, EnqueueInput } from "../tasks-client.js"
import {
  HARD_CAP_MS,
  DEFAULT_DELAY_MS,
  FORCE_FIRE_MESSAGE_COUNT,
} from "../buffer.js"

// ----------------- fake Cloud Tasks client -----------------

class FakeTasks implements TasksClient {
  enqueued: EnqueueInput[] = []
  cancelled: string[] = []
  failNextEnqueue = false
  cancelReturnsFalseFor: Set<string> = new Set()

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
    return !this.cancelReturnsFalseFor.has(name)
  }
}

// ----------------- fake Firestore -----------------

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
      doc(id: string) {
        return makeDocRef(coll, id)
      },
      where(_field: string, _op: string, _val: unknown) {
        // Bare-minimum: chained .where().where().limit().get(). Returns a
        // builder that scans the bucket and applies all predicates locally.
        const filters: Array<[string, string, unknown]> = [[_field, _op, _val]]
        let lim = Infinity
        const builder = {
          where(f: string, o: string, v: unknown) {
            filters.push([f, o, v])
            return builder
          },
          limit(n: number) {
            lim = n
            return builder
          },
          async get() {
            const all = Array.from(bucket(coll).entries())
            const matched = all
              .filter(([, d]) =>
                filters.every(([f, o, v]) => {
                  const x = (d as DocData)[f]
                  if (o === "==") return x === v
                  if (o === "<") return typeof x === "string" && typeof v === "string" ? x < v : (x as number) < (v as number)
                  return false
                })
              )
              .slice(0, lim)
            return {
              docs: matched.map(([id, d]) => ({
                id,
                data: () => d,
                ref: makeDocRef(coll, id),
              })),
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
    collection(name: string) {
      return makeCollection(name)
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      // Naive single-threaded transaction (sequential await tx.get/set).
      const tx = {
        async get(ref: { _coll: string; _id: string }) {
          const d = bucket(ref._coll).get(ref._id)
          return { exists: d !== undefined, data: () => d }
        },
        set(ref: { _coll: string; _id: string }, data: DocData, opts?: { merge?: boolean }) {
          if (opts?.merge) bucket(ref._coll).set(ref._id, { ...(bucket(ref._coll).get(ref._id) ?? {}), ...data })
          else bucket(ref._coll).set(ref._id, { ...data })
        },
        update(ref: { _coll: string; _id: string }, data: DocData) {
          bucket(ref._coll).set(ref._id, { ...(bucket(ref._coll).get(ref._id) ?? {}), ...data })
        },
      }
      return fn(tx)
    },
    _stores: stores,
  }
}

// ----------------- harness builders -----------------

function buildDeps(opts: {
  now?: () => Date
  tasks?: FakeTasks
  reactionThrows?: boolean
  reactionCalls?: Array<{ messageHandle: string; reaction: string }>
} = {}): { deps: CoalescerDeps; db: ReturnType<typeof makeFakeDb>; tasks: FakeTasks; orchestratorCalls: string[] } {
  const db = makeFakeDb()
  const tasks = opts.tasks ?? new FakeTasks()
  const orchestratorCalls: string[] = []
  const reactionCalls = opts.reactionCalls ?? []
  const deps: CoalescerDeps = {
    db: db as never,
    tasks,
    now: opts.now,
    log: () => {/* swallow */},
    sendReaction: async (input) => {
      reactionCalls.push({ messageHandle: input.messageHandle, reaction: input.reaction })
      if (opts.reactionThrows) throw new Error("fake_reaction_503")
      return { status: "queued" }
    },
    claimAndProcessInboundEvent: async (_db, eventId) => {
      orchestratorCalls.push(eventId)
      return 1
    },
    createInboundEvent: async (_db, input) => {
      const id = `inb_synth_${input.idempotencyKey}`
      // Mirror broker behavior: write into pa-inbound-events
      const map = (db as { _stores: Map<string, Map<string, DocData>> })._stores
      if (!map.has("pa-inbound-events")) map.set("pa-inbound-events", new Map())
      const store = map.get("pa-inbound-events")!
      if (store.has(id)) {
        return {
          id,
          created: false,
          event: { id, ...store.get(id) } as never,
        }
      }
      store.set(id, {
        id,
        channel: input.channel,
        status: "pending",
        idempotencyKey: input.idempotencyKey,
        rawPayload: input.rawPayload,
        createdAt: new Date().toISOString(),
      })
      return {
        id,
        created: true,
        event: { id, ...(store.get(id) as object) } as never,
      }
    },
  }
  return { deps, db, tasks, orchestratorCalls }
}

const BASE_MSG = {
  userId: "u_adam",
  fromNumber: "+15551234567",
  toNumber: "+15559999999",
}

// ----------------- TEST 1: single message → create, no cancel, default delay -----------------

describe("paMessageCoalescer — case 1: single message creates buffer", () => {
  it("first message creates a turn buffer and enqueues at default delay", async () => {
    const t0 = new Date("2026-05-02T12:00:00Z")
    const { deps, tasks, db } = buildDeps({ now: () => t0 })
    const outcome = await enqueueOrCoalesce(deps, {
      ...BASE_MSG,
      messageHandle: "msg-1",
      body: "hello",
      inboundEventId: "inb_1",
      receivedAt: t0.toISOString(),
    })
    assert.equal(outcome.action, "created")
    assert.equal(outcome.delayMs, DEFAULT_DELAY_MS)
    assert.equal(tasks.enqueued.length, 1)
    assert.equal(tasks.cancelled.length, 0)
    assert.match(tasks.enqueued[0]!.taskName, /^pa-coalesce-u_adam-1-1$/)
    // Buffer doc was written
    const buf = (db as ReturnType<typeof makeFakeDb>)._stores.get("pa-message-coalesce-buffer")?.get("u_adam__1") as DocData
    assert.ok(buf, "buffer doc exists")
    assert.equal((buf as { messageCount?: number }).messageCount, 1)
    assert.equal((buf as { lastMessageId?: string }).lastMessageId, "msg-1")
    // Original inbound row marked coalescing
    const inb = (db as ReturnType<typeof makeFakeDb>)._stores.get("pa-inbound-events")?.get("inb_1") as DocData | undefined
    assert.equal((inb as { coalescing?: boolean })?.coalescing, true)
  })
})

// ----------------- TEST 2: 3 quick messages within window → cancel+re-enqueue → single fire -----------------

describe("paMessageCoalescer — case 2: 3 quick messages coalesce", () => {
  it("cancels prior task and re-enqueues with combined body each time, then fires once", async () => {
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, tasks, orchestratorCalls, db } = buildDeps({
      now: () => new Date(now),
    })

    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "hi", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    now += 1500
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-2", body: "are you there", inboundEventId: "inb_2",
      receivedAt: new Date(now).toISOString(),
    })
    now += 1500
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-3", body: "ping", inboundEventId: "inb_3",
      receivedAt: new Date(now).toISOString(),
    })

    // 3 enqueues, 2 cancels (cancel happens on appends, not on first create)
    assert.equal(tasks.enqueued.length, 3)
    assert.equal(tasks.cancelled.length, 2)
    // Latest task targets messageCount=3
    assert.match(tasks.enqueued[2]!.taskName, /-1-3$/)

    // Now fire (Cloud Tasks would call us)
    now += 4000
    const fired = await processCoalescedTurn(deps, "u_adam", 1)
    assert.equal(fired.status, "fired")
    assert.equal(fired.buffer?.messageCount, 3)
    assert.equal(fired.buffer?.lastMessageId, "msg-3")
    assert.match(fired.buffer?.accumulatedBody ?? "", /hi\nare you there\nping/)
    // Orchestrator called exactly ONCE
    assert.equal(orchestratorCalls.length, 1)
    // Synthetic inbound exists
    const synth = (db as ReturnType<typeof makeFakeDb>)._stores.get("pa-inbound-events")?.get("inb_synth_coalesced-u_adam-1") as DocData | undefined
    assert.ok(synth, "synthetic inbound exists")
  })
})

// ----------------- TEST 3: 6 messages → soft-cap force-fire -----------------

describe("paMessageCoalescer — case 3: 6 messages soft-cap force-fires", () => {
  it("recommends delay=0 when messageCount exceeds soft cap", async () => {
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, tasks } = buildDeps({ now: () => new Date(now) })

    for (let i = 1; i <= FORCE_FIRE_MESSAGE_COUNT + 1; i++) {
      now += 100
      await enqueueOrCoalesce(deps, {
        ...BASE_MSG,
        messageHandle: `msg-${i}`,
        body: `m${i}`,
        inboundEventId: `inb_${i}`,
        receivedAt: new Date(now).toISOString(),
      })
    }
    // The LAST enqueue should have delayMs=0 (force-fire branch)
    const last = tasks.enqueued[tasks.enqueued.length - 1]!
    assert.equal(last.delayMs, 0, "soft-cap must force delay=0")
    // The 5th-and-earlier enqueues use the normal default (with possible
    // remaining-time clamp). Verify at least the 1st didn't force-fire.
    assert.ok(tasks.enqueued[0]!.delayMs > 0, "first enqueue is not force-fire")
  })
})

// ----------------- TEST 4: hard 12s cap → force-fire -----------------

describe("paMessageCoalescer — case 4: hard 12s cap force-fires", () => {
  it("recommends delay=0 when buffer is older than HARD_CAP_MS", async () => {
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, tasks } = buildDeps({ now: () => new Date(now) })

    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "first", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    // Advance past hard cap
    now += HARD_CAP_MS + 500
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-2", body: "second", inboundEventId: "inb_2",
      receivedAt: new Date(now).toISOString(),
    })
    const last = tasks.enqueued[tasks.enqueued.length - 1]!
    assert.equal(last.delayMs, 0, "hard-cap must force delay=0")
  })
})

// ----------------- TEST 5: idempotent fire — duplicate Cloud Tasks delivery -----------------

describe("paMessageCoalescer — case 5: duplicate fire is idempotent", () => {
  it("second processCoalescedTurn returns already_fired and does NOT call orchestrator twice", async () => {
    const t0 = new Date("2026-05-02T12:00:00Z")
    const { deps, orchestratorCalls } = buildDeps({ now: () => t0 })

    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "single", inboundEventId: "inb_1",
      receivedAt: t0.toISOString(),
    })

    const r1 = await processCoalescedTurn(deps, "u_adam", 1)
    assert.equal(r1.status, "fired")
    assert.equal(orchestratorCalls.length, 1)

    // Cloud Tasks at-least-once: a second delivery should be a no-op
    const r2 = await processCoalescedTurn(deps, "u_adam", 1)
    assert.equal(r2.status, "already_fired")
    assert.equal(orchestratorCalls.length, 1, "orchestrator must not fire twice")
  })
})

// ----------------- TEST 6: flag-off bypass via webhook integration -----------------

describe("paMessageCoalescer — case 6: webhook bypasses coalesce when flag=false", () => {
  it("when paMessageCoalesceEnabled=false, webhook never calls enqueueOrCoalesce", async () => {
    // Webhook integration test: import handleSendblueWebhook and ensure the
    // coalesce path is not taken when the flag is off. We use the harness
    // pattern from the existing webhook test suite, trimmed.
    const { handleSendblueWebhook } = await import("../../sendblue/webhook.js")
    const { _clearFeatureFlagCache } = await import("@pa/pa-persistence")
    _clearFeatureFlagCache()

    // Minimal fake Firestore matching webhook.test.ts shape
    const inbound = new Map<string, DocData>()
    const flags = new Map<string, DocData>()
    // explicit flag=false (the default if absent is also false; assert
    // explicit-off path)
    flags.set("paMessageCoalesceEnabled", {
      key: "paMessageCoalesceEnabled", value: false, type: "bool", scope: "perUser",
      allowlist: [], blocklist: [],
    })
    function genericDocRef(store: Map<string, DocData>, id: string) {
      return {
        async get() {
          const d = store.get(id)
          return { exists: d !== undefined, data: () => d, id }
        },
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
        if (name === "pa-inbound-events") {
          return { doc: (id: string) => genericDocRef(inbound, id) }
        }
        if (name === "pa-feature-flags") {
          return { doc: (id: string) => genericDocRef(flags, id) }
        }
        if (name === "pa-sendblue-webhook-raw") {
          return { add: async () => ({ id: "raw" }) }
        }
        return { doc: (id: string) => genericDocRef(new Map(), id), add: async () => ({ id: "x" }) }
      },
    }

    let coalesceWasCalled = false
    const SECRET = "test-webhook-secret"
    const { createHmac } = await import("node:crypto")
    const payload = {
      message_handle: "msg-1",
      content: "hi",
      from_number: "+15551234567",
      to_number: "+15559999999",
      type: "message",
      service: "iMessage",
    }
    const raw = JSON.stringify(payload)
    const sig = createHmac("sha256", SECRET).update(raw).digest("hex")

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
        body: payload,
        headers: { "sendblue-signature": sig } as Record<string, string>,
      },
      res,
      {
        db: fakeDb as never,
        secret: SECRET,
        log: () => { /* swallow */ },
        // Explicitly inject these so the path exists, but verify it's not
        // called because the flag is off.
        enqueueOrCoalesce: (async () => {
          coalesceWasCalled = true
          return { action: "created" as const }
        }) as never,
        coalescerDeps: {} as never,
        // Even with lookup returning a userId, flag=false should short-circuit
        lookupUserByPhone: async () => "u_adam",
      }
    )
    assert.equal(status, 200, `expected 200, got ${status}, body=${JSON.stringify(body)}`)
    assert.equal(coalesceWasCalled, false, "coalesce path must not run when flag is off")
  })
})

// ----------------- TEST 7: synthesized inbound carries sessionId (Bug 1 fix) -----------------

describe("paMessageCoalescer — case 7: synthesized inbound stamps sessionId", () => {
  it("processCoalescedTurn populates BOTH userId and sessionId on the synthesized inbound row", async () => {
    // Bug 1 RCA (2026-05-03 Adam iMessage CRASH):
    //   Without this fix, the synthesized inbound doc only had `userId` —
    //   sessionId was undefined, so the orchestrator's `claimInboundEvent`
    //   produced an InboundEvent with `sessionId: undefined`, which then
    //   crashed `store.createTurn` writing to pa-turns:
    //     "Cannot use undefined as a Firestore value (found in field sessionId)".
    //   This test asserts the synthesized inbound has BOTH identifiers and
    //   that the resolved sessionId is also persisted as a pa-sessions row.
    const t0 = new Date("2026-05-02T12:00:00Z")
    const { deps, db } = buildDeps({ now: () => t0 })
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "hi", inboundEventId: "inb_1",
      receivedAt: t0.toISOString(),
    })
    const fired = await processCoalescedTurn(deps, "u_adam", 1)
    assert.equal(fired.status, "fired")
    const inbounds = (db as ReturnType<typeof makeFakeDb>)._stores.get("pa-inbound-events")
    const synth = inbounds?.get("inb_synth_coalesced-u_adam-1") as DocData | undefined
    assert.ok(synth, "synthetic inbound must exist")
    assert.equal((synth as { userId?: string }).userId, "u_adam", "userId stamped")
    const sessionId = (synth as { sessionId?: string }).sessionId
    assert.ok(sessionId && typeof sessionId === "string", "sessionId stamped (non-empty string)")
    assert.match(sessionId!, /^ses_[0-9a-f]{32}$/, "sessionId follows ses_<hash> shape")
    // The pa-sessions row was also written
    const sessions = (db as ReturnType<typeof makeFakeDb>)._stores.get("pa-sessions")
    assert.ok(sessions, "pa-sessions collection populated")
    const sess = sessions!.get(sessionId!) as DocData | undefined
    assert.ok(sess, "session row exists for resolved sessionId")
    assert.equal((sess as { userId?: string }).userId, "u_adam")
    assert.equal((sess as { channel?: string }).channel, "imessage")
    assert.equal((sess as { externalChatId?: string }).externalChatId, BASE_MSG.fromNumber)
  })
})

// ----------------- TEST 8: session is reused across coalesced turns (idempotent) -----------------

describe("paMessageCoalescer — case 8: session reused across turns", () => {
  it("a second coalesced turn for the same user reuses the existing session row", async () => {
    // Without idempotent reuse, every coalesced turn would create a NEW
    // session — splitting the user's history across many ses_* docs and
    // breaking history.loadHistory() retrieval. Determinism comes from
    // sha256(userId|imessage|externalChatId), so the same inputs MUST yield
    // the same docId.
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, db } = buildDeps({ now: () => new Date(now) })
    // Turn 1
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "hi", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    await processCoalescedTurn(deps, "u_adam", 1)
    const sessions = (db as ReturnType<typeof makeFakeDb>)._stores.get("pa-sessions")!
    assert.equal(sessions.size, 1, "exactly 1 session after turn 1")
    const sessionIdT1 = Array.from(sessions.keys())[0]!
    const t1CreatedAt = (sessions.get(sessionIdT1) as { createdAt?: string }).createdAt
    // Turn 2 (advance clock past hard-cap so the buffer is fresh)
    now += HARD_CAP_MS + 5000
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-2", body: "second turn", inboundEventId: "inb_2",
      receivedAt: new Date(now).toISOString(),
    })
    await processCoalescedTurn(deps, "u_adam", 2)
    assert.equal(sessions.size, 1, "still exactly 1 session after turn 2 (reuse)")
    assert.ok(sessions.get(sessionIdT1), "same sessionId still present")
    // createdAt was NOT clobbered (idempotent: existing rows are not overwritten)
    assert.equal(
      (sessions.get(sessionIdT1) as { createdAt?: string }).createdAt,
      t1CreatedAt,
      "createdAt preserved on reuse"
    )
  })
})

// ----------------- TEST 9: R1 sweep path also gets sessionId populated -----------------

describe("paMessageCoalescer — case 9: R1 sweep path stamps sessionId", () => {
  it("processCoalescedTurn invoked from buffer-sweep path also populates sessionId", async () => {
    // The R1 sweep (apps/functions/src/coalesce/buffer-sweep.ts) calls
    // `processCoalescedTurn` directly — no different code path, but this
    // explicit test pins the contract so a future refactor can't silently
    // break sweep-fired turns while leaving Cloud Tasks-fired turns ok.
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, db } = buildDeps({ now: () => new Date(now) })
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "stuck task", inboundEventId: "inb_stuck",
      receivedAt: new Date(now).toISOString(),
    })
    // Simulate a stuck Cloud Tasks task — the sweep just calls
    // processCoalescedTurn directly with the same (userId, turnSeq).
    now += 35_000
    const fired = await processCoalescedTurn(deps, "u_adam", 1)
    assert.equal(fired.status, "fired")
    const synth = (db as ReturnType<typeof makeFakeDb>)._stores.get("pa-inbound-events")
      ?.get("inb_synth_coalesced-u_adam-1") as DocData | undefined
    assert.ok(synth, "synthetic inbound exists")
    assert.ok((synth as { sessionId?: string }).sessionId, "sessionId stamped on sweep-fired turn")
  })
})

// ----------------- TEST 10: sessionId is missing → no stamp, but Bug 1 protection still holds -----------------

describe("paMessageCoalescer — case 10: deterministic sessionId across calls", () => {
  it("two calls with the same (userId, fromNumber) produce the same sessionId hash", async () => {
    // Ensures the inline sessionDocIdForCoalesce mirrors the production
    // getOrCreateSession (apps/functions/src/index.ts) byte-for-byte. If
    // the hash inputs ever drift, the broker iMessage path and the
    // coalesce path would write to different sessions and history would
    // bifurcate. This test pins the determinism property.
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, db } = buildDeps({ now: () => new Date(now) })

    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "first", inboundEventId: "inb_a",
      receivedAt: new Date(now).toISOString(),
    })
    await processCoalescedTurn(deps, "u_adam", 1)

    now += HARD_CAP_MS + 5000
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-2", body: "second", inboundEventId: "inb_b",
      receivedAt: new Date(now).toISOString(),
    })
    await processCoalescedTurn(deps, "u_adam", 2)

    const inbounds = (db as ReturnType<typeof makeFakeDb>)._stores.get("pa-inbound-events")!
    const s1 = (inbounds.get("inb_synth_coalesced-u_adam-1") as { sessionId?: string }).sessionId
    const s2 = (inbounds.get("inb_synth_coalesced-u_adam-2") as { sessionId?: string }).sessionId
    assert.ok(s1)
    assert.ok(s2)
    assert.equal(s1, s2, "same (userId, fromNumber) MUST yield the same sessionId across turns")
  })
})
