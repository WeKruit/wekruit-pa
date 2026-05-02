/**
 * Stream H6 — backfill-user-embeddings unit tests.
 *
 * No live Firestore. Inject FsPort + EmbedPort fakes and assert: text
 * synthesis fidelity, dry-run skips OpenAI, idempotent skip on existing
 * 1536-d, write payload contains all 5 required fields, allowlist source
 * resolves users.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  parseArgs,
  synthesizeResumeText,
  runBackfill,
  type FsPort,
  type EmbedPort,
} from "../backfill-user-embeddings.js"

// ---- helpers ---------------------------------------------------------------

function makeFakeFs(opts: {
  resumes?: Record<string, { resumeId: string; raw: Record<string, unknown> }>
  allowlist?: string[]
}) {
  const writes: Array<{ resumeId: string; payload: Record<string, unknown> }> = []
  const fs: FsPort = {
    async loadLatestResume(userId) {
      return opts.resumes?.[userId] ?? null
    },
    async writeEmbedding(resumeId, payload) {
      writes.push({ resumeId, payload })
    },
    async loadAllowlist() {
      return opts.allowlist ?? []
    },
  }
  return { fs, writes }
}

function makeFakeEmbedder(dim = 1536, calls?: { count: number }): EmbedPort {
  return {
    async embed(_text: string) {
      if (calls) calls.count += 1
      // Deterministic non-zero vector at requested dimension.
      const out: number[] = new Array(dim)
      for (let i = 0; i < dim; i++) out[i] = (i % 7) * 0.001 + 0.5
      return out
    },
  }
}

// ---- tests -----------------------------------------------------------------

describe("Stream H6 — backfill-user-embeddings", () => {
  it("parseArgs: --user repeats accumulate; defaults to --from-allowlist", () => {
    const a = parseArgs(["--user=a", "--user=b"])
    assert.deepEqual(a.users, ["a", "b"])
    assert.equal(a.fromAllowlist, false, "explicit --user should NOT auto-enable allowlist")
    const b = parseArgs([])
    assert.equal(b.fromAllowlist, true, "empty argv defaults to --from-allowlist")
    const c = parseArgs(["--dry-run", "--force"])
    assert.equal(c.dryRun, true)
    assert.equal(c.force, true)
  })

  it("synthesizeResumeText: covers name + skills + recent role + education + tags; bilingual location ok", () => {
    const text = synthesizeResumeText({
      candidateProfile: {
        name: "Qitong Liang",
        location: "Baltimore,MD",
        skills: ["SQL", "Python", "Machine Learning"],
      },
      experiences: [
        {
          title: "Data Analyst Intern",
          company: "NEUROVA Inc",
          startDate: "Aug 2025",
          endDate: "Oct 2025",
          description: "Built ETL pipelines, A/B-tested recommender features.",
        },
      ],
      education: [{ school: "Johns Hopkins", degree: "MS", field: "Data Science" }],
      industryTags: ["tech_software", "ai_ml", "fintech_finance"],
    })
    assert.ok(text)
    assert.match(text!, /Name: Qitong Liang/)
    assert.match(text!, /Location: Baltimore,MD/)
    assert.match(text!, /Skills: SQL, Python, Machine Learning/)
    assert.match(text!, /Recent role: Data Analyst Intern at NEUROVA Inc/)
    assert.match(text!, /Achievements: Built ETL pipelines/)
    assert.match(text!, /Education: Johns Hopkins MS Data Science/)
    assert.match(text!, /Industry tags: tech_software, ai_ml, fintech_finance/)
  })

  it("synthesizeResumeText: returns null on empty doc + handles missing endDate as 'present'", () => {
    assert.equal(synthesizeResumeText({}), null)
    const text = synthesizeResumeText({
      candidateProfile: { name: "X", skills: ["python"] },
      experiences: [{ title: "SWE", company: "Co", startDate: "2024" }], // no endDate
    })
    assert.ok(text)
    assert.match(text!, /\(2024–present\)/)
  })

  it("runBackfill: dry-run skips embedder + skips existing 1536-d; allowlist resolution works", async () => {
    const { fs } = makeFakeFs({
      allowlist: ["u1", "u2"],
      resumes: {
        u1: {
          resumeId: "r1",
          raw: {
            // Already has 1536-d embedding — should skip.
            embedding: new Array(1536).fill(0.1),
            embeddingDim: 1536,
            candidateProfile: { name: "U1", skills: ["x"] },
            experiences: [{ title: "T", company: "C", startDate: "2024" }],
          },
        },
        u2: {
          resumeId: "r2",
          raw: {
            candidateProfile: { name: "U2", skills: ["y"] },
            experiences: [{ title: "T", company: "C", startDate: "2024" }],
            industryTags: ["tech_software"],
          },
        },
      },
    })
    const calls = { count: 0 }
    const embedder = makeFakeEmbedder(1536, calls)
    const out = await runBackfill(
      { users: [], fromAllowlist: true, dryRun: true, force: false },
      fs,
      embedder
    )
    assert.equal(calls.count, 0, "dry-run must NOT call embedder")
    assert.equal(out.skippedAlreadyHas, 1, "u1 has 1536-d — skipped")
    assert.equal(out.scanned, 2)
    const u2Row = out.perUser.find((p) => p.userId === "u2")
    assert.equal(u2Row?.status, "would_embed")
  })

  it("runBackfill: live path writes 5-field payload + reports embedded count", async () => {
    const { fs, writes } = makeFakeFs({
      resumes: {
        adam: {
          resumeId: "rAdam",
          raw: {
            candidateProfile: {
              name: "Adam",
              location: "Baltimore,MD",
              skills: ["python", "ml"],
            },
            experiences: [
              {
                title: "Data Analyst",
                company: "NEUROVA",
                startDate: "2025",
                endDate: "2025",
                description: "ETL + ML pipelines.",
              },
            ],
            industryTags: ["tech_software", "ai_ml"],
          },
        },
      },
    })
    const embedder = makeFakeEmbedder(1536)
    const out = await runBackfill(
      { users: ["adam"], fromAllowlist: false, dryRun: false, force: false },
      fs,
      embedder,
      () => {},
      () => "2026-05-01T22:00:00.000Z"
    )
    assert.equal(out.embedded, 1)
    assert.equal(out.errors, 0)
    assert.equal(writes.length, 1)
    const w = writes[0]!
    assert.equal(w.resumeId, "rAdam")
    assert.equal((w.payload.embedding as number[]).length, 1536)
    assert.equal(w.payload.embeddingModel, "text-embedding-3-small")
    assert.equal(w.payload.embeddingDim, 1536)
    assert.equal(w.payload.embeddingComputedAt, "2026-05-01T22:00:00.000Z")
    assert.ok(typeof w.payload.resumeText === "string")
    assert.match(w.payload.resumeText as string, /Industry tags: tech_software, ai_ml/)
  })

  it("runBackfill: skips users with no resume row (skip_no_resume) without error", async () => {
    const { fs, writes } = makeFakeFs({ resumes: {} })
    const embedder = makeFakeEmbedder()
    const out = await runBackfill(
      { users: ["ghost"], fromAllowlist: false, dryRun: false, force: false },
      fs,
      embedder
    )
    assert.equal(out.scanned, 1)
    assert.equal(out.skippedNoResume, 1)
    assert.equal(out.errors, 0)
    assert.equal(writes.length, 0)
    assert.equal(out.perUser[0]?.status, "skip_no_resume")
  })
})
