import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildRoleCatalogueText, buildRecommendUserText, runRecommendRoles } from "../admin-recommend-roles.js"

/** Minimal Firestore stand-in: one submission doc + a pa-jobs collection. */
function makeDb(args: {
  submission: Record<string, unknown> | null
  jobs: Array<{ id: string; data: Record<string, unknown> }>
  onWrite?: (patch: Record<string, unknown>) => void
}) {
  const jobDocs = args.jobs.map((j) => ({ id: j.id, exists: true, data: () => j.data }))
  return {
    collection(name: string) {
      if (name === "pa-jobs") return { limit: () => ({ get: async () => ({ docs: jobDocs }) }) }
      return {
        doc: () => ({
          get: async () => ({ exists: args.submission !== null, data: () => args.submission ?? {} }),
          set: async (patch: Record<string, unknown>) => { args.onWrite?.(patch) },
        }),
      }
    },
  } as never
}

const hardJob = (id: string, title: string, company: string, hard: string[], status = "active") => ({
  id,
  data: {
    title,
    companyName: company,
    status,
    recruiterBoard: {
      checklist: { groups: [{ kind: "hard", heading: "Hard", items: hard.map((t, i) => ({ id: `${id}-h${i}`, text: t })) }] },
    },
  },
})

const SUBMISSION = {
  jobId: "photon-be",
  jobTitleSnapshot: "Backend Engineer",
  candidate: { name: "Sam Okonkwo", currentRole: "Engineer", notes: "Built an SMS router at Tessell." },
  aiEvaluation: { research: { companies: [{ name: "Tessell", role: "Engineer" }] } },
}

const CATALOGUE = [
  hardJob("photon-be", "Backend Engineer", "Photon", ["5 years"]),
  hardJob("sekai-tl", "Technical Lead", "Sekai", ["8+ years"]),
  hardJob("vc-founding", "Founding Engineer", "VoiceCursor", ["0 to 1"], ""), // no status — must NOT be treated as closed
  hardJob("no-rubric", "Ghost Role", "Nowhere", []),
  hardJob("closed-one", "Closed Role", "X", ["x"], "inactive"),
]

const stubModel = (recommendations: unknown) =>
  (async () => ({ rawJson: JSON.stringify({ recommendations }), usedTier: "primary", usedModel: "stub-model" })) as never

describe("role recommendations — catalogue + prompt", () => {
  it("lists each role's hard requirements under its jobId", () => {
    const text = buildRoleCatalogueText([
      { id: "sekai-tl", title: "Technical Lead", company: "Sekai", hard: ["8+ years", "Owned a platform"], fit: ["Rust"] },
    ])
    assert.match(text, /jobId: sekai-tl/)
    assert.match(text, /Technical Lead @ Sekai/)
    assert.match(text, /- 8\+ years/)
    assert.match(text, /Strong-fit signals: Rust/)
  })

  it("names the source role as excluded and admits when there is no résumé", () => {
    const text = buildRecommendUserText({
      candidate: { name: "Sam" },
      notes: "",
      currentRoleLabel: "Backend Engineer",
      catalogue: "(roles)",
      topN: 5,
    })
    assert.match(text, /submitted for: Backend Engineer\. Do NOT include that role/)
    assert.match(text, /no résumé available/)
  })
})

describe("role recommendations — runner", () => {
  const run = async (recommendations: unknown, over: Partial<Parameters<typeof makeDb>[0]> = {}) => {
    const writes: Record<string, unknown>[] = []
    const db = makeDb({ submission: SUBMISSION, jobs: CATALOGUE, onWrite: (p) => writes.push(p), ...over })
    const res = await runRecommendRoles(
      { db, openaiKey: "k", nowIso: () => "2026-07-26T00:00:00.000Z", fetchResumeText: async () => undefined, callModel: stubModel(recommendations) },
      { submissionId: "s1" },
    )
    return { res, writes }
  }

  it("excludes the source role, rubric-less roles and closed roles — but keeps a status-less role", async () => {
    let seenUserText = ""
    const db = makeDb({ submission: SUBMISSION, jobs: CATALOGUE })
    await runRecommendRoles(
      {
        db,
        openaiKey: "k",
        fetchResumeText: async () => undefined,
        callModel: (async (a: { userText: string }) => {
          seenUserText = a.userText
          return { rawJson: JSON.stringify({ recommendations: [] }), usedTier: "primary", usedModel: "stub" }
        }) as never,
      },
      { submissionId: "s1" },
    )
    assert.doesNotMatch(seenUserText, /jobId: photon-be/, "source role must not be offered back")
    assert.doesNotMatch(seenUserText, /Ghost Role/, "a role with no rubric has no bar to judge")
    assert.doesNotMatch(seenUserText, /Closed Role/)
    assert.match(seenUserText, /jobId: vc-founding/, "a job with no status is open, not closed")
  })

  it("drops a hallucinated jobId rather than sending an operator to pitch a role that does not exist", async () => {
    const { res } = await run([
      { jobId: "sekai-tl", fitScore: 0.9, whyFits: "owned a router", whatsMissing: "" },
      { jobId: "does-not-exist", fitScore: 0.95, whyFits: "invented", whatsMissing: "" },
    ])
    assert.equal(res.ok, true)
    assert.deepEqual(res.ok && res.result.items.map((i) => i.jobId), ["sekai-tl"])
  })

  it("drops sub-threshold fits and ranks the rest best-first", async () => {
    const { res } = await run([
      { jobId: "sekai-tl", fitScore: 0.62, whyFits: "a", whatsMissing: "" },
      { jobId: "vc-founding", fitScore: 0.88, whyFits: "b", whatsMissing: "" },
      { jobId: "closed-one", fitScore: 0.49, whyFits: "c", whatsMissing: "" },
    ])
    assert.equal(res.ok, true)
    assert.deepEqual(res.ok && res.result.items.map((i) => i.jobId), ["vc-founding", "sekai-tl"])
  })

  it("keeps an empty list empty — a padded recommendation costs a wasted pitch", async () => {
    const { res, writes } = await run([])
    assert.equal(res.ok, true)
    assert.deepEqual(res.ok && res.result.items, [])
    assert.equal(writes.length, 1, "still persists, so the UI can show 'checked, nothing fits'")
  })

  it("writes only roleRecommendations — never a status", async () => {
    const { writes } = await run([{ jobId: "sekai-tl", fitScore: 0.9, whyFits: "x", whatsMissing: "" }])
    assert.deepEqual(Object.keys(writes[0] ?? {}), ["roleRecommendations"])
  })

  it("returns the cached doc without calling the model when the source role matches", async () => {
    const items = [{ jobId: "sekai-tl", title: "Technical Lead", company: "Sekai", fitScore: 0.8, whyFits: "x", whatsMissing: "" }]
    const db = makeDb({
      submission: { ...SUBMISSION, roleRecommendations: { generatedAt: "t", model: "m", sourceJobId: "photon-be", candidateRoleCount: 1, items } },
      jobs: [],
    })
    const res = await runRecommendRoles(
      { db, openaiKey: "k", callModel: (() => { throw new Error("model must not be called on a cache hit") }) as never },
      { submissionId: "s1" },
    )
    assert.equal(res.ok && res.cached, true)
    assert.deepEqual(res.ok && res.result.items, items)
  })

  it("ignores a cache built for a different source role", async () => {
    const db = makeDb({
      submission: { ...SUBMISSION, roleRecommendations: { generatedAt: "t", model: "m", sourceJobId: "some-other-job", candidateRoleCount: 1, items: [] } },
      jobs: CATALOGUE,
    })
    const res = await runRecommendRoles(
      { db, openaiKey: "k", fetchResumeText: async () => undefined, callModel: stubModel([{ jobId: "sekai-tl", fitScore: 0.9, whyFits: "x", whatsMissing: "" }]) },
      { submissionId: "s1" },
    )
    assert.equal(res.ok && res.cached, false)
  })

  it("reports a missing submission instead of throwing", async () => {
    const db = makeDb({ submission: null, jobs: [] })
    const res = await runRecommendRoles({ db, openaiKey: "k" }, { submissionId: "nope" })
    assert.deepEqual(res, { ok: false, reason: "submission_not_found" })
  })

  it("reports an empty catalogue instead of asking the model to rank nothing", async () => {
    const db = makeDb({ submission: SUBMISSION, jobs: [hardJob("photon-be", "Backend Engineer", "Photon", ["5 years"])] })
    const res = await runRecommendRoles({ db, openaiKey: "k", fetchResumeText: async () => undefined }, { submissionId: "s1" })
    assert.deepEqual(res, { ok: false, reason: "no_other_roles_with_a_rubric" })
  })
})
