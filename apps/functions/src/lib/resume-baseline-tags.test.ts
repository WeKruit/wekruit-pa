import assert from "node:assert/strict"
import test from "node:test"

import { computeResumeBaselineTagPatch } from "./resume-baseline-tags.js"

test("resume baseline infers product intern profile from title and active education", () => {
  const out = computeResumeBaselineTagPatch({
    existingTags: {},
    mergedTags: {},
    parsedResume: {
      candidateProfile: { skills: ["Roadmapping", "Analytics"] },
      workHistory: [{ title: "Product Manager Intern", company: "Acme", startDate: "2025", endDate: "Present" }],
      education: [{ school: "State University", degree: "BS", field: "Business", endDate: "2027" }],
    },
    nowYear: 2026,
  })

  assert.deepEqual(out.proposed.targetRoleFunction, ["product_management"])
  assert.equal(out.proposed.careerStage, "intern")
  assert.deepEqual(out.proposed.yoeRange, [0, 1])
  assert.deepEqual(out.proposed.targetJobType, ["internship"])
})

test("resume baseline infers entry-level data profile and conservative full-time default", () => {
  const out = computeResumeBaselineTagPatch({
    existingTags: {},
    mergedTags: {},
    parsedResume: {
      candidateProfile: { skills: ["SQL", "Python", "Tableau"] },
      workHistory: [{ title: "Associate Data Analyst", company: "EnergyCo", startDate: "2024", endDate: "2026" }],
      education: [{ school: "State University", degree: "MS", field: "Information Systems", endDate: "2024" }],
    },
    nowYear: 2026,
  })

  assert.deepEqual(out.proposed.targetRoleFunction, ["data_analysis"])
  assert.equal(out.proposed.careerStage, "entry_level")
  assert.deepEqual(out.proposed.yoeRange, [1, 3])
  assert.deepEqual(out.proposed.targetJobType, ["full_time"])
})

test("resume baseline can infer marketing and data from a marketing analytics resume", () => {
  const out = computeResumeBaselineTagPatch({
    existingTags: {},
    mergedTags: {},
    parsedResume: {
      candidateProfile: { skills: ["SQL", "Google Analytics", "Lifecycle Marketing", "A/B testing"] },
      workHistory: [{ title: "Marketing Data Analyst", company: "RetailCo", startDate: "2023", endDate: "2025" }],
    },
    nowYear: 2026,
  })

  assert.deepEqual(out.proposed.targetRoleFunction, ["data_analysis", "marketing"])
  assert.deepEqual(out.proposed.targetJobType, ["full_time"])
})

test("resume baseline does not turn one historical internship into target internship for experienced candidates", () => {
  const out = computeResumeBaselineTagPatch({
    existingTags: {},
    mergedTags: {},
    parsedResume: {
      candidateProfile: { skills: ["Demand generation", "Salesforce", "Tableau"] },
      workHistory: [
        { title: "Product Marketing Manager, Demand Generation", company: "ActiveFence", startDate: "2025", endDate: "2026" },
        { title: "Product Marketing Intern", company: "All Across Africa", startDate: "2025", endDate: "2025" },
        { title: "Operations Manager", company: "SPANTA Trade", startDate: "2011", endDate: "2018" },
      ],
      education: [{ school: "Santa Clara University", degree: "MBA", field: "Business", endDate: "2026" }],
    },
    nowYear: 2026,
  })

  assert.ok((out.proposed.targetRoleFunction as string[]).includes("marketing"))
  assert.equal(out.proposed.careerStage, "manager")
  assert.deepEqual(out.proposed.yoeRange, [12, 20])
  assert.deepEqual(out.proposed.targetJobType, ["full_time"])
})

test("resume baseline never overwrites explicit existing or merged tags", () => {
  const out = computeResumeBaselineTagPatch({
    existingTags: {
      targetRoleFunction: ["marketing"],
      careerStage: "mid_level",
    },
    mergedTags: {
      targetJobType: ["contract"],
      yoeRange: [3, 5],
    },
    parsedResume: {
      candidateProfile: { skills: ["Python", "React", "Kubernetes"] },
      workHistory: [{ title: "Software Engineer Intern", company: "Acme", startDate: "2025", endDate: "2025" }],
    },
    nowYear: 2026,
  })

  assert.equal(out.proposed.targetRoleFunction, undefined)
  assert.equal(out.proposed.careerStage, undefined)
  assert.equal(out.proposed.yoeRange, undefined)
  assert.equal(out.proposed.targetJobType, undefined)
})
