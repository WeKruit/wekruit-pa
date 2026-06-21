import test from "node:test"
import assert from "node:assert/strict"

import {
  ACTIVE_PRESCREEN_TIMEOUT_MS,
  ACTIVE_PRESCREEN_MAX_AGE_MS,
  isPrescreenSessionPastMaxAge,
  RECENT_TERMINAL_PRESCREEN_GUARD_MS,
  FirestoreSessionFinder,
  InMemorySessionFinder,
} from "../session-finder.js"

const HOUR = 60 * 60 * 1000

test("InMemorySessionFinder.findForUser → none when user has no sessions", async () => {
  const f = new InMemorySessionFinder()
  const r = await f.findForUser("u1")
  assert.equal(r.kind, "none")
})

test("InMemorySessionFinder.findForUser → active when terminal=null and fresh", async () => {
  const f = new InMemorySessionFinder()
  const now = Date.now()
  f.add({
    sessionId: "s1",
    userId: "u1",
    jobId: "j1",
    terminal: null,
    currentQId: "q1",
    updatedAtMs: now - 5 * 60 * 1000,
  })
  const r = await f.findForUser("u1", { nowMs: now })
  assert.equal(r.kind, "active")
  if (r.kind === "active") {
    assert.equal(r.sessionId, "s1")
    assert.equal(r.jobId, "j1")
    assert.equal(r.activeQId, "q1")
  }
})

test("InMemorySessionFinder.findForUser → expired when terminal=null but > timeout", async () => {
  const f = new InMemorySessionFinder()
  const now = Date.now()
  f.add({
    sessionId: "s_stale",
    userId: "u1",
    jobId: "j1",
    terminal: null,
    currentQId: "q1",
    updatedAtMs: now - ACTIVE_PRESCREEN_TIMEOUT_MS - 1000,
  })
  const r = await f.findForUser("u1", { nowMs: now })
  assert.equal(r.kind, "expired")
  if (r.kind === "expired") assert.equal(r.sessionId, "s_stale")
  // Side effect: doc was mutated to terminal=PAUSE
  const loaded = await f.loadById("s_stale")
  assert.equal(loaded?.terminal, "PAUSE")
  assert.equal(loaded?.activeQId, null)
})

test("InMemorySessionFinder.findForUser → newest active wins when multiple", async () => {
  const f = new InMemorySessionFinder()
  const now = Date.now()
  f.add({ sessionId: "old", userId: "u1", jobId: "jOld", terminal: null, currentQId: "q1", updatedAtMs: now - 10 * 60 * 1000 })
  f.add({ sessionId: "new", userId: "u1", jobId: "jNew", terminal: null, currentQId: "q2", updatedAtMs: now - 1 * 60 * 1000 })
  const r = await f.findForUser("u1", { nowMs: now })
  assert.equal(r.kind, "active")
  if (r.kind === "active") assert.equal(r.sessionId, "new")
})

test("InMemorySessionFinder.findForUser → recent_terminal when no active but recent ended exists", async () => {
  const f = new InMemorySessionFinder()
  const now = Date.now()
  f.add({
    sessionId: "s_passed",
    userId: "u1",
    jobId: "j1",
    terminal: "PASS",
    currentQId: null,
    updatedAtMs: now - 30 * 60 * 1000,
    endedAtMs: now - 30 * 60 * 1000,
    workSessionKind: "job_prescreen",
  })
  const r = await f.findForUser("u1", { nowMs: now })
  assert.equal(r.kind, "recent_terminal")
  if (r.kind === "recent_terminal") {
    assert.equal(r.sessionId, "s_passed")
    assert.equal(r.terminal, "PASS")
    assert.equal(r.alreadyAcked, false)
  }
})

test("InMemorySessionFinder.findForUser → recent_terminal acked when postTerminalFollowupAckAt set", async () => {
  const f = new InMemorySessionFinder()
  const now = Date.now()
  f.add({
    sessionId: "s_acked",
    userId: "u1",
    jobId: "j1",
    terminal: "FAIL",
    currentQId: null,
    updatedAtMs: now - 10 * 60 * 1000,
    endedAtMs: now - 10 * 60 * 1000,
    workSessionKind: "job_prescreen",
    postTerminalFollowupAckAt: new Date(now - 5 * 60 * 1000).toISOString(),
  })
  const r = await f.findForUser("u1", { nowMs: now })
  assert.equal(r.kind, "recent_terminal")
  if (r.kind === "recent_terminal") assert.equal(r.alreadyAcked, true)
})

test("InMemorySessionFinder.findForUser → none when recent terminal is outside guard window", async () => {
  const f = new InMemorySessionFinder()
  const now = Date.now()
  f.add({
    sessionId: "s_old",
    userId: "u1",
    jobId: "j1",
    terminal: "PASS",
    currentQId: null,
    updatedAtMs: now - RECENT_TERMINAL_PRESCREEN_GUARD_MS - 1000,
    endedAtMs: now - RECENT_TERMINAL_PRESCREEN_GUARD_MS - 1000,
    workSessionKind: "job_prescreen",
  })
  const r = await f.findForUser("u1", { nowMs: now })
  assert.equal(r.kind, "none")
})

test("InMemorySessionFinder.findForUser → ignores non-job_prescreen workSession kinds", async () => {
  const f = new InMemorySessionFinder()
  const now = Date.now()
  f.add({
    sessionId: "s_other",
    userId: "u1",
    jobId: "j1",
    terminal: "PASS",
    currentQId: null,
    updatedAtMs: now - 5 * 60 * 1000,
    endedAtMs: now - 5 * 60 * 1000,
    workSessionKind: "onboarding",
  })
  const r = await f.findForUser("u1", { nowMs: now })
  assert.equal(r.kind, "none")
})

test("InMemorySessionFinder.findForUser → latest recent_terminal wins when multiple", async () => {
  const f = new InMemorySessionFinder()
  const now = Date.now()
  f.add({
    sessionId: "earlier",
    userId: "u1",
    jobId: "jA",
    terminal: "FAIL",
    currentQId: null,
    updatedAtMs: now - 50 * 60 * 1000,
    endedAtMs: now - 50 * 60 * 1000,
    workSessionKind: "job_prescreen",
  })
  f.add({
    sessionId: "later",
    userId: "u1",
    jobId: "jB",
    terminal: "PASS",
    currentQId: null,
    updatedAtMs: now - 5 * 60 * 1000,
    endedAtMs: now - 5 * 60 * 1000,
    workSessionKind: "job_prescreen",
  })
  const r = await f.findForUser("u1", { nowMs: now })
  assert.equal(r.kind, "recent_terminal")
  if (r.kind === "recent_terminal") assert.equal(r.sessionId, "later")
})

test("InMemorySessionFinder.findForUser → active takes precedence over recent_terminal", async () => {
  const f = new InMemorySessionFinder()
  const now = Date.now()
  f.add({
    sessionId: "ended",
    userId: "u1",
    jobId: "jOld",
    terminal: "PASS",
    currentQId: null,
    updatedAtMs: now - 10 * 60 * 1000,
    endedAtMs: now - 10 * 60 * 1000,
    workSessionKind: "job_prescreen",
  })
  f.add({
    sessionId: "alive",
    userId: "u1",
    jobId: "jNew",
    terminal: null,
    currentQId: "q1",
    updatedAtMs: now - 1 * 60 * 1000,
  })
  const r = await f.findForUser("u1", { nowMs: now })
  assert.equal(r.kind, "active")
  if (r.kind === "active") assert.equal(r.sessionId, "alive")
})

test("InMemorySessionFinder.loadById → null when missing", async () => {
  const f = new InMemorySessionFinder()
  const r = await f.loadById("nope")
  assert.equal(r, null)
})

test("InMemorySessionFinder.loadById → record shape with currentQId + jobId", async () => {
  const f = new InMemorySessionFinder()
  f.add({
    sessionId: "s1",
    userId: "u1",
    jobId: "j1",
    terminal: null,
    currentQId: "q42",
    updatedAtMs: Date.now(),
  })
  const r = await f.loadById("s1")
  assert.ok(r)
  assert.equal(r!.userId, "u1")
  assert.equal(r!.jobId, "j1")
  assert.equal(r!.activeQId, "q42")
  assert.equal(r!.terminal, null)
})

test("InMemorySessionFinder.findForUser → expired side-effect calls log when provided", async () => {
  const f = new InMemorySessionFinder()
  const now = Date.now()
  f.add({
    sessionId: "expire-me",
    userId: "u1",
    jobId: "j1",
    terminal: null,
    currentQId: "q1",
    updatedAtMs: now - ACTIVE_PRESCREEN_TIMEOUT_MS - 1,
  })
  const events: Array<{ event: string; payload: Record<string, unknown> }> = []
  await f.findForUser("u1", {
    nowMs: now,
    log: (event, payload) => events.push({ event, payload }),
  })
  const matched = events.find((e) => e.event === "prescreen.session_finder.expired_inactive")
  assert.ok(matched, "expected expired_inactive log event")
  assert.equal(matched!.payload.sessionId, "expire-me")
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Firestore impl — fake-Firestore spy tests                                  */
/* ────────────────────────────────────────────────────────────────────────── */

interface FakeDoc {
  id: string
  data: () => Record<string, unknown>
  ref: { set: (patch: Record<string, unknown>, opts?: { merge?: boolean }) => Promise<void> }
}

function makeFakeFirestore(docsByCollectionByQuery: {
  activeByUser?: FakeDoc[]
  allByUser?: FakeDoc[]
  byId?: Record<string, FakeDoc | null>
  sets?: Array<{ id: string; patch: Record<string, unknown> }>
}) {
  const sets = docsByCollectionByQuery.sets ?? []
  const collectionFn = (name: string) => {
    if (name !== "pa-prescreen-sessions") throw new Error("unexpected collection " + name)
    return {
      where: (_field: string, _op: string, _value: unknown) => ({
        where: (_f2: string, _op2: string, _v2: unknown) => ({
          get: async () => ({
            empty: (docsByCollectionByQuery.activeByUser ?? []).length === 0,
            docs: docsByCollectionByQuery.activeByUser ?? [],
          }),
        }),
        get: async () => ({
          empty: (docsByCollectionByQuery.allByUser ?? []).length === 0,
          docs: docsByCollectionByQuery.allByUser ?? [],
        }),
      }),
      doc: (id: string) => ({
        get: async () => {
          const d = docsByCollectionByQuery.byId?.[id] ?? null
          return d
            ? { exists: true, data: () => d.data() }
            : { exists: false, data: () => undefined }
        },
        set: async (patch: Record<string, unknown>) => {
          sets.push({ id, patch })
        },
      }),
    }
  }
  return { collection: collectionFn, _sets: sets } as unknown as {
    collection: (n: string) => unknown
    _sets: Array<{ id: string; patch: Record<string, unknown> }>
  }
}

test("FirestoreSessionFinder.findForUser → none when no docs", async () => {
  const fake = makeFakeFirestore({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finder = new FirestoreSessionFinder(fake as any)
  const r = await finder.findForUser("u1")
  assert.equal(r.kind, "none")
})

test("FirestoreSessionFinder.findForUser → active when fresh terminal=null doc", async () => {
  const now = Date.now()
  const fake = makeFakeFirestore({
    activeByUser: [
      {
        id: "s1",
        data: () => ({
          jobId: "j1",
          currentQId: "qA",
          updatedAt: new Date(now - 60_000).toISOString(),
        }),
        ref: { set: async () => {} },
      },
    ],
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finder = new FirestoreSessionFinder(fake as any)
  const r = await finder.findForUser("u1", { nowMs: now })
  assert.equal(r.kind, "active")
  if (r.kind === "active") {
    assert.equal(r.sessionId, "s1")
    assert.equal(r.jobId, "j1")
    assert.equal(r.activeQId, "qA")
  }
})

test("FirestoreSessionFinder.findForUser → expired writes PAUSE patch", async () => {
  const now = Date.now()
  const sets: Array<{ id: string; patch: Record<string, unknown> }> = []
  const fake = makeFakeFirestore({
    activeByUser: [
      {
        id: "stale",
        data: () => ({
          jobId: "j1",
          currentQId: "qA",
          updatedAt: new Date(now - ACTIVE_PRESCREEN_TIMEOUT_MS - 1000).toISOString(),
        }),
        ref: {
          set: async (patch: Record<string, unknown>) => {
            sets.push({ id: "stale", patch })
          },
        },
      },
    ],
    sets,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finder = new FirestoreSessionFinder(fake as any)
  const r = await finder.findForUser("u1", { nowMs: now })
  assert.equal(r.kind, "expired")
  assert.equal(sets.length, 1)
  assert.equal(sets[0]!.patch.terminal, "PAUSE")
  assert.equal(sets[0]!.patch.terminalReason, "expired_inactive_prescreen_session")
})

test("FirestoreSessionFinder.loadById → null when missing", async () => {
  const fake = makeFakeFirestore({ byId: { "missing": null } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finder = new FirestoreSessionFinder(fake as any)
  const r = await finder.loadById("missing")
  assert.equal(r, null)
})

test("FirestoreSessionFinder.loadById → returns record when present", async () => {
  const fake = makeFakeFirestore({
    byId: {
      "exists": {
        id: "exists",
        data: () => ({
          userId: "u1",
          jobId: "j7",
          terminal: null,
          currentQId: "q3",
          postTerminalFollowupAckAt: "2026-05-16T00:00:00.000Z",
        }),
        ref: { set: async () => {} },
      },
    },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finder = new FirestoreSessionFinder(fake as any)
  const r = await finder.loadById("exists")
  assert.ok(r)
  assert.equal(r!.userId, "u1")
  assert.equal(r!.jobId, "j7")
  assert.equal(r!.activeQId, "q3")
  assert.equal(r!.terminal, null)
  assert.equal(r!.postTerminalFollowupAckAt, "2026-05-16T00:00:00.000Z")
})

/* ───────────────────────── zombie-prescreen max-age cap ───────────────────────── */
// Adam 2026-06-21: a non-terminal session whose updatedAt keeps refreshing (clarify loop
// captures unrelated turns) must STILL expire on its createdAt-keyed absolute age cap.

test("isPrescreenSessionPastMaxAge → true past 24h, false within, false on missing createdAt", () => {
  const now = Date.now()
  assert.equal(isPrescreenSessionPastMaxAge(now - ACTIVE_PRESCREEN_MAX_AGE_MS - 1000, now), true)
  assert.equal(isPrescreenSessionPastMaxAge(now - 60 * 60 * 1000, now), false) // 1h old → fresh
  assert.equal(isPrescreenSessionPastMaxAge(null, now), false) // fail-open
})

test("InMemorySessionFinder → expired when createdAt past max-age even though updatedAt is FRESH (zombie)", async () => {
  // Mirrors live +19196415056: createdAt days ago, updatedAt seconds ago (self-refreshed by
  // the clarify loop capturing job-rec replies). The inactivity timeout (updatedAt) would NOT
  // fire; the createdAt cap must.
  const f = new InMemorySessionFinder()
  const now = Date.now()
  f.add({
    sessionId: "ps_zombie",
    userId: "u_zombie",
    jobId: "hs-10996795-invoko-product-manager",
    terminal: null,
    currentQId: "q_consumer_product_experience",
    createdAtMs: now - 3 * 24 * HOUR, // 3 days old
    updatedAtMs: now - 30 * 1000, // refreshed 30s ago by the zombie capture
  })
  const r = await f.findForUser("u_zombie", { nowMs: now })
  assert.equal(r.kind, "expired")
  if (r.kind === "expired") assert.equal(r.sessionId, "ps_zombie")
  const loaded = await f.loadById("ps_zombie")
  assert.equal(loaded?.terminal, "PAUSE")
  assert.equal(loaded?.activeQId, null)
})

test("InMemorySessionFinder → still ACTIVE when both createdAt and updatedAt are recent (no regression)", async () => {
  const f = new InMemorySessionFinder()
  const now = Date.now()
  f.add({
    sessionId: "ps_live",
    userId: "u_live",
    jobId: "j1",
    terminal: null,
    currentQId: "q1",
    createdAtMs: now - 10 * 60 * 1000, // 10min ago — a real sitting
    updatedAtMs: now - 30 * 1000,
  })
  const r = await f.findForUser("u_live", { nowMs: now })
  assert.equal(r.kind, "active")
  if (r.kind === "active") assert.equal(r.sessionId, "ps_live")
})
