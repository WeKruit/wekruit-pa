/**
 * Email-Apple-ID sender → switch-to-phone guidance (Adam + Sendblue, 2026-06-13).
 *
 * iPhones with "Start New Conversations From: Apple ID/Email" send iMessage with
 * an EMAIL sender (`from_number: "ppoojan455@gmail.com"`). Our outbound to that
 * person's PHONE is blocked by the inbound-only plan (RULE-1 / 400
 * INBOUND_ONLY_PLAN) because the phone never texted us — every reply vaporized
 * (live: Sylvia +15419084350, Poojan).
 *
 * The PRIOR rework rewrote the email sender onto their profile PHONE and ran the
 * pipeline → guaranteed silence. The NEW behavior replies INTO THE EMAIL THREAD
 * (allowed: we're replying to who just texted us) with ONE deterministic
 * guidance bubble asking them to flip "Start New Conversations From" to their
 * phone, then text again. We do NOT proceed into pitch/prescreen this turn, but
 * we still resolve/bind identity so the next phone-origin text is recognized.
 *
 * Verifies:
 *   1. email sender (no prior) → ONE guidance reply enqueued TO the email handle,
 *      inbound-evidence row for the email handle written, dedup marker stamped,
 *      identity resolved + bound — and NO pitch/prescreen ran this turn.
 *   2. same email texts again within cooldown → NO second guidance (dedup).
 *   3. E.164 sender → untouched fast path (regression).
 *   4. email-format STOP → STOP honored (doNotContact written, confirmation into
 *      the email thread), NO switch-to-phone guidance.
 *   5. unresolved email sender → still gets guidance (identity not required to
 *      reply into the thread).
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

import { handleSendblueWebhook } from "../webhook.js"
import { inboundEventMatchesOutboundHandle } from "../outbox.js"
import {
  SWITCH_TO_PHONE_GUIDANCE_TEXT,
  PA_EMAIL_SWITCH_GUIDANCE_COLLECTION,
} from "../email-sender-resolution.js"
import { STOP_CONFIRMATION_TEXT } from "../../claire-agent/stop-gate.js"
import { hashCandidateHandle, _clearFeatureFlagCache } from "@pa/pa-persistence"

const SECRET = "test-webhook-secret"
const UID = "RoO4VFRekn74NRAEgovO"
const EMAIL = "ppoojan455@gmail.com"
const PHONE = "+14436760696"

type DocData = Record<string, unknown>

/**
 * Generic lazy fake Firestore: every collection is a Map-backed store with
 * doc(get/set/create/delete), add, and equality-filter where().limit().get().
 */
function makeFakeDb(seed?: { users?: Record<string, DocData>; handles?: Record<string, DocData>; guidance?: Record<string, DocData> }) {
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
  for (const [id, data] of Object.entries(seed?.guidance ?? {})) store(PA_EMAIL_SWITCH_GUIDANCE_COLLECTION).set(id, { ...data })

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
    outbound: store("pa-outbound"),
    users: store("pa-users"),
    handles: store("pa-candidate-handles"),
    guidance: store(PA_EMAIL_SWITCH_GUIDANCE_COLLECTION),
    conflicts: store("pa-candidate-identity-conflicts"),
    auditRows(): DocData[] {
      return [...store("pa-audit-events").values()]
    },
    outboundRows(): DocData[] {
      return [...store("pa-outbound").values()]
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
    date_sent: "2026-06-13T10:00:00Z",
    status: "RECEIVED",
    service: "iMessage",
  })
}

const emailHandleDocId = hashCandidateHandle("email", EMAIL).handleId

describe("Email-sender → switch-to-phone guidance (Adam + Sendblue, 2026-06-13)", () => {
  beforeEach(() => { _clearFeatureFlagCache() })
  afterEach(() => { _clearFeatureFlagCache() })

  it("email sender → ONE guidance reply to the EMAIL handle, evidence + dedup marker, identity bound, no pitch/prescreen", async () => {
    const { db, handles, guidance, outboundRows, auditRows } = makeFakeDb({
      users: { [UID]: { phoneE164: PHONE, email: EMAIL, emailLower: EMAIL } },
    })
    const preScreenCalls: unknown[] = []
    const body = inboundPayload("Hi! is anyone there?", EMAIL, "msg-email-guide-1")
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, {
      db,
      secret: SECRET,
      runPreScreenForUser: (async () => { preScreenCalls.push(1); return { ok: true } }) as never,
    })

    assert.equal(res.statusCode, 200)
    assert.equal((res.bodyOut as { ignored?: string }).ignored, "email_sender_switch_guidance_sent")
    assert.equal(preScreenCalls.length, 0, "did NOT proceed into prescreen this turn")

    // ONE guidance outbound, addressed to the EMAIL handle.
    const sends = outboundRows()
    assert.equal(sends.length, 1, "exactly one guidance row enqueued")
    assert.equal(sends[0]!.toE164, EMAIL, "reply goes TO the email handle (the thread that texted us)")
    assert.equal(sends[0]!.body, SWITCH_TO_PHONE_GUIDANCE_TEXT)
    assert.equal(sends[0]!.runtimeSource, "pa_identity_notice", "reply-into-inbound-thread exemption")

    // Identity bound + dedup marker stamped.
    assert.equal(handles.get(emailHandleDocId)?.candidateId, UID, "email→userId binding written")
    assert.equal(guidance.size, 1, "switch-guidance dedup marker stamped")

    const sent = auditRows().filter((a) => a.type === "email_sender_switch_guidance_sent")
    assert.equal(sent.length, 1, "guidance-sent audit recorded")
  })

  it("inbound evidence preserves the email handle as the consented transport sender", async () => {
    const { db, inbound } = makeFakeDb({
      users: { [UID]: { phoneE164: PHONE, email: EMAIL, emailLower: EMAIL } },
    })
    const body = inboundPayload("hey?", EMAIL, "msg-email-guide-evid-1")
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    const evidenceRows = [...inbound.values()].filter(
      (r) => r.completedReason === "email_switch_to_phone_guidance",
    )
    assert.equal(evidenceRows.length, 1, "one email-handle evidence row written")
    const evidence = evidenceRows[0]!
    assert.equal(
      inboundEventMatchesOutboundHandle(evidence, EMAIL),
      true,
      "evidence consents the EMAIL handle — the outbox gate permits the guidance reply",
    )
    assert.equal(
      inboundEventMatchesOutboundHandle(evidence, PHONE),
      false,
      "evidence does NOT consent the profile phone (never cold-open it)",
    )
  })

  it("same email texts again within cooldown → NO second guidance (dedup)", async () => {
    const docId = `email_switch_to_phone_${hashCandidateHandle("email", EMAIL).handleHash.slice(0, 40)}`
    const { db, outboundRows, auditRows } = makeFakeDb({
      users: { [UID]: { phoneE164: PHONE, email: EMAIL, emailLower: EMAIL } },
      guidance: { [docId]: { lastSentAtMs: Date.now() - 60_000 } }, // 1 min ago — inside 24h cooldown
    })
    const body = inboundPayload("still nothing?", EMAIL, "msg-email-guide-dup-1")
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal((res.bodyOut as { ignored?: string }).ignored, "email_sender_switch_guidance_cooldown")
    assert.equal(outboundRows().length, 0, "no second guidance enqueued within cooldown")
    assert.equal(
      auditRows().filter((a) => a.type === "email_sender_switch_guidance_skipped").length,
      1,
      "cooldown skip audited",
    )
  })

  it("E.164 sender → untouched fast path (regression)", async () => {
    const { db, inbound, outboundRows, auditRows } = makeFakeDb()
    const body = inboundPayload("Just a normal text", PHONE, "msg-phone-fast-1")
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal(inbound.size, 1, "normal phone inbound enqueued")
    const rawPayload = [...inbound.values()][0]!.rawPayload as DocData
    assert.equal(rawPayload.fromNumber, PHONE)
    assert.equal(outboundRows().length, 0, "no guidance for a phone sender")
    const emailAudits = auditRows().filter((a) =>
      typeof a.type === "string" && (a.type as string).startsWith("email_sender_"))
    assert.equal(emailAudits.length, 0, "email-sender machinery never fires for E.164")
  })

  it("email-format STOP → STOP honored (doNotContact + confirmation into email thread), no switch guidance", async () => {
    const { db, users, outboundRows, guidance, auditRows } = makeFakeDb({
      users: { [UID]: { phoneE164: PHONE, email: EMAIL, emailLower: EMAIL } },
    })
    const body = inboundPayload("STOP", EMAIL, "msg-email-stop-1")
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal((res.bodyOut as { action?: string }).action, "opt_out", "STOP gate ran and opted out")
    assert.equal(users.get(UID)?.doNotContact, true, "doNotContact written")

    const sends = outboundRows()
    assert.equal(sends.length, 1, "exactly the STOP confirmation (no switch guidance)")
    assert.equal(sends[0]!.toE164, EMAIL, "confirmation lands in the email thread")
    assert.equal(sends[0]!.body, STOP_CONFIRMATION_TEXT)

    assert.equal(guidance.size, 0, "no switch-to-phone guidance marker for a STOP")
    assert.equal(
      auditRows().filter((a) => a.type === "email_sender_switch_guidance_sent").length,
      0,
      "no guidance audit for a STOP",
    )
    assert.equal(
      auditRows().filter((a) => a.type === "email_sender_stop_keyword").length,
      1,
      "email STOP audited",
    )
  })

  it("unresolved email sender → still gets guidance (identity not required to reply into the thread)", async () => {
    const { db, outboundRows, guidance, auditRows } = makeFakeDb()
    const body = inboundPayload("Hello, when do I hear back?", EMAIL, "msg-email-unres-guide-1")
    const res = makeRes()
    await handleSendblueWebhook(makeReq(body), res, { db, secret: SECRET })

    assert.equal(res.statusCode, 200)
    assert.equal((res.bodyOut as { ignored?: string }).ignored, "email_sender_switch_guidance_sent")
    const sends = outboundRows()
    assert.equal(sends.length, 1)
    assert.equal(sends[0]!.toE164, EMAIL)
    assert.equal(sends[0]!.userId, EMAIL, "owner key falls back to the email handle when unresolved")
    assert.equal(guidance.size, 1, "dedup marker stamped for an unresolved sender too")
    assert.equal(
      auditRows().filter((a) => a.type === "email_sender_switch_guidance_sent").length,
      1,
    )
  })
})
