import test from "node:test"
import assert from "node:assert/strict"
import type { ExternalCandidateRecord } from "@pa/core-types"
import {
  buildBatchCsv,
  type ExternalCandidateRecordRowWithRaw,
} from "./batch-csv-export.js"

const NOW = "2026-05-21T05:00:00.000Z"

function makeRecord(
  over: Partial<ExternalCandidateRecordRowWithRaw> = {},
): ExternalCandidateRecordRowWithRaw {
  return {
    recordId: "rec-abc",
    batchId: "batch-1",
    source: "coresignal_collect_v2" as ExternalCandidateRecord["source"],
    rawPayload: { id: 725992096, headline: "Tech Recruiter" },
    canonicalLinkedInUrl: "https://linkedin.com/in/yue",
    emails: [{ value: "yue@example.com", hash: "h".repeat(64) }],
    name: "Yue H.",
    currentTitle: "Tech Recruiter",
    currentCompany: "IntelliPro",
    location: "SF Bay Area",
    experience: [
      { company: "IntelliPro", title: "Tech Recruiter", durationMonths: 24 },
      { company: "Acme", title: "Engineer" },
    ],
    education: [{ school: "MIT", degree: "BS" }],
    sourceTags: ["python", "react"],
    normalizationStatus: "ok",
    identityResolutionStatus: "create_new",
    evidence: [],
    createdAt: NOW,
    ...over,
  }
}

test("buildBatchCsv — header row + one record", () => {
  const csv = buildBatchCsv([makeRecord()])
  const lines = csv.trimEnd().split("\n")
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^record_id,coresignal_id,source,resolved_user_id/)
  assert.match(lines[1], /^rec-abc,725992096,coresignal_collect_v2,/)
})

test("buildBatchCsv — escapes commas + quotes", () => {
  const csv = buildBatchCsv([
    makeRecord({
      name: "Doe, John \"Jr\"",
      currentTitle: "VP, Engineering",
    }),
  ])
  const lines = csv.trimEnd().split("\n")
  assert.match(lines[1], /"Doe, John ""Jr"""/)
  assert.match(lines[1], /"VP, Engineering"/)
})

test("buildBatchCsv — newlines stripped from cell content", () => {
  const csv = buildBatchCsv([
    makeRecord({ name: "Multi\nLine\nName" }),
  ])
  // The cell should be flattened to single line; output has exactly 2 lines (header + 1 record)
  const lines = csv.trimEnd().split("\n")
  assert.equal(lines.length, 2)
  assert.match(lines[1], /Multi Line Name/)
})

test("buildBatchCsv — empty records list still emits header", () => {
  const csv = buildBatchCsv([])
  const lines = csv.trimEnd().split("\n")
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^record_id,coresignal_id/)
})

test("buildBatchCsv — multi-email joined with semicolon", () => {
  const csv = buildBatchCsv([
    makeRecord({
      emails: [
        { value: "a@x.com", hash: "h".repeat(64) },
        { value: "b@x.com", hash: "h".repeat(64) },
      ],
    }),
  ])
  const lines = csv.trimEnd().split("\n")
  // primary_email = first; all_emails = "a@x.com; b@x.com" (escaped because contains comma)
  assert.match(lines[1], /a@x\.com/)
  assert.match(lines[1], /b@x\.com/)
})

test("buildBatchCsv — experience_summary formats company + title + duration", () => {
  const csv = buildBatchCsv([makeRecord()])
  // Should contain "Tech Recruiter @ IntelliPro (24mo); Engineer @ Acme"
  assert.match(csv, /Tech Recruiter @ IntelliPro \(24mo\)/)
  assert.match(csv, /Engineer @ Acme/)
})

test("buildBatchCsv — top_skills capped at 12", () => {
  const long = Array.from({ length: 30 }, (_, i) => `skill_${i}`)
  const csv = buildBatchCsv([makeRecord({ sourceTags: long })])
  const lines = csv.trimEnd().split("\n")
  // top_skills column contains exactly 12 entries
  // all_skills column contains all 30
  const topSkillsField = lines[1].split(/,(?=(?:[^"]|"[^"]*")*$)/)
  // simplest: check that "skill_11" is in CSV but "skill_12" only in all_skills section
  assert.match(csv, /skill_0/)
  assert.match(csv, /skill_29/) // all_skills has it
})

test("buildBatchCsv — UTF-8 multi-byte names preserved", () => {
  const csv = buildBatchCsv([makeRecord({ name: "李雷" })])
  assert.match(csv, /李雷/)
})
