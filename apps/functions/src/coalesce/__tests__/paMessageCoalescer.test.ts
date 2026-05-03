/**
 * v1.5 Stream-D — paMessageCoalescer test suite (6 cases).
 *
 * Coverage map:
 *   1. single message — creates buffer, enqueues at delay=DEFAULT_DELAY_MS, no cancel
 *   2. 3 quick messages within DEFAULT_DELAY_MS window — cancel + re-enqueue, single fire
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
    // Bug 4 (2026-05-03): coalesce window bumped 4s→8s to absorb >4s typing
    // gaps. Adam 4 inbound msgs in 12s used to wave-split into 3 turns; 8s
    // catches them inside HARD_CAP_MS (since-bumped to 20s — see Adam
    // 2026-05-03 01:22 amendment, plus the rapid-gap heuristic below).
    assert.equal(DEFAULT_DELAY_MS, 8_000, "Bug 4 — coalesce window must be 8s")
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
    now += DEFAULT_DELAY_MS
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

// ----------------- TEST 11: Bug 5 body invariant — synth inbound stamps body/from/externalChatId -----------------

describe("paMessageCoalescer — case 11: synthesized inbound stamps body (Bug 5 fix)", () => {
  it("processCoalescedTurn populates `body` (and `from`/`externalChatId`) on the synthesized inbound row", async () => {
    // Bug 5 RCA (2026-05-03 01:05+01:22 Adam iMessage TURN_FAILED, repeated):
    //   Without this fix, the synthesized inbound doc only had userId +
    //   sessionId stamped — top-level `body` (and `from`, `externalChatId`)
    //   were absent. The orchestrator's `claimInboundEvent` reads the doc as
    //   InboundEvent, so `event.body` came back undefined; downstream
    //   `store.appendMessage({ body: event.body })` then crashed Firestore:
    //     "Cannot use \"undefined\" as a Firestore value (found in field \"body\")".
    //   Same RCA mode as Bug 1 (sessionId). This test pins the contract that
    //   the synth doc carries ALL InboundEvent-required scalars after stamp.
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, db } = buildDeps({ now: () => new Date(now) })
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "hi there", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    now += 1500
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-2", body: "are you up", inboundEventId: "inb_2",
      receivedAt: new Date(now).toISOString(),
    })
    const fired = await processCoalescedTurn(deps, "u_adam", 1)
    assert.equal(fired.status, "fired")
    const inbounds = (db as ReturnType<typeof makeFakeDb>)._stores.get("pa-inbound-events")
    const synth = inbounds?.get("inb_synth_coalesced-u_adam-1") as DocData | undefined
    assert.ok(synth, "synthetic inbound exists")
    // Bug 5 contract — top-level `body` is the accumulated text
    const body = (synth as { body?: string }).body
    assert.ok(body && typeof body === "string", "body stamped (non-empty string)")
    assert.match(body!, /hi there/)
    assert.match(body!, /are you up/)
    assert.equal(body, "hi there\nare you up", "body equals accumulatedBody verbatim")
    // sessionId / userId still stamped (Bug 1 regression guard)
    assert.equal((synth as { userId?: string }).userId, "u_adam")
    assert.ok((synth as { sessionId?: string }).sessionId)
    // from + externalChatId — completes InboundEvent required-scalar set
    assert.equal((synth as { from?: string }).from, BASE_MSG.fromNumber)
    assert.equal((synth as { externalChatId?: string }).externalChatId, BASE_MSG.fromNumber)
  })
})

// ----------------- TEST 12: rapid-gap heuristic extends delay (Adam 2026-05-03 amendment) -----------------

describe("paMessageCoalescer — case 12: rapid-gap heuristic extends delay", () => {
  it("when gap < RAPID_MESSAGE_THRESHOLD_MS, the next-task delay is bumped to defaultDelay+RAPID_BUMP_MS (clamped to remaining cap)", async () => {
    // Adam amendment 2026-05-03 ("可以消息间隔 < 5s 自动延长"): when a follow-up
    // message arrives within 5s of the previous one, treat it as the SAME
    // thought and extend the coalesce window. The window is still clamped to
    // `firstReceivedAt + HARD_CAP_MS`, so the bump cannot push past 20s.
    const { RAPID_BUMP_MS, RAPID_MESSAGE_THRESHOLD_MS } = await import("../buffer.js")
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, tasks } = buildDeps({ now: () => new Date(now) })
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "hi", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    // First enqueue at t=0 → default delay
    assert.equal(tasks.enqueued[0]!.delayMs, DEFAULT_DELAY_MS)

    // Rapid follow-up: 1.5s < 5s threshold → extend to defaultDelay+RAPID_BUMP_MS
    now += 1_500
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-2", body: "u there", inboundEventId: "inb_2",
      receivedAt: new Date(now).toISOString(),
    })
    const expectedRapidDelay = Math.min(
      DEFAULT_DELAY_MS + RAPID_BUMP_MS,
      HARD_CAP_MS - 1_500
    )
    assert.equal(
      tasks.enqueued[1]!.delayMs,
      expectedRapidDelay,
      `rapid-gap follow-up (1.5s < ${RAPID_MESSAGE_THRESHOLD_MS}ms) extends delay to ${expectedRapidDelay}ms (default+bump, clamped to remaining)`
    )
    assert.ok(
      expectedRapidDelay > DEFAULT_DELAY_MS,
      "rapid-gap delay MUST be greater than default — proves the bump fired"
    )
  })

  it("when gap >= RAPID_MESSAGE_THRESHOLD_MS AND no continuation marker, delay stays default (no bump)", async () => {
    // Slow gap (>= rapidThreshold) AND non-continuation body → no bump.
    // Adam 02:01 amendment: rapid-gap threshold is now 8s. Body "still there?"
    // does NOT start with any continuation marker, so the no-bump path applies.
    const { RAPID_MESSAGE_THRESHOLD_MS } = await import("../buffer.js")
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, tasks } = buildDeps({ now: () => new Date(now) })
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "hi", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    // Slow follow-up: gap = threshold + 500ms → no rapid-gap; "still there?"
    // is not a continuation marker → no continuation bump. Net: default delay.
    now += RAPID_MESSAGE_THRESHOLD_MS + 500
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-2", body: "still there?", inboundEventId: "inb_2",
      receivedAt: new Date(now).toISOString(),
    })
    const remainingMs = HARD_CAP_MS - (RAPID_MESSAGE_THRESHOLD_MS + 500)
    const expectedDelay = Math.min(DEFAULT_DELAY_MS, remainingMs)
    assert.equal(
      tasks.enqueued[1]!.delayMs,
      expectedDelay,
      `slow-gap + non-marker follow-up (>=${RAPID_MESSAGE_THRESHOLD_MS}ms) uses default delay, no bump`
    )
  })

  it("HARD_CAP_MS = 30_000 (Adam 2026-05-03 02:01 amendment 长一点)", async () => {
    // Pin the cap value. Adam 2026-05-03 02:01 spec ("长一点") bumped 20s → 30s
    // after observing 3 zh msgs ("算了/还是/或者") still wave-split into 4
    // outbounds at 20s cap. Future regression must not silently shrink without
    // updating Adam's directive context.
    assert.equal(HARD_CAP_MS, 30_000, "HARD_CAP_MS must be 30s per Adam 02:01 amendment")
  })

  it("RAPID_MESSAGE_THRESHOLD_MS = 5_000 (Adam 2026-05-03 02:30 spec)", async () => {
    // Pin the threshold. Adam spec: time range 5-30s. Continuation-marker
    // heuristic catches semantic case independent of timing, so 5s rapid is
    // sufficient — slow-typing users will hit continuation marker path or
    // wait for HARD_CAP=30s.
    const { RAPID_MESSAGE_THRESHOLD_MS } = await import("../buffer.js")
    assert.equal(
      RAPID_MESSAGE_THRESHOLD_MS,
      5_000,
      "RAPID_MESSAGE_THRESHOLD_MS must be 5s per Adam 02:30 spec (5-30s range)"
    )
  })
})

// ----------------- TEST 13: continuation-marker heuristic (Adam 2026-05-03 02:01 spec) -----------------

describe("paMessageCoalescer — case 13: continuation-marker bumps delay regardless of gap timing", () => {
  it("zh msg starting with continuation marker (\"还是\") bumps delay even when gap > rapid threshold", async () => {
    // Adam 02:01 实测 spec: 3 zh msgs ("算了 我觉得可能有点难" / "还是找点ai的?" /
    // "或者是pm") arrived with thinking-pauses > 5s yet semantically were
    // clearly one brainstorm. Without the continuation-marker heuristic, gaps
    // > rapidThreshold would NOT bump and turn would wave-split.
    const { RAPID_BUMP_MS, RAPID_MESSAGE_THRESHOLD_MS } = await import("../buffer.js")
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, tasks } = buildDeps({ now: () => new Date(now) })
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "算了 我觉得可能有点难", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    // Gap = rapidThreshold + 2s, so rapid-gap is FALSE; only continuation
    // marker can drive the bump.
    now += RAPID_MESSAGE_THRESHOLD_MS + 2_000
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-2", body: "还是找点ai的?", inboundEventId: "inb_2",
      receivedAt: new Date(now).toISOString(),
    })
    const remaining = HARD_CAP_MS - (RAPID_MESSAGE_THRESHOLD_MS + 2_000)
    const expectedDelay = Math.min(DEFAULT_DELAY_MS + RAPID_BUMP_MS, remaining)
    assert.equal(
      tasks.enqueued[1]!.delayMs,
      expectedDelay,
      "continuation-marker (\"还是\") MUST bump delay even when gap exceeds rapid threshold"
    )
    assert.ok(
      expectedDelay > DEFAULT_DELAY_MS,
      "bumped delay MUST be > default — proves continuation-marker fired"
    )
  })

  it("en msg starting with \"or \" continuation marker bumps delay across slow gap", async () => {
    const { RAPID_BUMP_MS, RAPID_MESSAGE_THRESHOLD_MS } = await import("../buffer.js")
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, tasks } = buildDeps({ now: () => new Date(now) })
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "I'm looking at SWE roles", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    now += RAPID_MESSAGE_THRESHOLD_MS + 1_500
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-2", body: "or maybe PM positions?", inboundEventId: "inb_2",
      receivedAt: new Date(now).toISOString(),
    })
    const remaining = HARD_CAP_MS - (RAPID_MESSAGE_THRESHOLD_MS + 1_500)
    const expectedDelay = Math.min(DEFAULT_DELAY_MS + RAPID_BUMP_MS, remaining)
    assert.equal(
      tasks.enqueued[1]!.delayMs,
      expectedDelay,
      "en \"or \" continuation must bump"
    )
  })


  it("non-continuation slow message body \"can you help me\" does NOT bump", async () => {
    const { RAPID_MESSAGE_THRESHOLD_MS } = await import("../buffer.js")
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, tasks } = buildDeps({ now: () => new Date(now) })
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "I want a job", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    now += RAPID_MESSAGE_THRESHOLD_MS + 2_000
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-2", body: "can you help me with my resume", inboundEventId: "inb_2",
      receivedAt: new Date(now).toISOString(),
    })
    const remaining = HARD_CAP_MS - (RAPID_MESSAGE_THRESHOLD_MS + 2_000)
    const expectedDelay = Math.min(DEFAULT_DELAY_MS, remaining)
    assert.equal(
      tasks.enqueued[1]!.delayMs,
      expectedDelay,
      "non-marker slow follow-up uses default delay (no bump)"
    )
    assert.ok(
      tasks.enqueued[1]!.delayMs <= DEFAULT_DELAY_MS,
      "non-bumped delay MUST NOT exceed default"
    )
  })

  it("HARD_CAP clamps continuation-marker bump (anti-troll invariant)", async () => {
    // Continuous slow continuation messages cannot push firesAt past
    // firstReceivedAt + HARD_CAP_MS — the clamp still applies.
    const t0 = new Date("2026-05-02T12:00:00Z")
    let now = t0.getTime()
    const { deps, tasks } = buildDeps({ now: () => new Date(now) })
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-1", body: "first", inboundEventId: "inb_1",
      receivedAt: new Date(now).toISOString(),
    })
    // Advance to within 1s of HARD_CAP — bump should clamp to ~1000ms
    now += HARD_CAP_MS - 1_000
    await enqueueOrCoalesce(deps, {
      ...BASE_MSG, messageHandle: "msg-2", body: "或者这样行吗", inboundEventId: "inb_2",
      receivedAt: new Date(now).toISOString(),
    })
    assert.ok(
      tasks.enqueued[1]!.delayMs <= 1_000,
      `continuation bump must clamp to remaining cap; got ${tasks.enqueued[1]!.delayMs}ms`
    )
  })

  it("isContinuationMessage unit cases — Adam実測 strings + edge cases", async () => {
    const { isContinuationMessage } = await import("../buffer.js")
    // Adam 02:01 production-observed strings — MUST classify as continuation:
    assert.equal(isContinuationMessage("还是找点ai的?"), true, "还是 prefix")
    assert.equal(isContinuationMessage("或者是pm"), true, "或者 prefix")
    // zh listing markers
    assert.equal(isContinuationMessage("或者这样"), true)
    assert.equal(isContinuationMessage("还有一个问题"), true)
    assert.equal(isContinuationMessage("另外想问"), true)
    assert.equal(isContinuationMessage("然后呢"), true)
    assert.equal(isContinuationMessage("而且我觉得"), true)
    // en markers
    assert.equal(isContinuationMessage("or maybe PM"), true)
    assert.equal(isContinuationMessage("And also remote ok"), true)
    assert.equal(isContinuationMessage("actually wait"), true)
    assert.equal(isContinuationMessage("btw, do you have time"), true)
    // Single-word edge case
    assert.equal(isContinuationMessage("or"), true)
    // en word-boundary protection — "order" must NOT match "or"
    assert.equal(isContinuationMessage("order placed yesterday"), false, "boundary blocks order≠or")
    assert.equal(isContinuationMessage("Android phone broke"), false, "boundary blocks Android≠and")
    assert.equal(isContinuationMessage("plus-size shirts"), false, "punct hyphen blocks plus-size≠plus")
    // Topic-shift NEGATIVES (intentionally NOT in marker list)
    assert.equal(isContinuationMessage("对了你那边怎么样"), false, "对了 = topic shift, NOT continuation")
    assert.equal(isContinuationMessage("但是我不确定"), false, "但是 contrast = excluded by design")
    assert.equal(isContinuationMessage("不过算了"), false, "不过 contrast = excluded")
    // Defensive defaults
    assert.equal(isContinuationMessage(""), false, "empty → false")
    assert.equal(isContinuationMessage("   "), false, "whitespace-only → false")
    assert.equal(isContinuationMessage(undefined as unknown as string), false, "non-string → false")
    // Leading whitespace handled by trim
    assert.equal(isContinuationMessage("  还是不要了"), true, "leading ws trimmed")
  })
})
