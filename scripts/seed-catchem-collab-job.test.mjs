import assert from "node:assert/strict"
import test from "node:test"

import {
  COMPANY_ID,
  COMPANY_NAME,
  JOB_ID,
  buildMatchingJob,
  buildPublicJob,
} from "./seed-catchem-collab-job.mjs"

const now = "2026-09-14T00:00:00.000Z"

test("Catchem seed publishes one collaborated Founding CEO role", () => {
  assert.equal(COMPANY_ID, "catchem")
  assert.equal(COMPANY_NAME, "Catchem")
  assert.equal(JOB_ID, "catchem-founding-ceo")

  const publicJob = buildPublicJob(now, now)
  const matchingJob = buildMatchingJob(now)

  assert.equal(publicJob.publicVisible, true)
  assert.equal(publicJob.candidatePageStatus, "published")
  assert.equal(publicJob.wekruitCollaborationStatus, "collaborated")
  assert.equal(publicJob.recruiterBoard.active, true)
  assert.equal(publicJob.title, "Founding CEO")
  assert.equal(publicJob.location, "Remote (United States)")
  assert.equal(publicJob.salaryRange, "$2.5K-$4K/month initial 6-month period + founder-level equity")
  assert.equal(publicJob.sponsorship, false)
  assert.ok(publicJob.roleFunction.includes("management_and_executive"))
  assert.ok(publicJob.industrySector.includes("crypto_web3_blockchain"))
  assert.ok(publicJob.locationBuckets.includes("remote_united_states"))
  assert.ok(publicJob.descriptionMd.includes("## What Catchem is screening for"))

  assert.equal(publicJob.prescreenConfig.company, "Catchem")
  assert.equal(publicJob.prescreenConfig.questions.length, 6)
  assert.deepEqual(
    publicJob.prescreenConfig.questions.slice(0, 2).map((question) => question.qId),
    ["q_founder_attempt", "q_collector_domain"],
  )
  assert.ok(publicJob.prescreenConfig.questions.every((question) => question.prompt.en === question.prompt.zh))

  assert.equal(matchingJob.status, "active")
  assert.equal(matchingJob.dead, false)
  assert.equal(matchingJob.companyId, COMPANY_ID)
  assert.equal(matchingJob.title, "Founding CEO")
  assert.equal(matchingJob.salaryRange, publicJob.salaryRange)
})

test("Catchem recruiter checklist captures founder and domain hard filters", () => {
  const publicJob = buildPublicJob(now, now)
  const groups = publicJob.recruiterBoard.checklist.groups
  const hardIds = groups.find((group) => group.kind === "hard")?.items.map((item) => item.id)
  const antiIds = groups.find((group) => group.kind === "anti")?.items.map((item) => item.id)

  assert.deepEqual(hardIds, [
    "technical_or_product_background",
    "founder_attempt_or_shipped_project",
    "collector_or_card_enthusiast",
    "comp_structure_aligned",
  ])
  assert.ok(antiIds?.includes("wants_operator_job_only"))
  assert.ok(antiIds?.includes("no_collector_interest"))
})
