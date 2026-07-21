/**
 * runBookInterviewSlot — the headhunter book-on-behalf runner. Confirms the
 * confirm-first gate (dry-run books NOTHING), the scheduling eligibility gate
 * (non-dev candidate silently no-ops), slot-selection validation, and that a
 * confirm:true call for a dev candidate reaches the REAL Cal.com createBooking
 * (POST /v2/bookings) via the shared bookInterviewSlotCore.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { runBookInterviewSlot } from "../headhunter-mcp/scheduling.js"
import { buildInterviewOffer } from "../claire-agent/tools/scheduling-tools.js"
import type { ClaireToolContext } from "../claire-agent/types.js"
import type { FlatSlot } from "../calcom/calcom-client.js"
import { interviewBookingDocId } from "@pa/core-types"

const DEV_UID = "8fEwIduUrzxZsblHHsNz" // Adam — always scheduling-eligible (dev floor).
const NON_DEV_UID = "someRandomCandidate"
const JOB_ID = "job-1"
const BOOKING_PATH = `pa-interview-bookings/${interviewBookingDocId({ userId: DEV_UID, jobId: JOB_ID })}`

// FAKE secrets so the Cal client + mailgun don't throw.
process.env.CALCOM_API_KEY = "cal_test_FAKE"
process.env.MAILGUN_API_KEY = "key-fake"
process.env.MAILGUN_DOMAIN = "wekruit.com"
process.env.MAILGUN_FROM = "WeKruit <hi@wekruit.com>"
process.env.MAILGUN_REGION = "us"

type Doc = Record<string, unknown>

/** Minimal in-memory Firestore for pa-interview-bookings + pa-candidate-handles + pa-users. */
class FakeDb {
  store = new Map<string, Doc>()
  handles: Doc[] = []
  paUsers = new Map<string, Doc>()
  writes: Array<{ path: string; data: Doc }> = []
  collection(name: string) {
    const self = this
    return {
      async add(doc: Doc) {
        return { id: `${name}-add` }
      },
      doc(id: string) {
        const path = `${name}/${id}`
        return {
          async get() {
            let data: Doc | undefined
            if (name === "pa-interview-bookings") data = self.store.get(path)
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
        return {
          async get() {
            // pa-employer-visible-profiles by candidateId == X (single where) — none here.
            return { empty: true, docs: [] as Array<{ id: string; data: () => Doc }> }
          },
          where(field2: string, op2: string, value2: unknown) {
            const runBookingsRecovery = () => {
              const rows = Array.from(self.store.entries())
                .filter(([p]) => p.startsWith(`${name}/`))
                .map(([, d]) => d)
                .filter((d) => {
                  if (d[field] !== value) return false
                  if (op2 === "in" && Array.isArray(value2)) return (value2 as unknown[]).includes(d[field2])
                  return d[field2] === value2
                })
              return { empty: rows.length === 0, docs: rows.map((d, i) => ({ id: `${name}-${i}`, data: () => d })) }
            }
            return {
              async get() {
                if (name === "pa-interview-bookings") return runBookingsRecovery()
                const rows = self.handles.filter((h) => h[field] === value && h[field2] === value2)
                return { empty: rows.length === 0, docs: rows.map((d) => ({ data: () => d })) }
              },
              limit(_n: number) {
                return {
                  async get() {
                    const rows = self.handles.filter((h) => h[field] === value && h[field2] === value2)
                    return { empty: rows.length === 0, docs: rows.slice(0, 1).map((d) => ({ data: () => d })) }
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

// The runner uses REAL wall-clock time (new Date()) for staleness — unlike the
// candidate tool's pinnable ctx.nowIso — so the offered slots MUST be in the
// future relative to actual "now", or every book would return slots_expired.
function futureSlot(daysAhead: number, hh: number): FlatSlot {
  const d = new Date(Date.now() + daysAhead * 24 * 3600 * 1000)
  d.setUTCHours(hh, 0, 0, 0)
  const iso = d.toISOString()
  return { iso, date: iso.slice(0, 10) }
}
const SLOTS: FlatSlot[] = [futureSlot(2, 13), futureSlot(3, 18), futureSlot(4, 15)]

/** Mock global fetch: /slots → SLOTS, /bookings → accepted booking, else mailgun ok. */
function installFetch(): { restore: () => void; bookingPosts: () => number } {
  const orig = globalThis.fetch
  let posts = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/slots")) {
      const data: Record<string, unknown[]> = {}
      for (const s of SLOTS) {
        data[s.date] ??= []
        ;(data[s.date] as unknown[]).push({ start: s.iso })
      }
      return new Response(JSON.stringify({ status: "success", data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("/bookings")) {
      posts++
      const body = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            id: 9090,
            uid: "hh-uid-1",
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
    return new Response(JSON.stringify({ id: "<mg@wekruit.com>" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = orig }, bookingPosts: () => posts }
}

/** Build the SDK-free ctx used by buildInterviewOffer to seed a persisted offer doc. */
function offerCtx(db: FakeDb, userId: string): ClaireToolContext {
  return {
    db: db as unknown as ClaireToolContext["db"],
    userId,
    sessionId: "sess-offer",
    lang: "en",
    judgeModel: "test",
    jobId: JOB_ID,
    log: () => undefined,
    nowIso: () => "2026-06-01T12:00:00.000Z",
  } as unknown as ClaireToolContext
}

async function seedOffer(db: FakeDb, userId: string) {
  await buildInterviewOffer(offerCtx(db, userId), { timeZone: null, partOfDay: null, jobChoice: null })
}

test("runBookInterviewSlot: no slotNumber/slotIso → no_slot_selected, books nothing", async () => {
  const db = new FakeDb()
  const { restore, bookingPosts } = installFetch()
  try {
    const res = await runBookInterviewSlot({ userId: DEV_UID, confirm: true }, { db: db as never })
    assert.equal(res.ok, false)
    assert.equal((res as { reason: string }).reason, "no_slot_selected")
    assert.equal(bookingPosts(), 0)
  } finally {
    restore()
  }
})

test("runBookInterviewSlot: dry-run (confirm omitted) → not_confirmed, ZERO Cal POST", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const { restore, bookingPosts } = installFetch()
  try {
    await seedOffer(db, DEV_UID)
    const res = await runBookInterviewSlot({ userId: DEV_UID, slotNumber: 1 }, { db: db as never })
    assert.equal(res.ok, false)
    assert.equal((res as { reason: string }).reason, "not_confirmed")
    assert.equal(bookingPosts(), 0, "dry-run never books")
    assert.equal(db.store.get(BOOKING_PATH)!.status, "offered")
  } finally {
    restore()
  }
})

test("runBookInterviewSlot: non-dev candidate → scheduling_not_enabled, ZERO Cal POST (even with confirm:true)", async () => {
  const db = new FakeDb()
  const { restore, bookingPosts } = installFetch()
  try {
    const res = await runBookInterviewSlot(
      { userId: NON_DEV_UID, confirm: true, slotNumber: 1 },
      { db: db as never },
    )
    assert.equal(res.ok, false)
    assert.equal((res as { reason: string }).reason, "scheduling_not_enabled")
    assert.equal(bookingPosts(), 0, "gated candidate never books")
  } finally {
    restore()
  }
})

test("runBookInterviewSlot: dev candidate + confirm:true + offered slot → REAL createBooking, doc confirmed", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const { restore, bookingPosts } = installFetch()
  try {
    await seedOffer(db, DEV_UID)
    const offered = db.store.get(BOOKING_PATH)!.offeredSlots as Array<{ iso: string }>
    const res = await runBookInterviewSlot(
      { userId: DEV_UID, confirm: true, slotNumber: 2 },
      { db: db as never },
    )
    assert.equal(res.ok, true)
    assert.equal((res as { action: string }).action, "booked")
    assert.equal((res as { slotIso: string }).slotIso, offered[1]!.iso) // slotNumber 2 → index 1
    assert.equal((res as { calBookingUid: string }).calBookingUid, "hh-uid-1")
    assert.equal(bookingPosts(), 1, "exactly one REAL Cal POST")
    const doc = db.store.get(BOOKING_PATH)!
    assert.equal(doc.status, "confirmed")
    assert.equal(doc.calBookingId, 9090)
    assert.equal(doc.selectedSlotIso, offered[1]!.iso)
  } finally {
    restore()
  }
})

test("runBookInterviewSlot: confirm:true but slot NOT offered → slot_not_offered, no booking", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const { restore, bookingPosts } = installFetch()
  try {
    await seedOffer(db, DEV_UID) // offers 3
    const res = await runBookInterviewSlot(
      { userId: DEV_UID, confirm: true, slotNumber: 9 },
      { db: db as never },
    )
    assert.equal(res.ok, false)
    assert.equal((res as { reason: string }).reason, "slot_not_offered")
    assert.equal(bookingPosts(), 0)
    assert.equal(db.store.get(BOOKING_PATH)!.status, "offered")
  } finally {
    restore()
  }
})

test("runBookInterviewSlot: idempotent — second confirm of same slot → already_booked, no 2nd POST", async () => {
  const db = new FakeDb()
  db.handles.push({ candidateId: DEV_UID, kind: "email", normalizedValue: "adam@example.com" })
  const { restore, bookingPosts } = installFetch()
  try {
    await seedOffer(db, DEV_UID)
    // Pass jobId (as the headhunter flow does, from schedule_interview) so the
    // re-confirm resolves the SAME doc directly — cross-turn recovery via the
    // bookings query intentionally only spans offered/booked/failed, not the
    // post-email `confirmed` status, so a jobless re-confirm can't recover it.
    const first = await runBookInterviewSlot({ userId: DEV_UID, jobId: JOB_ID, confirm: true, slotNumber: 1 }, { db: db as never })
    assert.equal((first as { action: string }).action, "booked")
    assert.equal(bookingPosts(), 1)
    const second = await runBookInterviewSlot({ userId: DEV_UID, jobId: JOB_ID, confirm: true, slotNumber: 1 }, { db: db as never })
    assert.equal(second.ok, true)
    assert.equal((second as { action: string }).action, "already_booked")
    assert.equal(bookingPosts(), 1, "no second Cal POST")
  } finally {
    restore()
  }
})
