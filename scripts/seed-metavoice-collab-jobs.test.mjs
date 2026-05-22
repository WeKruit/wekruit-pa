import assert from "node:assert/strict"
import test from "node:test"

import {
  COMPANY_ID,
  DATA_EVALS_JOB_ID,
  RESEARCH_SCIENTIST_JOB_ID,
  buildMatchingJob,
  buildPublicJob,
  jobs,
} from "./seed-metavoice-collab-jobs.mjs"

test("MetaVoice collab seed defines two public collaborated jobs with prescreen configs", () => {
  assert.equal(COMPANY_ID, "metavoice")
  assert.deepEqual(
    jobs.map((job) => job.jobId).sort(),
    [DATA_EVALS_JOB_ID, RESEARCH_SCIENTIST_JOB_ID].sort(),
  )

  for (const job of jobs) {
    const publicJob = buildPublicJob(job, "2026-05-21T00:00:00.000Z", "2026-05-21T00:00:00.000Z")
    const matchingJob = buildMatchingJob(job, "2026-05-21T00:00:00.000Z")

    assert.equal(publicJob.companyId, COMPANY_ID)
    assert.equal(publicJob.companyName, "MetaVoice")
    assert.equal(publicJob.publicVisible, true)
    assert.equal(publicJob.candidatePageStatus, "published")
    assert.equal(publicJob.wekruitCollaborationStatus, "collaborated")
    assert.equal(publicJob.status, "active")
    assert.equal(publicJob.sponsorship, true)
    assert.equal(publicJob.companyProfile.websiteUrl, "https://www.metavoice.io/")

    assert.equal(matchingJob.companyId, COMPANY_ID)
    assert.equal(matchingJob.status, "active")
    assert.equal(matchingJob.dead, false)
    assert.equal(matchingJob.sponsorship, true)
    assert.ok(matchingJob.roleFunction.includes("software_engineering"))
    assert.ok(matchingJob.industrySector.includes("artificial_intelligence_and_machine_learning"))
    assert.ok(matchingJob.locationBuckets.includes("san_francisco_bay_area"))

    assert.equal(publicJob.prescreenConfig.company, "MetaVoice")
    assert.ok(publicJob.prescreenConfig.questions.length >= 5)
    assert.ok(
      publicJob.prescreenConfig.questions.every(
        (question) => question.prompt.en === question.prompt.zh && question.clarifyPrompt.en === question.clarifyPrompt.zh,
      ),
    )
    assert.ok(publicJob.descriptionMd.includes("## How WeKruit will evaluate candidates"))
  }
})

test("Research Scientist prescreen captures the hard filters from the job brief", () => {
  const job = jobs.find((candidate) => candidate.jobId === RESEARCH_SCIENTIST_JOB_ID)
  assert.ok(job)

  const publicJob = buildPublicJob(job, "2026-05-21T00:00:00.000Z", "2026-05-21T00:00:00.000Z")
  assert.equal(publicJob.sourceUrl, "https://metavoice.notion.site/research-scientist")
  assert.equal(publicJob.salaryRange, "$200K-$500K base")

  const qIds = publicJob.prescreenConfig.questions.map((question) => question.qId)
  assert.deepEqual(qIds.slice(0, 5), [
    "q_top_venue_research",
    "q_large_model_training",
    "q_post_training_finetuning",
    "q_eval_workflows",
    "q_sf_in_person",
  ])
})

test("Data Evals prescreen captures large-scale multimodal data requirements", () => {
  const job = jobs.find((candidate) => candidate.jobId === DATA_EVALS_JOB_ID)
  assert.ok(job)

  const publicJob = buildPublicJob(job, "2026-05-21T00:00:00.000Z", "2026-05-21T00:00:00.000Z")
  assert.equal(
    publicJob.sourceUrl,
    "https://metavoice.notion.site/Software-Engineer-Data-Evals-22f766326ae38033b036c3a7b6c0d7c2",
  )
  assert.equal(publicJob.salaryRange, "$180K-$250K base")

  const qIds = publicJob.prescreenConfig.questions.map((question) => question.qId)
  assert.deepEqual(qIds.slice(0, 5), [
    "q_large_scale_data_pipelines",
    "q_multimodal_ai_data",
    "q_distributed_processing",
    "q_speech_processing_pipelines",
    "q_sf_in_person",
  ])
})
