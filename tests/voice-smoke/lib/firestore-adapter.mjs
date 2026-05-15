/**
 * v2.1 S6 — Firestore adapter for the voice smoke suite.
 *
 * Live mode lazy-loads `firebase-admin` so unit tests never need the SDK.
 * Mock mode is an in-memory backing store sufficient to exercise the
 * runner's create→poll→read cycle deterministically.
 *
 * The shape mirrors `outbound-bookings/{id}` per MILESTONE v2.1:
 *   {
 *     paUserId, paJobId,
 *     voiceCallSid, voiceState, voiceOutcome,
 *     voiceStartedAt, voiceEndedAt,
 *     transcript: [{ role: 'agent'|'user', text, atIso }],
 *     events: [{ type, atIso, payload? }]
 *   }
 *
 * Pure module — no top-level side effects.
 */

const TERMINAL_STATES = new Set(["PASS", "NOT_PASS", "PAUSE", "HANGUP"])

/** In-memory backend. Useful for unit tests + driver dry-runs. */
export function createMockFirestoreAdapter(initial = {}) {
  const bookings = new Map()
  const metrics = new Map()
  const counters = { creates: 0, reads: 0, updates: 0 }

  for (const [id, doc] of Object.entries(initial.bookings ?? {})) {
    bookings.set(id, { ...doc })
  }
  for (const [sid, m] of Object.entries(initial.metrics ?? {})) {
    metrics.set(sid, { ...m })
  }

  return {
    kind: "mock",
    counters,
    async createBooking(id, doc) {
      counters.creates += 1
      bookings.set(id, { ...doc, voiceState: doc.voiceState ?? "queued" })
      return id
    },
    async readBooking(id) {
      counters.reads += 1
      const d = bookings.get(id)
      return d ? { ...d } : null
    },
    async updateBooking(id, patch) {
      counters.updates += 1
      const cur = bookings.get(id)
      if (!cur) throw new Error(`booking ${id} not found`)
      bookings.set(id, { ...cur, ...patch })
    },
    async readMetrics(callSid) {
      counters.reads += 1
      const m = metrics.get(callSid)
      return m ? { ...m } : null
    },
    async writeMetrics(callSid, m) {
      metrics.set(callSid, { ...m })
    },
    /** Test seam — advance a booking to a terminal state. */
    __advanceTerminal(id, outcome) {
      const cur = bookings.get(id)
      if (!cur) throw new Error(`booking ${id} not found`)
      bookings.set(id, {
        ...cur,
        voiceState: outcome,
        voiceOutcome: outcome,
        voiceEndedAt: new Date().toISOString(),
      })
    },
  }
}

/** Live Firestore adapter — lazy-imports firebase-admin. */
export async function createLiveFirestoreAdapter() {
  // eslint-disable-next-line import/no-unresolved
  const admin = await import("firebase-admin")
  if (admin.default.apps.length === 0) {
    admin.default.initializeApp({
      credential: admin.default.credential.applicationDefault(),
    })
  }
  const db = admin.default.firestore()
  return {
    kind: "live",
    async createBooking(id, doc) {
      await db
        .collection("outbound-bookings")
        .doc(id)
        .set({ ...doc, voiceState: doc.voiceState ?? "queued" })
      return id
    },
    async readBooking(id) {
      const snap = await db.collection("outbound-bookings").doc(id).get()
      return snap.exists ? snap.data() : null
    },
    async updateBooking(id, patch) {
      await db.collection("outbound-bookings").doc(id).update(patch)
    },
    async readMetrics(callSid) {
      const snap = await db.collection("voice-call-metrics").doc(callSid).get()
      return snap.exists ? snap.data() : null
    },
    async writeMetrics(callSid, m) {
      await db.collection("voice-call-metrics").doc(callSid).set(m, { merge: true })
    },
  }
}

/** Poll a booking until it reaches a terminal state or timeout. */
export async function waitForTerminal(adapter, bookingId, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 300_000
  const intervalMs = opts.intervalMs ?? 2_000
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const doc = await adapter.readBooking(bookingId)
    if (doc && TERMINAL_STATES.has(doc.voiceOutcome)) {
      return doc
    }
    await sleep(intervalMs)
  }
  throw new Error(`waitForTerminal: timeout after ${timeoutMs}ms for booking ${bookingId}`)
}

export { TERMINAL_STATES }
