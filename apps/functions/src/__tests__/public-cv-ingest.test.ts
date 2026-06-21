import assert from "node:assert/strict"
import test from "node:test"
import {
  buildCandidateUploadResumeArtifactWrites,
  __test_sourceForProfileCreate,
} from "../public-cv-ingest.js"

test("buildCandidateUploadResumeArtifactWrites persists resumeFileUrl + storageUri for inline preview", () => {
  const writes = buildCandidateUploadResumeArtifactWrites({
    candidateId: "cand-1",
    parsedCandidateResumeId: "parsed-1",
    fileName: "Resume.pdf",
    sha256: "a".repeat(64),
    resumeFileUrl: "https://firebasestorage.googleapis.com/v0/b/b/o/candidate-resumes%2Fcand-1%2Fx.pdf?alt=media&token=tok",
    storageUri: "gs://b/candidate-resumes/cand-1/x.pdf",
    now: "2026-06-16T12:00:00.000Z",
  })
  const artifact = writes.artifact as Record<string, unknown>
  assert.equal(artifact.resumeFileUrl, "https://firebasestorage.googleapis.com/v0/b/b/o/candidate-resumes%2Fcand-1%2Fx.pdf?alt=media&token=tok")
  assert.equal(artifact.storageUri, "gs://b/candidate-resumes/cand-1/x.pdf")
  assert.equal(writes.selfProfilePatch.resumeFileUrl, artifact.resumeFileUrl)
})

test("buildCandidateUploadResumeArtifactWrites omits resumeFileUrl when not persisted (fail-open)", () => {
  const writes = buildCandidateUploadResumeArtifactWrites({
    candidateId: "cand-2",
    parsedCandidateResumeId: "parsed-2",
    fileName: "Resume.pdf",
    now: "2026-06-16T12:00:00.000Z",
  })
  assert.equal("resumeFileUrl" in (writes.artifact as Record<string, unknown>), false)
  assert.equal("resumeFileUrl" in writes.selfProfilePatch, false)
})

test("buildCandidateUploadResumeArtifactWrites preserves existing layoff source", () => {
  const writes = buildCandidateUploadResumeArtifactWrites({
    candidateId: "cand-1",
    parsedCandidateResumeId: "parsed-1",
    fileName: "Resume.pdf",
    existingUserSource: "WeKruit_Laid_Off",
    uploadSource: "candidate_signup",
    now: "2026-05-14T12:00:00.000Z",
  })

  assert.equal(writes.userPatch.latestResumeArtifactId, writes.artifact.resumeId)
  assert.equal("source" in writes.userPatch, false)
})

test("buildCandidateUploadResumeArtifactWrites stamps layoff source only for source-less layoff uploads", () => {
  const writes = buildCandidateUploadResumeArtifactWrites({
    candidateId: "cand-1",
    parsedCandidateResumeId: "parsed-1",
    fileName: "Resume.pdf",
    uploadSource: "layoff_signup",
    now: "2026-05-14T12:00:00.000Z",
  })

  assert.equal(writes.userPatch.source, "WeKruit_Laid_Off")
})

test("sourceForProfileCreate maps layoff_signup to WeKruit_Laid_Off", () => {
  assert.equal(__test_sourceForProfileCreate("layoff_signup"), "WeKruit_Laid_Off")
})

test("sourceForProfileCreate maps layoffhedge to layoffhedge", () => {
  assert.equal(__test_sourceForProfileCreate("layoffhedge"), "layoffhedge")
})

test("sourceForProfileCreate accepts any valid PaUserSource verbatim", () => {
  assert.equal(__test_sourceForProfileCreate("candidate"), "candidate")
  assert.equal(__test_sourceForProfileCreate("admin"), "admin")
  assert.equal(__test_sourceForProfileCreate("external_supply"), "external_supply")
})

test("sourceForProfileCreate falls back to candidate for unknown strings", () => {
  assert.equal(__test_sourceForProfileCreate("nonsense"), "candidate")
  assert.equal(__test_sourceForProfileCreate("public_job_page"), "candidate")
})

test("sourceForProfileCreate falls back to candidate for undefined", () => {
  assert.equal(__test_sourceForProfileCreate(undefined), "candidate")
})

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY-UX-PRD §2.3.2/§2.3.5 — website upload entry seam (Builder A).
// public-cv-ingest runs cv-ingest with followupDeliveryMode:"none", so this
// helper is the ONLY runtime-event producer for website resume uploads.
// ─────────────────────────────────────────────────────────────────────────────
import type { Firestore } from "firebase-admin/firestore"
import { recordWebsiteEntryAfterPublicCvIngest } from "../public-cv-ingest.js"
import type { RuntimeEventHandoffInput, RuntimeEventHandoffResult } from "../runtime-event-handoff.js"

function fakeUsersDb(seed: Record<string, Record<string, unknown>>) {
  const users = new Map(Object.entries(seed))
  const db = {
    collection: (path: string) => ({
      doc: (id: string) => ({
        get: async () => ({ id, exists: users.has(id), data: () => users.get(id) }),
        set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          const prev = users.get(id) ?? {}
          if (path !== "pa-users") throw new Error(`unexpected collection ${path}`)
          users.set(id, opts?.merge ? { ...prev, ...data } : data)
        },
      }),
    }),
  } as unknown as Firestore
  return { db, users }
}

test("recordWebsiteEntryAfterPublicCvIngest emits a per-parse flow with job context", async () => {
  const { db, users } = fakeUsersDb({ "cand-up": { pitchedAt: "" } })
  const calls: RuntimeEventHandoffInput[] = []
  const out = await recordWebsiteEntryAfterPublicCvIngest({
    db,
    candidateId: "cand-up",
    resumeId: "resume-77",
    jobIdContext: "hs-555-job",
    deps: {
      isCanary: () => true,
      enqueue: async (_db, input) => {
        calls.push(input)
        return { ok: true, eventId: "e", sessionId: "s", created: true } satisfies RuntimeEventHandoffResult
      },
    },
  })
  assert.equal(out?.emitted, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.idempotencyKey, "website-entry:cand-up:cv:resume-77")
  assert.equal(calls[0]!.eventKind, "resume_parse_completed")
  assert.equal(calls[0]!.context?.jobIdContext, "hs-555-job")
  assert.equal(calls[0]!.context?.websiteEntry, true)
  const cont = (users.get("cand-up")?.websiteEntry ?? {}) as Record<string, unknown>
  assert.equal(cont.resumeStatus, "parsed")
  assert.equal(cont.source, "public_cv_ingest")
})

test("recordWebsiteEntryAfterPublicCvIngest with no routable phone leaves a pendingEmit continuation", async () => {
  const { db, users } = fakeUsersDb({ "cand-nophone": {} })
  const out = await recordWebsiteEntryAfterPublicCvIngest({
    db,
    candidateId: "cand-nophone",
    resumeId: "resume-1",
    deps: {
      isCanary: () => true,
      enqueue: async () => ({ ok: false, reason: "user_not_routable" }),
    },
  })
  assert.equal(out?.emitted, false)
  assert.equal(out?.pendingEmit, true)
  const cont = (users.get("cand-nophone")?.websiteEntry ?? {}) as Record<string, unknown>
  assert.equal(cont.pendingEmit, true)
  assert.equal(cont.flowId, "cv:resume-1")
})

test("recordWebsiteEntryAfterPublicCvIngest preserves the auth provider from a prior verify entry", async () => {
  const { db, users } = fakeUsersDb({
    "cand-keep": { websiteEntry: { authProvider: "linkedin_oauth", flowId: "login:1" } },
  })
  await recordWebsiteEntryAfterPublicCvIngest({
    db,
    candidateId: "cand-keep",
    resumeId: "resume-2",
    deps: {
      isCanary: () => false,
      enqueue: async () => ({ ok: true, eventId: "e", sessionId: "s", created: true }),
    },
  })
  const cont = (users.get("cand-keep")?.websiteEntry ?? {}) as Record<string, unknown>
  assert.equal(cont.authProvider, "linkedin_oauth")
})

test("recordWebsiteEntryAfterPublicCvIngest never throws (returns null on db failure)", async () => {
  const db = {
    collection: () => {
      throw new Error("firestore down")
    },
  } as unknown as Firestore
  const out = await recordWebsiteEntryAfterPublicCvIngest({
    db,
    candidateId: "cand-x",
    resumeId: "r",
  })
  assert.equal(out, null)
})
