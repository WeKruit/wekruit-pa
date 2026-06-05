import test from "node:test"
import assert from "node:assert/strict"
import type { ExternalCandidateRecord } from "@pa/core-types"
import {
  buildExperienceHighlightsFromRecord,
  buildParsedResumeDocFromRecord,
  makeFirestoreMirrorDeps,
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
      {
        company: "Confidential",
        title: "Software Engineer",
        location: "Remote",
        description: "Built realtime collaboration features for hotel operators.",
        startDate: "August 2024",
        durationMonths: 21,
        department: "Engineering",
        managementLevel: "Individual Contributor",
        companyIndustry: "Hospitality",
        companySizeRange: "501-1,000 employees",
        companyWebsite: "mews.com",
        companyLinkedinUrl: "linkedin.com/company/mews",
        companyHqCity: "Prague",
        companyHqCountry: "Czechia",
        companyLogoUrl: "https://static.licdn.com/mews.png",
      },
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
  assert.equal(
    (doc.experiences as Array<{ description?: string }>)[0].description,
    "Built realtime collaboration features for hotel operators.",
  )
  assert.equal((doc.experiences as Array<{ companyWebsite?: string }>)[0].companyWebsite, "https://mews.com/")
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
    location: "Remote",
    description: "Built realtime collaboration features for hotel operators.",
    startDate: "August 2024",
    durationMonths: 21,
    department: "Engineering",
    managementLevel: "Individual Contributor",
    companyIndustry: "Hospitality",
    companySizeRange: "501-1,000 employees",
    companyWebsite: "https://mews.com/",
    companyLinkedinUrl: "https://linkedin.com/company/mews",
    companyHqCity: "Prague",
    companyHqCountry: "Czechia",
    companyLogoUrl: "https://static.licdn.com/mews.png",
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

test("runCoresignalExperiencesMirror — merge null → no-regex fallback sets recentRoleTitle from current LinkedIn role, NOT careerStage", async () => {
  const writes: Array<{ mergedFacts?: Record<string, unknown> }> = []
  const result = await runCoresignalExperiencesMirror(
    makeRecord({
      experience: [
        { company: "Tesla", title: "Senior Software Engineer", currentRole: true, startDate: "February 2026" },
        { company: "Tesla", title: "Software Engineer", startDate: "March 2025", endDate: "January 2026" },
      ],
    }),
    "uid-fallback",
    {
      findExistingForUser: async () => [],
      // Force the merge LLM to be unavailable → exercise the fail-open fallback branch.
      mergeAndDetermine: async () => null,
      writeBoth: async (args) => {
        writes.push(args as { mergedFacts?: Record<string, unknown> })
      },
      now: () => NOW,
    },
  )
  assert.equal(result.status, "mirrored")
  assert.equal(writes.length, 1)
  const facts = writes[0]?.mergedFacts
  assert.ok(facts, "mergedFacts must be set by the fallback")
  assert.equal(facts?.recentRoleTitle, "Senior Software Engineer")
  assert.equal(facts?.recentCompany, "Tesla")
  // careerStage / yoeRange are enum/derived → LLM-only; the fallback must NOT invent them (no regex→enum).
  assert.equal(facts?.careerStage, undefined)
  assert.equal(facts?.yoeRange, undefined)
})

test("runCoresignalExperiencesMirror — merge roleFunction flows into mergedFacts (the LinkedIn role-derive seam)", async () => {
  const writes: Array<{ mergedFacts?: Record<string, unknown> }> = []
  const result = await runCoresignalExperiencesMirror(
    makeRecord({
      experience: [{ company: "Tesla", title: "Senior Software Engineer", currentRole: true, startDate: "February 2026" }],
    }),
    "uid-role",
    {
      findExistingForUser: async () => [],
      mergeAndDetermine: async () => ({
        mergedExperiences: [{ title: "Senior Software Engineer", company: "Tesla", isCurrent: true }],
        recentRoleTitle: "Senior Software Engineer",
        recentCompany: "Tesla",
        careerStage: "senior",
        yoeRange: [3, 5],
        roleFunction: ["software_engineering"],
      }),
      writeBoth: async (args) => {
        writes.push(args as { mergedFacts?: Record<string, unknown> })
      },
      now: () => NOW,
    },
  )
  assert.equal(result.status, "mirrored")
  assert.deepEqual(writes[0]?.mergedFacts?.roleFunction, ["software_engineering"], "roleFunction carried into mergedFacts")
})

test("runCoresignalExperiencesMirror — merge null fail-open fallback does NOT invent roleFunction (closed enum, LLM-only)", async () => {
  const writes: Array<{ mergedFacts?: Record<string, unknown> }> = []
  await runCoresignalExperiencesMirror(
    makeRecord({
      experience: [{ company: "Tesla", title: "Senior Software Engineer", currentRole: true, startDate: "February 2026" }],
    }),
    "uid-fallback-role",
    {
      findExistingForUser: async () => [],
      mergeAndDetermine: async () => null,
      writeBoth: async (args) => {
        writes.push(args as { mergedFacts?: Record<string, unknown> })
      },
      now: () => NOW,
    },
  )
  // fallback fixes recentRoleTitle (free text) but must NOT set roleFunction (no regex→enum).
  assert.equal(writes[0]?.mergedFacts?.recentRoleTitle, "Senior Software Engineer")
  assert.equal(writes[0]?.mergedFacts?.roleFunction, undefined)
})

test("makeFirestoreMirrorDeps.writeBoth — lands tags.targetRoleFunction WITHOUT clobbering sibling tags.skills (D8)", async () => {
  // Stub Firestore: pa-users doc already carries a tags.skills sibling; self-profile absent. We capture the
  // pa-users set(merge:true) patch and assert targetRoleFunction is written AND skills survives.
  let userPatch: Record<string, unknown> | undefined
  const userData = { tags: { skills: [{ name: "TypeScript" }], careerStage: "mid_level" } }
  const db = {
    batch() {
      return {
        set(ref: { __col: string }, patch: Record<string, unknown>) {
          if (ref.__col === "pa-users") userPatch = patch
        },
        async commit() {},
      }
    },
    collection(name: string) {
      return {
        doc() {
          return {
            __col: name,
            async get() {
              return { exists: name === "pa-users", data: () => (name === "pa-users" ? userData : undefined) }
            },
          }
        },
      }
    },
  } as unknown as import("firebase-admin/firestore").Firestore

  const deps = makeFirestoreMirrorDeps(db)
  await deps.writeBoth!({
    parsedResumeDoc: { source: "coresignal_collect_v2" },
    userId: "uid-1",
    coresignalEmployeeId: 123,
    experienceHighlights: [{ title: "Senior Software Engineer", company: "Tesla" }],
    mergedFacts: { recentRoleTitle: "Senior Software Engineer", roleFunction: ["software_engineering"] },
  })
  const tags = userPatch?.tags as Record<string, unknown>
  assert.ok(tags, "pa-users tags patch written")
  assert.deepEqual(tags.targetRoleFunction, ["software_engineering"], "targetRoleFunction written under tags")
  assert.deepEqual(tags.skills, [{ name: "TypeScript" }], "sibling tags.skills survives (not clobbered)")
  assert.equal(tags.careerStage, "mid_level", "other sibling tags survive")
  assert.equal(tags.recentRoleTitle, "Senior Software Engineer")
})

test("runCoresignalExperiencesMirror — fills missing LinkedIn descriptions from matching resume rows", async () => {
  const writes: Array<unknown> = []
  const result = await runCoresignalExperiencesMirror(
    makeRecord({
      experience: [
        {
          company: "Tesla",
          title: "Software Engineer",
          startDate: "May 2024",
          endDate: "August 2024",
          companyIndustry: "Motor Vehicle Manufacturing",
        },
      ],
    }),
    "uid-1",
    {
      findExistingForUser: async () => [
        {
          id: "resume-1",
          source: "imessage-attachment",
          experiences: [
            {
              company: "Tesla Inc.",
              title: "Software Engineer Intern",
              startDate: "May 2024",
              endDate: "August 2024",
              description: "Built CI/CD pipelines and migrated portfolio services onto Azure.",
            },
          ],
        },
      ],
      writeBoth: async (args) => {
        writes.push(args)
      },
      now: () => NOW,
    },
  )
  assert.equal(result.status, "mirrored")
  const write = writes[0] as {
    parsedResumeDoc: { experiences: Array<{ description?: string | null }> }
    experienceHighlights: Array<{ description?: string }>
  }
  assert.equal(
    write.experienceHighlights[0]?.description,
    "Built CI/CD pipelines and migrated portfolio services onto Azure.",
  )
  assert.equal(
    write.parsedResumeDoc.experiences[0]?.description,
    "Built CI/CD pipelines and migrated portfolio services onto Azure.",
  )
})

test("runCoresignalExperiencesMirror — matches compact company spelling with title and date evidence", async () => {
  const writes: Array<unknown> = []
  const result = await runCoresignalExperiencesMirror(
    makeRecord({
      experience: [
        {
          company: "aiStudy",
          title: "Founder National Reward Honoree",
          startDate: "January 2024",
          endDate: "May 2024",
        },
      ],
    }),
    "uid-1",
    {
      findExistingForUser: async () => [
        {
          id: "resume-1",
          source: "imessage-attachment",
          experiences: [
            {
              company: "AI Study",
              title: "Founder, Software Engineer & Product Manager",
              startDate: "Sep 2024",
              endDate: "Apr 2024",
              description: "Led research on dynamic knowledge tracing and managed the product build.",
            },
          ],
        },
      ],
      writeBoth: async (args) => {
        writes.push(args)
      },
      now: () => NOW,
    },
  )
  assert.equal(result.status, "mirrored")
  const write = writes[0] as {
    experienceHighlights: Array<{ description?: string }>
  }
  assert.equal(
    write.experienceHighlights[0]?.description,
    "Led research on dynamic knowledge tracing and managed the product build.",
  )
})

test("runCoresignalExperiencesMirror — does not copy unrelated resume descriptions by company only", async () => {
  const writes: Array<unknown> = []
  const result = await runCoresignalExperiencesMirror(
    makeRecord({
      experience: [
        {
          company: "Tesla",
          title: "Senior Software Engineer",
          startDate: "February 2026",
        },
      ],
    }),
    "uid-1",
    {
      findExistingForUser: async () => [
        {
          id: "resume-1",
          source: "imessage-attachment",
          experiences: [
            {
              company: "Tesla Inc.",
              title: "Software Engineer Intern",
              startDate: "May 2024",
              endDate: "August 2024",
              description: "Built CI/CD pipelines and migrated portfolio services onto Azure.",
            },
          ],
        },
      ],
      writeBoth: async (args) => {
        writes.push(args)
      },
      now: () => NOW,
    },
  )
  assert.equal(result.status, "mirrored")
  const write = writes[0] as {
    parsedResumeDoc: { experiences: Array<{ description?: string | null }> }
    experienceHighlights: Array<{ description?: string }>
  }
  assert.equal(write.experienceHighlights[0]?.description, undefined)
  assert.equal(write.parsedResumeDoc.experiences[0]?.description, null)
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

test("runCoresignalExperiencesMirror — refreshes candidate profile when same coresignal_id already exists", async () => {
  const writes: Array<unknown> = []
  const result = await runCoresignalExperiencesMirror(makeRecord(), "uid-1", {
    findExistingForUser: async () => [
      { id: "parsed-1", coresignalEmployeeId: 395094789, source: "coresignal_collect_v2" },
    ],
    writeBoth: async (args) => {
      writes.push(args)
    },
    now: () => NOW,
  })
  assert.equal(result.status, "refreshed_existing")
  assert.equal(writes.length, 1)
  assert.equal((writes[0] as { existingParsedResumeDocId?: string }).existingParsedResumeDocId, "parsed-1")
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
