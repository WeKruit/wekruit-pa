import assert from "node:assert/strict"
import test from "node:test"

import {
  buildSchedulingTools,
  SCHEDULING_DEV_UIDS,
  pickSpread,
  humanLabel,
  filterByPartOfDay,
  resolveTimeZone,
} from "./scheduling-tools.js"
import type { ClaireToolContext } from "../types.js"
import type { FlatSlot } from "../../calcom/calcom-client.js"
import { interviewBookingDocId } from "@pa/core-types"

const DEV_UID = "8fEwIduUrzxZsblHHsNz" // Adam +14243201960 — in the gate set.
const NON_DEV_UID = "someRandomCandidate"
// Computed (NOT hardcoded — the slug double-lowercases IdU→idu, Urzx→urzx etc).
const BOOKING_PATH = `pa-interview-bookings/${interviewBookingDocId({ userId: DEV_UID, jobId: "job-1" })}`

// FAKE Cal.com key so getCalcomApiKey() doesn't throw. (Tools call the client,
// which reads process.env.CALCOM_API_KEY.) Never a literal cal_live_.
process.env.CALCOM_API_KEY = "cal_test_FAKE"
// Mailgun config so sendInterviewConfirmationEmail can build a cfg.
process.env.MAILGUN_API_KEY = "key-fake"
process.env.MAILGUN_DOMAIN = "wekruit.com"
process.env.MAILGUN_FROM = "WeKruit <hi@wekruit.com>"
process.env.MAILGUN_REGION = "us"

// ── In-memory Firestore stand-in ──────────────────────────────────────────
type Doc = Record<string, unknown>
class FakeDb {
  store = new Map<string, Doc>() // "collection/id" → data
  // queryable rows: pa-candidate-handles
  handles: Doc[] = []
  matchingJobs = new Map<string, Doc>()
  paJobs = new Map<string, Doc>()
  paUsers = new Map<string, Doc>()
  writes: Array<{ path: string; data: Doc }> = []
  sentEmails: Doc[] = []
  calcomCalls: string[] = []

  collection(name: string) {
    const self = this
    return {
      async add(doc: Doc) {
        if (name === "sent_emails") self.sentEmails.push(doc)
        return { id: `${name}-${self.sentEmails.length}` }
      },
      doc(id: string) {
        const path = `${name}/${id}`
        return {
          async get() {
            let data: Doc | undefined
            if (name === "pa-interview-bookings") data = self.store.get(path)
            else if (name === "matching-jobs") data = self.matchingJobs.get(id)
            else if (name === "pa-jobs") data = self.paJobs.get(id)
            else if (name === "pa-users") data = self.paUsers.get(id)
            return { exists: data !== undefined, id, data: () => data }
          },
          async set(data: Doc, opts?: { merge?: boolean }) {
            self.writes.push({ path, data })
            const prev = self.store.get(path) ?? {}
            self.store.set(path, opts?.merge ? { ...prev, ...data } : data)
          },
        }
      },
      where(field: string, _op: string, value: unknown) {
        // Two query shapes:
        //   pa-candidate-handles: where(candidateId).where(kind).limit(1).get()
        //   pa-interview-bookings (cross-turn recovery): where(userId).where(status,'in',[...]).get()
        return {
          where(field2: string, op2: string, value2: unknown) {
            const runBookingsRecovery = () => {
              // rows = all booking docs in this collection matching userId + status-in.
              const rows = Array.from(self.store.entries())
                .filter(([path]) => path.startsWith(`${name}/`))
                .map(([, data]) => data)
                .filter((d) => {
                  if (d[field] !== value) return false
                  if (op2 === "in" && Array.isArray(value2)) return (value2 as unknown[]).includes(d[field2])
                  return d[field2] === value2
                })
              return {
                empty: rows.length === 0,
                docs: rows.map((d, i) => ({ id: `${name}-${i}`, data: () => d })),
              }
            }
            return {
              // pa-interview-bookings recovery uses a bare .get() (no .limit()).
              async get() {
                if (name === "pa-interview-bookings") return runBookingsRecovery()
                const rows = self.handles.filter((h) => h[field] === value && h[field2] === value2)
                return { empty: rows.length === 0, docs: rows.map((d) => ({ data: () => d })) }
              },
              limit(_n: number) {
                return {
                  async get() {
                    const rows = self.handles.filter((h) => h[field] === value && h[field2] === value2)
                    return {
                      empty: rows.length === 0,
                      docs: rows.slice(0, 1).map((d) => ({ data: () => d })),
                    }
                  },
                }
              },
            }
          },
        }
      },
    }
  }
}

// ── Mock global fetch for the Cal.com client ──────────────────────────────
function installCalcomFetch(
  opts: {
    slots?: FlatSlot[] | "throw"
    bookingStatus?: number
    bookingThrow?: boolean
  } = {},
): () => void {
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/slots")) {
      if (opts.slots === "throw") throw new Error("calcom slots down")
      const data: Record<string, unknown[]> = {}
      for (const s of opts.slots ?? []) {
        data[s.date] ??= []
        ;(data[s.date] as unknown[]).push({ start: s.iso })
      }
      return new Response(JSON.stringify({ status: "success", data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("/bookings")) {
      if (opts.bookingThrow) throw new Error("calcom bookings network error")
      const status = opts.bookingStatus ?? 200
      if (status >= 400) {
        return new Response(JSON.stringify({ error: { message: "slot taken" } }), {
          status,
          headers: { "content-type": "application/json" },
        })
      }
      const body = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            id: 4242,
            uid: "cal-uid-xyz",
            title: "Interview",
            status: "accepted",
            start: body.start,
            end: body.start,
            duration: 15,
            eventType: { id: body.eventTypeId, slug: "swe" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    // mailgun
    return new Response(JSON.stringify({ id: "<mg-msg@wekruit.com>" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return () => {
    globalThis.fetch = orig
  }
}

function makeCtx(db: FakeDb, userId: string, extra: Partial<ClaireToolContext> = {}): ClaireToolContext {
  const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
  const ctx = {
    db: db as unknown as ClaireToolContext["db"],
    userId,
    sessionId: "sess-1",
    lang: "en" as const,
    jobId: "job-1",
    transport: {} as ClaireToolContext["transport"],
    judgeModel: "test",
    log: (event: string, payload?: Record<string, unknown>) => {
      logs.push({ event, ...(payload ? { payload } : {}) })
    },
    nowIso: () => "2026-06-01T12:00:00.000Z",
    ...extra,
  } as ClaireToolContext
  ;(ctx as unknown as { _logs: typeof logs })._logs = logs
  return ctx
}

function tools(ctx: ClaireToolContext) {
  const [offer, book] = buildSchedulingTools(ctx)
  // The SDK tool() wraps execute; call its invoke. We call execute via the
  // `invoke`-equivalent: @openai/agents tool() returns an object with
  // `.invoke(runContext, argsJSON)`. We instead call the underlying execute by
  // re-extracting from the closure is not possible, so we use invoke with JSON.
  return { offer, book }
}

// Invoke a tool's execute via the @openai/agents tool wrapper.
async function invoke(toolObj: unknown, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t = toolObj as { invoke: (ctx: unknown, json: string) => Promise<unknown> }
  const out = await t.invoke({}, JSON.stringify(args))
  return (typeof out === "string" ? JSON.parse(out) : out) as Record<string, unknown>
}

const SLOTS: FlatSlot[] = [
  { iso: "2026-06-02T09:00:00.000-04:00", date: "2026-06-02" }, // morning
  { iso: "2026-06-03T14:00:00.000-04:00", date: "2026-06-03" }, // afternoon
  { iso: "2026-06-04T11:00:00.000-04:00", date: "2026-06-04" }, // morning
  { iso: "2026-06-05T18:00:00.000-04:00", date: "2026-06-05" }, // evening
  { iso: "2026-06-06T13:00:00.000-04:00", date: "2026-06-06" }, // afternoon
  { iso: "2026-06-07T10:00:00.000-04:00", date: "2026-06-07" }, // morning
]

// ── pure helpers ──────────────────────────────────────────────────────────
test("pickSpread returns all when <= n; spreads when more", () => {
  assert.equal(pickSpread(SLOTS.slice(0, 3), 5).length, 3)
  const picked = pickSpread(SLOTS, 5)
  assert.equal(picked.length, 5)
  assert.equal(picked[0]!.iso, SLOTS[0]!.iso) // first
  assert.equal(picked[picked.length - 1]!.iso, SLOTS[SLOTS.length - 1]!.iso) // last
})

test("humanLabel renders in tz (contains a weekday)", () => {
  const label = humanLabel("2026-06-02T09:00:00.000-04:00", "America/New_York")
  assert.match(label, /Jun 2/)
})

test("filterByPartOfDay narrows by local hour; any/null = no filter", () => {
  assert.equal(filterByPartOfDay(SLOTS, "any", "America/New_York").length, SLOTS.length)
  assert.equal(filterByPartOfDay(SLOTS, null, "America/New_York").length, SLOTS.length)
  const morning = filterByPartOfDay(SLOTS, "morning", "America/New_York")
  assert.ok(morning.every((s) => s.iso.includes("T09") || s.iso.includes("T11") || s.iso.includes("T10")))
})

// ── GATE ───────────────────────────────────────────────────────────────────
test("GATE: non-dev uid → both tools scheduling_not_enabled, ZERO Cal calls / writes / email", async () => {
  assert.equal(SCHEDULING_DEV_UIDS.has(NON_DEV_UID), false)
  const db = new FakeDb()
  let fetchCalled = false
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCalled = true
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    const ctx = makeCtx(db, NON_DEV_UID)
    const { offer, book } = tools(ctx)
    const o = await invoke(offer, { timeZone: null, partOfDay: null })
    const b = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.deepEqual(o, { ok: false, reason: "scheduling_not_enabled" })
    assert.deepEqual(b, { ok: false, reason: "scheduling_not_enabled" })
    assert.equal(fetchCalled, false, "no Cal.com / mailgun fetch")
    assert.equal(db.writes.length, 0, "no Firestore writes")
  } finally {
    globalThis.fetch = origFetch
  }
})

// ── OFFER ────────────────────────────────────────────────────────────────
test("offer persists status:offered + ordered offeredSlots; returns numbered list matching persisted", async () => {
  const db = new FakeDb()
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const ctx = makeCtx(db, DEV_UID)
    const { offer } = tools(ctx)
    const res = await invoke(offer, { timeZone: null, partOfDay: null })
    assert.equal(res.ok, true)
    const slots = res.slots as Array<{ number: number; iso: string; label: string }>
    assert.equal(slots.length, 5)
    assert.equal(slots[0]!.number, 1)
    // persisted doc.
    const persisted = db.store.get(BOOKING_PATH)!
    assert.equal(persisted.status, "offered")
    const offeredSlots = persisted.offeredSlots as Array<{ iso: string }>
    assert.equal(offeredSlots.length, 5)
    // numbered list iso matches the persisted array, in order.
    for (let i = 0; i < slots.length; i++) {
      assert.equal(slots[i]!.iso, offeredSlots[i]!.iso)
    }
  } finally {
    restore()
  }
})

test("offer partOfDay filter narrows; empties fall back to unfiltered with filteredEmpty:true", async () => {
  const db = new FakeDb()
  // Only morning slots available → asking for evening empties → fallback.
  const morningOnly: FlatSlot[] = [
    { iso: "2026-06-02T09:00:00.000-04:00", date: "2026-06-02" },
    { iso: "2026-06-03T10:00:00.000-04:00", date: "2026-06-03" },
  ]
  const restore = installCalcomFetch({ slots: morningOnly })
  try {
    const ctx = makeCtx(db, DEV_UID)
    const { offer } = tools(ctx)
    const res = await invoke(offer, { timeZone: "America/New_York", partOfDay: "evening" })
    assert.equal(res.ok, true)
    assert.equal(res.filteredEmpty, true)
    assert.equal((res.slots as unknown[]).length, 2) // unfiltered fallback
  } finally {
    restore()
  }
})

test("offer with no slots → { ok:false, reason:no_slots }", async () => {
  const db = new FakeDb()
  const restore = installCalcomFetch({ slots: [] })
  try {
    const res = await invoke(tools(makeCtx(db, DEV_UID)).offer, { timeZone: null, partOfDay: null })
    assert.deepEqual(res, { ok: false, reason: "no_slots" })
  } finally {
    restore()
  }
})

test("offer FAIL-OPEN: calcom throws → { ok:false, reason:calcom_unavailable } (no throw)", async () => {
  const db = new FakeDb()
  const restore = installCalcomFetch({ slots: "throw" })
  try {
    const res = await invoke(tools(makeCtx(db, DEV_UID)).offer, { timeZone: null, partOfDay: null })
    assert.deepEqual(res, { ok: false, reason: "calcom_unavailable" })
  } finally {
    restore()
  }
})

// ── BOOK ───────────────────────────────────────────────────────────────────
async function offerThen(db: FakeDb, ctx: ClaireToolContext) {
  const { offer } = tools(ctx)
  await invoke(offer, { timeZone: null, partOfDay: null })
}

test("book resolves slotNumber → exact persisted ISO; writes booked→confirmed; sent_emails audit", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx)
    const { book } = tools(ctx)
    const offered = db.store.get(BOOKING_PATH)!.offeredSlots as Array<{ iso: string }>
    const res = await invoke(book, { slotNumber: 2, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(res.ok, true)
    assert.equal(res.action, "booked")
    assert.equal(res.slotIso, offered[1]!.iso) // slotNumber 2 → index 1
    assert.equal(res.emailed, true)
    assert.equal(res.calBookingUid, "cal-uid-xyz")
    const doc = db.store.get(BOOKING_PATH)!
    assert.equal(doc.status, "confirmed")
    assert.equal(doc.selectedSlotIso, offered[1]!.iso)
    assert.equal(doc.calBookingId, 4242)
    // sent_emails audit row written (the email module's db.collection("sent_emails").add()).
    assert.equal(db.sentEmails.length, 1)
    assert.equal(db.sentEmails[0]!.uid, DEV_UID)
    assert.equal(db.sentEmails[0]!.to, "adam@example.com")
    assert.equal(db.sentEmails[0]!.status, "sent")
    assert.equal(db.sentEmails[0]!.provider, "mailgun")
  } finally {
    restore()
  }
})

test("book slotNumber that was NOT offered → slot_not_offered, no booking", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx) // offers 5
    const { book } = tools(ctx)
    const res = await invoke(book, { slotNumber: 9, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.deepEqual(res, { ok: false, reason: "slot_not_offered" })
    const doc = db.store.get(BOOKING_PATH)!
    assert.equal(doc.status, "offered") // unchanged
  } finally {
    restore()
  }
})

test("book slotIso that was NOT offered → slot_not_offered (guards LLM-invented time)", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx)
    const { book } = tools(ctx)
    const res = await invoke(book, {
      slotNumber: null,
      slotIso: "2026-12-25T09:00:00.000-05:00",
      candidateEmail: null,
      candidateName: null,
      timeZone: null,
    })
    assert.deepEqual(res, { ok: false, reason: "slot_not_offered" })
  } finally {
    restore()
  }
})

test("book need_email branch: no arg + no handle → need_email; with handle → books", async () => {
  const db = new FakeDb() // no email handle
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx)
    const { book } = tools(ctx)
    const noEmail = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.deepEqual(noEmail, { ok: false, reason: "need_email" })
    // now pass an email arg → books.
    const withArg = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: "typed@example.com", candidateName: null, timeZone: null })
    assert.equal(withArg.ok, true)
    assert.equal(withArg.action, "booked")
    assert.equal(db.store.get(BOOKING_PATH)!.candidateEmail, "typed@example.com")
  } finally {
    restore()
  }
})

test("book dedup: second book for same confirmed slot → already_booked, no 2nd POST", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  let bookingPosts = 0
  const orig = globalThis.fetch
  const restore = installCalcomFetch({ slots: SLOTS })
  // wrap to count POST /bookings
  const wrapped = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/bookings")) bookingPosts++
    return wrapped(input, init)
  }) as typeof fetch
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx)
    const { book } = tools(ctx)
    const first = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(first.ok, true)
    assert.equal(first.action, "booked")
    assert.equal(bookingPosts, 1)
    const second = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(second.ok, true)
    assert.equal(second.action, "already_booked")
    assert.equal(bookingPosts, 1, "no second Cal POST")
  } finally {
    globalThis.fetch = orig
    restore()
  }
})

test("book FAIL-OPEN: calcom POST throws → { ok:false, calcom_unavailable }, status stays offered", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  // offer with good fetch, then book with a throwing /bookings.
  const restoreOffer = installCalcomFetch({ slots: SLOTS })
  const ctx = makeCtx(db, DEV_UID)
  await offerThen(db, ctx)
  restoreOffer()
  const restoreBook = installCalcomFetch({ slots: SLOTS, bookingThrow: true })
  try {
    const { book } = tools(ctx)
    const res = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(res.ok, false)
    assert.equal(res.reason, "calcom_unavailable")
    assert.equal(res.retryable, true)
    assert.equal(db.store.get(BOOKING_PATH)!.status, "offered")
  } finally {
    restoreBook()
  }
})

test("book Cal 4xx → slot_unavailable + status failed (recoverable)", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const restoreOffer = installCalcomFetch({ slots: SLOTS })
  const ctx = makeCtx(db, DEV_UID)
  await offerThen(db, ctx)
  restoreOffer()
  const restoreBook = installCalcomFetch({ slots: SLOTS, bookingStatus: 409 })
  try {
    const { book } = tools(ctx)
    const res = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(res.ok, false)
    assert.equal(res.reason, "slot_unavailable")
    assert.equal(res.retryable, true)
    assert.equal(db.store.get(BOOKING_PATH)!.status, "failed")
  } finally {
    restoreBook()
  }
})

test("book mailgun-throws-after-booking → status stays booked, { ok:true, emailed:false }", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  // good slots + good booking, but mailgun (any non-cal fetch) returns 500.
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/slots")) {
      const data: Record<string, unknown[]> = {}
      for (const s of SLOTS) {
        data[s.date] ??= []
        ;(data[s.date] as unknown[]).push({ start: s.iso })
      }
      return new Response(JSON.stringify({ status: "success", data }), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (url.includes("/bookings")) {
      const body = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({ status: "success", data: { id: 7, uid: "uid-7", title: "x", status: "accepted", start: body.start, end: body.start, duration: 15, eventType: { id: body.eventTypeId, slug: "s" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    // mailgun → 500
    return new Response("boom", { status: 500 })
  }) as typeof fetch
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx)
    const { book } = tools(ctx)
    const res = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(res.ok, true)
    assert.equal(res.action, "booked")
    assert.equal(res.emailed, false)
    assert.equal(db.store.get(BOOKING_PATH)!.status, "booked")
  } finally {
    globalThis.fetch = orig
  }
})

// ── CROSS-TURN jobId recovery (HIGH) ───────────────────────────────────────
test("CROSS-TURN: offer in prescreen ctx (jobId set) then book in TRIAGE ctx (jobId undefined) still resolves", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    // Turn 1 — PRESCREEN mode: ctx.jobId is the real job, offer persists under calbk-<uid>__job-1.
    const offerCtx = makeCtx(db, DEV_UID, { jobId: "job-1" })
    await offerThen(db, offerCtx)
    const offered = db.store.get(BOOKING_PATH)!.offeredSlots as Array<{ iso: string }>
    assert.ok(offered.length > 0)

    // Turn 2 — TRIAGE mode (prescreen now terminal): ctx.jobId is undefined.
    // Without recovery this would key calbk-<uid>__unknown_job (empty) → slot_not_offered.
    const bookCtx = makeCtx(db, DEV_UID, { jobId: undefined })
    const { book } = tools(bookCtx)
    const res = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(res.ok, true)
    assert.equal(res.action, "booked")
    assert.equal(res.slotIso, offered[0]!.iso)
    // booked write landed on the SAME real-jobId doc, not an unknown_job doc.
    const doc = db.store.get(BOOKING_PATH)!
    assert.equal(doc.status, "confirmed")
    assert.equal(doc.jobId, "job-1")
    assert.equal(db.store.get(`pa-interview-bookings/${interviewBookingDocId({ userId: DEV_UID, jobId: "unknown_job" })}`), undefined)
  } finally {
    restore()
  }
})

test("CROSS-TURN: re-offer in TRIAGE ctx (jobId undefined) reconciles with the real-jobId offer doc, no orphan", async () => {
  const db = new FakeDb()
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    // Turn 1 — offer under the real jobId.
    await offerThen(db, makeCtx(db, DEV_UID, { jobId: "job-1" }))
    // Turn 2 — re-offer (e.g. 'anything in the afternoon?') in TRIAGE (no jobId).
    const { offer } = tools(makeCtx(db, DEV_UID, { jobId: undefined }))
    const res = await invoke(offer, { timeZone: null, partOfDay: "afternoon" })
    assert.equal(res.ok, true)
    // Re-offer wrote the SAME real-jobId doc — no calbk-<uid>__unknown_job orphan.
    assert.equal(db.store.get(`pa-interview-bookings/${interviewBookingDocId({ userId: DEV_UID, jobId: "unknown_job" })}`), undefined)
    assert.equal(db.store.get(BOOKING_PATH)!.jobId, "job-1")
  } finally {
    restore()
  }
})

// ── RESCHEDULE guard (MEDIUM) ──────────────────────────────────────────────
test("RESCHEDULE: book slot #1, re-offer (status flips to offered), then pick a DIFFERENT slot → already_booked_other_slot, NO 2nd Cal POST", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  let bookingPosts = 0
  const orig = globalThis.fetch
  const restore = installCalcomFetch({ slots: SLOTS })
  const wrapped = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/bookings")) bookingPosts++
    return wrapped(input, init)
  }) as typeof fetch
  try {
    const ctx = makeCtx(db, DEV_UID)
    // book slot #1 → real Cal booking A.
    await offerThen(db, ctx)
    const { book } = tools(ctx)
    const first = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(first.ok, true)
    assert.equal(first.action, "booked")
    assert.equal(bookingPosts, 1)
    // candidate asks for different times → re-offer flips status back to 'offered'
    // (but leaves calBookingId/calBookingUid/selectedSlotIso intact).
    await invoke(tools(ctx).offer, { timeZone: null, partOfDay: null })
    assert.equal(db.store.get(BOOKING_PATH)!.status, "offered")
    // now pick a DIFFERENT slot (#2). The OLD code would POST a 2nd booking and
    // orphan booking A. The guard refuses.
    const offered = db.store.get(BOOKING_PATH)!.offeredSlots as Array<{ iso: string }>
    const second = await invoke(tools(ctx).book, { slotNumber: 2, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(second.ok, false)
    assert.equal(second.reason, "already_booked_other_slot")
    assert.equal(bookingPosts, 1, "no second Cal POST — booking A not orphaned")
    // doc still points at the original booking A's slot.
    assert.notEqual(offered[1]!.iso, db.store.get(BOOKING_PATH)!.selectedSlotIso)
  } finally {
    globalThis.fetch = orig
    restore()
  }
})

test("RESCHEDULE: re-offer then re-pick the SAME already-booked slot → already_booked (idempotent), no 2nd POST", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  let bookingPosts = 0
  const orig = globalThis.fetch
  const restore = installCalcomFetch({ slots: SLOTS })
  const wrapped = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/bookings")) bookingPosts++
    return wrapped(input, init)
  }) as typeof fetch
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx)
    await invoke(tools(ctx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(bookingPosts, 1)
    await invoke(tools(ctx).offer, { timeZone: null, partOfDay: null }) // status → offered, live booking intact
    const again = await invoke(tools(ctx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(again.ok, true)
    assert.equal(again.action, "already_booked")
    assert.equal(bookingPosts, 1, "no second Cal POST for the same slot")
  } finally {
    globalThis.fetch = orig
    restore()
  }
})

// ── STALENESS guard (LOW) ──────────────────────────────────────────────────
test("STALENESS: every offered slot in the past → book returns slots_expired (no Cal POST)", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  // Offer with 'now' BEFORE the slots, then book with 'now' AFTER all of them.
  const restore = installCalcomFetch({ slots: SLOTS })
  let bookingPosts = 0
  const orig = globalThis.fetch
  const wrapped = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/bookings")) bookingPosts++
    return wrapped(input, init)
  }) as typeof fetch
  try {
    await offerThen(db, makeCtx(db, DEV_UID)) // nowIso = 2026-06-01 → all SLOTS future
    // book turn happens "later" — after every offered slot (latest is Jun 7).
    const lateCtx = makeCtx(db, DEV_UID, { nowIso: () => "2026-06-30T12:00:00.000Z" })
    const res = await invoke(tools(lateCtx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(res.ok, false)
    assert.equal(res.reason, "slots_expired")
    assert.equal(res.retryable, true)
    assert.equal(bookingPosts, 0, "no Cal POST for a past slot")
    assert.equal(db.store.get(BOOKING_PATH)!.status, "offered") // unchanged
  } finally {
    globalThis.fetch = orig
    restore()
  }
})

// ── TZ precedence (LOW) ────────────────────────────────────────────────────
test("TZ precedence: book WITHOUT an explicit tz uses the OFFER's persisted doc.timeZone, not user-tags/default", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  // user-tags default would resolve NY, but the offer was presented in LA.
  db.paUsers.set(DEV_UID, { tags: { targetLocations: ["new_york_metro"] } })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    // Offer in America/Los_Angeles (candidate said 'I'm on west coast').
    const ctx = makeCtx(db, DEV_UID)
    await invoke(tools(ctx).offer, { timeZone: "America/Los_Angeles", partOfDay: null })
    assert.equal(db.store.get(BOOKING_PATH)!.timeZone, "America/Los_Angeles")
    // Book WITHOUT restating the tz → must keep the offer's LA tz (not NY from tags).
    const res = await invoke(tools(ctx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null })
    assert.equal(res.ok, true)
    assert.equal(db.store.get(BOOKING_PATH)!.timeZone, "America/Los_Angeles")
    // the booked attendee.timeZone (PT) shows a PT wall-clock label, not ET.
    assert.match(String(res.when), /PDT|PST|GMT-7|GMT-8/)
  } finally {
    restore()
  }
})

// ── canonical LOCATION_TZ (MEDIUM) ─────────────────────────────────────────
test("LOCATION_TZ: a canonical west-coast targetLocations token resolves to America/Los_Angeles", async () => {
  const db = new FakeDb()
  db.paUsers.set(DEV_UID, { tags: { targetLocations: ["san_francisco_bay_area"] } })
  const tz = await resolveTimeZone(makeCtx(db, DEV_UID), null)
  assert.equal(tz, "America/Los_Angeles")
})

test("LOCATION_TZ: canonical new_york_metro → America/New_York; remote → default", async () => {
  const dbNy = new FakeDb()
  dbNy.paUsers.set(DEV_UID, { tags: { targetLocations: ["new_york_metro"] } })
  assert.equal(await resolveTimeZone(makeCtx(dbNy, DEV_UID), null), "America/New_York")

  const dbSeattle = new FakeDb()
  dbSeattle.paUsers.set(DEV_UID, { tags: { targetLocations: ["seattle_metro"] } })
  assert.equal(await resolveTimeZone(makeCtx(dbSeattle, DEV_UID), null), "America/Los_Angeles")

  const dbRemote = new FakeDb()
  dbRemote.paUsers.set(DEV_UID, { tags: { targetLocations: ["remote_united_states"] } })
  assert.equal(await resolveTimeZone(makeCtx(dbRemote, DEV_UID), null), "America/New_York") // default
})

test("LOCATION_TZ: the OLD bare/abbrev keys are GONE — old LA-mapping tokens no longer match (→ default)", async () => {
  const dbBare = new FakeDb()
  // Under the OLD map these all resolved to America/Los_Angeles; they are NOT
  // canonical tokens (D5 bans them / no bare form exists) so they can never
  // appear in stored tags. After re-keying they must NOT match → default NY.
  dbBare.paUsers.set(DEV_UID, { tags: { targetLocations: ["sf_bay_area", "san_francisco", "la", "los_angeles"] } })
  assert.equal(await resolveTimeZone(makeCtx(dbBare, DEV_UID), null), "America/New_York") // default, NOT LA
})
