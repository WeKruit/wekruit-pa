/**
 * v2.1 S1B — `loadPrescreenConfigForVoice` unit tests.
 *
 * Covers the 3-case contract:
 *   1. happy path — full config including optional company + level1Reveal
 *   2. missing doc — pa-jobs/{jobId} absent OR prescreenConfig absent OR
 *      Zod validation fails → all map to NotFoundError("prescreen-config",
 *      jobId). Voice cannot run an invalid pipeline config.
 *   3. partial doc — minimal valid config; missing optional canonical fields
 *      (company, level1Reveal) are enumerated in missingFields.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { MockFirestore, asFirestore } from "../../../job-rec/__tests__/mock-firestore.js"
import { loadPrescreenConfigForVoice } from "../load-prescreen-config.js"
import { NotFoundError } from "../types.js"

function minimalValidQuestion() {
  return {
    qId: "q_industry_match",
    type: "MUST_HAVE" as const,
    weight: 1.0,
    prompt: { zh: "你做过什么相关项目？", en: "Tell me about a related project." },
    clarifyPrompt: { zh: "再具体一点？", en: "Can you be more specific?" },
    keywords: [{ keyword: "fintech experience", weight: 1.0 }],
  }
}

describe("loadPrescreenConfigForVoice — happy path", () => {
  it("returns the full canonical config with empty missingFields", async () => {
    const mfs = new MockFirestore()
    await mfs
      .collection("pa-jobs")
      .doc("j_full_001")
      .set({
        prescreenConfig: {
          version: 1,
          jobTitle: "Staff SWE",
          company: "Stripe",
          threshold: 0.65,
          confidenceThreshold: 0.7,
          maxClarifyRounds: 2,
          voiceMode: "professional_prescreen",
          questions: [minimalValidQuestion()],
          level1Reveal: {
            applyUrl: "https://stripe.com/jobs/listing/12345",
            salaryRange: "$220k-$320k",
            nextStepEta: "Within 3 business days",
          },
        },
      })

    const out = await loadPrescreenConfigForVoice(asFirestore(mfs), "j_full_001")

    assert.equal(out.jobId, "j_full_001")
    assert.equal(out.version, 1)
    assert.equal(out.jobTitle, "Staff SWE")
    assert.equal(out.company, "Stripe")
    assert.equal(out.threshold, 0.95)
    assert.equal(out.confidenceThreshold, 0.7)
    assert.equal(out.maxClarifyRounds, 2)
    assert.equal(out.voiceMode, "professional_prescreen")
    assert.equal(out.questions.length, 1)
    assert.equal(out.questions[0]?.qId, "q_industry_match")
    assert.equal(out.questions[0]?.type, "MUST_HAVE")
    assert.equal(out.level1Reveal?.applyUrl, "https://stripe.com/jobs/listing/12345")
    assert.equal(out.parsedFromZod, true)
    assert.deepEqual(out.missingFields, [])
  })
})

describe("loadPrescreenConfigForVoice — missing/invalid doc", () => {
  it("throws NotFoundError when pa-jobs/{jobId} does not exist", async () => {
    const mfs = new MockFirestore()
    await assert.rejects(
      () => loadPrescreenConfigForVoice(asFirestore(mfs), "j_missing_doc"),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError, "expected NotFoundError")
        assert.equal(err.kind, "prescreen-config")
        assert.equal(err.id, "j_missing_doc")
        return true
      }
    )
  })

  it("throws NotFoundError when pa-jobs/{jobId} exists but prescreenConfig is absent", async () => {
    const mfs = new MockFirestore()
    await mfs.collection("pa-jobs").doc("j_no_cfg").set({
      title: "Some Role",
      // prescreenConfig: undefined
    })
    await assert.rejects(
      () => loadPrescreenConfigForVoice(asFirestore(mfs), "j_no_cfg"),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError)
        assert.equal(err.kind, "prescreen-config")
        return true
      }
    )
  })

  it("throws NotFoundError when prescreenConfig fails Zod validation", async () => {
    const mfs = new MockFirestore()
    await mfs
      .collection("pa-jobs")
      .doc("j_bad_cfg")
      .set({
        prescreenConfig: {
          // missing required jobTitle + threshold out of range
          version: 1,
          threshold: 99, // > 1.0 — Zod rejects
          questions: [], // empty — Zod requires min(1)
        },
      })
    await assert.rejects(
      () => loadPrescreenConfigForVoice(asFirestore(mfs), "j_bad_cfg"),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError)
        assert.equal(err.kind, "prescreen-config")
        assert.equal(err.id, "j_bad_cfg")
        return true
      }
    )
  })
})

describe("loadPrescreenConfigForVoice — partial doc", () => {
  it("returns minimal valid config and lists absent optional canonical fields", async () => {
    const mfs = new MockFirestore()
    // Minimal config the Zod schema accepts: only jobTitle + one question
    // are strictly required. version + threshold + confidenceThreshold +
    // maxClarifyRounds + voiceMode all have defaults. `company` and
    // `level1Reveal` are optional.
    await mfs
      .collection("pa-jobs")
      .doc("j_partial_001")
      .set({
        prescreenConfig: {
          jobTitle: "SWE",
          questions: [minimalValidQuestion()],
        },
      })

    const out = await loadPrescreenConfigForVoice(asFirestore(mfs), "j_partial_001")

    assert.equal(out.jobTitle, "SWE")
    assert.equal(out.questions.length, 1)
    // schema defaults must populate
    assert.equal(out.version, 1)
    assert.equal(out.threshold, 0.95)
    assert.equal(out.confidenceThreshold, 0.7)
    assert.equal(out.maxClarifyRounds, 2)
    assert.equal(out.voiceMode, "professional_prescreen")
    assert.equal(out.parsedFromZod, true)
    // optional absent → listed
    assert.equal(out.company, undefined)
    assert.equal(out.level1Reveal, undefined)
    assert.ok(out.missingFields.includes("company"))
    assert.ok(out.missingFields.includes("level1Reveal"))
  })
})
