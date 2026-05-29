/**
 * Flywheel HITL → regression replay — unit tests.
 *
 * Proves the loop is CLOSED end-to-end and offline ($0):
 *   1. a human correction is materialized into a `pa-eval-artifacts` doc via
 *      the REAL producer (`materializeEvalArtifactForCorrection`);
 *   2. the replay harness reads it back and replays it through the relevant
 *      PRODUCTION seam (applyPartialUserTags / scoreCandidateForJob /
 *      structural), asserting the corrected expectation still holds;
 *   3. counts are HONEST — a deliberately-broken expectation yields a `fail`,
 *      a structurally-empty correction yields `skipped`, and write-back
 *      records `latestRunResult`.
 *
 * Run via the functions suite (src/__tests__/*.test.ts).
 */

import test from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import {
  CorrectionEventSchema,
  EvalArtifactSchema,
  PA_COLLECTIONS,
  type CorrectionEvent,
} from "@pa/core-types"
import { materializeEvalArtifactForCorrection } from "../flywheel-eval.js"
import { runFlywheelRegressionReplay } from "../flywheel-regression-replay.js"

// ---------------------------------------------------------------------------
// Minimal in-memory Firestore (collection().doc().get/set + orderBy/limit/get).
// ---------------------------------------------------------------------------

class FakeDb {
  /** @type {Map<string, Map<string, Record<string, unknown>>>} */
  store = new Map<string, Map<string, Record<string, unknown>>>()

  _col(name: string): Map<string, Record<string, unknown>> {
    if (!this.store.has(name)) this.store.set(name, new Map())
    return this.store.get(name)!
  }

  collection(name: string): FakeColl {
    return new FakeColl(this, name)
  }
}

class FakeColl {
  constructor(
    private db: FakeDb,
    private name: string,
    private filters: Array<{ field: string; op: string; value: unknown }> = [],
    private orderField?: string,
    private orderDir: "asc" | "desc" = "asc",
    private lim = 0,
  ) {}

  doc(id: string) {
    const db = this.db
    const name = this.name
    return {
      id,
      collection(sub: string) {
        return new FakeColl(db, `${name}/${id}/${sub}`)
      },
      async get() {
        const data = db._col(name).get(id)
        return { exists: data !== undefined, id, data: () => data }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const cur = db._col(name).get(id)
        db._col(name).set(id, opts?.merge && cur ? { ...cur, ...data } : { ...data })
      },
    }
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): FakeColl {
    return new FakeColl(this.db, this.name, this.filters, field, dir, this.lim)
  }

  limit(n: number): FakeColl {
    return new FakeColl(this.db, this.name, this.filters, this.orderField, this.orderDir, n)
  }

  async get() {
    let rows = [...this.db._col(this.name).entries()]
    if (this.orderField) {
      const f = this.orderField
      rows.sort(([, a], [, b]) => {
        const av = String(a[f] ?? "")
        const bv = String(b[f] ?? "")
        return this.orderDir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv)
      })
    }
    if (this.lim > 0) rows = rows.slice(0, this.lim)
    return {
      docs: rows.map(([id, v]) => ({ id, exists: true, data: () => ({ ...v }) })),
      size: rows.length,
      empty: rows.length === 0,
    }
  }
}

function asFirestore(db: FakeDb): Firestore {
  return db as unknown as Firestore
}

// ---------------------------------------------------------------------------
// Seed a correction → artifact via the REAL producer.
// ---------------------------------------------------------------------------

async function seedCorrectionArtifact(
  db: FakeDb,
  correctionInput: Partial<CorrectionEvent> & Pick<CorrectionEvent, "eventId" | "targetType" | "targetId" | "actor" | "reason">,
  kind?: "correction_regression_fixture" | "candidate_profile_correction",
) {
  const correction = CorrectionEventSchema.parse({
    beforeRedacted: {},
    afterRedacted: {},
    evidence: [],
    createdAt: NOW,
    ...correctionInput,
  })
  // For correction-derived artifacts the producer drops before/after into
  // payloadRedacted.{beforeRedacted,afterRedacted}; pass them through so the
  // replay has the corrected expectation to assert.
  const artifact = materializeEvalArtifactForCorrection({
    correction,
    kind,
    payloadRedacted: {
      targetType: correction.targetType,
      targetId: correction.targetId,
      beforeRedacted: correction.beforeRedacted,
      afterRedacted: correction.afterRedacted,
      ...(correction.targetType === "candidate_job_state" || correction.targetType === "candidate_job_match"
        ? {}
        : {
            changedFieldKeys: Array.from(
              new Set([...Object.keys(correction.beforeRedacted), ...Object.keys(correction.afterRedacted)]),
            ).sort(),
          }),
    },
  })
  // Validate it really is a schema-valid, PII-safe artifact (producer contract).
  EvalArtifactSchema.parse(artifact)
  await db.collection(PA_COLLECTIONS.evalArtifacts).doc(artifact.artifactId).set(artifact as unknown as Record<string, unknown>)
  return artifact
}

const NOW = "2026-05-29T12:00:00.000Z"

// ---------------------------------------------------------------------------
// user_tags / candidate_profile seam
// ---------------------------------------------------------------------------

test("replay: user_tags correction PASSES when corrected fields persist through applyPartialUserTags", async () => {
  const db = new FakeDb()
  await seedCorrectionArtifact(db, {
    eventId: "corr_user_tags_pass",
    targetType: "user_tags",
    targetId: "cand-1",
    actor: "operator",
    candidateId: "cand-1",
    reason: "candidate is actually a backend SWE not data analyst",
    beforeRedacted: { targetRoleFunction: ["data_analysis"], careerStage: "entry_level" },
    afterRedacted: { targetRoleFunction: ["software_engineering"], careerStage: "mid_level", skills: ["python", "go"] },
  })

  const report = await runFlywheelRegressionReplay({}, { db: asFirestore(db), now: () => NOW })
  assert.equal(report.counts.replayable, 1)
  assert.equal(report.counts.pass, 1)
  assert.equal(report.counts.fail, 0)
  assert.equal(report.ok, true)
  const r = report.results[0]!
  assert.equal(r.seam, "user_tags")
  assert.equal(r.verdict, "pass")
})

test("replay: candidate_profile correction routes to user_tags seam and passes", async () => {
  const db = new FakeDb()
  await seedCorrectionArtifact(
    db,
    {
      eventId: "corr_profile_pass",
      targetType: "candidate_profile",
      targetId: "cand-2",
      actor: "candidate",
      candidateId: "cand-2",
      reason: "I want NYC + remote only and need sponsorship",
      beforeRedacted: {},
      afterRedacted: { targetLocations: ["new_york_city", "remote_us"], visaStatus: "sponsor_needed" },
    },
    "candidate_profile_correction",
  )

  const report = await runFlywheelRegressionReplay({}, { db: asFirestore(db), now: () => NOW })
  assert.equal(report.counts.replayable, 1)
  assert.equal(report.results[0]!.seam, "user_tags")
  assert.equal(report.results[0]!.verdict, "pass")
})

test("replay: empty afterRedacted user_tags correction is SKIPPED (honest, not a silent pass)", async () => {
  const db = new FakeDb()
  await seedCorrectionArtifact(db, {
    eventId: "corr_user_tags_empty",
    targetType: "user_tags",
    targetId: "cand-3",
    actor: "operator",
    candidateId: "cand-3",
    reason: "no structured change",
    beforeRedacted: { targetRoleFunction: ["software_engineering"] },
    afterRedacted: {},
  })

  const report = await runFlywheelRegressionReplay({}, { db: asFirestore(db), now: () => NOW })
  assert.equal(report.counts.skipped, 1)
  assert.equal(report.counts.pass, 0)
  assert.equal(report.counts.fail, 0)
  assert.equal(report.results[0]!.verdict, "skipped")
})

// ---------------------------------------------------------------------------
// candidate_job_match seam
// ---------------------------------------------------------------------------

test("replay: candidate_job_match correction PASSES when scoring reproduces corrected direction", async () => {
  const db = new FakeDb()
  // Operator says: this strong frontend SWE SHOULD surface for this SWE job
  // (corrected expectation: hardFilterResult=pass, shouldSurface=true).
  await seedCorrectionArtifact(db, {
    eventId: "corr_match_pass",
    targetType: "candidate_job_match",
    targetId: "cjm-1",
    actor: "operator",
    candidateId: "cand-fe",
    jobId: "job-fe",
    reason: "this candidate is a clear fit, should be activatable",
    beforeRedacted: {},
    afterRedacted: {
      hardFilterResult: "pass",
      shouldSurface: true,
      job: {
        id: "job-fe",
        roleFunction: ["software_engineering"],
        requiredSkills: ["typescript", "react"],
        locationBuckets: ["san_francisco_bay_area"],
        seniorityLevel: "mid_level",
        jobType: "full_time",
        sponsorship: true,
        atsApplyUrl: "https://boards.greenhouse.io/co/job-fe",
        firstSeenAt: "2026-05-27T00:00:00.000Z",
      },
      candidateTags: {
        skills: ["typescript", "react", "javascript"],
        targetRoleFunction: ["software_engineering"],
        targetLocations: ["san_francisco_bay_area"],
        careerStage: "mid_level",
        targetJobType: ["full_time"],
        visaStatus: "citizen",
      },
    },
  })

  const report = await runFlywheelRegressionReplay({}, { db: asFirestore(db), now: () => NOW })
  assert.equal(report.results[0]!.seam, "candidate_job_match")
  assert.equal(report.results[0]!.verdict, "pass", report.results[0]!.summary)
})

test("replay: candidate_job_match correction FAILS honestly when scoring contradicts corrected direction", async () => {
  const db = new FakeDb()
  // Corrected expectation claims a role-mismatched candidate should surface,
  // but the production hard filter blocks role_mismatch → replay must FAIL.
  await seedCorrectionArtifact(db, {
    eventId: "corr_match_fail",
    targetType: "candidate_job_match",
    targetId: "cjm-2",
    actor: "operator",
    candidateId: "cand-mk",
    jobId: "job-fe",
    reason: "(deliberately wrong) marketer should surface for SWE job",
    beforeRedacted: {},
    afterRedacted: {
      hardFilterResult: "pass",
      shouldSurface: true,
      job: {
        id: "job-fe",
        roleFunction: ["software_engineering"],
        requiredSkills: ["typescript", "react"],
        locationBuckets: ["san_francisco_bay_area"],
        seniorityLevel: "mid_level",
        jobType: "full_time",
        sponsorship: true,
        atsApplyUrl: "https://boards.greenhouse.io/co/job-fe",
        firstSeenAt: "2026-05-27T00:00:00.000Z",
      },
      candidateTags: {
        skills: ["seo", "content_marketing"],
        targetRoleFunction: ["marketing"],
        targetLocations: ["los_angeles"],
        careerStage: "mid_level",
        targetJobType: ["full_time"],
        visaStatus: "citizen",
      },
    },
  })

  const report = await runFlywheelRegressionReplay({}, { db: asFirestore(db), now: () => NOW })
  assert.equal(report.results[0]!.verdict, "fail", report.results[0]!.summary)
  assert.equal(report.counts.fail, 1)
  assert.equal(report.ok, false)
})

test("replay: candidate_job_match with no reconstructable inputs is SKIPPED", async () => {
  const db = new FakeDb()
  await seedCorrectionArtifact(db, {
    eventId: "corr_match_skip",
    targetType: "candidate_job_state",
    targetId: "cjs-1",
    actor: "system",
    candidateId: "cand-x",
    jobId: "job-x",
    reason: "state nudge with no structured scoring inputs",
    beforeRedacted: { state: "outbound_queued" },
    afterRedacted: { state: "candidate_interested" },
  })

  const report = await runFlywheelRegressionReplay({}, { db: asFirestore(db), now: () => NOW })
  assert.equal(report.results[0]!.seam, "candidate_job_match")
  assert.equal(report.results[0]!.verdict, "skipped")
})

// ---------------------------------------------------------------------------
// structural seam (job_tags / outbound_copy / agent_ranking_result / ...)
// ---------------------------------------------------------------------------

test("replay: job_tags correction routes to structural seam and passes when corrected value present", async () => {
  const db = new FakeDb()
  await seedCorrectionArtifact(db, {
    eventId: "corr_job_tags",
    targetType: "job_tags",
    targetId: "job-9",
    actor: "operator",
    jobId: "job-9",
    reason: "industry should be fintech not generic software",
    beforeRedacted: { industrySector: ["enterprise_software"] },
    afterRedacted: { industrySector: ["financial_technology"] },
  })

  const report = await runFlywheelRegressionReplay({}, { db: asFirestore(db), now: () => NOW })
  assert.equal(report.results[0]!.seam, "structural")
  assert.equal(report.results[0]!.verdict, "pass")
})

// ---------------------------------------------------------------------------
// filtering, non-replayable kinds, and write-back
// ---------------------------------------------------------------------------

test("replay: ignores non-replayable artifact kinds (e.g. marketplace_simulation/ranking_eval)", async () => {
  const db = new FakeDb()
  // A non-correction artifact (scenarioRef sourced) — must NOT be replayed.
  const simArtifact = EvalArtifactSchema.parse({
    artifactId: "sim_marketplace_simulation__x__000",
    kind: "marketplace_simulation",
    status: "draft",
    scenarioRef: "x",
    payloadRedacted: { eventKind: "match_positive" },
    createdAt: NOW,
  })
  await db.collection(PA_COLLECTIONS.evalArtifacts).doc(simArtifact.artifactId).set(simArtifact as unknown as Record<string, unknown>)
  // plus one real correction
  await seedCorrectionArtifact(db, {
    eventId: "corr_mixed",
    targetType: "user_tags",
    targetId: "cand-7",
    actor: "operator",
    candidateId: "cand-7",
    reason: "fix skills",
    beforeRedacted: {},
    afterRedacted: { skills: ["python"] },
  })

  const report = await runFlywheelRegressionReplay({}, { db: asFirestore(db), now: () => NOW })
  assert.equal(report.counts.artifactsScanned, 2)
  assert.equal(report.counts.replayable, 1)
  assert.equal(report.results[0]!.kind, "correction_regression_fixture")
})

test("replay: writeBack records latestRunResult on the artifact", async () => {
  const db = new FakeDb()
  const artifact = await seedCorrectionArtifact(db, {
    eventId: "corr_writeback",
    targetType: "user_tags",
    targetId: "cand-8",
    actor: "operator",
    candidateId: "cand-8",
    reason: "fix role",
    beforeRedacted: {},
    afterRedacted: { targetRoleFunction: ["software_engineering"] },
  })

  await runFlywheelRegressionReplay({ writeBack: true }, { db: asFirestore(db), now: () => NOW, writeBack: true })

  const snap = await db.collection(PA_COLLECTIONS.evalArtifacts).doc(artifact.artifactId).get()
  const data = snap.data() as Record<string, unknown>
  const run = data.latestRunResult as Record<string, unknown>
  assert.ok(run, "latestRunResult written")
  assert.equal(run.status, "pass")
  assert.equal(run.runAt, NOW)
  assert.equal(run.command, "runFlywheelRegressionReplay")
})

test("replay: empty collection → honest zero counts, ok=true", async () => {
  const db = new FakeDb()
  const report = await runFlywheelRegressionReplay({}, { db: asFirestore(db), now: () => NOW })
  assert.equal(report.counts.artifactsScanned, 0)
  assert.equal(report.counts.replayable, 0)
  assert.equal(report.counts.pass, 0)
  assert.equal(report.ok, true)
})
