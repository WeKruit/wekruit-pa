/**
 * Flywheel HITL → regression replay — CLOSES the write-only loop.
 *
 * Today the flywheel is write-only: `flywheel-eval.ts` +
 * `flywheel-candidate-correction.ts` MATERIALIZE human corrections into
 * `pa-eval-artifacts` (regression fixtures), but nothing REPLAYS them. A
 * fixture that is never re-run is not a regression test. This harness reads
 * those artifacts and replays each through the relevant PRODUCTION seam,
 * asserting the corrected expectation (the artifact's `afterRedacted`) still
 * holds — then emits an honest per-artifact pass/fail report and (optionally)
 * writes the verdict back to the artifact's `latestRunResult`.
 *
 * This is NOT `admin-bootstrap.ts#replayFixtures` — that replays conversation
 * fixtures (message lists) through the orchestrator. It does not fit a
 * correction-artifact (`targetType` + before/after) replay, so a dedicated
 * harness is required.
 *
 * Seam dispatch by `payloadRedacted.targetType`:
 *
 *   user_tags / candidate_profile
 *     → applyPartialUserTags (the SOLE user-tag writer seam, D8). Seed the
 *       baseline `beforeRedacted` into pa-users/{userId}.tags, apply the
 *       corrected `afterRedacted` patch, read back, and assert every corrected
 *       canonical field persisted (skills compared by canonical name set).
 *
 *   candidate_job_match / candidate_job_state
 *     → scoreCandidateForJob (the S5 job→candidate scoring seam). Assert the
 *       corrected ranking direction holds: if the correction RAISED the match
 *       (e.g. operator un-blocked a candidate / bumped action up) the replay
 *       must surface the candidate (hardFilterResult !== "hard_block"); if it
 *       LOWERED it, the replay must suppress / down-rank. When the artifact
 *       lacks enough structured signal to reconstruct a job+candidate, the
 *       artifact is reported as `skipped` (honest — not a silent pass).
 *
 *   any other targetType (job_tags / job_enrichment_draft / outbound_copy /
 *   evaluation_attempt / agent_ranking_result / feedback_event / ...)
 *     → structural regression: assert the corrected `afterRedacted` is present,
 *       non-empty, and survived the artifact's PII/redaction guard (the
 *       EvalArtifactSchema already rejects raw PII). This guards against a
 *       correction silently losing its corrected value.
 *
 * Offline: unit-tested against a fake store seeding `pa-eval-artifacts`.
 * Online: `paFlywheelRegressionReplayWeekly` (scheduled) + admin callable.
 *
 * @module flywheel-regression-replay
 */

import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { z } from "zod"
import {
  EvalArtifactSchema,
  PA_COLLECTIONS,
  type EvalArtifact,
} from "@pa/core-types"
import { applyPartialUserTags } from "@pa/pa-orchestrator"
import { scoreCandidateForJob, type MatchingCandidateRow } from "@pa/job-rec"
import type { MatchingJob } from "@pa/job-rec"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

/** Artifact kinds that carry a HITL correction we can replay as a regression. */
const REPLAYABLE_KINDS = new Set<EvalArtifact["kind"]>([
  "correction_regression_fixture",
  "candidate_profile_correction",
])

/** Per-artifact replay outcome. */
export type ReplayVerdict = "pass" | "fail" | "skipped" | "error"

export type ArtifactReplayResult = {
  artifactId: string
  kind: EvalArtifact["kind"]
  targetType: string | undefined
  seam: "user_tags" | "candidate_job_match" | "structural" | "none"
  verdict: ReplayVerdict
  summary: string
  candidateId?: string
  jobId?: string
}

export type RegressionReplayReport = {
  generatedAt: string
  ranAt: string
  counts: {
    artifactsScanned: number
    replayable: number
    pass: number
    fail: number
    skipped: number
    error: number
  }
  /** True only when there are 0 fail + 0 error among replayable artifacts. */
  ok: boolean
  bySeam: Record<string, number>
  results: ArtifactReplayResult[]
}

export type RegressionReplayDeps = {
  db: Firestore
  /** Override clock for deterministic tests. */
  now?: () => string
  /** Persist `latestRunResult` back onto each replayed artifact. Default false. */
  writeBack?: boolean
  log?: (event: string, payload?: Record<string, unknown>) => void
}

const RegressionReplayInputSchema = z.object({
  limit: z.number().int().min(1).max(500).default(200),
  kinds: z.array(z.string()).optional(),
  writeBack: z.boolean().default(false),
  adminToken: z.string().optional(),
})
export type RegressionReplayInput = z.input<typeof RegressionReplayInputSchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Canonical-name set for skills (tolerates string[] or {name}[] shapes). */
function skillNameSet(value: unknown): Set<string> {
  const out = new Set<string>()
  if (!Array.isArray(value)) return out
  for (const s of value) {
    if (typeof s === "string") out.add(s.trim().toLowerCase())
    else if (s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string") {
      out.add((s as { name: string }).name.trim().toLowerCase())
    }
  }
  return out
}

/**
 * Does `actual` satisfy the corrected `expected` value? Used to compare a
 * read-back tag field against the artifact's `afterRedacted` value. Arrays of
 * skill-like objects compare by canonical-name superset (the writer may
 * canonicalize / re-shape entries); plain arrays compare by lowercase-set
 * superset; scalars compare by strict equality after string-normalization.
 */
function fieldSatisfies(key: string, expected: unknown, actual: unknown): boolean {
  if (expected === undefined || expected === null) return true
  if (key === "skills" || (Array.isArray(expected) && skillNameSet(expected).size > 0 && Array.isArray(actual) && skillNameSet(actual).size > 0)) {
    const want = skillNameSet(expected)
    const got = skillNameSet(actual)
    for (const w of want) if (!got.has(w)) return false
    return true
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false
    const got = new Set(actual.map((v) => String(v).trim().toLowerCase()))
    for (const e of expected) if (!got.has(String(e).trim().toLowerCase())) return false
    return true
  }
  if (typeof expected === "object") {
    // shallow object subset
    const a = asRecord(actual)
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
      if (!fieldSatisfies(k, v, a[k])) return false
    }
    return true
  }
  if (typeof expected === "number") return typeof actual === "number" && actual === expected
  return String(actual).trim().toLowerCase() === String(expected).trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// Seam replays
// ---------------------------------------------------------------------------

/**
 * Replay a user-tag / candidate-profile correction through the REAL sole
 * writer (`applyPartialUserTags`). The replay uses an ISOLATED scratch userId
 * (`__regression_replay__<artifactId>`) so production user docs are never
 * touched: seed baseline `beforeRedacted`, apply `afterRedacted`, read back,
 * assert corrected canonical fields persisted.
 */
async function replayUserTagsCorrection(
  db: Firestore,
  artifact: EvalArtifact,
  payload: Record<string, unknown>,
  log: (event: string, payload?: Record<string, unknown>) => void,
): Promise<ArtifactReplayResult> {
  const before = asRecord(payload.beforeRedacted)
  const after = asRecord(payload.afterRedacted)
  const base = {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    targetType: payload.targetType as string | undefined,
    seam: "user_tags" as const,
    ...(artifact.candidateId ? { candidateId: artifact.candidateId } : {}),
  }
  // Only canonical, non-empty corrected fields are assertable. An empty
  // `afterRedacted` carries no expectation → skipped (honest).
  const assertableKeys = Object.keys(after).filter((k) => after[k] !== undefined)
  if (assertableKeys.length === 0) {
    return { ...base, verdict: "skipped", summary: "no corrected fields in afterRedacted" }
  }

  const scratchUserId = `__regression_replay__${artifact.artifactId}`.slice(0, 256)
  // Seed baseline (best-effort — `before` may be empty for a fresh profile).
  if (Object.keys(before).length > 0) {
    await db.collection("pa-users").doc(scratchUserId).set({ tags: before }, { merge: true })
  }
  const applied = await applyPartialUserTags(db, scratchUserId, after, { source: "migration", log: () => {} })
  if (!applied.ok) {
    return { ...base, verdict: "error", summary: `applyPartialUserTags failed: ${applied.error ?? "unknown"}` }
  }
  const snap = await db.collection("pa-users").doc(scratchUserId).get()
  const persisted = asRecord(asRecord(snap.data()).tags)

  const missing: string[] = []
  for (const k of assertableKeys) {
    if (!fieldSatisfies(k, after[k], persisted[k])) missing.push(k)
  }
  if (missing.length > 0) {
    log("pa.flywheel_replay.user_tags_regression", { artifactId: artifact.artifactId, missing })
    return {
      ...base,
      verdict: "fail",
      summary: `corrected field(s) did not persist through applyPartialUserTags: ${missing.join(", ")}`,
    }
  }
  return {
    ...base,
    verdict: "pass",
    summary: `corrected field(s) persisted: ${assertableKeys.join(", ")}`,
  }
}

/**
 * Replay a candidate↔job match / state correction through the REAL
 * `scoreCandidateForJob` seam. The correction's `afterRedacted` may carry a
 * corrected directional signal (`recommendedAction`, `hardFilterResult`, or a
 * boolean `shouldSurface`). We reconstruct a minimal job + candidate from the
 * artifact's structured payload and assert the corrected direction holds.
 *
 * When the artifact lacks the structured job/candidate signal needed to
 * reconstruct the scoring inputs, we report `skipped` rather than fabricate a
 * pass.
 */
function replayMatchCorrection(
  artifact: EvalArtifact,
  payload: Record<string, unknown>,
  log: (event: string, payload?: Record<string, unknown>) => void,
): ArtifactReplayResult {
  const base = {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    targetType: payload.targetType as string | undefined,
    seam: "candidate_job_match" as const,
    ...(artifact.candidateId ? { candidateId: artifact.candidateId } : {}),
    ...(artifact.jobId ? { jobId: artifact.jobId } : {}),
  }
  const after = asRecord(payload.afterRedacted)
  const job = asRecord(after.job ?? payload.job)
  const candidateTags = asRecord(after.candidateTags ?? payload.candidateTags)
  // Need both a reconstructable job + candidate tags to drive the scorer.
  if (Object.keys(job).length === 0 || Object.keys(candidateTags).length === 0) {
    return {
      ...base,
      verdict: "skipped",
      summary: "insufficient structured job/candidate signal to replay scoring",
    }
  }

  const matchingJob = {
    id: typeof job.id === "string" ? job.id : artifact.jobId ?? "replay-job",
    roleFunction: Array.isArray(job.roleFunction) ? (job.roleFunction as string[]) : [],
    requiredSkills: Array.isArray(job.requiredSkills) ? (job.requiredSkills as string[]) : [],
    locationBuckets: Array.isArray(job.locationBuckets) ? (job.locationBuckets as string[]) : [],
    seniorityLevel: typeof job.seniorityLevel === "string" ? job.seniorityLevel : undefined,
    jobType: typeof job.jobType === "string" ? job.jobType : undefined,
    sponsorship: typeof job.sponsorship === "boolean" ? job.sponsorship : null,
    atsApplyUrl: typeof job.atsApplyUrl === "string" ? job.atsApplyUrl : "https://boards.greenhouse.io/replay/job",
    firstSeenAt: typeof job.firstSeenAt === "string" ? job.firstSeenAt : new Date().toISOString(),
    industrySector: Array.isArray(job.industrySector) ? (job.industrySector as string[]) : [],
    relevantTags: Array.isArray(job.relevantTags) ? (job.relevantTags as string[]) : [],
    salaryMin: typeof job.salaryMin === "number" ? job.salaryMin : null,
    salaryMax: typeof job.salaryMax === "number" ? job.salaryMax : null,
    companyName: typeof job.companyName === "string" ? job.companyName : "ReplayCo",
  } as unknown as MatchingJob

  const candidate: MatchingCandidateRow = {
    userId: artifact.candidateId ?? "replay-candidate",
    tags: candidateTags as MatchingCandidateRow["tags"],
  }

  const scored = scoreCandidateForJob(matchingJob, candidate, {
    nowMs: typeof job.firstSeenAt === "string" ? Date.parse(job.firstSeenAt) + 1 : Date.now(),
  })

  // Expected directional signal in the correction.
  const expectedAction = typeof after.recommendedAction === "string" ? after.recommendedAction : undefined
  const expectedHard = typeof after.hardFilterResult === "string" ? after.hardFilterResult : undefined
  const expectedSurface =
    typeof after.shouldSurface === "boolean" ? after.shouldSurface : undefined

  const checks: string[] = []
  let ok = true
  if (expectedHard !== undefined) {
    if (scored.hardFilterResult !== expectedHard) ok = false
    checks.push(`hardFilterResult=${scored.hardFilterResult} (want ${expectedHard})`)
  }
  if (expectedAction !== undefined) {
    if (scored.recommendedAction !== expectedAction) ok = false
    checks.push(`recommendedAction=${scored.recommendedAction} (want ${expectedAction})`)
  }
  if (expectedSurface !== undefined) {
    const surfaced = scored.hardFilterResult !== "hard_block"
    if (surfaced !== expectedSurface) ok = false
    checks.push(`surfaced=${surfaced} (want ${expectedSurface})`)
  }
  if (checks.length === 0) {
    return {
      ...base,
      verdict: "skipped",
      summary: "no directional expectation (recommendedAction/hardFilterResult/shouldSurface) in correction",
    }
  }
  if (!ok) log("pa.flywheel_replay.match_regression", { artifactId: artifact.artifactId, checks })
  return {
    ...base,
    verdict: ok ? "pass" : "fail",
    summary: checks.join("; "),
  }
}

/**
 * Structural regression for non-tag, non-match corrections: assert the
 * corrected value is present and non-empty (the EvalArtifactSchema already
 * proved it is PII-safe at write time). A correction that lost its corrected
 * value is a regression.
 */
function replayStructuralCorrection(
  artifact: EvalArtifact,
  payload: Record<string, unknown>,
): ArtifactReplayResult {
  const base = {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    targetType: payload.targetType as string | undefined,
    seam: "structural" as const,
    ...(artifact.candidateId ? { candidateId: artifact.candidateId } : {}),
    ...(artifact.jobId ? { jobId: artifact.jobId } : {}),
  }
  const after = asRecord(payload.afterRedacted)
  const changed = Array.isArray(payload.changedFieldKeys)
    ? (payload.changedFieldKeys as unknown[]).filter((k): k is string => typeof k === "string")
    : []
  const hasCorrection = Object.keys(after).length > 0 || changed.length > 0
  if (!hasCorrection) {
    return { ...base, verdict: "skipped", summary: "no corrected fields to assert" }
  }
  return {
    ...base,
    verdict: "pass",
    summary: `corrected ${changed.length > 0 ? changed.join(", ") : Object.keys(after).join(", ")} present & PII-safe`,
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function replayOne(
  db: Firestore,
  artifact: EvalArtifact,
  log: (event: string, payload?: Record<string, unknown>) => void,
): Promise<ArtifactReplayResult> {
  const payload = asRecord(artifact.payloadRedacted)
  const targetType = typeof payload.targetType === "string" ? payload.targetType : undefined
  try {
    switch (targetType) {
      case "user_tags":
      case "candidate_profile":
        return await replayUserTagsCorrection(db, artifact, payload, log)
      case "candidate_job_match":
      case "candidate_job_state":
        return replayMatchCorrection(artifact, payload, log)
      default:
        return replayStructuralCorrection(artifact, payload)
    }
  } catch (err) {
    return {
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      targetType,
      seam: "none",
      verdict: "error",
      summary: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Read `pa-eval-artifacts`, replay each replayable correction artifact through
 * its production seam, and return an honest pass/fail report. Pure/dep-injected
 * — the CF wrappers bind real Firestore; the unit test injects a fake store.
 */
export async function runFlywheelRegressionReplay(
  raw: unknown,
  deps: RegressionReplayDeps,
): Promise<RegressionReplayReport> {
  const parsed = RegressionReplayInputSchema.safeParse(raw ?? {})
  if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
  const { limit } = parsed.data
  const writeBack = deps.writeBack ?? parsed.data.writeBack
  const log = deps.log ?? (() => {})
  const ranAt = deps.now?.() ?? new Date().toISOString()

  const kindFilter = parsed.data.kinds && parsed.data.kinds.length > 0
    ? new Set(parsed.data.kinds)
    : null

  const snap = await deps.db
    .collection(PA_COLLECTIONS.evalArtifacts)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get()

  const results: ArtifactReplayResult[] = []
  let scanned = 0
  for (const doc of snap.docs) {
    scanned++
    const out = EvalArtifactSchema.safeParse(doc.data())
    if (!out.success) continue
    const artifact = out.data
    if (!REPLAYABLE_KINDS.has(artifact.kind)) continue
    if (kindFilter && !kindFilter.has(artifact.kind)) continue

    const result = await replayOne(deps.db, artifact, log)
    results.push(result)

    if (writeBack) {
      try {
        const runStatus = result.verdict === "pass" ? "pass" : result.verdict === "fail" ? "fail" : result.verdict === "error" ? "error" : "not_run"
        await deps.db.collection(PA_COLLECTIONS.evalArtifacts).doc(artifact.artifactId).set(
          {
            latestRunResult: {
              status: runStatus,
              runAt: ranAt,
              command: "runFlywheelRegressionReplay",
              summary: result.summary.slice(0, 2_000),
              metrics: { seam: result.seam },
            },
          },
          { merge: true },
        )
      } catch (err) {
        log("pa.flywheel_replay.writeback_error", {
          artifactId: artifact.artifactId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  const counts = {
    artifactsScanned: scanned,
    replayable: results.length,
    pass: results.filter((r) => r.verdict === "pass").length,
    fail: results.filter((r) => r.verdict === "fail").length,
    skipped: results.filter((r) => r.verdict === "skipped").length,
    error: results.filter((r) => r.verdict === "error").length,
  }
  const bySeam: Record<string, number> = {}
  for (const r of results) bySeam[r.seam] = (bySeam[r.seam] ?? 0) + 1

  log("pa.flywheel_replay.done", { counts })

  return {
    generatedAt: ranAt,
    ranAt,
    counts,
    ok: counts.fail === 0 && counts.error === 0,
    bySeam,
    results,
  }
}

// ---------------------------------------------------------------------------
// Cloud Function wrappers
// ---------------------------------------------------------------------------

/** Admin callable — replay on demand from the eval/regression dashboard. */
export const paFlywheelRegressionReplay = onCall(
  { region: "us-central1", memory: "256MiB", timeoutSeconds: 120, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<RegressionReplayReport> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runFlywheelRegressionReplay(req.data, { db: getFirestore(), writeBack: true })
  },
)

/** Scheduled weekly regression replay (Mon 10:00 UTC — after the QA evaluator). */
export const paFlywheelRegressionReplayWeekly = onSchedule(
  { schedule: "0 10 * * 1", timeZone: "Etc/UTC", region: "us-central1", memory: "256MiB", timeoutSeconds: 300 },
  async () => {
    const report = await runFlywheelRegressionReplay(
      { writeBack: true },
      { db: getFirestore(), writeBack: true, log: (e, p) => console.log(e, JSON.stringify(p ?? {})) },
    )
    console.log("pa.flywheel_replay.weekly", JSON.stringify(report.counts))
  },
)
