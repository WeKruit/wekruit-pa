import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../mock-firestore.js"
import {
  parseResume,
  projectParsedDocToResumeProfile,
  createParseResumeTool,
} from "../../tools/parse-resume.js"

test("projectParsedDocToResumeProfile pulls top experience + skills", () => {
  const raw = {
    candidateProfile: {
      name: "Alice",
      skills: ["Python", "TypeScript", "React"],
    },
    experiences: [
      { company: "Acme", title: "Senior SWE", description: "Built a thing." },
      { company: "Older", title: "SWE I" },
    ],
    education: [{ degree: "BS CS", school: "Rice" }],
  }
  const p = projectParsedDocToResumeProfile(raw)
  assert.equal(p.name, "Alice")
  assert.equal(p.lastCompany, "Acme")
  assert.equal(p.currentRole, "Senior SWE")
  assert.equal(p.education, "BS CS @ Rice")
  assert.equal(p.yearsExp, 2)
  assert.deepEqual(p.skills, ["Python", "TypeScript", "React"])
})

test("projectParsedDocToResumeProfile returns fallback on empty input", () => {
  const p = projectParsedDocToResumeProfile({})
  assert.equal(p.name, "")
  assert.equal(p.yearsExp, 0)
  assert.deepEqual(p.skills, [])
})

test("projectParsedDocToResumeProfile is robust to non-object input", () => {
  assert.equal(projectParsedDocToResumeProfile(null).name, "")
  assert.equal(projectParsedDocToResumeProfile(undefined).name, "")
  assert.equal(projectParsedDocToResumeProfile("garbage" as unknown).name, "")
})

test("parseResume: writes a stub doc + returns parsedDocId on happy path", async () => {
  const mfs = new MockFirestore()
  const fakeBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF
  let uploadCalled = false
  const out = await parseResume(
    { mediaUrl: "https://sendblue.example/x.pdf", userId: "u-123" },
    {
      db: asFirestore(mfs),
      fetchBytes: async () => ({ bytes: fakeBytes, contentType: "application/pdf" }),
      uploadToBucket: async (bucket, key) => {
        uploadCalled = true
        assert.equal(bucket, "wekruit-resumes")
        assert.match(key, /^u-123\//)
        return { gcsUri: `gs://${bucket}/${key}` }
      },
      nowIso: () => "2026-04-30T00:00:00Z",
    }
  )
  assert.ok(out.parsedDocId)
  assert.equal(uploadCalled, true)
  // The stub doc must be in parsedCandidateResumes with the right userId.
  const writes = mfs.writeLog.filter((w) => w.path === "parsedCandidateResumes")
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.data.userId, "u-123")
  assert.equal(writes[0]?.data.ingestStatus, "uploaded")
})

test("parseResume: fail-soft when fetch errors — emits stub w/ ingestStatus fetch_failed", async () => {
  const mfs = new MockFirestore()
  const out = await parseResume(
    { mediaUrl: "https://broken/", userId: "u-2" },
    {
      db: asFirestore(mfs),
      fetchBytes: async () => {
        throw new Error("net down")
      },
    }
  )
  assert.equal(out.profile.name, "")
  assert.ok(out.parsedDocId)
  const writes = mfs.writeLog.filter((w) => w.path === "parsedCandidateResumes")
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.data.ingestStatus, "fetch_failed")
  assert.match(String(writes[0]?.data.ingestError), /net down/)
})

test("parseResume: skips upload when uploadToBucket dep absent (test path)", async () => {
  const mfs = new MockFirestore()
  const out = await parseResume(
    { mediaUrl: "https://x/", userId: "u-3" },
    {
      db: asFirestore(mfs),
      fetchBytes: async () => ({ bytes: new Uint8Array(2), contentType: "application/pdf" }),
    }
  )
  assert.ok(out.parsedDocId)
  const writes = mfs.writeLog.filter((w) => w.path === "parsedCandidateResumes")
  assert.equal(writes[0]?.data.sourceGcsUri, "")
})

test("parseResume: respects PA_RESUME_BUCKET env override", async () => {
  const mfs = new MockFirestore()
  const orig = process.env.PA_RESUME_BUCKET
  process.env.PA_RESUME_BUCKET = "custom-bucket"
  try {
    let captured = ""
    await parseResume(
      { mediaUrl: "https://x/", userId: "u-4" },
      {
        db: asFirestore(mfs),
        fetchBytes: async () => ({ bytes: new Uint8Array(1) }),
        uploadToBucket: async (b) => {
          captured = b
          return { gcsUri: "gs://custom-bucket/x" }
        },
      }
    )
    assert.equal(captured, "custom-bucket")
  } finally {
    if (orig === undefined) delete process.env.PA_RESUME_BUCKET
    else process.env.PA_RESUME_BUCKET = orig
  }
})

test("createParseResumeTool wires the SDK shape with name + parameters", () => {
  const mfs = new MockFirestore()
  const t = createParseResumeTool({ db: asFirestore(mfs), fetchBytes: async () => ({ bytes: new Uint8Array(0) }) })
  // SDK Tool exposes a .name and .parameters under various property names
  // depending on version. Defensive assertion: at least one of them exists.
  const anyT = t as unknown as { name?: string; parameters?: unknown }
  assert.equal(anyT.name, "parseResume")
  assert.ok(anyT.parameters)
})
