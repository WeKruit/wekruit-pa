import assert from "node:assert/strict"
import test from "node:test"

import { buildVoiceCallTools, OUTBOUND_BOOKINGS_COLLECTION, VOICE_CALL_OFFERS_COLLECTION } from "./voice-call-tools.js"
import type { ClaireToolContext } from "../types.js"

type Doc = Record<string, unknown>
const DEV_PHONE = "+14243201960"
const NON_DEV_PHONE = "+15551234567"

class FakeDocRef {
  constructor(
    private readonly db: FakeDb,
    private readonly collectionName: string,
    readonly id: string,
  ) {}

  get path(): string {
    return `${this.collectionName}/${this.id}`
  }

  async get() {
    const data = this.db.docs.get(this.path)
    return { exists: data !== undefined, id: this.id, data: () => data, ref: this }
  }

  async set(data: Doc, opts?: { merge?: boolean }) {
    const prev = this.db.docs.get(this.path) ?? {}
    this.db.docs.set(this.path, opts?.merge ? { ...prev, ...data } : { ...data })
  }
}

class FakeQuery {
  private filters: Array<{ field: string; value: unknown }> = []
  private max = Infinity

  constructor(
    private readonly db: FakeDb,
    private readonly collectionName: string,
    field: string,
    value: unknown,
  ) {
    this.filters.push({ field, value })
  }

  where(field: string, _op: string, value: unknown) {
    this.filters.push({ field, value })
    return this
  }

  limit(n: number) {
    this.max = n
    return this
  }

  async get() {
    const prefix = `${this.collectionName}/`
    const docs = Array.from(this.db.docs.entries())
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, data]) => ({ id: path.slice(prefix.length), data }))
      .filter(({ data }) => this.filters.every((f) => data[f.field] === f.value))
      .slice(0, this.max)
      .map(({ id, data }) => ({
        id,
        ref: new FakeDocRef(this.db, this.collectionName, id),
        data: () => data,
      }))
    return { empty: docs.length === 0, docs }
  }
}

class FakeCollection {
  constructor(
    private readonly db: FakeDb,
    private readonly collectionName: string,
  ) {}

  doc(id: string) {
    return new FakeDocRef(this.db, this.collectionName, id)
  }

  where(field: string, _op: string, value: unknown) {
    return new FakeQuery(this.db, this.collectionName, field, value)
  }
}

class FakeDb {
  docs = new Map<string, Doc>()
  collection(name: string) {
    return new FakeCollection(this, name)
  }
}

function makeCtx(db: FakeDb, overrides: Partial<ClaireToolContext> = {}): ClaireToolContext & { sent: string[] } {
  const sent: string[] = []
  return {
    db: db as never,
    userId: "u1",
    sessionId: "chat1",
    lang: "en",
    toE164: DEV_PHONE,
    judgeModel: "test",
    transport: {
      markRead: async () => undefined,
      typing: async () => undefined,
      sendStatus: async () => undefined,
      sendText: async (text: string) => {
        sent.push(text)
      },
      tapback: async () => undefined,
      noReply: async () => undefined,
    },
    log: () => undefined,
    nowIso: () => "2026-06-18T12:00:00.000Z",
    ...overrides,
    sent,
  } as ClaireToolContext & { sent: string[] }
}

async function invoke(toolObj: unknown, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t = toolObj as { invoke: (ctx: unknown, json: string) => Promise<unknown> }
  const out = await t.invoke({}, JSON.stringify(args))
  return (typeof out === "string" ? JSON.parse(out) : out) as Record<string, unknown>
}

function getOnlyOffer(db: FakeDb): [string, Doc] {
  const rows = Array.from(db.docs.entries()).filter(([path]) => path.startsWith(`${VOICE_CALL_OFFERS_COLLECTION}/`))
  assert.equal(rows.length, 1)
  return rows[0]!
}

test("offer_voice_call creates pending onboarding offer and asks for explicit confirmation without dialing", async () => {
  const db = new FakeDb()
  const ctx = makeCtx(db)
  const [offer] = buildVoiceCallTools(ctx)

  const out = await invoke(offer, { purpose: "onboarding", jobId: null })

  assert.equal(out.ok, true)
  assert.equal(out.delivered, true)
  const [, data] = getOnlyOffer(db)
  assert.equal(data.userId, "u1")
  assert.equal(data.sessionId, "chat1")
  assert.equal(data.purpose, "onboarding")
  assert.equal(data.status, "pending")
  assert.equal(ctx.sent.length, 1)
  assert.match(ctx.sent[0]!, /Reply yes and I'll call now/)
  assert.equal(Array.from(db.docs.keys()).some((path) => path.startsWith(`${OUTBOUND_BOOKINGS_COLLECTION}/`)), false)
})

test("offer_voice_call creates a prescreen offer only after the role is in the candidate's matched roles", async () => {
  const db = new FakeDb()
  db.docs.set("pa-users/u1", {
    lastCollabRoles: [
      { jobId: "sekai-agent", company: "Sekai", title: "AI Agent Engineer" },
    ],
  })
  const ctx = makeCtx(db)
  const [offer] = buildVoiceCallTools(ctx)

  const out = await invoke(offer, { purpose: "prescreen", jobId: "sekai-agent" })

  assert.equal(out.ok, true)
  assert.equal(out.delivered, true)
  const [, data] = getOnlyOffer(db)
  assert.equal(data.purpose, "prescreen")
  assert.equal(data.paJobId, "sekai-agent")
  assert.equal(data.matchedRoleValidatedAt, "2026-06-18T12:00:00.000Z")
  assert.match(ctx.sent[0]!, /Reply yes and I'll call now/)
})

test("offer_voice_call asks which role instead of asking for call consent when prescreen jobId is not startable", async () => {
  const db = new FakeDb()
  db.docs.set("pa-users/u1", {
    lastCollabRoles: [
      { jobId: "sekai-agent", company: "Sekai", title: "AI Agent Engineer" },
      { jobId: "maximor-staff", company: "Maximor", title: "Staff SWE" },
    ],
  })
  const ctx = makeCtx(db)
  const [offer] = buildVoiceCallTools(ctx)

  const out = await invoke(offer, { purpose: "prescreen", jobId: "guessed-sekai-role" })

  assert.equal(out.ok, false)
  assert.equal(out.delivered, true)
  assert.equal(out.reason, "role_needs_clarification")
  assert.equal(Array.from(db.docs.keys()).some((path) => path.startsWith(`${VOICE_CALL_OFFERS_COLLECTION}/`)), false)
  assert.equal(ctx.sent.length, 1)
  assert.match(ctx.sent[0]!, /which role should i call you about/i)
  assert.match(ctx.sent[0]!, /AI Agent Engineer @ Sekai/)
  assert.match(ctx.sent[0]!, /Staff SWE @ Maximor/)
  assert.doesNotMatch(ctx.sent[0]!, /Reply yes and I'll call now/)
})

test("buildVoiceCallTools hides tools for a known non-dev phone", () => {
  const db = new FakeDb()
  const ctx = makeCtx(db, { toE164: NON_DEV_PHONE })
  assert.equal(buildVoiceCallTools(ctx).length, 0)
})

test("buildVoiceCallTools hides tools without a known dev phone", () => {
  const db = new FakeDb()
  const ctx = makeCtx(db, { toE164: undefined })
  assert.equal(buildVoiceCallTools(ctx).length, 0)
})

test("resolve_voice_call_offer confirmed creates exactly one dialing booking", async () => {
  const db = new FakeDb()
  const ctx = makeCtx(db)
  const [offer, resolve] = buildVoiceCallTools(ctx)
  await invoke(offer, { purpose: "onboarding", jobId: null })

  const out = await invoke(resolve, { confirmed: true })

  assert.equal(out.ok, true)
  assert.equal(out.delivered, true)
  assert.equal(out.voiceState, "dialing")
  const bookingRows = Array.from(db.docs.entries()).filter(([path]) => path.startsWith(`${OUTBOUND_BOOKINGS_COLLECTION}/`))
  assert.equal(bookingRows.length, 1)
  assert.equal(bookingRows[0]![1].purpose, "onboarding")
  assert.equal(bookingRows[0]![1].paUserId, "u1")
  assert.equal(bookingRows[0]![1].voiceState, "dialing")
  const [, offerData] = getOnlyOffer(db)
  assert.equal(offerData.status, "confirmed")
  assert.equal(offerData.outboundBookingId, bookingRows[0]![1].id)
})

test("resolve_voice_call_offer declined or expired never dials", async () => {
  const db = new FakeDb()
  const ctx = makeCtx(db)
  const [offer, resolve] = buildVoiceCallTools(ctx)
  await invoke(offer, { purpose: "onboarding", jobId: null })
  await invoke(resolve, { confirmed: false })
  assert.equal(Array.from(db.docs.keys()).some((path) => path.startsWith(`${OUTBOUND_BOOKINGS_COLLECTION}/`)), false)
  assert.equal(getOnlyOffer(db)[1].status, "declined")

  const db2 = new FakeDb()
  const ctx2 = makeCtx(db2)
  const [offer2, resolve2] = buildVoiceCallTools(ctx2)
  await invoke(offer2, { purpose: "onboarding", jobId: null })
  const [path, stale] = getOnlyOffer(db2)
  db2.docs.set(path, { ...stale, expiresAt: "2026-06-18T11:49:00.000Z" })
  const out = await invoke(resolve2, { confirmed: true })
  assert.equal(out.reason, "offer_expired")
  assert.equal(getOnlyOffer(db2)[1].status, "expired")
  assert.equal(Array.from(db2.docs.keys()).some((p) => p.startsWith(`${OUTBOUND_BOOKINGS_COLLECTION}/`)), false)
})

test("resolve_voice_call_offer invalidates an unvalidated prescreen offer that cannot start and asks for the role", async () => {
  const db = new FakeDb()
  db.docs.set("pa-users/u1", {
    lastCollabRoles: [
      { jobId: "sekai-agent", company: "Sekai", title: "AI Agent Engineer" },
      { jobId: "maximor-staff", company: "Maximor", title: "Staff SWE" },
    ],
  })
  db.docs.set(`${VOICE_CALL_OFFERS_COLLECTION}/bad-offer`, {
    userId: "u1",
    sessionId: "chat1",
    purpose: "prescreen",
    paJobId: "guessed-sekai-role",
    phoneE164: DEV_PHONE,
    status: "pending",
    createdAt: "2026-06-18T11:59:00.000Z",
    expiresAt: "2026-06-18T12:09:00.000Z",
    updatedAt: "2026-06-18T11:59:00.000Z",
  })
  const ctx = makeCtx(db)
  const [, resolve] = buildVoiceCallTools(ctx)

  const out = await invoke(resolve, { confirmed: true })

  assert.equal(out.ok, false)
  assert.equal(out.delivered, true)
  assert.equal(out.reason, "role_needs_clarification")
  assert.equal(db.docs.get(`${VOICE_CALL_OFFERS_COLLECTION}/bad-offer`)?.status, "expired")
  assert.equal(Array.from(db.docs.keys()).some((path) => path.startsWith(`${OUTBOUND_BOOKINGS_COLLECTION}/`)), false)
  assert.match(ctx.sent[0]!, /which role should i call you about/i)
  assert.match(ctx.sent[0]!, /AI Agent Engineer @ Sekai/)
  assert.doesNotMatch(ctx.sent[0]!, /I can't start that phone screen yet/)
})

test("resolve_voice_call_offer refuses a stale non-dev offer before dialing", async () => {
  const db = new FakeDb()
  db.docs.set(`${VOICE_CALL_OFFERS_COLLECTION}/offer-non-dev`, {
    userId: "u1",
    sessionId: "chat1",
    purpose: "onboarding",
    phoneE164: NON_DEV_PHONE,
    status: "pending",
    createdAt: "2026-06-18T12:00:00.000Z",
    expiresAt: "2026-06-18T12:10:00.000Z",
    updatedAt: "2026-06-18T12:00:00.000Z",
  })
  const ctx = makeCtx(db)
  const [, resolve] = buildVoiceCallTools(ctx)

  const out = await invoke(resolve, { confirmed: true })

  assert.equal(out.ok, false)
  assert.equal(out.reason, "voice_call_not_enabled")
  assert.equal(db.docs.get(`${VOICE_CALL_OFFERS_COLLECTION}/offer-non-dev`)?.status, "declined")
  assert.equal(Array.from(db.docs.keys()).some((path) => path.startsWith(`${OUTBOUND_BOOKINGS_COLLECTION}/`)), false)
})

test("offer_voice_call requires a job for prescreen", async () => {
  const db = new FakeDb()
  const ctx = makeCtx(db, { jobId: undefined })
  const [offer] = buildVoiceCallTools(ctx)

  const out = await invoke(offer, { purpose: "prescreen", jobId: null })

  assert.equal(out.ok, false)
  assert.equal(out.reason, "missing_jobId")
  assert.equal(db.docs.size, 0)
})
