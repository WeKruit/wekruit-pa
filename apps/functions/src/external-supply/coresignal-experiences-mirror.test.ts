import test from "node:test"
import assert from "node:assert/strict"
import type { ExternalCandidateRecord } from "@pa/core-types"
import {
  buildExperienceHighlightsFromRecord,
  buildParsedResumeDocFromRecord,
  runCoresignalExperiencesMirror,
} from "./coresignal-experiences-mirror.js"

const NOW = "2026-05-21T05:00:00.000Z"

function makeRecord(over: Partial<ExternalCandidateRecord> = {}): ExternalCandidateRecord {
  return {
    recordId: "rec-1",
    batchId: "batch-1",
    source: "coresignal_collect_v2",
    rawPayload: { id: 395094789 } as Record<string, unknown>,
    canonicalLinkedInUrl: "https://linkedin.com/in/nicreichert",
    linkedinProfileHash: "h".repeat(64),
    emails: [],
    name: "Nic Reichert",
    currentTitle: "Software Engineer",
    currentCompany: "Confidential",
    experience: [
      { company: "Confidential", title: "Software Engineer", startDate: "August 2024", durationMonths: 21 },
      { company: "Mews", title: "Senior Frontend Engineer", startDate: "September 2023", endDate: "July 2024", durationMonths: 10 },
    ],
    education: [
      { school: "Unisinos", degree: "Computer Games" },
    ],
    sourceTags: ["react", "typescript", "node"],
    normalizationStatus: "ok",
    identityResolutionStatus: "create_new",
    evidence: [],
    createdAt: NOW,
    ...over,
  }
}

test("buildParsedResumeDocFromRecord — produces canonical shape", () => {
  const doc = buildParsedResumeDocFromRecord(makeRecord(), "uid-1", NOW, 395094789)
  assert.equal(doc.userId, "uid-1")
  assert.equal(doc.source, "coresignal_collect_v2")
  assert.equal(doc.coresignalEmployeeId, 395094789)
  assert.equal(doc.parserVersion, "coresignal_collect_v2")
  assert.equal(doc.ingestedVia, "coresignal_collect_v2")
  assert.equal((doc.candidateProfile as { name: string }).name, "Nic Reichert")
  assert.deepEqual((doc.candidateProfile as { skills: string[] }).skills, ["react", "typescript", "node"])
  assert.equal((doc.experiences as unknown[]).length, 2)
  assert.equal((doc.experiences as Array<{ company: string }>)[0].company, "Confidential")
  assert.equal((doc.topSkills as string[]).length, 3)
  assert.equal(doc.sourceRecordId, "rec-1")
  assert.equal(doc.sourceBatchId, "batch-1")
})

test("buildExperienceHighlightsFromRecord — produces candidate-facing LinkedIn highlights", () => {
  const highlights = buildExperienceHighlightsFromRecord(makeRecord())
  assert.equal(highlights.length, 2)
  assert.deepEqual(highlights[0], {
    title: "Software Engineer",
    company: "Confidential",
    startDate: "August 2024",
    currentRole: true,
    source: "coresignal_collect_v2",
    sourceLabel: "LinkedIn",
  })
})

test("runCoresignalExperiencesMirror — happy path writes new parsedResume doc", async () => {
  const writes: Array<unknown> = []
  const result = await runCoresignalExperiencesMirror(makeRecord(), "uid-1", {
    findExistingForUser: async () => [],
    writeBoth: async (args) => {
      writes.push(args)
    },
    now: () => NOW,
  })
  assert.equal(result.status, "mirrored")
  assert.equal(writes.length, 1)
  const w = writes[0] as {
    parsedResumeDoc: Record<string, unknown>
    userId: string
    coresignalEmployeeId: number
    canonicalLinkedInUrl?: string
    experienceHighlights: Array<{ company: string }>
  }
  assert.equal(w.userId, "uid-1")
  assert.equal(w.coresignalEmployeeId, 395094789)
  assert.equal(w.parsedResumeDoc.source, "coresignal_collect_v2")
  assert.equal(w.canonicalLinkedInUrl, "https://linkedin.com/in/nicreichert")
  assert.equal(w.experienceHighlights[0]?.company, "Confidential")
})

test("runCoresignalExperiencesMirror — skips when source is not coresignal_collect_v2", async () => {
  const result = await runCoresignalExperiencesMirror(
    makeRecord({ source: "juicebox" }),
    "uid-1",
    { writeBoth: async () => {}, now: () => NOW },
  )
  assert.equal(result.status, "skipped_not_coresignal")
})

test("runCoresignalExperiencesMirror — skips when no experience", async () => {
  const result = await runCoresignalExperiencesMirror(
    makeRecord({ experience: [] }),
    "uid-1",
    { writeBoth: async () => {}, now: () => NOW },
  )
  assert.equal(result.status, "skipped_no_experience")
})

test("runCoresignalExperiencesMirror — skips when no coresignal id in rawPayload", async () => {
  const result = await runCoresignalExperiencesMirror(
    makeRecord({ rawPayload: {} }),
    "uid-1",
    { writeBoth: async () => {}, now: () => NOW },
  )
  assert.equal(result.status, "skipped_no_coresignal_id")
})

test("runCoresignalExperiencesMirror — skips when same coresignal_id already mirrored", async () => {
  let wroteCalled = false
  const result = await runCoresignalExperiencesMirror(makeRecord(), "uid-1", {
    findExistingForUser: async () => [
      { coresignalEmployeeId: 395094789, source: "coresignal_collect_v2" },
    ],
    writeBoth: async () => {
      wroteCalled = true
    },
    now: () => NOW,
  })
  assert.equal(result.status, "skipped_already_mirrored")
  assert.equal(wroteCalled, false)
})

test("runCoresignalExperiencesMirror — does NOT dedup against different coresignal_id (different id = different person)", async () => {
  const writes: Array<unknown> = []
  const result = await runCoresignalExperiencesMirror(makeRecord(), "uid-1", {
    findExistingForUser: async () => [
      { coresignalEmployeeId: 999999999, source: "coresignal_collect_v2" },
    ],
    writeBoth: async (args) => {
      writes.push(args)
    },
    now: () => NOW,
  })
  assert.equal(result.status, "mirrored")
  assert.equal(writes.length, 1)
})

test("runCoresignalExperiencesMirror — extracts coresignal id from string rawPayload.id", async () => {
  const writes: Array<unknown> = []
  const rec = makeRecord({
    rawPayload: { id: "123456" } as unknown as Record<string, unknown>,
  })
  const result = await runCoresignalExperiencesMirror(rec, "uid-1", {
    findExistingForUser: async () => [],
    writeBoth: async (args) => {
      writes.push(args)
    },
    now: () => NOW,
  })
  assert.equal(result.status, "mirrored")
  const w = writes[0] as { coresignalEmployeeId: number }
  assert.equal(w.coresignalEmployeeId, 123456)
})

test("buildParsedResumeDocFromRecord — caps topSkills at 12", () => {
  const tagsLong = Array.from({ length: 30 }, (_, i) => `skill_${i}`)
  const doc = buildParsedResumeDocFromRecord(
    makeRecord({ sourceTags: tagsLong }),
    "uid-1",
    NOW,
    1,
  )
  assert.equal((doc.topSkills as string[]).length, 12)
  assert.equal((doc.candidateProfile as { skills: string[] }).skills.length, 30) // full list preserved
})
