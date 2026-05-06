/**
 * iter34 Sprint A.6 — tests for pollParsedCandidateResume + isCvDocUsable.
 *
 * Coverage:
 *   - doc already exists → returns on first poll
 *   - doc shows up after N polls (virtual time) → returns when found
 *   - timeout → returns {cv: null, timedOut: true}
 *   - bare doc (no fields) treated as "still parsing", keeps polling
 *   - Firestore query throws → keeps polling, doesn't bail
 *   - missing db → instant timeout, no poll
 *   - isCvDocUsable: detects topSkills / industryTags / experiences /
 *     candidateProfile.skills correctly
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  isCvDocUsable,
  pollParsedCandidateResume,
} from "./cv-poll.js"
import type { CvSummaryInput } from "../cv-summary.js"

// ---------- Fake Firestore ---------------------------------------------------

type DocSnap = { data: () => unknown }

interface FakeDbOpts {
  /**
   * Sequence of "what's in the collection" snapshots, one per get() call.
   * If the test runs more polls than provided snapshots, the LAST snapshot
   * is reused.
   */
  snapshots: Array<{ docs: unknown[] }>
  /** If set, the Nth get() call (1-indexed) throws. */
  throwOnCall?: number
}

function makeFakeDb(opts: FakeDbOpts) {
  let getCalls = 0
  const queryShape = {
    where(_field: string, _op: string, _val: unknown) {
      return this
    },
    orderBy(_field: string, _dir: string) {
      return this
    },
    limit(_n: number) {
      return this
    },
    async get() {
      getCalls++
      if (opts.throwOnCall && opts.throwOnCall === getCalls) {
        throw new Error("firestore unavailable")
      }
      const idx = Math.min(getCalls - 1, opts.snapshots.length - 1)
      const docs = opts.snapshots[idx]?.docs ?? []
      const snapDocs: DocSnap[] = docs.map((d) => ({ data: () => d }))
      return { empty: snapDocs.length === 0, docs: snapDocs }
    },
  }
  const db = {
    collection(_name: string) {
      return queryShape
    },
  }
  return { db, getCallCount: () => getCalls }
}

// ---------- Virtual clock ----------------------------------------------------

/**
 * Tracks "wall-clock now" advanced by injected sleep calls. Lets tests
 * precisely control the timeoutMs comparison without using real timers.
 */
function makeClock() {
  let t = 1_000_000 // start at a non-zero baseline
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

const FULL_CV: CvSummaryInput = {
  topSkills: ["TypeScript", "Firestore"],
  experiences: [{ company: "WeKruit", title: "Founder" }],
}

// ---------- isCvDocUsable ----------------------------------------------------

describe("isCvDocUsable", () => {
  it("doc with topSkills → usable", () => {
    assert.equal(isCvDocUsable({ topSkills: ["A"] }), true)
  })
  it("doc with industryTags → usable", () => {
    assert.equal(isCvDocUsable({ industryTags: ["fintech"] }), true)
  })
  it("doc with experiences → usable", () => {
    assert.equal(isCvDocUsable({ experiences: [{ company: "X" }] }), true)
  })
  it("doc with only candidateProfile.skills → usable", () => {
    assert.equal(
      isCvDocUsable({ candidateProfile: { skills: ["Python"] } }),
      true
    )
  })
  it("bare doc (all empty arrays) → NOT usable, keep polling", () => {
    assert.equal(
      isCvDocUsable({ topSkills: [], industryTags: [], experiences: [] }),
      false
    )
  })
  it("empty doc {} → NOT usable", () => {
    assert.equal(isCvDocUsable({}), false)
  })
  it("null → NOT usable", () => {
    assert.equal(isCvDocUsable(null), false)
  })
  it("doc with only candidateProfile.name (no skills) → NOT usable", () => {
    // Just having a name isn't signal; we want skills/exp/tags.
    assert.equal(isCvDocUsable({ candidateProfile: { name: "x" } }), false)
  })
})

// ---------- pollParsedCandidateResume ----------------------------------------

describe("pollParsedCandidateResume", () => {
  it("doc exists on first poll → returns immediately", async () => {
    const { db, getCallCount } = makeFakeDb({
      snapshots: [{ docs: [FULL_CV] }],
    })
    const clock = makeClock()
    const out = await pollParsedCandidateResume(db, "user_a", {
      intervalMs: 5_000,
      timeoutMs: 90_000,
      sleep: clock.sleep,
      now: clock.now,
    })
    assert.equal(out.timedOut, false)
    assert.deepEqual(out.cv, FULL_CV)
    assert.equal(out.attempts, 1)
    assert.equal(getCallCount(), 1)
  })

  it("doc shows up after several polls → returns when found", async () => {
    // Empty for first 3 polls, then full CV on poll #4.
    const { db, getCallCount } = makeFakeDb({
      snapshots: [
        { docs: [] },
        { docs: [] },
        { docs: [] },
        { docs: [FULL_CV] },
      ],
    })
    const clock = makeClock()
    const out = await pollParsedCandidateResume(db, "user_b", {
      intervalMs: 5_000,
      timeoutMs: 90_000,
      sleep: clock.sleep,
      now: clock.now,
    })
    assert.equal(out.timedOut, false)
    assert.deepEqual(out.cv, FULL_CV)
    assert.equal(out.attempts, 4)
    assert.equal(getCallCount(), 4)
  })

  it("timeout — doc never lands → {cv: null, timedOut: true}", async () => {
    const { db, getCallCount } = makeFakeDb({
      snapshots: [{ docs: [] }],
    })
    const clock = makeClock()
    const out = await pollParsedCandidateResume(db, "user_c", {
      intervalMs: 5_000,
      timeoutMs: 90_000,
      sleep: clock.sleep,
      now: clock.now,
    })
    assert.equal(out.timedOut, true)
    assert.equal(out.cv, null)
    // 90_000 / 5_000 = 18 sleeps + 1 final attempt that exits → ~19 attempts
    // (the loop attempts at start of iteration, then sleeps; on the iteration
    // where elapsed >= timeout we exit before sleeping).
    assert.ok(out.attempts >= 18 && out.attempts <= 20, `expected ~19 attempts, got ${out.attempts}`)
    assert.equal(getCallCount(), out.attempts)
  })

  it("bare placeholder doc (empty fields) → keeps polling, eventually times out", async () => {
    // Doc exists every poll, but with empty fields = "still parsing".
    const { db } = makeFakeDb({
      snapshots: [{ docs: [{ topSkills: [], experiences: [] }] }],
    })
    const clock = makeClock()
    const out = await pollParsedCandidateResume(db, "user_d", {
      intervalMs: 5_000,
      timeoutMs: 30_000,
      sleep: clock.sleep,
      now: clock.now,
    })
    assert.equal(out.timedOut, true)
    assert.equal(out.cv, null)
  })

  it("Firestore query throws → keeps polling, recovers when doc lands", async () => {
    // Throw on call #1, empty on #2, full on #3.
    const { db } = makeFakeDb({
      snapshots: [{ docs: [] }, { docs: [] }, { docs: [FULL_CV] }],
      throwOnCall: 1,
    })
    const clock = makeClock()
    const out = await pollParsedCandidateResume(db, "user_e", {
      intervalMs: 5_000,
      timeoutMs: 90_000,
      sleep: clock.sleep,
      now: clock.now,
    })
    assert.equal(out.timedOut, false)
    assert.deepEqual(out.cv, FULL_CV)
    assert.equal(out.attempts, 3)
  })

  it("no db (undefined) → instant timeout, zero attempts", async () => {
    const out = await pollParsedCandidateResume(undefined, "user_f", {
      intervalMs: 5_000,
      timeoutMs: 90_000,
    })
    assert.equal(out.timedOut, true)
    assert.equal(out.cv, null)
    assert.equal(out.attempts, 0)
  })

  it("doc lands at exactly the timeout boundary → still returned (don't oversleep past it)", async () => {
    // Configure: empty for 17 polls, then full on poll #18 (right at 85s).
    // This pins the "clamp wait so we exit cleanly" path.
    const snapshots: Array<{ docs: unknown[] }> = []
    for (let i = 0; i < 17; i++) snapshots.push({ docs: [] })
    snapshots.push({ docs: [FULL_CV] })
    const { db } = makeFakeDb({ snapshots })
    const clock = makeClock()
    const out = await pollParsedCandidateResume(db, "user_g", {
      intervalMs: 5_000,
      timeoutMs: 90_000,
      sleep: clock.sleep,
      now: clock.now,
    })
    assert.equal(out.timedOut, false)
    assert.deepEqual(out.cv, FULL_CV)
    assert.equal(out.attempts, 18)
  })

  it("custom intervalMs/timeoutMs respected", async () => {
    const { db } = makeFakeDb({ snapshots: [{ docs: [] }] })
    const clock = makeClock()
    const out = await pollParsedCandidateResume(db, "user_h", {
      intervalMs: 1_000,
      timeoutMs: 10_000,
      sleep: clock.sleep,
      now: clock.now,
    })
    assert.equal(out.timedOut, true)
    // 10_000 / 1_000 = 10 sleeps. Attempts ≈ 10-11.
    assert.ok(out.attempts >= 10 && out.attempts <= 11, `expected ~10 attempts, got ${out.attempts}`)
  })
})
