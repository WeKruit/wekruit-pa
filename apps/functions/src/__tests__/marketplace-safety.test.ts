/**
 * Marketplace SAFETY suite — deterministic, $0 coverage of three product
 * invariants that previously had NO automated test (CLAUDE.md v2.0 §"Layer 5:
 * safety / privacy eval", non-negotiable rules #5/#6 + "no PII before consent"):
 *
 *   A. Employer-cannot-see-non-passed — the employer/admin passed-candidate
 *      read surface (runAdminPassedCandidatesSnapshot) returns ONLY candidates
 *      whose candidate↔job state is passed / employer_visible. not_passed /
 *      paused / interested candidates must never surface.
 *
 *   B. No PII before consent — the passed-candidate read marks a candidate's
 *      consentStatus = "missing" when no PII consent exists, and the
 *      transcript / free-text redaction seam (redactPassedCandidateText) strips
 *      email / phone / linkedin / storage-locator / resume PII from any text
 *      surfaced to the employer.
 *
 *   C. Cross-user PII / memory isolation — the Mem0 partition-key resolver
 *      (resolveMem0PartitionKey) gives every user a DISTINCT namespace (so one
 *      user's memory can never be queried under another's key), and the
 *      passed-candidate read is scoped per (jobId, candidateId) so one
 *      candidate's snapshot / profile / transcript never bleeds into another's
 *      employer row.
 *
 * All three drive REAL production seams. Runs in the functions suite.
 */

import test from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  CandidateJobStateDocSchema,
  EmployerVisibleProfileSchema,
  createCandidateJobStateId,
  createEmployerVisibleProfileId,
  type CandidateJobState,
} from "@pa/core-types"
import { resolveMem0PartitionKey } from "@pa/memory"
import {
  runAdminPassedCandidatesSnapshot,
  redactPassedCandidateText,
} from "../admin-passed-candidates.js"

// ---------------------------------------------------------------------------
// Fake Firestore: collection().where().limit().get(), doc().get(),
// doc().collection().orderBy().limit().get() (for transcript turns).
// ---------------------------------------------------------------------------

class FakeColl {
  constructor(
    private store: Map<string, Map<string, Record<string, unknown>>>,
    private name: string,
    private filters: Array<{ field: string; value: unknown }> = [],
    private orderField?: string,
    private lim = 0,
  ) {}

  private col() {
    if (!this.store.has(this.name)) this.store.set(this.name, new Map())
    return this.store.get(this.name)!
  }

  where(field: string, _op: string, value: unknown): FakeColl {
    return new FakeColl(this.store, this.name, [...this.filters, { field, value }], this.orderField, this.lim)
  }
  orderBy(field: string): FakeColl {
    return new FakeColl(this.store, this.name, this.filters, field, this.lim)
  }
  limit(n: number): FakeColl {
    return new FakeColl(this.store, this.name, this.filters, this.orderField, n)
  }
  doc(id: string) {
    const store = this.store
    const name = this.name
    return {
      id,
      collection(sub: string) {
        return new FakeColl(store, `${name}/${id}/${sub}`)
      },
      async get() {
        const data = (store.get(name) ?? new Map()).get(id)
        return { exists: data !== undefined, id, data: () => data }
      },
      async set(data: Record<string, unknown>) {
        if (!store.has(name)) store.set(name, new Map())
        store.get(name)!.set(id, { ...data })
      },
    }
  }
  async get() {
    let rows = [...this.col().entries()].filter(([, v]) =>
      this.filters.every((f) => v[f.field] === f.value),
    )
    if (this.orderField) {
      const f = this.orderField
      rows.sort(([, a], [, b]) => String(a[f] ?? "").localeCompare(String(b[f] ?? "")))
    }
    if (this.lim > 0) rows = rows.slice(0, this.lim)
    return {
      docs: rows.map(([id, v]) => ({ id, exists: true, data: () => ({ ...v }) })),
      size: rows.length,
      empty: rows.length === 0,
    }
  }
}

class FakeDb {
  store = new Map<string, Map<string, Record<string, unknown>>>()
  collection(name: string) {
    return new FakeColl(this.store, name)
  }
  _set(name: string, id: string, data: Record<string, unknown>) {
    if (!this.store.has(name)) this.store.set(name, new Map())
    this.store.get(name)!.set(id, data)
  }
}

const asFirestore = (db: FakeDb): Firestore => db as unknown as Firestore

const NOW = "2026-05-29T12:00:00.000Z"
const JOB_ID = "job-safety-1"

/** Seed a candidate↔job state + (optional) employer-visible snapshot. */
function seedCandidate(
  db: FakeDb,
  candidateId: string,
  state: CandidateJobState,
  opts: { withSnapshot?: boolean; consent?: boolean; displayName?: string; resumeSummary?: string } = {},
) {
  const stateId = createCandidateJobStateId(candidateId, JOB_ID)
  db._set(
    PA_COLLECTIONS.candidateJobStates,
    stateId,
    CandidateJobStateDocSchema.parse({
      id: stateId,
      candidateId,
      jobId: JOB_ID,
      state,
      stateUpdatedAt: NOW,
    }) as unknown as Record<string, unknown>,
  )
  // EmployerVisibleProfile can ONLY be createdFromState:"passed" (schema literal),
  // so a snapshot is seeded only for passed/employer_visible candidates.
  if (opts.withSnapshot) {
    const snapshotId = createEmployerVisibleProfileId(JOB_ID, candidateId)
    db._set(
      PA_COLLECTIONS.employerVisibleProfiles,
      snapshotId,
      EmployerVisibleProfileSchema.parse({
        snapshotId,
        candidateId,
        jobId: JOB_ID,
        candidateJobStateId: stateId,
        createdFromState: "passed",
        ...(opts.displayName ? { displayName: opts.displayName } : {}),
        ...(opts.resumeSummary ? { resumeSummary: opts.resumeSummary } : {}),
        ...(opts.consent ? { consentAt: NOW, piiConsentAt: NOW } : {}),
        createdAt: NOW,
      }) as unknown as Record<string, unknown>,
    )
  }
}

// ===========================================================================
// A. Employer-cannot-see-non-passed
// ===========================================================================

test("safety A: employer read surfaces ONLY passed / employer_visible candidates", async () => {
  const db = new FakeDb()
  seedCandidate(db, "cand-passed", "passed", { withSnapshot: true, displayName: "Pat Passed" })
  seedCandidate(db, "cand-empvis", "employer_visible", { withSnapshot: true, displayName: "Eve Visible" })
  // Non-passed candidates — seed states but NO employer-visible snapshot
  // (the schema forbids a non-"passed" snapshot anyway).
  seedCandidate(db, "cand-notpassed", "not_passed")
  seedCandidate(db, "cand-paused", "paused")
  seedCandidate(db, "cand-interested", "candidate_interested")

  const snap = await runAdminPassedCandidatesSnapshot({ jobId: JOB_ID }, { db: asFirestore(db), now: () => NOW })
  const surfaced = snap.rows.map((r) => r.candidateId).sort()
  assert.deepEqual(surfaced, ["cand-empvis", "cand-passed"])
  for (const r of snap.rows) assert.ok(r.state === "passed" || r.state === "employer_visible")
})

test("safety A: a not_passed candidate with a STALE 'passed' snapshot is dropped on state mismatch", async () => {
  const db = new FakeDb()
  // Snapshot exists (createdFromState passed) but the live candidate↔job state
  // has since reverted to not_passed → must be dropped (stateMismatch), never
  // shown to the employer.
  seedCandidate(db, "cand-reverted", "not_passed", { withSnapshot: true, displayName: "Stale Snap" })
  const snap = await runAdminPassedCandidatesSnapshot({ jobId: JOB_ID }, { db: asFirestore(db), now: () => NOW })
  assert.equal(snap.rows.length, 0)
  assert.equal(snap.summary.droppedStateMismatch, 1)
})

test("safety A: employer read is scoped to the requested jobId only", async () => {
  const db = new FakeDb()
  seedCandidate(db, "cand-thisjob", "passed", { withSnapshot: true })
  // A passed candidate for a DIFFERENT job must not leak into this job's view.
  const otherJobStateId = createCandidateJobStateId("cand-otherjob", "job-other")
  db._set(
    PA_COLLECTIONS.candidateJobStates,
    otherJobStateId,
    CandidateJobStateDocSchema.parse({
      id: otherJobStateId,
      candidateId: "cand-otherjob",
      jobId: "job-other",
      state: "passed",
      stateUpdatedAt: NOW,
    }) as unknown as Record<string, unknown>,
  )
  const otherSnapId = createEmployerVisibleProfileId("job-other", "cand-otherjob")
  db._set(
    PA_COLLECTIONS.employerVisibleProfiles,
    otherSnapId,
    EmployerVisibleProfileSchema.parse({
      snapshotId: otherSnapId,
      candidateId: "cand-otherjob",
      jobId: "job-other",
      candidateJobStateId: otherJobStateId,
      createdFromState: "passed",
      createdAt: NOW,
    }) as unknown as Record<string, unknown>,
  )

  const snap = await runAdminPassedCandidatesSnapshot({ jobId: JOB_ID }, { db: asFirestore(db), now: () => NOW })
  const surfaced = snap.rows.map((r) => r.candidateId)
  assert.deepEqual(surfaced, ["cand-thisjob"])
  assert.ok(!surfaced.includes("cand-otherjob"))
})

// ===========================================================================
// B. No PII before consent
// ===========================================================================

test("safety B: consentStatus = 'missing' for a passed candidate with no PII consent", async () => {
  const db = new FakeDb()
  seedCandidate(db, "cand-noconsent", "passed", { withSnapshot: true, displayName: "No Consent", consent: false })
  const snap = await runAdminPassedCandidatesSnapshot({ jobId: JOB_ID }, { db: asFirestore(db), now: () => NOW })
  assert.equal(snap.rows.length, 1)
  assert.equal(snap.rows[0]!.profile.consentStatus, "missing")
  assert.equal(snap.summary.missingConsent, 1)
  assert.equal(snap.summary.withConsent, 0)
})

test("safety B: consentStatus = 'granted' only when consent timestamp present", async () => {
  const db = new FakeDb()
  seedCandidate(db, "cand-consent", "passed", { withSnapshot: true, displayName: "Has Consent", consent: true })
  const snap = await runAdminPassedCandidatesSnapshot({ jobId: JOB_ID }, { db: asFirestore(db), now: () => NOW })
  assert.equal(snap.rows[0]!.profile.consentStatus, "granted")
  assert.equal(snap.summary.withConsent, 1)
})

test("safety B: redaction strips email / phone / linkedin / storage / resume PII from employer-visible text", () => {
  const dirty =
    "Reach me at jane.doe@example.com or +1 (415) 555-2671. " +
    "Profile: https://www.linkedin.com/in/jane-doe and resume at " +
    "gs://wekruit-resumes/jane.pdf — handle @janedoe."
  const clean = redactPassedCandidateText(dirty)
  assert.ok(!/jane\.doe@example\.com/.test(clean), "email redacted")
  assert.ok(!/415.*555.*2671/.test(clean), "phone redacted")
  assert.ok(!/linkedin\.com\/in\/jane-doe/.test(clean), "linkedin redacted")
  assert.ok(!/gs:\/\/wekruit-resumes/.test(clean), "storage locator redacted")
  assert.ok(clean.includes("[redacted email]"))
  assert.ok(clean.includes("[redacted phone]"))
})

test("safety B: transcript turns surfaced to employer are PII-redacted", async () => {
  const db = new FakeDb()
  const candidateId = "cand-transcript"
  const stateId = createCandidateJobStateId(candidateId, JOB_ID)
  // passed state with a prescreen session whose turns carry raw PII.
  db._set(
    PA_COLLECTIONS.candidateJobStates,
    stateId,
    CandidateJobStateDocSchema.parse({
      id: stateId,
      candidateId,
      jobId: JOB_ID,
      state: "passed",
      stateUpdatedAt: NOW,
      prescreenSessionId: "sess-1",
    }) as unknown as Record<string, unknown>,
  )
  const snapshotId = createEmployerVisibleProfileId(JOB_ID, candidateId)
  db._set(
    PA_COLLECTIONS.employerVisibleProfiles,
    snapshotId,
    EmployerVisibleProfileSchema.parse({
      snapshotId,
      candidateId,
      jobId: JOB_ID,
      candidateJobStateId: stateId,
      createdFromState: "passed",
      sourcePrescreenSessionId: "sess-1",
      createdAt: NOW,
    }) as unknown as Record<string, unknown>,
  )
  db._set("pa-prescreen-sessions/sess-1/turns", "t1", {
    id: "t1",
    reply: "Sure, my email is leak@example.com and phone +14155550000",
    ts: NOW,
  })

  const snap = await runAdminPassedCandidatesSnapshot({ jobId: JOB_ID }, { db: asFirestore(db), now: () => NOW })
  const turns = snap.rows[0]!.transcript.turns
  assert.equal(turns.length, 1)
  assert.ok(!/leak@example\.com/.test(turns[0]!.body), "transcript email redacted")
  assert.ok(!/4155550000/.test(turns[0]!.body), "transcript phone redacted")
})

// ===========================================================================
// C. Cross-user PII / memory isolation
// ===========================================================================

test("safety C: distinct users get DISTINCT mem0 partition keys (no cross-user namespace collision)", () => {
  const keyA = resolveMem0PartitionKey({ id: "user-a" })
  const keyB = resolveMem0PartitionKey({ id: "user-b" })
  assert.notEqual(keyA, keyB)
  assert.equal(keyA, "user-a")
  assert.equal(keyB, "user-b")
})

test("safety C: mem0UserId rebind never collapses two users onto one key", () => {
  // Even after an operator rebind, user A's resolved key must differ from B's.
  const keyA = resolveMem0PartitionKey({ id: "user-a", mem0UserId: "rebound-a" })
  const keyB = resolveMem0PartitionKey({ id: "user-b", mem0UserId: "rebound-b" })
  assert.equal(keyA, "rebound-a")
  assert.equal(keyB, "rebound-b")
  assert.notEqual(keyA, keyB)
  // Blank / whitespace mem0UserId falls back to the canonical id (not "").
  assert.equal(resolveMem0PartitionKey({ id: "user-c", mem0UserId: "  " }), "user-c")
  assert.equal(resolveMem0PartitionKey({ id: "user-d", mem0UserId: null }), "user-d")
})

test("safety C: a corrupt (id-less) user is REJECTED, never silently routed into shared memory", () => {
  // Empty-string id is type-valid but a runtime corruption signal → must throw.
  assert.throws(() => resolveMem0PartitionKey({ id: "" }), /user\.id is required/)
  // @ts-expect-error intentional bad input
  assert.throws(() => resolveMem0PartitionKey({}), /user\.id is required/)
})

test("safety C: employer read never bleeds one candidate's profile/snapshot into another's row", async () => {
  const db = new FakeDb()
  seedCandidate(db, "cand-alice", "passed", { withSnapshot: true, displayName: "Alice", resumeSummary: "Alice resume" })
  seedCandidate(db, "cand-bob", "passed", { withSnapshot: true, displayName: "Bob", resumeSummary: "Bob resume" })
  const snap = await runAdminPassedCandidatesSnapshot({ jobId: JOB_ID }, { db: asFirestore(db), now: () => NOW })
  const byId = new Map(snap.rows.map((r) => [r.candidateId, r]))
  assert.equal(byId.get("cand-alice")!.displayName, "Alice")
  assert.equal(byId.get("cand-alice")!.resumeSummary, "Alice resume")
  assert.equal(byId.get("cand-bob")!.displayName, "Bob")
  assert.equal(byId.get("cand-bob")!.resumeSummary, "Bob resume")
  // Each row's snapshot/candidateJobState ids are self-consistent (no swap).
  for (const r of snap.rows) {
    assert.equal(r.snapshotId, createEmployerVisibleProfileId(JOB_ID, r.candidateId))
    assert.equal(r.candidateJobStateId, createCandidateJobStateId(r.candidateId, JOB_ID))
  }
})
