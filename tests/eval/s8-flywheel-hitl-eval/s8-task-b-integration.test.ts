import assert from "node:assert/strict"
import test from "node:test"
import {
  PA_COLLECTIONS,
  createEvalArtifactId,
} from "../../../packages/core-types/src/index.js"
import {
  candidateCorrectionEvent,
  correctionEvent,
  feedbackEventId,
  jobId,
  prescreenFeedbackEvent,
} from "./fixtures.js"

type ModuleRecord = Record<string, unknown>

async function optionalImport(paths: string[], exportName: string): Promise<ModuleRecord | null> {
  for (const modulePath of paths) {
    try {
      const mod = await import(modulePath) as ModuleRecord
      if (typeof mod[exportName] === "function") return mod
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw error
    }
  }
  return null
}

test("S8 Task B materializeEvalArtifactForCorrection turns correction into redacted eval artifact", async (t) => {
  const mod = await optionalImport([
    "../../../apps/functions/src/flywheel-eval-artifacts.js",
    "../../../apps/functions/src/flywheel-eval-artifacts.ts",
    "../../../apps/functions/src/flywheel-eval.js",
    "../../../apps/functions/src/flywheel-eval.ts",
  ], "materializeEvalArtifactForCorrection")

  if (!mod) {
    t.skip("Task B dependency missing: materializeEvalArtifactForCorrection export is not present yet")
    return
  }

  const materialize = mod.materializeEvalArtifactForCorrection as (input: unknown) => unknown
  const correction = correctionEvent()
  const artifact = await materialize({ correction, scenarioRef: "s8/correction-to-artifact" }) as {
    artifactId?: string
    sourceCorrectionEventIds?: string[]
    payloadRedacted?: Record<string, unknown>
  }

  assert.equal(artifact.artifactId, createEvalArtifactId("correction_regression_fixture", correction.eventId))
  assert.deepEqual(artifact.sourceCorrectionEventIds, [correction.eventId])
  assert.doesNotMatch(JSON.stringify(artifact), /@|linkedin\.com|gs:\/\/|rawPrompt|rawTranscript/i)
})

test("S8 Task B candidate self-correction export produces candidate-authored correction artifacts", async (t) => {
  const mod = await optionalImport([
    "../../../apps/functions/src/flywheel-candidate-correction.js",
    "../../../apps/functions/src/flywheel-candidate-correction.ts",
    "../../../apps/functions/src/flywheel-eval-artifacts.js",
    "../../../apps/functions/src/flywheel-eval-artifacts.ts",
  ], "materializeEvalArtifactForCorrection")

  if (!mod) {
    t.skip("Task B dependency missing: candidate correction materializer export is not present yet")
    return
  }

  const materialize = mod.materializeEvalArtifactForCorrection as (input: unknown) => unknown
  const correction = candidateCorrectionEvent()
  const artifact = await materialize({ correction, kind: "candidate_profile_correction" }) as {
    createdBy?: string
    sourceCorrectionEventIds?: string[]
    payloadRedacted?: Record<string, unknown>
  }

  assert.equal(artifact.createdBy, "candidate")
  assert.deepEqual(artifact.sourceCorrectionEventIds, [correction.eventId])
  assert.doesNotMatch(JSON.stringify(artifact), /@|linkedin\.com|phone|raw/i)
})

test("S8 Task B buildFlywheelFeedbackEvent redacts prescreen feedback", async (t) => {
  const mod = await optionalImport([
    "../../../apps/functions/src/flywheel-events.js",
    "../../../apps/functions/src/flywheel-events.ts",
    "../../../apps/functions/src/flywheel-eval.js",
    "../../../apps/functions/src/flywheel-eval.ts",
  ], "buildFlywheelFeedbackEvent")

  if (!mod) {
    t.skip("Task B dependency missing: buildFlywheelFeedbackEvent export is not present yet")
    return
  }

  const build = mod.buildFlywheelFeedbackEvent as (input: unknown) => unknown
  const event = await build({
    eventId: "feedback-s8-built-prescreen-pass",
    behavior: "prescreen_pass",
    candidateId: "cand-s8-redacted",
    jobId,
    candidateJobStateId: `cand-s8-redacted__${jobId}`,
    outcome: "passed",
    signals: {
      scoreBucket: "strong",
      rawTranscript: "candidate@example.com raw transcript must be removed",
      storageUri: "gs://bucket/private-resume.pdf",
    },
    createdAt: "2026-05-14T12:00:00.000Z",
  }) as { kind?: string; payloadRedacted?: Record<string, unknown>; evidence?: unknown[] }

  assert.equal(event.kind, "candidate_behavior")
  assert.deepEqual(event.payloadRedacted, { behavior: "prescreen_pass", scoreBucket: "strong" })
  assert.doesNotMatch(JSON.stringify(event), /@|linkedin\.com|rawTranscript|rawPrompt/i)
})

test("S8 Task B deterministic simulation is no-contact and reaches passed-only visibility", async (t) => {
  const mod = await optionalImport([
    "../../../apps/functions/src/flywheel-simulation.js",
    "../../../apps/functions/src/flywheel-simulation.ts",
    "../../../apps/functions/src/flywheel-eval.js",
    "../../../apps/functions/src/flywheel-eval.ts",
  ], "runFlywheelMarketplaceSimulation")

  if (!mod) {
    t.skip("Task B dependency missing: runFlywheelMarketplaceSimulation export is not present yet")
    return
  }

  const run = mod.runFlywheelMarketplaceSimulation as (input: unknown) => unknown
  const result = await run({
    scenarioRef: "s8-deterministic-pass-no-contact",
    candidates: [{ candidateId: "cand-s8-redacted", tags: ["react", "figma"] }],
    jobs: [{ jobId, tags: ["react"], active: true }],
    events: [
      { kind: "prescreen_pass", candidateId: "cand-s8-redacted", jobId },
    ],
  }) as {
    dryRun?: boolean
    counts?: { outboundWrites?: number; generatedArtifactSummaries?: number }
    artifacts?: unknown[]
  }

  const second = await run({
    scenarioRef: "s8-deterministic-pass-no-contact",
    candidates: [{ candidateId: "cand-s8-redacted", tags: ["react", "figma"] }],
    jobs: [{ jobId, tags: ["react"], active: true }],
    events: [
      { kind: "prescreen_pass", candidateId: "cand-s8-redacted", jobId },
    ],
  })

  assert.deepEqual(result, second)
  assert.equal(result.dryRun, true)
  assert.equal(result.counts?.outboundWrites ?? 0, 0)
  assert.equal(result.counts?.generatedArtifactSummaries, 1)
  assert.ok((result.artifacts?.length ?? 0) >= 1)
})
