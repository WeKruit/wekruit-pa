import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

import { handleSendblueWebhook } from "../webhook.js"
import type { SendblueInboundPayload } from "../types.js"
import { _clearFeatureFlagCache } from "@pa/pa-persistence"

const SECRET = "test-webhook-secret"

// ---------- Fake Firestore + broker harness ----------

type DocData = Record<string, unknown>

function makeFakeDb(opts: { rateLimitFlag?: boolean } = {}) {
  const inbound = new Map<string, DocData>()
  const audit: DocData[] = []
  const flags = new Map<string, DocData>()
  const rateLimit = new Map<string, DocData>()
  const tapbacks: DocData[] = []
  const users = new Map<string, DocData>()
  const prescreenIdempotency = new Map<string, DocData>()
  const layoffIdempotency = new Map<string, DocData>()
  const applyIdempotency = new Map<string, DocData>()
  const pendingInvites = new Map<string, DocData>()
  const atsPendingTriggers = new Map<string, DocData>()

  if (opts.rateLimitFlag) {
    flags.set("paRateLimitPerUserEnabled", {
      key: "paRateLimitPerUserEnabled",
      value: true,
      type: "bool",
      scope: "perUser",
      allowlist: [],
      blocklist: [],
    })
  }

  function genericDocRef(store: Map<string, DocData>, id: string) {
    return {
      _key: id,
      async get() {
        const data = store.get(id)
        return { exists: data !== undefined, data: () => data, id }
      },
      async set(data: DocData, options?: { merge?: boolean }) {
        if (options?.merge) store.set(id, { ...(store.get(id) ?? {}), ...data })
        else store.set(id, { ...data })
      },
      async update(data: DocData) {
        store.set(id, { ...(store.get(id) ?? {}), ...data })
      },
      async delete() {
        store.delete(id)
      },
    }
  }

  const inboundCollection = {
    doc(id: string) {
      return {
        async create(data: DocData) {
          if (inbound.has(id)) {
            const err: Error & { code?: number } = new Error("ALREADY_EXISTS")
            err.code = 6
            throw err
          }
          inbound.set(id, { ...data })
        },
        async get() {
          const data = inbound.get(id)
          return { exists: data !== undefined, data: () => data, id }
        },
        // Stream H9 TD1 — webhook now writes Timestamp expiresAtTs after broker
        // enqueue via .set({merge:true}). Harness must accept it so the
        // non-fatal log path doesn't trip and noise the test output.
        async set(data: DocData, opts?: { merge?: boolean }) {
          if (opts?.merge) inbound.set(id, { ...(inbound.get(id) ?? {}), ...data })
          else inbound.set(id, { ...data })
        },
      }
    },
  }
  const auditCollection = {
    add(data: DocData) {
      audit.push({ ...data })
      return Promise.resolve({ id: `audit_${audit.length}` })
    },
    doc(id: string) {
      return genericDocRef(new Map(), id)
    },
  }
  const flagsCollection = { doc(id: string) { return genericDocRef(flags, id) } }
  const rateLimitCollection = { doc(id: string) { return genericDocRef(rateLimit, id) } }
  // Phase 33 — accept fire-and-forget writes from logRawWebhook without
  // shape constraints; tests don't assert on contents.
  const rawWebhookCollection = {
    add(_data: DocData) { return Promise.resolve({ id: "raw_1" }) },
  }
  const tapbackCollection = {
    add(data: DocData) {
      tapbacks.push({ ...data })
      return Promise.resolve({ id: `tap_${tapbacks.length}` })
    },
  }
  const collections: Record<string, unknown> = {
    // Phase 23+ kebab-case migration. Old snake-case keys retained as
    // aliases so any stale code path during transition still resolves.
    "pa-inbound-events": inboundCollection,
    "pa-audit-events": auditCollection,
    "pa-feature-flags": flagsCollection,
    "pa-rate-limits": rateLimitCollection,
    "pa-users": { doc(id: string) { return genericDocRef(users, id) } },
    "pa-prescreen-trigger-idempotency": { doc(id: string) { return genericDocRef(prescreenIdempotency, id) } },
    "pa-layoff-trigger-idempotency": { doc(id: string) { return genericDocRef(layoffIdempotency, id) } },
    "pa-apply-trigger-idempotency": { doc(id: string) { return genericDocRef(applyIdempotency, id) } },
    "pa-prescreen-pending-invites": { doc(id: string) { return genericDocRef(pendingInvites, id) } },
    "pa-ats-pending-trigger": { doc(id: string) { return genericDocRef(atsPendingTriggers, id) } },
    "pa-rate-limit": rateLimitCollection,
    "pa-sendblue-webhook-raw": rawWebhookCollection,
    "pa-tapback-events": tapbackCollection,
    pa_inbound_events: inboundCollection,
    pa_audit_events: auditCollection,
    pa_feature_flags: flagsCollection,
    pa_rate_limit: rateLimitCollection,
  }

  const db = {
    collection(name: string) {
      const c = collections[name]
      if (!c) throw new Error(`unexpected collection: ${name}`)
      return c
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const t = {
        async get(ref: { get(): Promise<unknown> }) {
          return ref.get()
        },
        update(ref: { _key: string }, data: DocData) {
          rateLimit.set(ref._key, { ...(rateLimit.get(ref._key) ?? {}), ...data })
        },
        set(ref: { _key: string }, data: DocData) {
          rateLimit.set(ref._key, { ...data })
        },
      }
      return fn(t)
    },
  } as unknown as Parameters<typeof handleSendblueWebhook>[2]["db"]

  return {
    db,
    inbound,
    audit,
    flags,
    rateLimit,
    tapbacks,
    users,
    prescreenIdempotency,
    layoffIdempotency,
    applyIdempotency,
    pendingInvites,
    atsPendingTriggers,
  }
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex")
}

function makeReq(opts: {
  body: string
  signature?: string
  signatureHeader?: string
  headers?: Record<string, string>
}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.signature ? { [opts.signatureHeader ?? "sendblue-signature"]: opts.signature } : {}),
    ...(opts.headers ?? {}),
  }
  return {
    rawBody: Buffer.from(opts.body, "utf8"),
    body: opts.body,
    headers,
    method: "POST",
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name]
    },
  } as unknown as Parameters<typeof handleSendblueWebhook>[0]
}

function makeRes() {
  let statusCode = 200
  let bodyOut: unknown = null
  return {
    status(code: number) {
      statusCode = code
      return this
    },
    json(body: unknown) {
      bodyOut = body
      return this
    },
    send(body: unknown) {
      bodyOut = body
      return this
    },
    set() {
      return this
    },
    get statusCode() {
      return statusCode
    },
    get bodyOut() {
      return bodyOut
    },
  } as Parameters<typeof handleSendblueWebhook>[1] & { statusCode: number; bodyOut: unknown }
}

const ENV_KEYS = [
  "IMESSAGE_PEERS",
  "IMESSAGE_PEER",
  "IMESSAGE_DEFAULT_PEER",
  "PA_TYPING_INDICATOR",
  // R3 audio canary gate determinism: keep the dev-cohort split (env unset →
  // isCanaryUser only true for CANARY_UIDS) so the non-canary audio test holds.
  "PA_ONBOARDING_RAMP_ALL",
] as const

let savedEnv: Record<string, string | undefined>

function basePayload(overrides: Partial<SendblueInboundPayload> = {}): SendblueInboundPayload {
  return {
    content: "hello sendblue",
    from_number: "+15551234567",
    to_number: "+15557654321",
    message_handle: "msg-abc-123",
    date_sent: "2026-04-27T20:00:00.000Z",
    status: "RECEIVED",
    service: "iMessage",
    ...overrides,
  }
}

// ---------- Tests ----------

describe("handleSendblueWebhook", () => {
  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    _clearFeatureFlagCache()
  })
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v
    }
  })

  it("Test 1: invalid HMAC → 401, no inbound event, no audit record", async () => {
    const { db, inbound, audit } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: "deadbeef" })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 401)
    assert.equal(inbound.size, 0)
    assert.equal(audit.length, 0)
  })

  it("Test 2: valid HMAC + arbitrary from_number → 200, ONE inbound", async () => {
    const { db, inbound, audit } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()
    const typingCalls: string[] = []

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      sendTypingIndicator: async ({ to }) => {
        typingCalls.push(to)
      },
    })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
    assert.deepEqual(typingCalls, ["+15551234567"], "accepted inbound should show bot typing")
    assert.equal(audit.length, 0)
  })

  it("Test 3: valid HMAC + receive → 200, ONE inbound row keyed sendblue-${message_handle}", async () => {
    const { db, inbound } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()
    const typingCalls: string[] = []

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      sendTypingIndicator: async ({ to }) => {
        typingCalls.push(to)
      },
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(typingCalls, ["+15551234567"])
    assert.equal(inbound.size, 1)
    const [doc] = [...inbound.values()]
    assert.ok(doc)
    assert.equal(doc!.idempotencyKey, "sendblue-msg-abc-123")
    assert.equal(doc!.channel, "imessage")
    assert.equal(doc!.status, "pending")
  })

  it("Test 3b: accepted inbound bot typing hint runs before broker enqueue and honors PA_TYPING_INDICATOR=0", async () => {
    const { db } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()
    const order: string[] = []

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      sendTypingIndicator: async ({ to }) => {
        order.push(`typing:${to}`)
      },
      createInboundEvent: async (_db, input) => {
        order.push(`broker:${input.idempotencyKey}`)
        const now = new Date().toISOString()
        return {
          id: "inb_order_test",
          created: true,
          event: {
            id: "inb_order_test",
            channel: "imessage",
            status: "pending",
            idempotencyKey: input.idempotencyKey,
            rawPayload: input.rawPayload,
            createdAt: now,
            attemptCount: 0,
            maxAttempts: 8,
            correlationId: "corr-order-test",
          },
        }
      },
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(order, ["typing:+15551234567", "broker:sendblue-msg-abc-123"])

    process.env.PA_TYPING_INDICATOR = "0"
    const disabledRes = makeRes()
    const disabledOrder: string[] = []
    await handleSendblueWebhook(makeReq({ body, signature: SECRET }), disabledRes, {
      db,
      secret: SECRET,
      sendTypingIndicator: async ({ to }) => {
        disabledOrder.push(`typing:${to}`)
      },
      createInboundEvent: async (_db, input) => {
        disabledOrder.push(`broker:${input.idempotencyKey}`)
        const now = new Date().toISOString()
        return {
          id: "inb_order_test_disabled",
          created: true,
          event: {
            id: "inb_order_test_disabled",
            channel: "imessage",
            status: "pending",
            idempotencyKey: input.idempotencyKey,
            rawPayload: input.rawPayload,
            createdAt: now,
            attemptCount: 0,
            maxAttempts: 8,
            correlationId: "corr-order-test-disabled",
          },
        }
      },
    })

    assert.equal(disabledRes.statusCode, 200)
    assert.deepEqual(disabledOrder, ["broker:sendblue-msg-abc-123"])
  })

  it("Test 4: same message_handle posted twice → exactly ONE inbound row (broker idempotency)", async () => {
    const { db, inbound } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req1 = makeReq({ body, signature: SECRET })
    const res1 = makeRes()
    await handleSendblueWebhook(req1, res1, { db, secret: SECRET })

    const req2 = makeReq({ body, signature: SECRET })
    const res2 = makeRes()
    await handleSendblueWebhook(req2, res2, { db, secret: SECRET })

    assert.equal(res1.statusCode, 200)
    assert.equal(res2.statusCode, 200)
    assert.equal(inbound.size, 1)
  })

  it("Test 5: outbound event (is_outbound=true) → 200, NO inbound, audit outbound_mirror", async () => {
    const { db, inbound, audit } = makeFakeDb()
    const payload = { ...basePayload(), is_outbound: true }
    const body = JSON.stringify(payload)
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 0)
    assert.ok(audit.some((a) => a.type === "outbound_mirror"))
  })

  it("Test 6: typing_indicator / line_blocked event → 200, NO inbound, audit log only", async () => {
    const { db, inbound, audit } = makeFakeDb()
    // Synthetic typing payload (no message_handle, no content)
    const body = JSON.stringify({ type: "typing_indicator", number: "+15551234567" })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 0)
    assert.ok(audit.length >= 1)
  })

  it("Test 7: group_id non-empty → 200, NO inbound, audit group_chat_rejected (Q-03 lock)", async () => {
    const { db, inbound, audit } = makeFakeDb()
    const body = JSON.stringify({ ...basePayload(), group_id: "g-abc" })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 0)
    assert.ok(audit.some((a) => a.type === "group_chat_rejected"))
  })

  it("Test 8: empty content AND no media_url → 200, NO inbound", async () => {
    const { db, inbound } = makeFakeDb()
    // Explicit: no media_url. Skip-empty rule still applies.
    const body = JSON.stringify({ ...basePayload(), content: "" })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 0)
  })

  it("Test 8b (BUG #6): empty content + media_url → 200, ONE inbound row with mediaUrl + attachmentReceived in rawPayload", async () => {
    const { db, inbound } = makeFakeDb()
    const mediaUrl = "https://storage.googleapis.com/inbound-file-store/test-resume.pdf"
    const body = JSON.stringify({ ...basePayload(), content: "", media_url: mediaUrl })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200, "empty content with media_url MUST NOT skip — that was BUG #6")
    assert.equal(inbound.size, 1, "attachment-only message must enqueue a single inbound row")
    const [doc] = [...inbound.values()]
    assert.ok(doc)
    assert.equal(doc!.idempotencyKey, "sendblue-msg-abc-123")
    assert.equal(doc!.channel, "imessage")
    const raw = doc!.rawPayload as Record<string, unknown>
    assert.equal(raw.mediaUrl, mediaUrl)
    assert.equal(raw.attachmentReceived, true)
    assert.equal(raw.text, "[attachment]")
  })

  it("Test 8d (Stream D): media_url → 200 + inbound enqueued + no webhook tapback + ingestCv called once with resolved userId", async () => {
    const { db, inbound } = makeFakeDb()
    const mediaUrl = "https://storage.googleapis.com/inbound-file-store/test-cv.pdf"
    const body = JSON.stringify({ ...basePayload(), content: "", media_url: mediaUrl })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    const ingestCalls: Array<{ userId: string; mediaUrl: string; sessionId?: string }> = []

    const ingestCvMock = async (input: { userId: string; mediaUrl: string; sessionId?: string }) => {
      ingestCalls.push({ userId: input.userId, mediaUrl: input.mediaUrl, sessionId: input.sessionId })
      return { ok: true as const, resumeId: "rsm_test_1", userId: input.userId }
    }
    const lookupMock = async (_db: unknown, phone: string) => {
      return phone === "+15551234567" ? "user_adam_test" : null
    }

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      ingestCv: ingestCvMock,
      lookupUserByPhone: lookupMock,
    })

    // Reply path is unchanged — 200 + one inbound row.
    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)

    // Both side-effects are fire-and-forget; let the microtask queue settle
    // before asserting on the mock state.
    await new Promise((r) => setTimeout(r, 20))

    // D4: ingestCv fired with resolved userId.
    assert.equal(ingestCalls.length, 1, "ingestCv must be called exactly once on media_url receipt with a resolvable user")
    assert.equal(ingestCalls[0]!.userId, "user_adam_test")
    assert.equal(ingestCalls[0]!.mediaUrl, mediaUrl)
  })

  it("Test 8e (Stream D): text-only inbound (no media_url) → no ingestCv", async () => {
    const { db } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    let ingestCount = 0
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      ingestCv: async () => { ingestCount++; return { ok: false as const, reason: "test" } },
      lookupUserByPhone: async () => "user_adam_test",
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(res.statusCode, 200)
    assert.equal(ingestCount, 0, "no media_url → no ingest")
  })

  // ---- R3 (Adam 2026-06-04) — AUDIO evidence intake ----
  const CANARY_UID = "8fEwIduUrzxZsblHHsNz" // dev cohort (canary.ts CANARY_UIDS)

  it("Test 8f (R3 audio): canary voice note → transcribed → inbound text = transcript, mediaUrl cleared, NO ingestCv", async () => {
    const { db, inbound } = makeFakeDb()
    const audioUrl = "https://storage.googleapis.com/inbound-file-store/voice.m4a"
    const body = JSON.stringify({ ...basePayload(), content: "", media_url: audioUrl })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    let ingestCvCount = 0
    let ingestAudioCount = 0
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => CANARY_UID,
      ingestCv: async () => { ingestCvCount++; return { ok: false as const, reason: "should_not_run" } },
      ingestAudio: async (url) => {
        ingestAudioCount++
        assert.equal(url, audioUrl)
        return { ok: true as const, transcript: "i'm a senior backend engineer, 6 years at stripe" }
      },
    })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
    const raw = ([...inbound.values()][0]!.rawPayload) as Record<string, unknown>
    // Transcript becomes the inbound text — processed like a typed message.
    assert.equal(raw.text, "i'm a senior backend engineer, 6 years at stripe")
    // mediaUrl cleared → NOT plumbed as an attachment.
    assert.equal(raw.mediaUrl, undefined)
    assert.equal(raw.attachmentReceived, undefined)
    assert.equal(ingestAudioCount, 1, "audio was transcribed")
    assert.equal(ingestCvCount, 0, "a voice note must NOT route to the PDF ingestCv path")
  })

  it("Test 8g (R3 audio): PDF résumé still routes to ingestCv unchanged (not treated as audio)", async () => {
    const { db, inbound } = makeFakeDb()
    const pdfUrl = "https://storage.googleapis.com/inbound-file-store/resume.pdf"
    const body = JSON.stringify({ ...basePayload(), content: "", media_url: pdfUrl })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    let ingestCvCount = 0
    let ingestAudioCount = 0
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => CANARY_UID, // canary, but a PDF is not audio
      ingestCv: async (input) => {
        ingestCvCount++
        assert.equal(input.mediaUrl, pdfUrl)
        return { ok: true as const, resumeId: "rsm_1", userId: CANARY_UID }
      },
      ingestAudio: async () => { ingestAudioCount++; return { ok: false as const, reason: "should_not_run" } },
    })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
    const raw = ([...inbound.values()][0]!.rawPayload) as Record<string, unknown>
    // Untouched media path: still an [attachment] inbound carrying the media_url.
    assert.equal(raw.text, "[attachment]")
    assert.equal(raw.mediaUrl, pdfUrl)
    assert.equal(raw.attachmentReceived, true)
    assert.equal(ingestAudioCount, 0, "a PDF must never hit the audio path")
    assert.equal(ingestCvCount, 1, "PDF résumé still ingests via ingestCv")
  })

  it("Test 8g2 (BUG 3 — Noah Liu, 2026-06-04): webhook Stream-D résumé ingest bypasses the invite-gate (no phantom not_invited rejection)", async () => {
    // ROOT CAUSE this pins: a canary user (no resumeAccepted flag) texted us a perfectly
    // readable PDF résumé. The webhook Stream-D fire-and-forget ingest did NOT pass
    // skipLimitEnforcement, so cv-ingest's invite-gate rejected it with "not_invited" and
    // enqueued a resume_ingest_rejected runtime event. The thin agent, handed only that bare
    // reject context, hallucinated "not enough readable text — re-upload" even though the PDF
    // parsed to 4213 chars. The fix makes this internal, system-initiated parse bypass the gate
    // (it stays parse-only via followupDeliveryMode:"none", so the cutover Path-B ingest remains
    // the single producer of the candidate-facing pitch/overwrite UX).
    //
    // The Stream-D ingest is fire-and-forget (void Promise(...).catch(...)) so an assertion thrown
    // INSIDE the ingestCv mock is swallowed and would NOT fail the test. We therefore RECORD the
    // opts and assert AFTER the promise settles — making this a genuine RED against the old code.
    const { db } = makeFakeDb()
    const pdfUrl = "https://storage.googleapis.com/inbound-file-store/hQxHpy48_Noah_Liu_CV.pdf"
    const body = JSON.stringify({ ...basePayload(), content: "", media_url: pdfUrl })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    let capturedOpts: { skipLimitEnforcement?: boolean; followupDeliveryMode?: string } | undefined
    let ingestCvCount = 0
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => CANARY_UID,
      ingestCv: async (input, opts) => {
        ingestCvCount++
        assert.equal(input.mediaUrl, pdfUrl)
        capturedOpts = opts as typeof capturedOpts
        return { ok: true as const, resumeId: "rsm_noah", userId: CANARY_UID }
      },
    })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.statusCode, 200)
    assert.equal(ingestCvCount, 1, "the texted PDF résumé reaches the Stream-D ingest")
    // The load-bearing assertions — observed OUTSIDE the swallowed fire-and-forget promise.
    assert.equal(
      capturedOpts?.skipLimitEnforcement,
      true,
      "webhook Stream-D ingest MUST bypass the invite-gate (no spurious not_invited rejection)",
    )
    assert.equal(
      capturedOpts?.followupDeliveryMode,
      "none",
      "webhook Stream-D ingest stays parse-only — cutover Path-B is the single pitch producer",
    )
  })

  it("Test 8g3 (double-parse fix, 2026-06-05): THIN user → webhook Stream-D ingest SKIPPED (cutover Path B is the sole producer)", async () => {
    // The live ~3-min repitch (8fEw) was caused by TWO full parses racing: this webhook Path-A
    // "pre-warm" (which writes its row only at the END of a ~70s parse, so it never actually warms)
    // AND the cutover Path-B ingest. For a THIN user, cutover Path B is already the single parse +
    // pitch producer, so Path A is pure redundant contention → skip it. Legacy (thin OFF) keeps Path A.
    const { db } = makeFakeDb()
    await db.collection("pa-feature-flags").doc("paThinClaireEnabled").set({
      key: "paThinClaireEnabled", value: true, type: "bool", scope: "perUser", allowlist: [], blocklist: [],
    })
    const pdfUrl = "https://storage.googleapis.com/inbound-file-store/resume.pdf"
    const body = JSON.stringify({ ...basePayload(), content: "", media_url: pdfUrl })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    let ingestCvCount = 0
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => CANARY_UID,
      ingestCv: async () => { ingestCvCount++; return { ok: true as const, resumeId: "r", userId: CANARY_UID } },
    })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.statusCode, 200)
    assert.equal(ingestCvCount, 0, "thin user → webhook Path A ingest is skipped (no double-parse; cutover Path B owns it)")
  })

  it("Test 8g4 (double-parse fix): LEGACY user (thin OFF) → webhook Stream-D ingest STILL runs (sole ingest there)", async () => {
    const { db } = makeFakeDb() // no thin flag seeded → isThinClaireEnabled false
    const pdfUrl = "https://storage.googleapis.com/inbound-file-store/resume.pdf"
    const body = JSON.stringify({ ...basePayload(), content: "", media_url: pdfUrl })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    let ingestCvCount = 0
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "legacy_user",
      ingestCv: async () => { ingestCvCount++; return { ok: true as const, resumeId: "r", userId: "legacy_user" } },
    })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.statusCode, 200)
    assert.equal(ingestCvCount, 1, "legacy user → webhook Path A is the only résumé ingest, must still run")
  })

  it("Test 8h (R3 audio): non-canary voice note → audio path skipped, media path unchanged", async () => {
    const { db, inbound } = makeFakeDb()
    const audioUrl = "https://storage.googleapis.com/inbound-file-store/voice.m4a"
    const body = JSON.stringify({ ...basePayload(), content: "", media_url: audioUrl })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    let ingestCvCount = 0
    let ingestAudioCount = 0
    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "non_canary_user", // NOT in the dev cohort
      ingestCv: async () => { ingestCvCount++; return { ok: true as const, resumeId: "r", userId: "non_canary_user" } },
      ingestAudio: async () => { ingestAudioCount++; return { ok: true as const, transcript: "should not run" } },
    })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.statusCode, 200)
    assert.equal(ingestAudioCount, 0, "non-canary users do not get the audio transcription path yet")
    const raw = ([...inbound.values()][0]!.rawPayload) as Record<string, unknown>
    // Unchanged: still an [attachment] inbound with the media_url present.
    assert.equal(raw.text, "[attachment]")
    assert.equal(raw.mediaUrl, audioUrl)
  })

  it("Test 8i (R3 audio): transcription fails → FAIL OPEN, media path continues unchanged", async () => {
    const { db, inbound } = makeFakeDb()
    const audioUrl = "https://storage.googleapis.com/inbound-file-store/voice.caf"
    const body = JSON.stringify({ ...basePayload(), content: "", media_url: audioUrl })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => CANARY_UID,
      ingestCv: async () => ({ ok: false as const, reason: "noop" }),
      // Transcription returns a failure — turn must NOT break.
      ingestAudio: async () => ({ ok: false as const, reason: "transcribe_failed" }),
    })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.statusCode, 200, "an audio hiccup must never break the turn")
    assert.equal(inbound.size, 1)
    const raw = ([...inbound.values()][0]!.rawPayload) as Record<string, unknown>
    // Fall back to the existing media path: still [attachment] + media_url present.
    assert.equal(raw.text, "[attachment]")
    assert.equal(raw.mediaUrl, audioUrl)
  })

  it("Test 8j (R3 audio): audio-ingest throws → FAIL OPEN (caught), 200 + media path unchanged", async () => {
    const { db, inbound } = makeFakeDb()
    const audioUrl = "https://storage.googleapis.com/inbound-file-store/voice.m4a"
    const body = JSON.stringify({ ...basePayload(), content: "", media_url: audioUrl })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => CANARY_UID,
      ingestCv: async () => ({ ok: false as const, reason: "noop" }),
      ingestAudio: async () => { throw new Error("unexpected audio crash") },
    })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.statusCode, 200, "an audio crash must be caught and never break the turn")
    assert.equal(inbound.size, 1)
    const raw = ([...inbound.values()][0]!.rawPayload) as Record<string, unknown>
    assert.equal(raw.text, "[attachment]")
    assert.equal(raw.mediaUrl, audioUrl)
  })

  it("Test 8c (tapback inbound): Loved \"...\" → still enqueues inbound + writes pa-tapback-events row", async () => {
    const { db, inbound, tapbacks } = makeFakeDb()
    const body = JSON.stringify({ ...basePayload(), content: "Loved “Career check-in tomorrow?”" })
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    // Normal inbound still flows through so Claire can acknowledge in chat.
    assert.equal(inbound.size, 1)
    // Plus a tapback-events row for the matching pipeline.
    assert.equal(tapbacks.length, 1)
    const tap = tapbacks[0]!
    assert.equal(tap.kind, "love")
    assert.equal(tap.quotedText, "Career check-in tomorrow?")
    assert.equal(tap.sourceMessageHandle, "msg-abc-123")
    assert.equal(tap.userId, "+15551234567")
  })

  it("Test 9: malformed JSON body (with valid HMAC) → 400 Bad Request", async () => {
    const { db, inbound } = makeFakeDb()
    const body = "{not-json"
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 400)
    assert.equal(inbound.size, 0)
  })

  it("Test 11 (Phase 26 T1): rate-limit flag enabled → 21st message in window returns 429", async () => {
    const { db, inbound, audit } = makeFakeDb({ rateLimitFlag: true })
    let lastStatus = 200
    for (let i = 0; i < 21; i++) {
      const body = JSON.stringify(basePayload({ message_handle: `msg-rl-${i}` }))
      const req = makeReq({ body, signature: SECRET })
      const res = makeRes()
      await handleSendblueWebhook(req, res, { db, secret: SECRET })
      lastStatus = res.statusCode
    }
    assert.equal(lastStatus, 429)
    // First 20 enqueued; 21st rejected → exactly 20 inbound rows.
    assert.equal(inbound.size, 20)
    assert.ok(audit.some((a) => a.type === "rate_limit_exceeded"))
  })

  it("Test 10: signature header alias sb-signature also accepted", async () => {
    // Sendblue auth is plaintext shared-secret compare (not HMAC-over-body)
    // per hmac.ts line 5-6 + verifier rewrite 2026-04-27. The signature
    // header carries the SECRET itself, not a hash of the body.
    const { db, inbound } = makeFakeDb()
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: SECRET, signatureHeader: "sb-signature" })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
  })

  // Phase 33 — Regression lock for the 2026-04-28 incident: Sendblue's
  // production webhook header is `sb-signing-secret` carrying the configured
  // shared secret value verbatim. The verifier MUST accept this format.
  it("Test 12 (Phase 33 regression lock): real Sendblue sb-signing-secret header → 200 + enqueued", async () => {
    const { db, inbound } = makeFakeDb()
    const body = JSON.stringify(basePayload({ message_handle: "msg-real-sendblue" }))
    const req = makeReq({ body, signature: SECRET, signatureHeader: "sb-signing-secret" })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200, "real Sendblue header must be accepted post-fix")
    assert.equal(inbound.size, 1)
  })

  // Phase 33 — every delivery hits pa-sendblue-webhook-raw BEFORE verify.
  // Even on 401, the raw payload is preserved for replay.
  it("Test 13 (Phase 33): raw-payload log written even when HMAC verify fails", async () => {
    const captured: Array<Record<string, unknown>> = []
    const { db } = makeFakeDb()
    // Tap the raw collection by overlaying a custom add() that captures rows.
    const origCollection = (db as { collection(name: string): unknown }).collection
    ;(db as { collection(name: string): unknown }).collection = (name: string) => {
      if (name === "pa-sendblue-webhook-raw") {
        return {
          add(row: Record<string, unknown>) {
            captured.push(row)
            return Promise.resolve({ id: `raw_${captured.length}` })
          },
        }
      }
      return origCollection.call(db, name)
    }
    const body = JSON.stringify(basePayload())
    const req = makeReq({ body, signature: "wrong-secret", signatureHeader: "sb-signing-secret" })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 401, "wrong secret must still reject")
    // Allow ms for the fire-and-forget write to land.
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(captured.length >= 1, "raw payload must be logged even on 401")
    assert.equal(typeof captured[0]?.bodyText, "string")
  })

  // Stream G4a — synthetic-webhook marker tests.
  it("Test 14 (Stream G4a): X-E2E-Test:1 → rawMeta.e2eTest=true on raw row + rawPayload.e2eTest=true on inbound", async () => {
    const captured: Array<Record<string, unknown>> = []
    const { db, inbound } = makeFakeDb()
    const origCollection = (db as { collection(name: string): unknown }).collection
    ;(db as { collection(name: string): unknown }).collection = (name: string) => {
      if (name === "pa-sendblue-webhook-raw") {
        return {
          add(row: Record<string, unknown>) {
            captured.push(row)
            return Promise.resolve({ id: `raw_${captured.length}` })
          },
        }
      }
      return origCollection.call(db, name)
    }
    const body = JSON.stringify(basePayload({ message_handle: "msg-e2e-1" }))
    const req = makeReq({ body, signature: SECRET, headers: { "x-e2e-test": "1" } })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200, "X-E2E-Test:1 must preserve the synthetic marker")
    assert.equal(inbound.size, 1, "synthetic test must enqueue inbound")

    // Allow microtask for fire-and-forget raw log.
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(captured.length >= 1, "raw payload row must be written")
    const rawRow = captured[0]!
    assert.equal((rawRow.rawMeta as { e2eTest?: boolean } | undefined)?.e2eTest, true,
      "rawMeta.e2eTest=true must be present when X-E2E-Test header is set")

    const inboundDoc = [...inbound.values()][0]!
    const raw = inboundDoc.rawPayload as Record<string, unknown>
    assert.equal(raw.e2eTest, true, "inbound rawPayload.e2eTest=true must be present")
  })

  it("Test 15 (Stream G4a): no X-E2E-Test header → no e2eTest field anywhere (regression lock)", async () => {
    const captured: Array<Record<string, unknown>> = []
    const { db, inbound } = makeFakeDb()
    const origCollection = (db as { collection(name: string): unknown }).collection
    ;(db as { collection(name: string): unknown }).collection = (name: string) => {
      if (name === "pa-sendblue-webhook-raw") {
        return {
          add(row: Record<string, unknown>) {
            captured.push(row)
            return Promise.resolve({ id: `raw_${captured.length}` })
          },
        }
      }
      return origCollection.call(db, name)
    }
    const body = JSON.stringify(basePayload({ message_handle: "msg-organic-1" }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(captured.length >= 1)
    const rawRow = captured[0]!
    assert.equal(rawRow.rawMeta, undefined,
      "organic traffic must NOT have rawMeta field — backward compat with existing analytics")

    const inboundDoc = [...inbound.values()][0]!
    const raw = inboundDoc.rawPayload as Record<string, unknown>
    assert.equal(raw.e2eTest, undefined,
      "organic traffic must NOT have rawPayload.e2eTest field")
  })

  it("Test 16 (entrypoints): job prescreen token starts a prescreen session and skips normal onboarding", async () => {
    const { db, inbound, audit, prescreenIdempotency } = makeFakeDb()
    const prescreenCalls: Array<{ jobId: string; userId: string; toE164: string; sourceRequestedUserId?: string }> = []
    const body = JSON.stringify(basePayload({
      content: "WeKruit_rain-software-engineer-fullstack-8849f6ef_uJob1_Job",
      message_handle: "msg-entry-job-1",
    }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "uJob1",
      runPreScreenForUser: async (args) => {
        prescreenCalls.push(args)
        return { ok: true, sessionId: "ps_job_1" }
      },
    })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, action: "prescreen_triggered" })
    assert.equal(inbound.size, 0, "trigger token must not enter normal onboarding as user text")
    assert.equal(prescreenCalls.length, 1)
    assert.equal(prescreenCalls[0]!.jobId, "rain-software-engineer-fullstack-8849f6ef")
    assert.equal(prescreenCalls[0]!.userId, "uJob1")
    assert.equal(prescreenCalls[0]!.toE164, "+15551234567")
    assert.ok(prescreenIdempotency.has("rain-software-engineer-fullstack-8849f6ef_uJob1_msg-entry-job-1"))
    assert.ok(audit.some((row) =>
      row.type === "trigger_fired" &&
      (row.payload as { trigger?: string } | undefined)?.trigger === "prescreen"
    ))
  })

  it("Test 16a (entrypoints): prescreen trigger waits for session bootstrap before replying", async () => {
    const { db, inbound } = makeFakeDb()
    const body = JSON.stringify(basePayload({
      content: "WeKruit_rain-software-engineer-fullstack-8849f6ef_uJob1_Job",
      message_handle: "msg-entry-job-wait-1",
    }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    let started = false
    let release!: () => void
    const bootstrapGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const request = handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "uJob1",
      runPreScreenForUser: async () => {
        started = true
        await bootstrapGate
        return { ok: true, sessionId: "ps_job_wait_1" }
      },
    })

    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(started, true)
    assert.equal(res.bodyOut, null, "webhook must not reply before prescreen bootstrap finishes")
    assert.equal(inbound.size, 0, "trigger token must not enter normal onboarding while waiting")

    release()
    await request

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, action: "prescreen_triggered" })
  })

  it("Test 16a.1 (entrypoints): prescreen trigger bootstrap failure does not acknowledge handled", async () => {
    const { db, inbound, prescreenIdempotency } = makeFakeDb()
    const body = JSON.stringify(basePayload({
      content: "WeKruit_rain-software-engineer-fullstack-8849f6ef_uJob1_Job",
      message_handle: "msg-entry-job-fail-1",
    }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "uJob1",
      runPreScreenForUser: async () => {
        throw new Error("firestore unavailable")
      },
    })

    assert.equal(res.statusCode, 500)
    assert.deepEqual(res.bodyOut, {
      ok: false,
      error: "trigger_error",
      action: "prescreen_error",
      reason: "firestore unavailable",
    })
    assert.equal(inbound.size, 0, "failed control-plane token must not fall through as candidate text")
    assert.equal(
      prescreenIdempotency.has("rain-software-engineer-fullstack-8849f6ef_uJob1_msg-entry-job-fail-1"),
      false,
      "failed bootstrap must not leave a permanent retry-dedupe marker",
    )
  })

  it("Test 16a.2 (entrypoints): prescreen trigger send_failed result does not acknowledge handled", async () => {
    const { db, inbound, prescreenIdempotency } = makeFakeDb()
    const body = JSON.stringify(basePayload({
      content: "WeKruit_rain-software-engineer-fullstack-8849f6ef_uJob1_Job",
      message_handle: "msg-entry-job-send-failed-1",
    }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "uJob1",
      runPreScreenForUser: async () => ({
        ok: false,
        reason: "send_failed",
        sessionId: "ps_job_send_failed_1",
      }),
    })

    assert.equal(res.statusCode, 500)
    assert.deepEqual(res.bodyOut, {
      ok: false,
      error: "trigger_error",
      action: "prescreen_error",
      reason: "prescreen_start_send_failed",
    })
    assert.equal(inbound.size, 0, "failed control-plane token must not fall through as candidate text")
    assert.equal(
      prescreenIdempotency.has("rain-software-engineer-fullstack-8849f6ef_uJob1_msg-entry-job-send-failed-1"),
      false,
      "failed send result must not leave a permanent retry-dedupe marker",
    )
  })

  it("Test 16a.3 (entrypoints): prescreen trigger config_missing reports the notice action", async () => {
    const { db, inbound, prescreenIdempotency } = makeFakeDb()
    const body = JSON.stringify(basePayload({
      content: "WeKruit_rain-software-engineer-fullstack-8849f6ef_uJob1_Job",
      message_handle: "msg-entry-job-config-missing-1",
    }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "uJob1",
      runPreScreenForUser: async () => ({
        ok: false,
        reason: "config_missing",
        sessionId: "ps_job_config_missing_1",
      }),
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, action: "prescreen_config_missing" })
    assert.equal(inbound.size, 0, "config-missing control-plane token must not fall through as candidate text")
    assert.equal(
      prescreenIdempotency.has("rain-software-engineer-fullstack-8849f6ef_uJob1_msg-entry-job-config-missing-1"),
      true,
      "sent config-missing notice remains idempotent for the same inbound message",
    )
  })

  it("Test 16a.4 (entrypoints): SELF prescreen token for an UNMATCHED job is refused (matched-gate), no fall-through, idempotency cleared", async () => {
    const { db, inbound, prescreenIdempotency } = makeFakeDb()
    const body = JSON.stringify(basePayload({
      content: "WeKruit_rain-software-engineer-fullstack-8849f6ef_uJob1_Job",
      message_handle: "msg-entry-job-not-matched-1",
    }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      // body userId "uJob1" === resolved → SELF path → matched-gate runs in the real
      // bootstrap. Here the stub returns not_matched (job never matched/pushed to them).
      lookupUserByPhone: async () => "uJob1",
      runPreScreenForUser: async () => ({
        ok: false,
        reason: "not_matched",
        sessionId: "ps_job_not_matched_1",
      }),
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, action: "prescreen_not_matched" })
    assert.equal(inbound.size, 0, "refused control-plane token must not fall through as candidate text")
    assert.equal(
      prescreenIdempotency.has("rain-software-engineer-fullstack-8849f6ef_uJob1_msg-entry-job-not-matched-1"),
      false,
      "not_matched clears the stamp so a later legit start (after the job IS matched) is not deduped",
    )
  })

  it("Test 16b (entrypoints): job prescreen token with answer binds and routes initial reply after session start", async () => {
    const { db, inbound } = makeFakeDb()
    const prescreenCalls: Array<{ jobId: string; userId: string; toE164: string; suppressFirstQuestion?: boolean }> = []
    const turnCalls: Array<{ userId: string; toE164: string; replyText: string }> = []
    const body = JSON.stringify(basePayload({
      content: "WeKruit_rain-software-engineer-fullstack-8849f6ef_uJob1_Job\n\nI shipped a Figma-to-Framer consumer onboarding redesign.",
      message_handle: "msg-entry-job-answer-1",
    }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "uJob1",
      runPreScreenForUser: async (args) => {
        prescreenCalls.push(args)
        return { ok: true, sessionId: "ps_job_answer_1" }
      },
      runPrescreenTurnIfActive: async (args) => {
        turnCalls.push({ userId: args.userId, toE164: args.toE164, replyText: args.replyText })
        return { handled: true, sessionId: "ps_job_answer_1", terminal: undefined, textSent: "next question" }
      },
    })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, action: "prescreen_triggered" })
    assert.equal(inbound.size, 0, "trigger token + answer must not enter normal onboarding")
    assert.equal(prescreenCalls.length, 1)
    assert.equal(prescreenCalls[0]!.userId, "uJob1")
    assert.equal(prescreenCalls[0]!.suppressFirstQuestion, true)
    assert.equal(turnCalls.length, 1)
    assert.deepEqual(turnCalls[0], {
      userId: "uJob1",
      toE164: "+15551234567",
      replyText: "I shipped a Figma-to-Framer consumer onboarding redesign.",
    })
  })

  it("Test 17 (entrypoints): public-page random uid token binds to phone-resolved pa-user through pending invite", async () => {
    const { db, inbound, pendingInvites, prescreenIdempotency } = makeFakeDb()
    pendingInvites.set("11111111-2222-4333-8444-555555555555", {
      jobId: "rain-software-engineer-fullstack-8849f6ef",
      createdAt: new Date().toISOString(),
    })
    const prescreenCalls: Array<{ jobId: string; userId: string; toE164: string; sourceRequestedUserId?: string }> = []
    const body = JSON.stringify(basePayload({
      content: "WeKruit_rain-software-engineer-fullstack-8849f6ef_11111111-2222-4333-8444-555555555555_Job",
      message_handle: "msg-entry-public-1",
    }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "u_real_candidate_1",
      runPreScreenForUser: async (args) => {
        prescreenCalls.push(args)
        return { ok: true, sessionId: "ps_public_1" }
      },
    })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, action: "prescreen_triggered" })
    assert.equal(inbound.size, 0)
    assert.equal(prescreenCalls.length, 1)
    assert.equal(prescreenCalls[0]!.userId, "u_real_candidate_1")
    assert.equal(prescreenCalls[0]!.sourceRequestedUserId, "11111111-2222-4333-8444-555555555555")
    assert.equal(pendingInvites.has("11111111-2222-4333-8444-555555555555"), false, "pending public invite is consumed after binding")
    assert.ok(prescreenIdempotency.has("rain-software-engineer-fullstack-8849f6ef_u_real_candidate_1_msg-entry-public-1"))
  })

  it("Test 17b (entrypoints): prescreen token from a conflicting phone gets a notice instead of silence", async () => {
    const { db, inbound, audit, prescreenIdempotency } = makeFakeDb()
    const notices: Array<{
      targetUserId: string
      jobId: string
      toE164: string
      fromNumber?: string
      messageHandle: string
      content: string
      conflictCode: string
    }> = []
    const prescreenCalls: Array<{ jobId: string; userId: string; toE164: string }> = []
    const body = JSON.stringify(basePayload({
      content: "WeKruit_hs-11005308-paradigm-gtm-growth_mGuQxsTGkisKtptNjg4b_Job",
      from_number: "+17167509332",
      to_number: "+17174919939",
      message_handle: "msg-entry-phone-conflict",
    }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => {
        throw new Error("identity_conflict:pa_users_phone_mismatch:mGuQxsTGkisKtptNjg4b:existing_+17163039362_attempted_+17167509332")
      },
      sendIdentityConflictNotice: async (input) => {
        notices.push(input)
      },
      runPreScreenForUser: async (args) => {
        prescreenCalls.push(args)
        return { ok: true, sessionId: "should_not_start" }
      },
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, action: "prescreen_identity_conflict_notified" })
    assert.equal(inbound.size, 0, "conflicting token must not fall through to normal Claire runtime")
    assert.equal(prescreenCalls.length, 0, "conflicting token must not start the interview")
    assert.equal(prescreenIdempotency.size, 0, "conflicting token must not stamp prescreen idempotency")
    assert.equal(notices.length, 1)
    assert.equal(notices[0]!.targetUserId, "mGuQxsTGkisKtptNjg4b")
    assert.equal(notices[0]!.jobId, "hs-11005308-paradigm-gtm-growth")
    assert.equal(notices[0]!.toE164, "+17167509332")
    assert.equal(notices[0]!.fromNumber, "+17174919939")
    assert.match(notices[0]!.content, /already tied to a different phone\/account/)
    assert.equal(notices[0]!.conflictCode, "pa_users_phone_mismatch")
    assert.equal(audit.some((row) =>
      row.type === "trigger_unauthorized" &&
      row.reason === "identity_conflict" &&
      row.fromNumber === "+17167509332"
    ), true)
  })

  it("Test 18 (entrypoints): WeKruit_LAID_OFF no longer starts manual layoff onboarding", async () => {
    const { db, inbound, audit, layoffIdempotency } = makeFakeDb()
    const layoffCalls: Array<{ userId: string; toE164: string }> = []
    const body1 = JSON.stringify(basePayload({
      content: "WeKruit_LAID_OFF",
      message_handle: "msg-entry-layoff-1",
    }))
    const req1 = makeReq({ body: body1, signature: SECRET })
    const res1 = makeRes()

    await handleSendblueWebhook(req1, res1, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "u_layoff_1",
      runLayoffSmsStart: async ({ userId, toE164 }) => {
        layoffCalls.push({ userId, toE164 })
        return { ok: true, kickoffOutboundId: "out_layoff_1", kickoffCreated: true, sourceTag: "WeKruit_Laid_Off" }
      },
    })
    await new Promise((r) => setTimeout(r, 20))

    const body2 = JSON.stringify(basePayload({
      content: "WeKruit_LAID_OFF",
      message_handle: "msg-entry-layoff-2",
    }))
    const req2 = makeReq({ body: body2, signature: SECRET })
    const res2 = makeRes()
    await handleSendblueWebhook(req2, res2, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "u_layoff_1",
      runLayoffSmsStart: async ({ userId, toE164 }) => {
        layoffCalls.push({ userId, toE164 })
        return { ok: true, kickoffOutboundId: "out_layoff_duplicate", kickoffCreated: true, sourceTag: "WeKruit_Laid_Off" }
      },
    })
    await new Promise((r) => setTimeout(r, 20))

    const bodyOut1 = res1.bodyOut as Record<string, unknown>
    const bodyOut2 = res2.bodyOut as Record<string, unknown>
    assert.equal(res1.statusCode, 200)
    assert.equal(bodyOut1.ok, true)
    assert.equal(bodyOut1.action, "layoff_unauthorized")
    assert.equal(res2.statusCode, 200)
    assert.equal(bodyOut2.ok, true)
    assert.equal(bodyOut2.action, "layoff_unauthorized")
    assert.equal(inbound.size, 0, "manual layoff text must not enter legacy onboarding as text")
    assert.deepEqual(layoffCalls, [])
    assert.equal(layoffIdempotency.has("u_layoff_1"), false)
    assert.equal(audit.some((row) =>
      row.type === "trigger_fired" &&
      (row.payload as { trigger?: string } | undefined)?.trigger === "layoff"
    ), false)
    assert.equal(audit.some((row) =>
      row.type === "trigger_deduped" &&
      (row.payload as { trigger?: string } | undefined)?.trigger === "layoff"
    ), false)
    assert.equal(audit.some((row) =>
      row.type === "trigger_unauthorized" &&
      row.reason === "manual_layoff_trigger_disabled"
    ), true)
  })

  it("Test 18b (entrypoints): mixed-case + lowercase WeKruit_Laid_Off variants are suppressed and never enqueue inbound", async () => {
    // 2026-05-19 — root cause of the email-Q live bug. Adam typed mixed-case
    // "WeKruit_Laid_Off" in Messages; the original case-sensitive guard only
    // matched WeKruit_LAID_OFF, so the variant fell through to the broker
    // and the runtime asked for an email. Every legacy variant must be
    // suppressed before any broker enqueue or runtime turn.
    for (const variant of ["WeKruit_Laid_Off", "wekruit_laid_off", "WEKRUIT_LAID_OFF"]) {
      const { db, inbound, audit, layoffIdempotency } = makeFakeDb()
      const body = JSON.stringify(basePayload({
        content: variant,
        message_handle: `msg-entry-variant-${variant}`,
      }))
      const req = makeReq({ body, signature: SECRET })
      const res = makeRes()
      let layoffStartCalls = 0

      await handleSendblueWebhook(req, res, {
        db,
        secret: SECRET,
        lookupUserByPhone: async () => "u_layoff_variant",
        runLayoffSmsStart: async () => {
          layoffStartCalls += 1
          return { ok: true, kickoffOutboundId: "should_not_happen", kickoffCreated: true, sourceTag: "WeKruit_Laid_Off" }
        },
      })

      const bodyOut = res.bodyOut as Record<string, unknown>
      assert.equal(res.statusCode, 200, `variant=${variant}`)
      assert.equal(bodyOut.action, "layoff_unauthorized", `variant=${variant}`)
      assert.equal(inbound.size, 0, `variant=${variant} must not enter broker enqueue`)
      assert.equal(layoffStartCalls, 0, `variant=${variant} must not start layoff path`)
      assert.equal(layoffIdempotency.has("u_layoff_variant"), false)
      assert.equal(audit.some((row) =>
        row.type === "trigger_unauthorized" &&
        row.reason === "manual_layoff_trigger_disabled"
      ), true, `variant=${variant} must audit manual_layoff_trigger_disabled`)
    }
  })

  it("Test 19 (entrypoints): normal START from a random candidate stays on the regular onboarding path when no pending invite exists", async () => {
    const { db, inbound } = makeFakeDb()
    let prescreenCalls = 0
    let layoffCalls = 0
    const body = JSON.stringify(basePayload({
      content: "START",
      message_handle: "msg-entry-normal-start",
    }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "u_normal_1",
      runPreScreenForUser: async () => {
        prescreenCalls += 1
        return { ok: true, sessionId: "should_not_happen" }
      },
      runLayoffSmsStart: async () => {
        layoffCalls += 1
        return { ok: true, kickoffOutboundId: "should_not_happen", kickoffCreated: true, sourceTag: "WeKruit_Laid_Off" }
      },
    })

    assert.equal(res.statusCode, 200)
    assert.equal(prescreenCalls, 0)
    assert.equal(layoffCalls, 0)
    assert.equal(inbound.size, 1, "normal START must enqueue one regular onboarding inbound row")
    const inboundDoc = [...inbound.values()][0]!
    const raw = inboundDoc.rawPayload as Record<string, unknown>
    assert.equal(raw.text, "START")
    assert.equal(raw.kind, "imessage")
    assert.equal(raw.source, "sendblue")
  })

  it("Test 20 (entrypoints): START activates a recent ATS pending invite as job prescreen instead of normal onboarding", async () => {
    const { db, inbound, atsPendingTriggers } = makeFakeDb()
    atsPendingTriggers.set("+15551234567", {
      jobId: "rain-software-engineer-fullstack-8849f6ef",
      userId: "uAts1",
      expiresAtMs: Date.now() + 60_000,
    })
    const prescreenCalls: Array<{ jobId: string; userId: string; toE164: string }> = []
    const body = JSON.stringify(basePayload({
      content: "START",
      message_handle: "msg-entry-ats-start",
    }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async () => "uAts1",
      runPreScreenForUser: async (args) => {
        prescreenCalls.push(args)
        return { ok: true, sessionId: "ps_ats_1" }
      },
    })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.bodyOut, { ok: true, action: "prescreen_triggered" })
    assert.equal(inbound.size, 0, "pending-invite START must be control-plane input, not normal onboarding text")
    assert.equal(prescreenCalls.length, 1)
    assert.equal(prescreenCalls[0]!.jobId, "rain-software-engineer-fullstack-8849f6ef")
    assert.equal(prescreenCalls[0]!.userId, "uAts1")
    assert.equal(atsPendingTriggers.has("+15551234567"), false, "pending ATS trigger is consumed")
  })


  // ---------- TD-A: Adam P0 race-condition fix (atomic coalescing flag) ----------

  it("Test TD-A.1: willCoalesce=true → broker writes coalescing:true on the SAME create() call (race window closed)", async () => {
    process.env.paMessageCoalesceEnabled = "1"
    // Adam 2026-05-03 实测: post-deploy 4 quick messages still split into 4
    // turns. RCA: webhook used to call broker.createInboundEvent FIRST then
    // coalescer.enqueueOrCoalesce (which merged coalescing:true). In between
    // those writes, onPaInbound's onDocumentCreated trigger fired (within ms)
    // and read the OLD doc (coalescing undefined) → processed as independent
    // turn. This test pins the FIX: when willCoalesce=true at decision time,
    // the broker write itself carries coalescing:true so onPaInbound's single
    // read sees the flag and skips.
    const { db, inbound, flags, users } = makeFakeDb()
    users.set("u_adam_test", { onboardingState: "complete" })
    flags.set("paMessageCoalesceEnabled", {
      key: "paMessageCoalesceEnabled",
      value: true,
      type: "bool",
      scope: "perUser",
      allowlist: [],
      blocklist: [],
    })
    users.set("u_adam_test", { onboardingState: "complete" })
    _clearFeatureFlagCache()

    let enqueueOrder: string[] = []
    const enqueueOrCoalesceMock = async (_deps: unknown, msg: { inboundEventId: string }) => {
      // CRITICAL ORDERING ASSERTION: by the time the coalescer is invoked,
      // the inbound row MUST ALREADY EXIST with coalescing=true. This is
      // the post-condition of the TD-A fix.
      const stored = inbound.get(msg.inboundEventId)
      assert.ok(stored, "inbound row already written before enqueueOrCoalesce called")
      assert.equal(
        (stored as { coalescing?: boolean }).coalescing,
        true,
        "broker MUST stamp coalescing:true on doc.create() so onPaInbound sees it in its single read"
      )
      enqueueOrder.push("coalesce")
      return { action: "created" as const }
    }

    const body = JSON.stringify(basePayload({ message_handle: "msg-td-a-1" }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      log: () => { /* swallow */ },
      enqueueOrCoalesce: enqueueOrCoalesceMock as never,
      coalescerDeps: {} as never,
      lookupUserByPhone: async () => "u_adam_test",
    })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
    const [doc] = [...inbound.values()]
    assert.ok(doc, "inbound doc exists post-handler")
    assert.equal(
      (doc as { coalescing?: boolean }).coalescing,
      true,
      "TD-A fix: doc has coalescing:true persisted (set on create, race window closed)"
    )
    assert.deepEqual(enqueueOrder, ["coalesce"], "enqueueOrCoalesce was called once")
    delete process.env.paMessageCoalesceEnabled
  })

  it("Test TD-A.2: willCoalesce=false (flag off) → broker omits coalescing field (legacy path keeps onPaInbound processing)", async () => {
    // Sister-test for TD-A.1: when the flag is OFF, the broker MUST NOT
    // stamp coalescing:true. Otherwise onPaInbound would skip rows that
    // nobody else handles → user gets no reply.
    const { db, inbound, flags } = makeFakeDb()
    flags.set("paMessageCoalesceEnabled", {
      key: "paMessageCoalesceEnabled",
      value: false,
      type: "bool",
      scope: "perUser",
      allowlist: [],
      blocklist: [],
    })
    _clearFeatureFlagCache()

    let coalesceCalled = false
    const enqueueOrCoalesceMock = async () => {
      coalesceCalled = true
      return { action: "created" as const }
    }

    const body = JSON.stringify(basePayload({ message_handle: "msg-td-a-2" }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      log: () => { /* swallow */ },
      enqueueOrCoalesce: enqueueOrCoalesceMock as never,
      coalescerDeps: {} as never,
      lookupUserByPhone: async () => "u_adam_test",
    })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
    const [doc] = [...inbound.values()]
    assert.equal(
      (doc as { coalescing?: boolean }).coalescing,
      undefined,
      "flag=false → no coalescing field (legacy path: onPaInbound processes normally)"
    )
    assert.equal(coalesceCalled, false, "coalescer never invoked when flag is off")
  })

  it("Test TD-A.2b: legacy incomplete onboarding without shared runtime → coalescer is bypassed even when flag is on", async () => {
    const { db, inbound, flags, users } = makeFakeDb()
    flags.set("paMessageCoalesceEnabled", {
      key: "paMessageCoalesceEnabled",
      value: true,
      type: "bool",
      scope: "perUser",
      allowlist: [],
      blocklist: [],
    })
    users.set("u_adam_test", { onboardingState: "q_tos_asked" })
    _clearFeatureFlagCache()

    let coalesceCalled = false
    const enqueueOrCoalesceMock = async () => {
      coalesceCalled = true
      return { action: "created" as const }
    }

    const body = JSON.stringify(basePayload({ message_handle: "msg-td-a-2b" }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      log: () => { /* swallow */ },
      enqueueOrCoalesce: enqueueOrCoalesceMock as never,
      coalescerDeps: {} as never,
      lookupUserByPhone: async () => "u_adam_test",
    })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
    const [doc] = [...inbound.values()]
    assert.equal(
      (doc as { coalescing?: boolean }).coalescing,
      undefined,
      "legacy deterministic onboarding users must not get coalescing:true"
    )
    assert.equal(coalesceCalled, false, "coalescer must not run for legacy incomplete onboarding")
  })

  it("Test TD-A.2c: active shared_onboarding uses coalescer before orchestrator judging", async () => {
    const { db, inbound, flags, users } = makeFakeDb()
    flags.set("paMessageCoalesceEnabled", {
      key: "paMessageCoalesceEnabled",
      value: true,
      type: "bool",
      scope: "perUser",
      allowlist: [],
      blocklist: [],
    })
    users.set("u_adam_test", {
      onboardingState: "pending",
      workSession: { kind: "shared_onboarding", status: "active" },
      sharedOnboarding: { status: "active", completed: false },
    })
    _clearFeatureFlagCache()

    let coalesceCalled = false
    const coalesceInputs: Array<{ isOnboarding?: boolean; isPrescreen?: boolean }> = []
    const enqueueOrCoalesceMock = async (_deps: unknown, input: { isOnboarding?: boolean; isPrescreen?: boolean }) => {
      coalesceCalled = true
      coalesceInputs.push(input)
      return { action: "created" as const }
    }

    const body = JSON.stringify(basePayload({ message_handle: "msg-td-a-2c" }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      log: () => { /* swallow */ },
      enqueueOrCoalesce: enqueueOrCoalesceMock as never,
      coalescerDeps: {} as never,
      lookupUserByPhone: async () => "u_adam_test",
    })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
    const [doc] = [...inbound.values()]
    assert.equal((doc as { coalescing?: boolean }).coalescing, true)
    assert.equal(coalesceCalled, true, "shared onboarding must coalesce split SMS answers")
    assert.equal(coalesceInputs[0]?.isOnboarding, true)
    assert.equal(coalesceInputs[0]?.isPrescreen, false)
  })

  it("Test TD-A.3: enqueue failure post-create → fallback driver invoked, coalescing reverted to false", async () => {
    // Post-TD-A: when the doc was stamped coalescing:true at create time
    // and the subsequent Cloud Tasks enqueue fails, onPaInbound has ALREADY
    // skipped the row. Without an active fallback, the user gets no reply.
    // This test pins the proper-fix: webhook calls
    // processBrokerImessageFallback (injected by index.ts in production).
    const { db, inbound, flags, users } = makeFakeDb()
    flags.set("paMessageCoalesceEnabled", {
      key: "paMessageCoalesceEnabled",
      value: true,
      type: "bool",
      scope: "perUser",
      allowlist: [],
      blocklist: [],
    })
    users.set("u_adam_test", { onboardingState: "complete" })
    _clearFeatureFlagCache()

    const enqueueOrCoalesceMock = async () => {
      throw new Error("Cloud Tasks 503")
    }
    const fallbackCalls: string[] = []
    const fallbackMock = async (eventId: string) => {
      fallbackCalls.push(eventId)
    }

    const body = JSON.stringify(basePayload({ message_handle: "msg-td-a-3" }))
    const req = makeReq({ body, signature: SECRET })
    const res = makeRes()

    await handleSendblueWebhook(req, res, {
      db,
      secret: SECRET,
      log: () => { /* swallow */ },
      enqueueOrCoalesce: enqueueOrCoalesceMock as never,
      coalescerDeps: {} as never,
      lookupUserByPhone: async () => "u_adam_test",
      processBrokerImessageFallback: fallbackMock,
    })

    assert.equal(res.statusCode, 200)
    assert.equal(fallbackCalls.length, 1, "fallback called exactly once on enqueue failure")
    const [doc] = [...inbound.values()]
    assert.equal(
      (doc as { coalescing?: boolean }).coalescing,
      false,
      "flag reverted to false (cosmetic — for forensic visibility)"
    )
    assert.equal(
      (doc as { coalesceFallback?: boolean }).coalesceFallback,
      true,
      "coalesceFallback marker set so dashboards can identify these rows"
    )
  })

})
