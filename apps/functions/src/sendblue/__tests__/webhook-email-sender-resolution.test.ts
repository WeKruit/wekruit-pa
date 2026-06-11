/**
 * Email-Apple-ID sender resolution (SEV 2026-06-11).
 *
 * iPhones with "Start New Conversations From: Apple ID" send iMessage with an
 * EMAIL sender (`from_number: "ppoojan455@gmail.com"`). The 2026-05-20 E.164
 * gate silently rejected every one — prescreen triggers, verification codes,
 * follow-ups all vaporized. Sendblue REST has NO outbound path to email
 * handles, so the reply channel is the user's KNOWN E.164 phone from their
 * pa-users doc.
 *
 * Verifies the reworked gate (webhook.ts 3c1):
 *   1. email sender + prescreen-trigger content → resolves uid, binds email
 *      handle, trigger dispatch sees the canonical phone.
 *   2. email sender + verification-code content → resolves uid, pipeline
 *      enqueues with canonical phone + rawSenderHandle audit field.
 *   3. email sender + free text + existing pa-candidate-handles binding → resolves.
 *   4. email sender + free text + pa-users email match → resolves.
 *   5. unresolved email sender → 200 + `email_sender_unresolved` audit + ops review item.
 *   6. two pa-users sharing the email → ambiguous → unresolved path (never guess).
 *   7. resolved user WITHOUT a phone → bind + `email_sender_resolved_no_phone` + review item.
 *   8. E.164 sender → untouched fast path (regression).
 *   9. uid token naming a NONEXISTENT user → falls through arms → unresolved.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

import { handleSendblueWebhook } from "../webhook.js"
import { hashCandidateHandle, _clearFeatureFlagCache } from "@pa/pa-persistence"

const SECRET = "test-webhook-secret"
const UID = "RoO4VFRekn74NRAEgovO"
const EMAIL = "ppoojan455@gmail.com"
const PHONE = "+14436760696"

type DocData = Record<string, unknown>

/**
 * Generic lazy fake Firestore: every collection is a Map-backed store with
 * doc(get/set/create/delete), add, and equality-filter where().limit().get().
 * Mirrors the harness style of webhook-email-apple-id-reject.test.ts but
 * generalized so the resolution arms (pa-users queries, handle point reads,
 * identity-event/conflict writes) all work without per-collection wiring.
 */
function makeFakeDb(seed?: { users?: Record<string, DocData>; handles?: Record<string, DocData> }) {
  const stores = new Map<string, Map<string, DocData>>()
  function store(name: string): Map<string, DocData> {
    let s = stores.get(name)
    if (!s) {
      s = new Map()
      stores.set(name, s)
    }
    return s
  }
  for (const [id, data] of Object.entries(seed?.users ?? {})) store("pa-users").set(id, { ...data })
  for (const [id, data] of Object.entries(seed?.handles ?? {})) store("pa-candidate-handles").set(id, { ...data })

  function makeCollection(name: string) {
    const s = store(name)
    function docRef(id: string) {
      return {
        id,
        async get() {
          const data = s.get(id)
          return { exists: data !== undefined, data: () => data, id }
        },
        async set(data: DocData, opts?: { merge?: boolean }) {
          if (opts?.merge) s.set(id, { ...(s.get(id) ?? {}), ...data })
          else s.set(id, { ...data })
        },
        async create(data: DocData) {
          if (s.has(id)) {
            const err: Error & { code?: number } = new Error("ALREADY_EXISTS")
            err.code = 6
            throw err
          }
          s.set(id, { ...data })
        },
        async delete() {
          s.delete(id)
        },
      }
    }
    function query(filters: Array<[string, unknown]>, limitN: number) {
      return {
        where(field: string, _op: string, value: unknown) {
          return query([...filters, [field, value]], limitN)
        },
        limit(n: number) {
          return query(filters, n)
        },
        orderBy() {
          return query(filters, limitN)
        },
        select() {
          return query(filters, limitN)
        },
        async get() {
          const docs = [...s.entries()]
            .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
            .slice(0, limitN)
            .map(([id, data]) => ({ id, data: () => data, ref: docRef(id) }))
          return { docs, empty: docs.length === 0, size: docs.length }
        },
      }
    }
    return {
      doc(id: string) {
        return docRef(id)
      },
      add(data: DocData) {
        const id = `${name}_auto_${s.size + 1}`
        s.set(id, { ...data })
        return Promise.resolve({ id })
      },
      where(field: string, _op: string, value: unknown) {
        return query([[field, value]], Number.POSITIVE_INFINITY)
      },
    }
  }

  const db = {
    collection(name: string) {
      return makeCollection(name)
    },
    async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      return fn({ async get(ref: { get(): Promise<unknown> }) { return ref.get() }, update() {}, set() {} })
    },
  } as unknown as Parameters<typeof handleSendblueWebhook>[2]["db"]

  const helpers = {
    db,
    inbound: store("pa-inbound-events"),
    users: store("pa-users"),
    handles: store("pa-candidate-handles"),
    conflicts: store("pa-candidate-identity-conflicts"),
    auditRows(): DocData[] {
      return [...store("pa-audit-events").values()]
    },
  }
  return helpers
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body, "utf8").digest("hex")
}

function makeReq(body: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "sendblue-signature": sign(body),
  }
  return {
    rawBody: Buffer.from(body, "utf8"),
    body,
    headers,
    method: "POST",
    header(name: string) { return headers[name.toLowerCase()] ?? headers[name] },
  } as unknown as Parameters<typeof handleSendblueWebhook>[0]
}

function makeRes() {
  let statusCode = 200
  let bodyOut: unknown = null
  return {
    status(code: number) { statusCode = code; return this },
    json(body: unknown) { bodyOut = body; return this },
    send(body: unknown) { bodyOut = body; return this },
    set() { return this },
    get statusCode() { return statusCode },
    get bodyOut() { return bodyOut },
  } as Parameters<typeof handleSendblueWebhook>[1] & { statusCode: number; bodyOut: unknown }
}

function inboundPayload(content: string, fromNumber: string, messageHandle: string): string {
  return JSON.stringify({
    content,
    from_number: fromNumber,
    to_number: "+17174919939",
    message_handle: messageHandle,
    date_sent: "2026-06-11T10:00:00Z",
    status: "RECEIVED",
    service: "iMessage",
  })
}

const emailHandleDocId = hashCandidateHandle("email", EMAIL).handleId

describe("Email-sender resolution — Sendblue webhook gate rework (SEV 2026-06-11)", () => {
  beforeEach(() => { _clearFeatureFlagCache() })
  afterEach(() => { _clearFeatureFlagCache() })

  it("email sender + prescreen trigger string → resolves uid, binds handle, trigger sees canonical phone", async () => {
    const { db, handles, auditRows } = makeFakeDb({
      users: { [UID]: { phoneE164: PHONE, email: EMAIL } },
    })
    const preScreenCalls: Array<{ jobId: string; userId: string; toE164: string }> = []
    const body = inboundPayload(`WeKruit_job-123_${UID}_Job`, EMAIL, "msg-email-trigger-1")
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, {
      db,
      secret: SECRET,
      lookupUserByPhone: async (_db, phone) => (phone === PHONE ? UID : null),
      runPreScreenForUser: (async (args: { jobId: string; userId: string; toE164: string }) => {
        preScreenCalls.push({ jobId: args.jobId, userId: args.userId, toE164: args.toE164 })
        return { ok: true, sessionId: "sess-1" }
      }) as never,
    })

    assert.equal(res.statusCode, 200)
    assert.equal((res.bodyOut as { ok: boolean }).ok, true)
    assert.equal(preScreenCalls.length, 1, "prescreen trigger fired once")
    assert.equal(preScreenCalls[0]!.jobId, "job-123")
    assert.equal(preScreenCalls[0]!.userId, UID)
    assert.equal(preScreenCalls[0]!.toE164, PHONE, "trigger dispatch sees the CANONICAL PHONE, not the email")

    const handleDoc = handles.get(emailHandleDocId)
    assert.ok(handleDoc, "email→userId binding written to pa-candidate-handles")
    assert.equal(handleDoc!.candidateId, UID)
    assert.equal(handleDoc!.kind, "email")

    const resolved = auditRows().filter((a) => a.type === "email_sender_resolved")
    assert.equal(resolved.length, 1, "email_sender_resolved audit recorded")
    assert.equal((resolved[0]!.payload as DocData).method, "uid_token")
  })

  it("email sender + verification-code content → resolves uid, enqueues on canonical phone with rawSenderHandle", async () => {
    const { db, inbound, auditRows } = makeFakeDb({
      users: { [UID]: { phoneE164: PHONE } },
    })
    const body = inboundPayload(
      `Hi, WeKruit, my verification code is ${UID}`,
      EMAIL,
      "msg-email-code-1",
    )
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1, "inbound event row created — message no longer vaporized")
    const row = [...inbound.values()][0]!
    const rawPayload = row.rawPayload as DocData
    assert.equal(rawPayload.fromNumber, PHONE, "pipeline runs on the canonical phone")
    assert.equal(rawPayload.participant, PHONE)
    assert.equal(rawPayload.chatId, `iMessage;-;${PHONE}`, "chatId rewritten to the phone thread")
    assert.equal(rawPayload.rawSenderHandle, EMAIL, "original email handle preserved for audit")

    const resolved = auditRows().filter((a) => a.type === "email_sender_resolved")
    assert.equal(resolved.length, 1)
    assert.equal((resolved[0]!.payload as DocData).userId, UID)
  })

  it("email sender + free text + existing pa-candidate-handles binding → resolves", async () => {
    const { db, inbound, auditRows } = makeFakeDb({
      users: { [UID]: { phoneE164: PHONE } },
      handles: { [emailHandleDocId]: { candidateId: UID, kind: "email" } },
    })
    const body = inboundPayload("Hello. When will I receive a text back?", EMAIL, "msg-email-free-1")
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1, "free text from a bound email sender flows through")
    const rawPayload = [...inbound.values()][0]!.rawPayload as DocData
    assert.equal(rawPayload.fromNumber, PHONE)
    assert.equal(rawPayload.rawSenderHandle, EMAIL)

    const resolved = auditRows().filter((a) => a.type === "email_sender_resolved")
    assert.equal(resolved.length, 1)
    assert.equal((resolved[0]!.payload as DocData).method, "handle_binding")
  })

  it("email sender + free text + pa-users email match → resolves", async () => {
    const { db, inbound, handles, auditRows } = makeFakeDb({
      users: { [UID]: { phoneE164: PHONE, email: EMAIL, emailLower: EMAIL } },
    })
    const body = inboundPayload("Hey Claire, any update?", EMAIL, "msg-email-free-2")
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1)
    const rawPayload = [...inbound.values()][0]!.rawPayload as DocData
    assert.equal(rawPayload.fromNumber, PHONE)
    assert.equal(handles.get(emailHandleDocId)?.candidateId, UID, "binding written so next text resolves via arm b1")

    const resolved = auditRows().filter((a) => a.type === "email_sender_resolved")
    assert.equal(resolved.length, 1)
    assert.equal((resolved[0]!.payload as DocData).method, "users_email")
  })

  it("unresolved email sender → 200, distinct audit, ops review item, no inbound row", async () => {
    const { db, inbound, conflicts, auditRows } = makeFakeDb()
    const body = inboundPayload("Hello. When will I receive a text back?", EMAIL, "msg-email-unres-1")
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal((res.bodyOut as { ignored?: string }).ignored, "email_sender_unresolved")
    assert.equal(inbound.size, 0, "still rejected — but no longer silently")
    const unresolved = auditRows().filter((a) => a.type === "email_sender_unresolved")
    assert.equal(unresolved.length, 1)
    assert.equal(unresolved[0]!.fromNumber, EMAIL)
    assert.equal(conflicts.size, 1, "ops review item written")
    const item = [...conflicts.values()][0]!
    assert.equal(item.kind, "email_sender_unresolved")
    assert.equal(item.status, "open")
    assert.equal(item.handleKind, "email")
  })

  it("two pa-users sharing the email → ambiguous → unresolved path (never guess)", async () => {
    const { db, inbound, conflicts, auditRows } = makeFakeDb({
      users: {
        userAaaa1111: { phoneE164: "+15550000001", emailLower: EMAIL },
        userBbbb2222: { phoneE164: "+15550000002", emailLower: EMAIL },
      },
    })
    const body = inboundPayload("Hi, following up!", EMAIL, "msg-email-ambig-1")
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal((res.bodyOut as { ignored?: string }).ignored, "email_sender_unresolved")
    assert.equal(inbound.size, 0)
    assert.equal(auditRows().filter((a) => a.type === "email_sender_resolved").length, 0, "never resolved to either user")
    assert.equal(auditRows().filter((a) => a.type === "email_sender_unresolved").length, 1)
    assert.equal(conflicts.size, 1, "ambiguity lands in the review queue")
  })

  it("resolved user WITHOUT a phone → bind + email_sender_resolved_no_phone + review item, no enqueue", async () => {
    const { db, inbound, handles, conflicts, auditRows } = makeFakeDb({
      users: { [UID]: { email: EMAIL } }, // no phoneE164
    })
    const body = inboundPayload(
      `Hi, WeKruit, my verification code is ${UID}`,
      EMAIL,
      "msg-email-nophone-1",
    )
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal((res.bodyOut as { ignored?: string }).ignored, "email_sender_resolved_no_phone")
    assert.equal(inbound.size, 0, "no reply channel exists — no pipeline run")
    assert.equal(handles.get(emailHandleDocId)?.candidateId, UID, "binding still written")
    const noPhone = auditRows().filter((a) => a.type === "email_sender_resolved_no_phone")
    assert.equal(noPhone.length, 1)
    assert.equal((noPhone[0]!.payload as DocData).userId, UID)
    const item = [...conflicts.values()].find((c) => c.kind === "email_sender_resolved_no_phone")
    assert.ok(item, "ops review item written for the no-phone case")
    assert.equal(item!.primaryCandidateId, UID)
  })

  it("E.164 sender → untouched fast path (regression)", async () => {
    const { db, inbound, auditRows } = makeFakeDb()
    const body = inboundPayload("Just a normal text", PHONE, "msg-phone-fast-1")
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1, "normal phone inbound enqueued")
    const rawPayload = [...inbound.values()][0]!.rawPayload as DocData
    assert.equal(rawPayload.fromNumber, PHONE)
    assert.equal(rawPayload.rawSenderHandle, undefined, "no rawSenderHandle on phone senders")
    const emailAudits = auditRows().filter((a) =>
      typeof a.type === "string" && (a.type as string).startsWith("email_sender_"))
    assert.equal(emailAudits.length, 0, "email-sender machinery never fires for E.164")
  })

  it("uid token naming a NONEXISTENT user → falls through arms → unresolved", async () => {
    const { db, inbound, conflicts, auditRows } = makeFakeDb()
    const body = inboundPayload(
      "Hi, WeKruit, my verification code is ghostuser12345",
      EMAIL,
      "msg-email-ghost-1",
    )
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal((res.bodyOut as { ignored?: string }).ignored, "email_sender_unresolved")
    assert.equal(inbound.size, 0)
    assert.equal(auditRows().filter((a) => a.type === "email_sender_unresolved").length, 1)
    assert.equal(conflicts.size, 1)
  })
})
