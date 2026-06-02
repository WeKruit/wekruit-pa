import assert from "node:assert/strict"
import test from "node:test"

import {
  buildSchedulingTools,
  SCHEDULING_DEV_UIDS,
  pickSpread,
  humanLabel,
  filterByPartOfDay,
  parseStatedTime,
  resolveTimeZone,
  listSchedulableJobs,
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
  // queryable rows: pa-employer-visible-profiles (dashboard-committed PASSes)
  employerVisible: Doc[] = []
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
        // Three query shapes:
        //   pa-candidate-handles: where(candidateId).where(kind).limit(1).get()
        //   pa-interview-bookings (cross-turn recovery): where(userId).where(status,'in',[...]).get()
        //   pa-employer-visible-profiles (schedulable jobs): where(candidateId).get()  ← single where
        return {
          // Single-where terminal .get() — listSchedulableJobs queries
          // pa-employer-visible-profiles by candidateId == userId only.
          async get() {
            if (name === "pa-employer-visible-profiles") {
              const rows = self.employerVisible.filter((d) => d[field] === value)
              return { empty: rows.length === 0, docs: rows.map((d, i) => ({ id: `${name}-${i}`, data: () => d })) }
            }
            return { empty: true, docs: [] as Array<{ id: string; data: () => Doc }> }
          },
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

// ── parseStatedTime (deterministic AM/PM + weekday backstop) ───────────────
test("parseStatedTime: extracts confident hour + weekday from the candidate's words", () => {
  // the live bug shape: '9am mon' must read as 9:00 (not 21:00) on Monday.
  assert.deepEqual(parseStatedTime("9am mon"), { hour24: 9, weekday: 1 })
  assert.deepEqual(parseStatedTime("9pm"), { hour24: 21, weekday: null })
  assert.deepEqual(parseStatedTime("9:00 pm"), { hour24: 21, weekday: null })
  assert.deepEqual(parseStatedTime("9 p.m."), { hour24: 21, weekday: null })
  assert.deepEqual(parseStatedTime("the 2pm friday"), { hour24: 14, weekday: 5 })
  assert.deepEqual(parseStatedTime("12am"), { hour24: 0, weekday: null }) // midnight
  assert.deepEqual(parseStatedTime("12pm"), { hour24: 12, weekday: null }) // noon
  assert.deepEqual(parseStatedTime("noon"), { hour24: 12, weekday: null })
  assert.deepEqual(parseStatedTime("midnight"), { hour24: 0, weekday: null })
  assert.deepEqual(parseStatedTime("13:00"), { hour24: 13, weekday: null }) // unambiguous 24h
  assert.deepEqual(parseStatedTime("tuesday"), { hour24: null, weekday: 2 }) // 'tue'/'tues' don't double-count
})

test("parseStatedTime: leaves AMBIGUOUS / non-time phrases null (no false rejection)", () => {
  assert.deepEqual(parseStatedTime("first one"), { hour24: null, weekday: null })
  assert.deepEqual(parseStatedTime("2"), { hour24: null, weekday: null }) // bare hour, no meridiem
  assert.deepEqual(parseStatedTime("the second one"), { hour24: null, weekday: null })
  assert.deepEqual(parseStatedTime(""), { hour24: null, weekday: null })
  assert.deepEqual(parseStatedTime("2pm or 3pm"), { hour24: null, weekday: null }) // two distinct hours
  assert.deepEqual(parseStatedTime("monday or tuesday"), { hour24: null, weekday: null }) // two distinct days
  assert.deepEqual(parseStatedTime("9amazing role"), { hour24: null, weekday: null }) // not a real time token
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
    const o = await invoke(offer, { timeZone: null, partOfDay: null, jobChoice: null })
    const b = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
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
    const res = await invoke(offer, { timeZone: null, partOfDay: null, jobChoice: null })
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
    const res = await invoke(offer, { timeZone: "America/New_York", partOfDay: "evening", jobChoice: null })
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
    const res = await invoke(tools(makeCtx(db, DEV_UID)).offer, { timeZone: null, partOfDay: null, jobChoice: null })
    assert.deepEqual(res, { ok: false, reason: "no_slots" })
  } finally {
    restore()
  }
})

test("offer FAIL-OPEN: calcom throws → { ok:false, reason:calcom_unavailable } (no throw)", async () => {
  const db = new FakeDb()
  const restore = installCalcomFetch({ slots: "throw" })
  try {
    const res = await invoke(tools(makeCtx(db, DEV_UID)).offer, { timeZone: null, partOfDay: null, jobChoice: null })
    assert.deepEqual(res, { ok: false, reason: "calcom_unavailable" })
  } finally {
    restore()
  }
})

// ── BOOK ───────────────────────────────────────────────────────────────────
async function offerThen(db: FakeDb, ctx: ClaireToolContext) {
  const { offer } = tools(ctx)
  await invoke(offer, { timeZone: null, partOfDay: null, jobChoice: null })
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
    const res = await invoke(book, { slotNumber: 2, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
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
    const res = await invoke(book, { slotNumber: 9, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
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
      statedTime: null,
    })
    assert.deepEqual(res, { ok: false, reason: "slot_not_offered" })
  } finally {
    restore()
  }
})

test("book REJECTS an AM/PM mismatch: slot is Fri 6PM but candidate said '6am fri' → slot_time_mismatch, NO booking", async () => {
  // The 2026-06-01 live bug: candidate typed '9am', the agent snapped it onto the
  // 9PM slot and booked it. The statedTime guard must catch the meridiem flip.
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx) // slot 3 = Fri Jun 5, 18:00-04:00 (6 PM ET)
    const { book } = tools(ctx)
    const res = await invoke(book, {
      slotNumber: 3,
      slotIso: null,
      statedTime: "6am fri",
      candidateEmail: null,
      candidateName: null,
      timeZone: null,
    })
    assert.equal(res.ok, false)
    assert.equal(res.reason, "slot_time_mismatch")
    assert.equal((res.offered as string[]).length, 5) // re-offer the real times
    // NO booking written — doc stays offered, no Cal POST persisted.
    const doc = db.store.get(BOOKING_PATH)!
    assert.equal(doc.status, "offered")
    assert.equal(doc.calBookingUid ?? null, null)
  } finally {
    restore()
  }
})

test("book REJECTS a wrong-DAY pick: slot is Tue but candidate said 'wednesday' → slot_time_mismatch", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx) // slot 1 = Tue Jun 2
    const res = await invoke(tools(ctx).book, {
      slotNumber: 1,
      slotIso: null,
      statedTime: "wednesday",
      candidateEmail: null,
      candidateName: null,
      timeZone: null,
    })
    assert.equal(res.ok, false)
    assert.equal(res.reason, "slot_time_mismatch")
    assert.equal(db.store.get(BOOKING_PATH)!.status, "offered")
  } finally {
    restore()
  }
})

test("book ALLOWS a matching statedTime ('9am tue' for the Tue 9AM slot) → books normally (no false reject)", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx) // slot 1 = Tue Jun 2, 09:00-04:00 (9 AM ET)
    const res = await invoke(tools(ctx).book, {
      slotNumber: 1,
      slotIso: null,
      statedTime: "9am tue",
      candidateEmail: null,
      candidateName: null,
      timeZone: null,
    })
    assert.equal(res.ok, true)
    assert.equal(res.action, "booked")
  } finally {
    restore()
  }
})

test("book ALLOWS a non-time statedTime ('first one') → no false reject, books normally", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx)
    const res = await invoke(tools(ctx).book, {
      slotNumber: 1,
      slotIso: null,
      statedTime: "first one",
      candidateEmail: null,
      candidateName: null,
      timeZone: null,
    })
    assert.equal(res.ok, true)
    assert.equal(res.action, "booked")
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
    const noEmail = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
    assert.deepEqual(noEmail, { ok: false, reason: "need_email" })
    // now pass an email arg → books.
    const withArg = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: "typed@example.com", candidateName: null, timeZone: null, statedTime: null })
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
    const first = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
    assert.equal(first.ok, true)
    assert.equal(first.action, "booked")
    assert.equal(bookingPosts, 1)
    const second = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
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
    const res = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
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
    const res = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
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
    const res = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
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
    const res = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
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
    const res = await invoke(offer, { timeZone: null, partOfDay: "afternoon", jobChoice: null })
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
    const first = await invoke(book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
    assert.equal(first.ok, true)
    assert.equal(first.action, "booked")
    assert.equal(bookingPosts, 1)
    // candidate asks for different times → re-offer flips status back to 'offered'
    // (but leaves calBookingId/calBookingUid/selectedSlotIso intact).
    await invoke(tools(ctx).offer, { timeZone: null, partOfDay: null, jobChoice: null })
    assert.equal(db.store.get(BOOKING_PATH)!.status, "offered")
    // now pick a DIFFERENT slot (#2). The OLD code would POST a 2nd booking and
    // orphan booking A. The guard refuses.
    const offered = db.store.get(BOOKING_PATH)!.offeredSlots as Array<{ iso: string }>
    const second = await invoke(tools(ctx).book, { slotNumber: 2, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
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
    await invoke(tools(ctx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
    assert.equal(bookingPosts, 1)
    await invoke(tools(ctx).offer, { timeZone: null, partOfDay: null, jobChoice: null }) // status → offered, live booking intact
    const again = await invoke(tools(ctx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
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
    const res = await invoke(tools(lateCtx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
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
    await invoke(tools(ctx).offer, { timeZone: "America/Los_Angeles", partOfDay: null, jobChoice: null })
    assert.equal(db.store.get(BOOKING_PATH)!.timeZone, "America/Los_Angeles")
    // Book WITHOUT restating the tz → must keep the offer's LA tz (not NY from tags).
    const res = await invoke(tools(ctx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
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

// ── listSchedulableJobs (schedule-which-role disambiguation) ───────────────
const NOAH_DEV_UID = "UKFaKdsMzzfPW2CDl5ve" // Noah +12154034668 — also in the gate set.

test("listSchedulableJobs: real pa-employer-visible-profiles passes → mapped jobs (label from matching-jobs)", async () => {
  const db = new FakeDb()
  // Dashboard-committed PASSes (written by applyPassedCandidateSnapshot).
  db.employerVisible.push({ candidateId: DEV_UID, jobId: "job-a" })
  db.employerVisible.push({ candidateId: DEV_UID, jobId: "job-b" })
  db.employerVisible.push({ candidateId: "someone-else", jobId: "job-z" }) // other candidate — excluded
  db.matchingJobs.set("job-a", { jobTitle: "Backend Engineer", companyName: "Acme" })
  db.matchingJobs.set("job-b", { jobTitle: "Staff Designer", companyName: "Globex" })
  const jobs = await listSchedulableJobs(makeCtx(db, DEV_UID))
  assert.equal(jobs.length, 2)
  assert.deepEqual(jobs.map((j) => j.jobId).sort(), ["job-a", "job-b"])
  assert.equal(jobs.find((j) => j.jobId === "job-a")!.label, "Backend Engineer @ Acme")
  assert.equal(jobs.find((j) => j.jobId === "job-b")!.label, "Staff Designer @ Globex")
})

test("listSchedulableJobs: dedup by jobId; falls back to jobId when no label source", async () => {
  const db = new FakeDb()
  db.employerVisible.push({ candidateId: DEV_UID, jobId: "job-a" })
  db.employerVisible.push({ candidateId: DEV_UID, jobId: "job-a" }) // duplicate row
  // no matching-jobs / pa-jobs doc → label falls back to the jobId itself.
  const jobs = await listSchedulableJobs(makeCtx(db, DEV_UID))
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]!.jobId, "job-a")
  assert.equal(jobs[0]!.label, "job-a")
})

test("listSchedulableJobs: dev uid with ZERO real passes → mimic 2 jobs routing to different event-types", async () => {
  const db = new FakeDb() // no employerVisible rows
  const jobs = await listSchedulableJobs(makeCtx(db, DEV_UID))
  assert.equal(jobs.length, 2)
  assert.deepEqual(
    jobs.map((j) => j.jobId),
    ["dev-metavoice-swe", "dev-helium-design"],
  )
  assert.equal(jobs[0]!.roleFunction, "software_engineering")
  assert.equal(jobs[1]!.roleFunction, "creatives_and_design")
})

test("listSchedulableJobs: dev uid REAL passes WIN over the mimic (no mimic when real exist)", async () => {
  const db = new FakeDb()
  db.employerVisible.push({ candidateId: NOAH_DEV_UID, jobId: "real-job" })
  db.matchingJobs.set("real-job", { jobTitle: "PM", companyName: "Initech" })
  const jobs = await listSchedulableJobs(makeCtx(db, NOAH_DEV_UID))
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]!.jobId, "real-job")
  assert.equal(jobs[0]!.label, "PM @ Initech")
})

test("listSchedulableJobs: NON-dev uid with empty real query → [] (no phantom mimic)", async () => {
  const db = new FakeDb()
  const jobs = await listSchedulableJobs(makeCtx(db, NON_DEV_UID))
  assert.deepEqual(jobs, [])
})

// ── offer_interview_slots disambiguation ───────────────────────────────────
// A ctx with NO turn-context job and NO live booking doc → resolveActiveSchedulingJobId
// returns "unknown_job" → the offer must disambiguate over listSchedulableJobs.
function noJobCtx(db: FakeDb, userId: string): ClaireToolContext {
  return makeCtx(db, userId, { jobId: undefined })
}

test("offer disambiguation: NON-dev (would be 0 jobs) → scheduling_not_enabled (gate wins, no Cal call)", async () => {
  // The gate is checked BEFORE any job resolution — confirm the gate is untouched.
  const db = new FakeDb()
  let fetchCalled = false
  const orig = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCalled = true
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    const res = await invoke(tools(noJobCtx(db, NON_DEV_UID)).offer, { timeZone: null, partOfDay: null, jobChoice: null })
    assert.deepEqual(res, { ok: false, reason: "scheduling_not_enabled" })
    assert.equal(fetchCalled, false)
  } finally {
    globalThis.fetch = orig
  }
})

test("offer disambiguation: 2+ schedulable jobs, no jobChoice → needs_job_choice (NO Cal call)", async () => {
  const db = new FakeDb()
  db.employerVisible.push({ candidateId: DEV_UID, jobId: "job-a" })
  db.employerVisible.push({ candidateId: DEV_UID, jobId: "job-b" })
  db.matchingJobs.set("job-a", { jobTitle: "Backend Engineer", companyName: "Acme" })
  db.matchingJobs.set("job-b", { jobTitle: "Staff Designer", companyName: "Globex" })
  let slotsFetched = false
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/slots")) slotsFetched = true
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    const res = await invoke(tools(noJobCtx(db, DEV_UID)).offer, { timeZone: null, partOfDay: null, jobChoice: null })
    assert.equal(res.ok, false)
    assert.equal(res.reason, "needs_job_choice")
    const jobs = res.jobs as Array<{ jobId: string; label: string }>
    assert.equal(jobs.length, 2)
    assert.ok(jobs.every((j) => typeof j.label === "string" && j.label.length > 0))
    assert.equal(slotsFetched, false, "no Cal.com /slots call before disambiguation")
    // nothing persisted yet (we didn't pick a job).
    assert.equal(db.writes.length, 0)
  } finally {
    globalThis.fetch = orig
  }
})

test("offer disambiguation: 2+ jobs WITH matching jobChoice (label substring) → proceeds, persists chosen jobId", async () => {
  const db = new FakeDb()
  db.employerVisible.push({ candidateId: DEV_UID, jobId: "job-a" })
  db.employerVisible.push({ candidateId: DEV_UID, jobId: "job-b" })
  db.matchingJobs.set("job-a", { jobTitle: "Backend Engineer", companyName: "Acme", roleFunction: ["software_engineering"] })
  db.matchingJobs.set("job-b", { jobTitle: "Staff Designer", companyName: "Globex", roleFunction: ["creatives_and_design"] })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const res = await invoke(tools(noJobCtx(db, DEV_UID)).offer, {
      timeZone: null,
      partOfDay: null,
      jobChoice: "designer", // case-insensitive substring on "Staff Designer @ Globex"
    })
    assert.equal(res.ok, true)
    assert.ok((res.slots as unknown[]).length > 0)
    // persisted under the CHOSEN jobId (job-b), so book recovers the SAME job.
    const path = `pa-interview-bookings/${interviewBookingDocId({ userId: DEV_UID, jobId: "job-b" })}`
    const persisted = db.store.get(path)!
    assert.equal(persisted.jobId, "job-b")
    assert.equal(persisted.status, "offered")
    // job-b is a design role → design event-type 5604544.
    assert.equal(persisted.eventTypeId, 5604544)
  } finally {
    restore()
  }
})

test("offer disambiguation: jobChoice that matches NOTHING → needs_job_choice again (no Cal call)", async () => {
  const db = new FakeDb()
  db.employerVisible.push({ candidateId: DEV_UID, jobId: "job-a" })
  db.employerVisible.push({ candidateId: DEV_UID, jobId: "job-b" })
  db.matchingJobs.set("job-a", { jobTitle: "Backend Engineer", companyName: "Acme" })
  db.matchingJobs.set("job-b", { jobTitle: "Staff Designer", companyName: "Globex" })
  let slotsFetched = false
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/slots")) slotsFetched = true
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    const res = await invoke(tools(noJobCtx(db, DEV_UID)).offer, { timeZone: null, partOfDay: null, jobChoice: "data scientist" })
    assert.equal(res.ok, false)
    assert.equal(res.reason, "needs_job_choice")
    assert.equal((res.jobs as unknown[]).length, 2)
    assert.equal(slotsFetched, false)
  } finally {
    globalThis.fetch = orig
  }
})

test("offer disambiguation: exactly 1 schedulable job → uses it, no ask; routes its event-type", async () => {
  const db = new FakeDb()
  db.employerVisible.push({ candidateId: NOAH_DEV_UID, jobId: "solo-job" })
  db.matchingJobs.set("solo-job", { jobTitle: "Sales Lead", companyName: "Hooli", roleFunction: ["sales"] })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const res = await invoke(tools(noJobCtx(db, NOAH_DEV_UID)).offer, { timeZone: null, partOfDay: null, jobChoice: null })
    assert.equal(res.ok, true)
    assert.equal(res.eventTypeId, 5180826) // sales → GTM Interview
    const path = `pa-interview-bookings/${interviewBookingDocId({ userId: NOAH_DEV_UID, jobId: "solo-job" })}`
    assert.equal(db.store.get(path)!.jobId, "solo-job")
  } finally {
    restore()
  }
})

test("offer disambiguation: dev-mimic 2-job round-trips — offer chosen mimic then BOOK recovers same job + event-type", async () => {
  const db = new FakeDb() // zero real passes → mimic kicks in
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    // Pick the DESIGN mimic by label substring → routes to design event-type 5604544.
    const offerCtx = noJobCtx(db, DEV_UID)
    const offerRes = await invoke(tools(offerCtx).offer, { timeZone: null, partOfDay: null, jobChoice: "Helium" })
    assert.equal(offerRes.ok, true)
    assert.equal(offerRes.eventTypeId, 5604544)
    const path = `pa-interview-bookings/${interviewBookingDocId({ userId: DEV_UID, jobId: "dev-helium-design" })}`
    assert.equal(db.store.get(path)!.jobId, "dev-helium-design")
    assert.equal(db.store.get(path)!.eventTypeId, 5604544)
    // Book on a later TRIAGE turn (no ctx.jobId) → resolveActiveSchedulingJobId
    // recovers dev-helium-design from the persisted offered doc, books the SAME job.
    const bookCtx = noJobCtx(db, DEV_UID)
    const bookRes = await invoke(tools(bookCtx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
    assert.equal(bookRes.ok, true)
    assert.equal(bookRes.action, "booked")
    const booked = db.store.get(path)!
    assert.equal(booked.jobId, "dev-helium-design")
    assert.equal(booked.eventTypeId, 5604544) // design event-type round-tripped through book
  } finally {
    restore()
  }
})

// ── meetingUrl plumbing (Google Meet join link) ────────────────────────────
test("book: Meet location in Cal response → persisted on doc + rendered as join link in the email", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  // Custom fetch: slots OK; booking returns a google-meet `location`; capture the
  // mailgun POST body to confirm the join link is rendered.
  let mailgunBody = ""
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
        JSON.stringify({
          status: "success",
          data: {
            id: 8888,
            uid: "uid-meet",
            title: "Interview",
            status: "accepted",
            start: body.start,
            end: body.start,
            duration: 15,
            eventType: { id: body.eventTypeId, slug: "swe" },
            location: "https://meet.google.com/abc-defg-hij",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    // mailgun — capture the form body (contains text/html).
    mailgunBody = init?.body ? String(init.body) : ""
    return new Response(JSON.stringify({ id: "<mg-msg@wekruit.com>" }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx)
    const res = await invoke(tools(ctx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
    assert.equal(res.ok, true)
    assert.equal(res.action, "booked")
    // returned to the agent → Claire can drop the link into the iMessage bubble.
    assert.equal(res.meetingUrl, "https://meet.google.com/abc-defg-hij")
    // persisted on the booking doc.
    assert.equal(db.store.get(BOOKING_PATH)!.meetingUrl, "https://meet.google.com/abc-defg-hij")
    // the WeKruit email rendered the ACTUAL join link (URL is form-encoded in the body).
    assert.ok(mailgunBody.includes("meet.google.com"))
  } finally {
    globalThis.fetch = orig
  }
})

test("book: no Meet location → ok result has meetingUrl:'' (prompt keeps the calendar-invite wording)", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  // installCalcomFetch's booking response carries NO location → no parseable join URL.
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx)
    const res = await invoke(tools(ctx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
    assert.equal(res.ok, true)
    assert.equal(res.action, "booked")
    assert.equal(res.meetingUrl, "") // empty → Claire uses the "calendar invite on the way" wording
  } finally {
    restore()
  }
})

test("book already_booked: returns the persisted meetingUrl so Claire can re-share the link in chat", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  // Custom fetch: booking returns a Meet location so the FIRST book persists it.
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
        JSON.stringify({
          status: "success",
          data: { id: 5, uid: "uid-5", title: "x", status: "accepted", start: body.start, end: body.start, duration: 15, eventType: { id: body.eventTypeId, slug: "s" }, location: "https://meet.google.com/dup-link-xyz" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return new Response(JSON.stringify({ id: "<mg@wekruit.com>" }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    const ctx = makeCtx(db, DEV_UID)
    await offerThen(db, ctx)
    const first = await invoke(tools(ctx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
    assert.equal(first.ok, true)
    assert.equal(first.action, "booked")
    // Repeat ask for the SAME slot → already_booked, link recovered from the doc.
    const again = await invoke(tools(ctx).book, { slotNumber: 1, slotIso: null, candidateEmail: null, candidateName: null, timeZone: null, statedTime: null })
    assert.equal(again.ok, true)
    assert.equal(again.action, "already_booked")
    assert.equal(again.meetingUrl, "https://meet.google.com/dup-link-xyz")
  } finally {
    globalThis.fetch = orig
  }
})

test("offer disambiguation: turn-context jobId WINS — single job, no disambiguation even with passes present", async () => {
  const db = new FakeDb()
  // Multiple committed passes exist, but the prescreen turn has ctx.jobId set →
  // the offer must use THAT job, not ask.
  db.employerVisible.push({ candidateId: DEV_UID, jobId: "job-a" })
  db.employerVisible.push({ candidateId: DEV_UID, jobId: "job-b" })
  const restore = installCalcomFetch({ slots: SLOTS })
  try {
    const ctx = makeCtx(db, DEV_UID, { jobId: "job-1" }) // turn context
    const res = await invoke(tools(ctx).offer, { timeZone: null, partOfDay: null, jobChoice: null })
    assert.equal(res.ok, true)
    assert.equal(db.store.get(BOOKING_PATH)!.jobId, "job-1") // persisted under turn-context job
  } finally {
    restore()
  }
})
