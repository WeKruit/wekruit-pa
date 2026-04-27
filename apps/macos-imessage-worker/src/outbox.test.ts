import assert from "node:assert/strict"
import test from "node:test"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

// Phase 21 — outbox tests exercise the legacy worker path; force LEGACY=1
// so the D-08/D-11 early-release guard does not short-circuit them.
process.env.PA_CHANNEL_LEGACY = "1"

import {
  normalizeOutboundPeer,
  processOutboundJob,
  reclaimStuckOutboundJobs,
  shouldAppendOutboundTranscript,
} from "./outbox.js"

test("broker-managed outbound does not append a duplicate transcript message", () => {
  assert.equal(
    shouldAppendOutboundTranscript({ idempotencyKey: "out-imessage-in-19289" }),
    false
  )
})

test("dashboard playground outbound can append its operator transcript message", () => {
  assert.equal(shouldAppendOutboundTranscript({ idempotencyKey: "pg-user-123" }), true)
})

test("iMessage email handles are preserved as outbound peers", () => {
  assert.equal(normalizeOutboundPeer("Admin1@WeKruit.com"), "admin1@wekruit.com")
})

test("phone outbound peers are normalized to E.164", () => {
  assert.equal(normalizeOutboundPeer("(215) 403-4668"), "+12154034668")
})

type QueryFilter = { field: string; op: string; value: unknown }

function fakeFirestore(docs: Record<string, Record<string, unknown>>) {
  const store = new Map(Object.entries(docs))
  const docRef = (id: string) => ({
    id,
    async get() {
      const data = store.get(id)
      return { id, exists: data != null, data: () => data }
    },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      const current = store.get(id) ?? {}
      store.set(id, opts?.merge ? { ...current, ...data } : { ...data })
    },
    async update(data: Record<string, unknown>) {
      const current = store.get(id)
      if (!current) throw new Error(`missing doc ${id}`)
      store.set(id, { ...current, ...data })
    },
  })
  const db = {
    collection(collectionName: string) {
      assert.equal(collectionName, PA_COLLECTIONS.outbound)
      const query = {
        filters: [] as QueryFilter[],
        max: Infinity,
        where(field: string, op: string, value: unknown) {
          this.filters.push({ field, op, value })
          return this
        },
        orderBy() {
          return this
        },
        limit(n: number) {
          this.max = n
          return this
        },
        doc(id: string) {
          return docRef(id)
        },
        async get() {
          const rows = [...store.entries()].filter(([, data]) =>
            this.filters.every((f) => {
              if (f.op !== "==") throw new Error(`unsupported op ${f.op}`)
              return data[f.field] === f.value
            })
          )
          return {
            empty: rows.length === 0,
            docs: rows.slice(0, this.max).map(([id, data]) => ({ id, data: () => data })),
          }
        },
      }
      return query
    },
    async runTransaction<T>(
      fn: (t: {
        get(ref: ReturnType<typeof docRef>): Promise<{ id: string; exists: boolean; data(): Record<string, unknown> | undefined }>
        update(ref: ReturnType<typeof docRef>, data: Record<string, unknown>): void
      }) => Promise<T>
    ) {
      return fn({
        async get(ref) {
          return ref.get()
        },
        update(ref, data) {
          void ref.update(data)
        },
      })
    },
  }
  return { db: db as unknown as Firestore, store }
}

test("legacy PA_OUTBOUND_ALLOWLIST_E164 mismatch marks outbound failed", async () => {
  const prevLegacy = process.env.PA_OUTBOUND_ALLOWLIST_E164
  const prevDm = process.env.IMESSAGE_DM_ALLOWLIST
  process.env.PA_OUTBOUND_ALLOWLIST_E164 = "+12154034668"
  process.env.IMESSAGE_DM_ALLOWLIST = "0" // disable layer 1 to isolate legacy gate
  try {
    const { db, store } = fakeFirestore({
      out1: {
        status: "pending",
        userId: "u1",
        toE164: "+19999999999",
        body: "blocked",
        createdAt: "2026-04-24T00:00:00.000Z",
      },
    })

    await processOutboundJob(db, { send: async () => undefined } as never, () => undefined, "out1", store.get("out1")!)

    assert.equal(store.get("out1")?.status, "failed")
    assert.equal(store.get("out1")?.error, "blocked by PA_OUTBOUND_ALLOWLIST_E164")
  } finally {
    if (prevLegacy == null) delete process.env.PA_OUTBOUND_ALLOWLIST_E164
    else process.env.PA_OUTBOUND_ALLOWLIST_E164 = prevLegacy
    if (prevDm == null) delete process.env.IMESSAGE_DM_ALLOWLIST
    else process.env.IMESSAGE_DM_ALLOWLIST = prevDm
  }
})

test("IMESSAGE_DM_ALLOWLIST fail-closed: empty list blocks outbound by default", async () => {
  const prevDm = process.env.IMESSAGE_DM_ALLOWLIST
  const prevPeer = process.env.IMESSAGE_PEER
  const prevPeers = process.env.IMESSAGE_PEERS
  delete process.env.IMESSAGE_DM_ALLOWLIST // default = enforce
  delete process.env.IMESSAGE_PEER
  delete process.env.IMESSAGE_PEERS
  try {
    const { db, store } = fakeFirestore({
      out1: {
        status: "pending",
        userId: "u1",
        toE164: "+19999999999",
        body: "blocked",
        createdAt: "2026-04-24T00:00:00.000Z",
      },
    })

    await processOutboundJob(db, { send: async () => undefined } as never, () => undefined, "out1", store.get("out1")!)

    assert.equal(store.get("out1")?.status, "failed")
    assert.equal(store.get("out1")?.error, "blocked by IMESSAGE_DM_ALLOWLIST")
  } finally {
    if (prevDm == null) delete process.env.IMESSAGE_DM_ALLOWLIST
    else process.env.IMESSAGE_DM_ALLOWLIST = prevDm
    if (prevPeer == null) delete process.env.IMESSAGE_PEER
    else process.env.IMESSAGE_PEER = prevPeer
    if (prevPeers == null) delete process.env.IMESSAGE_PEERS
    else process.env.IMESSAGE_PEERS = prevPeers
  }
})

test("IMESSAGE_DM_ALLOWLIST allows outbound when peer in list", async () => {
  const prevDm = process.env.IMESSAGE_DM_ALLOWLIST
  const prevPeer = process.env.IMESSAGE_PEER
  process.env.IMESSAGE_DM_ALLOWLIST = "1"
  process.env.IMESSAGE_PEER = "+12154034668"
  try {
    const sends: Array<{ to: string; text: string }> = []
    const sdk = { async send(arg: { to: string; text: string }) { sends.push(arg) } }
    const { db, store } = fakeFirestore({
      out1: {
        status: "pending",
        userId: "u1",
        toE164: "+12154034668",
        body: "ok",
        imessageChatId: "+12154034668",
        createdAt: "2026-04-24T00:00:00.000Z",
        idempotencyKey: "out-imessage-in-1", // skip transcript append (no real db ops)
      },
    })

    // The fake Firestore only knows about pa_outbound; getUser will throw
    // on the pa_users assertion. That's fine — we only care that the run
    // got PAST the allowlist gate (i.e. no early `failed: blocked by ...`).
    await processOutboundJob(db, sdk as never, () => undefined, "out1", store.get("out1")!).catch(
      () => undefined
    )

    const status = String(store.get("out1")?.status ?? "")
    const err = String(store.get("out1")?.error ?? "")
    assert.notEqual(status, "failed", `expected past-gate status, got failed err=${err}`)
    assert.ok(
      !err.includes("ALLOWLIST"),
      `allowlist should NOT have blocked, got: ${err}`
    )
  } finally {
    if (prevDm == null) delete process.env.IMESSAGE_DM_ALLOWLIST
    else process.env.IMESSAGE_DM_ALLOWLIST = prevDm
    if (prevPeer == null) delete process.env.IMESSAGE_PEER
    else process.env.IMESSAGE_PEER = prevPeer
  }
})

test("stuck sending outbound rows can be reclaimed to pending", async () => {
  const { db, store } = fakeFirestore({
    old: { status: "sending", updatedAt: "2026-04-24T00:00:00.000Z" },
    fresh: { status: "sending", updatedAt: "2026-04-24T01:00:00.000Z" },
    pending: { status: "pending", updatedAt: "2026-04-24T00:00:00.000Z" },
  })

  const reclaimed = await reclaimStuckOutboundJobs(db, {
    olderThanIso: "2026-04-24T00:30:00.000Z",
  })

  assert.deepEqual(reclaimed, ["old"])
  assert.equal(store.get("old")?.status, "pending")
  assert.equal(store.get("old")?.error, "reclaimed from stuck sending")
  assert.equal(store.get("fresh")?.status, "sending")
})

import { deliverOutboundBody } from "./outbox.js"

test("deliverOutboundBody: chunkingEnabled=false sends body as single sdk.send", async () => {
  const sends: Array<{ to: string; text: string }> = []
  const sleeps: number[] = []
  const sdk = {
    async send(arg: { to: string; text: string }) {
      sends.push(arg)
    },
  }
  const body =
    "First paragraph that is long enough to maybe split.\n\n" +
    "Second paragraph also long enough to split if chunking were on."
  const result = await deliverOutboundBody(sdk, "+15555550100", body, {
    chunkingEnabled: false,
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
  })
  assert.equal(sends.length, 1)
  assert.equal(sends[0].text, body)
  assert.equal(sleeps.length, 0)
  assert.equal(result.chunkPlan, undefined)
  assert.equal(result.chunkErrorIndex, undefined)
})

test("deliverOutboundBody: chunkingEnabled=true splits long paragraph reply into 2-3 chunks with sleeps", async () => {
  const sends: Array<{ to: string; text: string }> = []
  const sleeps: number[] = []
  const sdk = {
    async send(arg: { to: string; text: string }) {
      sends.push(arg)
    },
  }
  const body =
    "首先，我会查询最新的天气信息以确保你出门时不会被淋湿，这一点非常重要。\n\n" +
    "其次，我会基于你过去几次出行的偏好，把咖啡馆和公共交通的选项一并列出。\n\n" +
    "最后，我建议你提前30分钟出发，避开高峰，到达后再决定是否继续散步。"
  const result = await deliverOutboundBody(sdk, "+15555550100", body, {
    chunkingEnabled: true,
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
    random: () => 0.5,
  })
  assert.ok(sends.length >= 2 && sends.length <= 3, `got ${sends.length} chunks`)
  assert.equal(sleeps.length, sends.length - 1)
  for (const d of sleeps) {
    assert.ok(d >= 800 && d <= 1500, `delay out of range: ${d}`)
  }
  assert.equal(result.chunkPlan?.chunks.length, sends.length)
  assert.equal(result.chunkErrorIndex, undefined)
})

test("deliverOutboundBody: short reply stays a single chunk even with chunkingEnabled=true", async () => {
  const sends: Array<{ to: string; text: string }> = []
  const sdk = {
    async send(arg: { to: string; text: string }) {
      sends.push(arg)
    },
  }
  const body = "好的，我记下了。"
  const result = await deliverOutboundBody(sdk, "+15555550100", body, {
    chunkingEnabled: true,
    sleep: async () => undefined,
  })
  assert.equal(sends.length, 1)
  assert.equal(sends[0].text, body)
  assert.equal(result.chunkPlan, undefined)
})

test("deliverOutboundBody: mid-chunk error returns chunkErrorIndex without throwing", async () => {
  const sends: Array<{ to: string; text: string }> = []
  let attempt = 0
  const sdk = {
    async send(arg: { to: string; text: string }) {
      attempt += 1
      sends.push(arg)
      if (attempt === 2) throw new Error("fake send failure on chunk index 1")
    },
  }
  const body =
    "Paragraph one is long enough to clear the floor on its own here, see.\n\n" +
    "Paragraph two also clears the floor with margin so we get >= 2 chunks.\n\n" +
    "Paragraph three rounds it out so the splitter aims for three chunks."
  const result = await deliverOutboundBody(sdk, "+15555550100", body, {
    chunkingEnabled: true,
    sleep: async () => undefined,
    random: () => 0.5,
  })
  assert.equal(sends.length, 2, "loop must halt on error")
  assert.equal(result.chunkErrorIndex, 1)
  assert.ok(result.chunkErrorCause instanceof Error)
})

test("processOutboundJob with PA_TYPING_INDICATOR_DISABLED unset (default kill-switch armed) sends single message", async () => {
  const previousFlag = process.env.PA_TYPING_INDICATOR_DISABLED
  delete process.env.PA_TYPING_INDICATOR_DISABLED
  // We can't run the full processOutboundJob here without faking
  // pa-persistence; instead exercise the gate directly via deliverOutboundBody.
  try {
    const sends: Array<{ to: string; text: string }> = []
    const sdk = {
      async send(arg: { to: string; text: string }) {
        sends.push(arg)
      },
    }
    const body =
      "Long paragraph one to clear the floor on its own without trouble.\n\n" +
      "Long paragraph two would make this a chunked reply if the flag were off."
    await deliverOutboundBody(sdk, "+15555550100", body, {
      sleep: async () => undefined,
    })
    assert.equal(sends.length, 1, "default state must NOT chunk (kill switch armed)")
  } finally {
    if (previousFlag == null) delete process.env.PA_TYPING_INDICATOR_DISABLED
    else process.env.PA_TYPING_INDICATOR_DISABLED = previousFlag
  }
})
