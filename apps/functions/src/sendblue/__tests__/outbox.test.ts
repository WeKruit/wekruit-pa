import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import { isMarketplaceOutreachOutbound, paSendblueOutboxHandler, shouldAppendOutboundTranscript } from "../outbox.js"
import { SendblueClientError, SendblueServerError } from "../sendblue-client.js"

// ---------- Fake Firestore + sendblue client ----------

type DocData = Record<string, unknown>

function makeFakeDb(
  initialOutbound: Record<string, DocData> = {},
  users: Record<string, DocData> = {},
  opts: { quotaLimit?: number; existingDailyCount?: number } = {}
) {
  const outbound = new Map<string, DocData>(
    Object.entries(initialOutbound).map(([id, row]) => [
      id,
      { runtimeApproved: true, runtimeSource: "test_runtime", ...row },
    ])
  )
  const sessions = new Map<string, DocData>()
  const messages = new Map<string, DocData>()
  const usersMap = new Map<string, DocData>(Object.entries(users))
  const flags = new Map<string, DocData>()
  const audit: DocData[] = []
  const outboundDaily = new Map<string, DocData>()

  if (opts.quotaLimit != null) {
    flags.set("sendblueDailyQuota", {
      key: "sendblueDailyQuota",
      value: opts.quotaLimit,
      type: "number",
      scope: "global",
      allowlist: [],
      blocklist: [],
    })
  }
  if (opts.existingDailyCount != null) {
    // Today's bucket. Test pin via now() in handler.
    const today = new Date()
    const y = today.getUTCFullYear().toString().padStart(4, "0")
    const m = (today.getUTCMonth() + 1).toString().padStart(2, "0")
    const d = today.getUTCDate().toString().padStart(2, "0")
    outboundDaily.set(`${y}${m}${d}`, { count: opts.existingDailyCount })
  }

  function pickStore(coll: string): Map<string, DocData> {
    switch (coll) {
      case "pa-outbound": return outbound
      case "pa-sessions": return sessions
      case "pa-messages": return messages
      case "pa-feature-flags": return flags
      case "pa-outbound-daily": return outboundDaily
      default: return usersMap
    }
  }

  function makeDocRef(coll: string, id: string) {
    const store = pickStore(coll)
    return {
      _store: store,
      _id: id,
      async get() {
        const data = store.get(id)
        return { exists: data !== undefined, data: () => data, id }
      },
      async set(data: DocData, opts?: { merge?: boolean }) {
        if (opts?.merge) {
          store.set(id, { ...(store.get(id) ?? {}), ...data })
        } else {
          store.set(id, { ...data })
        }
      },
      async update(data: DocData) {
        store.set(id, { ...(store.get(id) ?? {}), ...data })
      },
    }
  }

  const db = {
    collection(name: string) {
      return {
        doc(id: string) {
          return makeDocRef(name, id)
        },
        add(data: DocData) {
          if (name === "pa-audit-events") {
            audit.push({ ...data })
            return Promise.resolve({ id: `audit_${audit.length}` })
          }
          return Promise.resolve({ id: "x" })
        },
        where() {
          return this
        },
        limit() {
          return this
        },
        async get() {
          return { empty: true, docs: [] }
        },
      }
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { get(): Promise<{ exists: boolean; data: () => DocData | undefined; id: string }> }) {
          return ref.get()
        },
        update(ref: { _store?: Map<string, DocData>; _id?: string; update?: (d: DocData) => Promise<void> }, data: DocData) {
          if (ref._store && ref._id) {
            ref._store.set(ref._id, { ...(ref._store.get(ref._id) ?? {}), ...data })
          } else if (ref.update) {
            void ref.update(data)
          }
          return undefined
        },
        set(ref: { _store?: Map<string, DocData>; _id?: string }, data: DocData) {
          if (ref._store && ref._id) ref._store.set(ref._id, { ...data })
          return undefined
        },
      }
      return fn(t)
    },
  }
  return { db, outbound, messages, sessions, audit, outboundDaily }
}

// Sendblue client mock
function makeSendblueMock(
  opts: { throwError?: Error; uuid?: string; mediaEcho?: string | null } = {}
) {
  let calls = 0
  const sendCalls: Array<Record<string, unknown>> = []
  const sendImessage = async (input: Record<string, unknown>) => {
    calls++
    sendCalls.push(input)
    if (opts.throwError) throw opts.throwError
    return {
      type: "message" as const,
      uuid: opts.uuid ?? "uuid-mock-1",
      message_handle: opts.uuid ?? "uuid-mock-1",
      status: "QUEUED",
      from_number: "+15557654321",
      number: "+15551234567",
      content: "test",
      service: "iMessage" as const,
      is_outbound: true as const,
      // Sendblue echoes the accepted media URL (null/absent when dropped).
      ...("mediaEcho" in opts ? { media_url: opts.mediaEcho } : {}),
    }
  }
  const sendTypingIndicator = async () => {
    calls++
  }
  return { sendImessage, sendTypingIndicator, get calls() { return calls }, get sendCalls() { return sendCalls } }
}

const ENV_KEYS = [
  "PA_TYPING_INDICATOR",
] as const

let savedEnv: Record<string, string | undefined>

function makeEvent(docId: string, data: DocData) {
  const row = { runtimeApproved: true, runtimeSource: "test_runtime", ...data }
  return {
    params: { docId },
    data: {
      data: () => row,
      id: docId,
    },
  }
}

const ALLOWED_PEER = "+15551234567"
const USER = { id: "u-1", phoneE164: ALLOWED_PEER }

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  // 2026-05-19 — production default flipped to typing-on. Tests in this
  // suite assert calls = 1 (single send), so explicitly disable typing here
  // and let Test 6 below re-enable it for the dedicated typing assertion.
  process.env.PA_TYPING_INDICATOR = "0"
})
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v
  }
})

describe("paSendblueOutboxHandler", () => {
  it("Test 1: pending row → fetch called once → status=sent", async () => {
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "hello",
      idempotencyKey: "out-test-1",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound } = makeFakeDb({ "doc-1": baseRow }, { [USER.id]: USER })
    const sb = makeSendblueMock()
    const event = makeEvent("doc-1", baseRow)

    await paSendblueOutboxHandler(event as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date("2026-04-27T20:00:00Z"),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1", userId: USER.id, externalChatId: "x", channel: "imessage" } as never),
    })

    assert.equal(sb.calls, 1)
    assert.equal(sb.sendCalls[0]!.userId, USER.id)
    assert.ok(sb.sendCalls[0]!.db)
    const finalDoc = outbound.get("doc-1")!
    assert.equal(finalDoc.status, "sent")
    assert.equal(finalDoc.messageHandle, "uuid-mock-1")
  })

  it("Test 1-media-ok: media row + Sendblue echoes media_url → mediaDropped=false recorded", async () => {
    const MEDIA = "https://storage.googleapis.com/inbound-file-store/abc_wk-rec.png"
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "one role worth your time",
      mediaUrl: MEDIA,
      idempotencyKey: "out-media-ok",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound } = makeFakeDb({ "doc-media-ok": baseRow }, { [USER.id]: USER })
    const sb = makeSendblueMock({ mediaEcho: MEDIA }) // Sendblue retained the attachment
    await paSendblueOutboxHandler(makeEvent("doc-media-ok", baseRow) as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date("2026-05-31T20:00:00Z"),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1", userId: USER.id, externalChatId: "x", channel: "imessage" } as never),
    })
    // the media_url was forwarded to Sendblue
    assert.equal(sb.sendCalls[0]!.mediaUrl, MEDIA)
    const finalDoc = outbound.get("doc-media-ok")!
    assert.equal(finalDoc.status, "sent")
    assert.equal(finalDoc.mediaRequestedUrl, MEDIA)
    assert.equal(finalDoc.mediaEchoUrl, MEDIA)
    assert.equal(finalDoc.mediaDropped, false)
  })

  it("Test 1-media-dropped: media row + Sendblue drops attachment (echo null) → mediaDropped=true recorded", async () => {
    const MEDIA = "https://firebasestorage.googleapis.com/v0/b/x/o/rec.png?alt=media&token=deadbeef"
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "one role worth your time",
      mediaUrl: MEDIA,
      idempotencyKey: "out-media-drop",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound } = makeFakeDb({ "doc-media-drop": baseRow }, { [USER.id]: USER })
    const sb = makeSendblueMock({ mediaEcho: null }) // Sendblue 2xx'd but dropped the image
    await paSendblueOutboxHandler(makeEvent("doc-media-drop", baseRow) as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date("2026-05-31T20:00:00Z"),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1", userId: USER.id, externalChatId: "x", channel: "imessage" } as never),
    })
    const finalDoc = outbound.get("doc-media-drop")!
    assert.equal(finalDoc.status, "sent")
    assert.equal(finalDoc.mediaRequestedUrl, MEDIA)
    assert.equal(finalDoc.mediaEchoUrl, null)
    assert.equal(finalDoc.mediaDropped, true, "a dropped attachment MUST be detectable on the row")
  })

  it("Test 1a: user senderNumber is passed as explicit Sendblue fromNumber", async () => {
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "hello",
      idempotencyKey: "out-test-1a",
      createdAt: new Date().toISOString(),
    }
    const stickyUser = { ...USER, senderNumber: "+13054507715" }
    const { db, outbound } = makeFakeDb({ "doc-1a": baseRow }, { [USER.id]: stickyUser })
    const sb = makeSendblueMock()

    await paSendblueOutboxHandler(makeEvent("doc-1a", baseRow) as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date("2026-04-27T20:00:00Z"),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => stickyUser as never,
      getOrCreateSession: async () => ({ id: "s-1", userId: USER.id, externalChatId: "x", channel: "imessage" } as never),
    })

    assert.equal(sb.sendCalls[0]!.fromNumber, "+13054507715")
    assert.equal(outbound.get("doc-1a")!.status, "sent")
  })

  it("Test 1b: unapproved legacy pa-outbound row is blocked before Sendblue", async () => {
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "legacy direct body",
      idempotencyKey: "out-legacy-direct",
      createdAt: new Date().toISOString(),
      runtimeApproved: false,
    }
    const { db, outbound } = makeFakeDb({ "doc-legacy": baseRow }, { [USER.id]: USER })
    const sb = makeSendblueMock()

    await paSendblueOutboxHandler(makeEvent("doc-legacy", baseRow) as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date("2026-04-27T20:00:00Z"),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1", userId: USER.id, externalChatId: "x", channel: "imessage" } as never),
    })

    assert.equal(sb.calls, 0)
    const finalDoc = outbound.get("doc-legacy")!
    assert.equal(finalDoc.status, "failed")
    assert.equal(finalDoc.blockedByRuntimeGate, true)
    assert.match(String(finalDoc.error), /not approved by runtime/)
  })

  it("Test 2: arbitrary outbound toE164 sends normally", async () => {
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: "+15559999999",
      body: "hello",
      idempotencyKey: "out-test-2",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound } = makeFakeDb({ "doc-2": baseRow })
    const sb = makeSendblueMock()
    const event = makeEvent("doc-2", baseRow)

    await paSendblueOutboxHandler(event as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date(),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1", userId: USER.id, externalChatId: "x", channel: "imessage" } as never),
    })

    assert.equal(sb.calls, 1)
    assert.equal(sb.sendCalls[0]!.to, "+15559999999")
    const finalDoc = outbound.get("doc-2")!
    assert.equal(finalDoc.status, "sent")
    assert.equal(finalDoc.messageHandle, "uuid-mock-1")
  })

  it("Test 3: SendblueClientError (4xx) → status=failed with parsed Sendblue error", async () => {
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "hello",
      idempotencyKey: "out-test-3",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound } = makeFakeDb({ "doc-3": baseRow })
    const sb = makeSendblueMock({
      throwError: new SendblueClientError(400, "bad number", { error_message: "bad" }),
    })
    const event = makeEvent("doc-3", baseRow)

    await paSendblueOutboxHandler(event as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date(),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
    })

    const finalDoc = outbound.get("doc-3")!
    assert.equal(finalDoc.status, "failed")
    assert.match(String(finalDoc.error), /bad/)
  })

  it("Test 4: SendblueServerError (5xx) → status=pending + attempt incremented", async () => {
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "hello",
      idempotencyKey: "out-test-4",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound } = makeFakeDb({ "doc-4": baseRow })
    const sb = makeSendblueMock({
      throwError: new SendblueServerError(503, "service unavailable", null),
    })
    const event = makeEvent("doc-4", baseRow)

    await paSendblueOutboxHandler(event as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date(),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
    })

    const finalDoc = outbound.get("doc-4")!
    // status reverts to pending (from sending) so reclaim picks up; attemptCount bumped
    assert.equal(finalDoc.status, "pending")
    assert.equal(finalDoc.attemptCount, 1)
  })

  it("Test 5: claim transaction prevents double-send (status != pending)", async () => {
    const baseRow: DocData = {
      status: "sent", // already sent
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "hello",
      idempotencyKey: "out-test-5",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound } = makeFakeDb({ "doc-5": baseRow })
    const sb = makeSendblueMock()
    const event = makeEvent("doc-5", baseRow)

    await paSendblueOutboxHandler(event as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date(),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
    })

    assert.equal(sb.calls, 0)
    assert.equal(outbound.get("doc-5")!.status, "sent")
  })

  it("Test 6: PA_TYPING_INDICATOR=1 → typing called BEFORE send; =0 → skipped (D-06)", async () => {
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "hello",
      idempotencyKey: "out-test-6",
      createdAt: new Date().toISOString(),
    }

    // Case A: enabled
    process.env.PA_TYPING_INDICATOR = "1"
    const callOrder: string[] = []
    const sbA = {
      sendImessage: async () => {
        callOrder.push("send")
        return { uuid: "u-A", status: "QUEUED", from_number: null, number: ALLOWED_PEER, content: "x", service: "iMessage" as const, is_outbound: true as const }
      },
      sendTypingIndicator: async () => {
        callOrder.push("typing")
      },
    }
    const { db: dbA } = makeFakeDb({ "doc-6a": { ...baseRow } })
    await paSendblueOutboxHandler(makeEvent("doc-6a", { ...baseRow }) as never, {
      db: dbA as never,
      sendblueClient: sbA,
      now: () => new Date(),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
    })
    assert.deepEqual(callOrder, ["typing", "send"])

    // Case B: disabled
    process.env.PA_TYPING_INDICATOR = "0"
    const callOrderB: string[] = []
    const sbB = {
      sendImessage: async () => {
        callOrderB.push("send")
        return { uuid: "u-B", status: "QUEUED", from_number: null, number: ALLOWED_PEER, content: "x", service: "iMessage" as const, is_outbound: true as const }
      },
      sendTypingIndicator: async () => {
        callOrderB.push("typing")
      },
    }
    const { db: dbB } = makeFakeDb({ "doc-6b": { ...baseRow } })
    await paSendblueOutboxHandler(makeEvent("doc-6b", { ...baseRow }) as never, {
      db: dbB as never,
      sendblueClient: sbB,
      now: () => new Date(),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
    })
    assert.deepEqual(callOrderB, ["send"])
  })

  it("Test 7: runtime-approved rows send through the Sendblue transport", async () => {
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "hello",
      idempotencyKey: "out-test-7",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound } = makeFakeDb({ "doc-7": baseRow })
    const sb = makeSendblueMock()

    await paSendblueOutboxHandler(makeEvent("doc-7", baseRow) as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date(),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
    })

    assert.equal(sb.calls, 1)
    assert.equal(outbound.get("doc-7")!.status, "sent")
  })

  it("Test 8: idempotency — same docId triggered twice → only ONE Sendblue POST", async () => {
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "hello",
      idempotencyKey: "out-test-8",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound } = makeFakeDb({ "doc-8": baseRow })
    const sb = makeSendblueMock()
    const deps = {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date(),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
    }

    await paSendblueOutboxHandler(makeEvent("doc-8", baseRow) as never, deps)
    // Second invocation sees status=sent → claim fails → no send
    const after = outbound.get("doc-8") as DocData
    await paSendblueOutboxHandler(makeEvent("doc-8", after) as never, deps)

    assert.equal(sb.calls, 1)
  })

  it("Test 9: shouldAppendOutboundTranscript skips transcript-owned outbound prefixes", () => {
    assert.equal(shouldAppendOutboundTranscript({ idempotencyKey: "out-imessage-in-123" }), false)
    assert.equal(shouldAppendOutboundTranscript({ idempotencyKey: "out-sendblue-abc" }), false)
    assert.equal(shouldAppendOutboundTranscript({ idempotencyKey: "outbound-inb_123" }), false)
    assert.equal(shouldAppendOutboundTranscript({ idempotencyKey: "outbox-msg-doc-1" }), true)
    assert.equal(shouldAppendOutboundTranscript({ idempotencyKey: "any-other" }), true)
    assert.equal(isMarketplaceOutreachOutbound({ idempotencyKey: "outreach_idempotency_outinvite-1" }), true)
    assert.equal(isMarketplaceOutreachOutbound({ idempotencyKey: "out-test-1" }), false)
  })

  it("Test 9a: outbound transcript append stores assistant messages as assistant role", async () => {
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "Manual operator reply",
      idempotencyKey: "manual-console-1",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound } = makeFakeDb({ "doc-role": baseRow }, { [USER.id]: USER })
    const sb = makeSendblueMock()
    let appended: DocData | undefined

    await paSendblueOutboxHandler(makeEvent("doc-role", baseRow) as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date("2026-05-26T22:39:00Z"),
      log: () => {},
      appendMessage: async (_db, input) => {
        appended = input as never
      },
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
    })

    assert.equal(sb.calls, 1)
    assert.equal(outbound.get("doc-role")!.status, "sent")
    assert.equal(appended?.role, "assistant")
    assert.equal((appended?.rawMeta as { source?: string } | undefined)?.source, "pa-outbound")
  })

  it("Test 9b: marketplace outreach stop gate blocks before transcript, quota, typing, or Sendblue", async () => {
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "hello",
      idempotencyKey: "outreach_idempotency_outinvite-1",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound, messages } = makeFakeDb({ "doc-paused": baseRow }, { [USER.id]: USER })
    const sb = makeSendblueMock()
    let appended = 0
    await paSendblueOutboxHandler(makeEvent("doc-paused", baseRow) as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date(),
      log: () => {},
      appendMessage: async () => {
        appended++
      },
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
      readOutreachStopControl: async () => ({
        paused: true,
        reason: "launch readiness pause",
      }),
    })

    assert.equal(sb.calls, 0)
    assert.equal(appended, 0)
    assert.equal(messages.size, 0)
    const finalDoc = outbound.get("doc-paused")!
    assert.equal(finalDoc.status, "failed")
    assert.equal(finalDoc.blockedByOutreachStopControl, true)
    assert.match(String(finalDoc.error), /marketplace outreach paused/)
  })

  it("Test 10 (Phase 26 T2): existing count at 80% → soft-warn audit, send still proceeds", async () => {
    // Reset feature-flag cache so the per-test flags map is consulted.
    const { _clearFeatureFlagCache } = await import("@pa/pa-persistence")
    _clearFeatureFlagCache()
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "hello",
      idempotencyKey: "out-quota-soft",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound, audit } = makeFakeDb(
      { "doc-soft": baseRow },
      {},
      { quotaLimit: 1000, existingDailyCount: 800 }
    )
    const sb = makeSendblueMock()
    await paSendblueOutboxHandler(makeEvent("doc-soft", baseRow) as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date(),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
    })
    assert.equal(sb.calls, 1)
    assert.equal(outbound.get("doc-soft")!.status, "sent")
    assert.ok(audit.some((a) => a.type === "quota_soft"), "expected quota_soft audit row")
  })

  it("Test 11 (Phase 26 T2): existing count at 100% → hard-block, NO send, audit emitted", async () => {
    const { _clearFeatureFlagCache } = await import("@pa/pa-persistence")
    _clearFeatureFlagCache()
    const baseRow: DocData = {
      status: "pending",
      userId: USER.id,
      toE164: ALLOWED_PEER,
      body: "hello",
      idempotencyKey: "out-quota-hard",
      createdAt: new Date().toISOString(),
    }
    const { db, outbound, audit } = makeFakeDb(
      { "doc-hard": baseRow },
      {},
      { quotaLimit: 1000, existingDailyCount: 1000 }
    )
    const sb = makeSendblueMock()
    await paSendblueOutboxHandler(makeEvent("doc-hard", baseRow) as never, {
      db: db as never,
      sendblueClient: sb,
      now: () => new Date(),
      log: () => {},
      appendMessage: async () => {},
      getUser: async () => USER as never,
      getOrCreateSession: async () => ({ id: "s-1" } as never),
    })
    assert.equal(sb.calls, 0)
    assert.equal(outbound.get("doc-hard")!.status, "failed")
    assert.match(String(outbound.get("doc-hard")!.error), /quota/)
    assert.ok(audit.some((a) => a.type === "quota_hardblock"), "expected quota_hardblock audit row")
  })
})
