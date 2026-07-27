/**
 * headhunter-mcp shortlist tools — the payload an MCP client ranks from.
 *
 * The failure these guard against is subtle: a row that LOOKS like a weak candidate when it is
 * really a thin record. Measured on the Photon board 2026-07-27, an engineer at Microsoft's Office
 * of the CTO scored 2/4 because we held only her student-era internships — so "no stack signal"
 * had to be distinguishable from "no description on file", and an internship at a tier-A employer
 * had to be distinguishable from a senior role there.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "../job-rec/__tests__/mock-firestore.js"
import {
  runListJobShortlist,
  runGetCandidateEvidence,
  runRecordJobRanking,
  runRecordCandidateReviews,
  runFindJob,
} from "../headhunter-mcp/shortlist.js"

const JOB = "photon-backend-engineer-high-concurrency"

function submission(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    submissionId: id,
    jobId: JOB,
    jobTitleSnapshot: "Backend Engineer",
    candidateId: `user-${id}`,
    candidate: { name: `Cand ${id}`, currentRole: "Software Engineer", currentCompany: "Acme", yoe: "6" },
    aiEvaluation: {
      verdict: "borderline",
      checklist: { hard: { met: 2, total: 4, gaps: ["Concrete implementation evidence"] } },
      research: { companies: [{ name: "Acme", role: "Software Engineer" }], education: [] },
    },
    ...over,
  }
}

async function seed(mfs: MockFirestore, id: string, sub: Record<string, unknown>, user: Record<string, unknown>) {
  await mfs.collection("pa-recruiter-submissions").doc(id).set(sub)
  await mfs.collection("pa-users").doc(`user-${id}`).set(user)
}

describe("list_job_shortlist", () => {
  it("reports every drop with a reason and never truncates silently", async () => {
    const mfs = new MockFirestore()
    await seed(mfs, "keep", submission("keep"), {
      experienceHighlights: [{ title: "SWE", company: "Acme", description: "Built Kafka pipelines." }],
    })
    // No stack, no tier employer, 0/4, nothing described — the only shape the drop fires on.
    await seed(mfs, "drop", submission("drop", {
      aiEvaluation: { verdict: "reject", checklist: { hard: { met: 0, total: 4, gaps: [] } }, research: { companies: [], education: [] } },
    }), { experienceHighlights: [] })

    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: JOB })

    assert.equal(r.totalSubmissions, 2)
    assert.equal(r.returned, 1)
    assert.equal(r.dropped.count, 1)
    assert.equal(r.dropped.reasons.no_evidence_of_any_kind, 1)
    assert.match(r.dropped.sample[0] ?? "", /Cand drop/)
  })

  it("counts an over-limit cut as a reported drop, not a silent slice", async () => {
    const mfs = new MockFirestore()
    for (const n of ["a", "b", "c"]) {
      await seed(mfs, n, submission(n), {
        experienceHighlights: [{ title: "SWE", company: "Acme", description: "Wrote Rust services." }],
      })
    }
    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: JOB, limit: 2 })
    assert.equal(r.returned, 2)
    assert.equal(r.dropped.reasons.over_limit, 1)
    assert.equal(r.dropped.count, 1)
  })

  it("keeps a candidate whose evidence is merely thin — thin is not weak", async () => {
    const mfs = new MockFirestore()
    // No descriptions anywhere, but a real employer in the verified history.
    await seed(mfs, "thin", submission("thin", {
      aiEvaluation: {
        verdict: "borderline",
        checklist: { hard: { met: 0, total: 4, gaps: [] } },
        research: { companies: [{ name: "Microsoft", role: "Senior Software Engineer" }], education: [] },
      },
    }), { experienceHighlights: [{ title: "Senior Software Engineer", company: "Microsoft" }] })

    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: JOB })
    assert.equal(r.returned, 1, "a tier-A employer offsets an empty description — must not be dropped")
    assert.equal(r.rows[0]!.evidence.describedRoles, 0)
    assert.deepEqual(r.rows[0]!.describedStack, [], "no described work -> no stack claimed")
    assert.match(r.evidenceCaveat, /WE HOLD NO DESCRIPTION/)
  })

  it("marks an internship at a tier-A employer as an internship", async () => {
    const mfs = new MockFirestore()
    await seed(mfs, "intern", submission("intern", {
      aiEvaluation: {
        verdict: "borderline",
        checklist: { hard: { met: 1, total: 4, gaps: [] } },
        research: { companies: [{ name: "Google", role: "Software Engineer Intern" }], education: [] },
      },
    }), { experienceHighlights: [{ title: "SWE Intern", company: "Google", description: "Wrote Python tools." }] })

    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: JOB })
    assert.equal(r.rows[0]!.bestEmployer?.tier, "A")
    assert.equal(r.rows[0]!.bestEmployer?.intern, true, "an intern at Google must not read as an engineer at Google")
  })

  it("prefers a real role over an internship at the same tier", async () => {
    const mfs = new MockFirestore()
    await seed(mfs, "both", submission("both", {
      aiEvaluation: {
        verdict: "borderline",
        checklist: { hard: { met: 2, total: 4, gaps: [] } },
        research: {
          companies: [
            { name: "Google", role: "Software Engineer Intern" },
            { name: "Microsoft", role: "Senior Software Engineer" },
          ],
          education: [],
        },
      },
    }), { experienceHighlights: [{ title: "Senior SWE", company: "Microsoft", description: "Golang microservices." }] })

    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: JOB })
    assert.equal(r.rows[0]!.bestEmployer?.name, "Microsoft")
    assert.equal(r.rows[0]!.bestEmployer?.intern, undefined)
  })

  it("does not credit a student chapter as employment at the company it is named after", async () => {
    const mfs = new MockFirestore()
    await seed(mfs, "club", submission("club", {
      aiEvaluation: {
        verdict: "borderline",
        checklist: { hard: { met: 1, total: 4, gaps: [] } },
        research: { companies: [{ name: "Google Developer Group on Campus at USF", role: "Tech Lead" }], education: [] },
      },
    }), { experienceHighlights: [{ title: "Tech Lead", company: "GDG", description: "Ran workshops in Python." }] })

    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: JOB })
    assert.equal(r.rows[0]!.bestEmployer, undefined)
  })

  it("reads stack signals from described work only, never from a job title alone", async () => {
    const mfs = new MockFirestore()
    await seed(mfs, "desc", submission("desc"), {
      experienceHighlights: [
        { title: "Engineer", company: "Acme", description: "Built Rust and TypeScript microservices handling high-concurrency routing." },
      ],
    })
    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: JOB })
    const stack = r.rows[0]!.describedStack
    for (const want of ["rust", "typescript_node", "microservices", "concurrency"]) {
      assert.ok(stack.includes(want), `expected ${want} in ${JSON.stringify(stack)}`)
    }
  })
})

describe("get_candidate_evidence", () => {
  it("returns roles newest-first so a truncated history does not read as intern-only", async () => {
    const mfs = new MockFirestore()
    await seed(mfs, "ord", submission("ord"), {
      // Stored oldest-first, as the enrichment writes it.
      experienceHighlights: [
        { title: "Intern", company: "NASA", startDate: "June 2018", endDate: "August 2018" },
        { title: "Senior Engineer", company: "Microsoft", startDate: "2023", endDate: "now" },
      ],
      tags: { recentRoleTitle: "Senior Engineer", recentCompany: "Microsoft" },
    })
    const ev = await runGetCandidateEvidence({ db: asFirestore(mfs) as never, submissionId: "ord" })
    assert.ok(!("error" in ev))
    assert.equal((ev as { roles: Array<{ title?: string }> }).roles[0]?.title, "Senior Engineer")
  })

  it("returns a typed error for an unknown submission rather than throwing", async () => {
    const mfs = new MockFirestore()
    const ev = await runGetCandidateEvidence({ db: asFirestore(mfs) as never, submissionId: "nope" })
    assert.deepEqual(ev, { error: "submission_not_found:nope" })
  })
})

describe("record_job_ranking", () => {
  it("persists the ranking sorted, and touches no submission status", async () => {
    const mfs = new MockFirestore()
    await seed(mfs, "a", submission("a"), { experienceHighlights: [] })

    const res = await runRecordJobRanking({
      db: asFirestore(mfs) as never,
      jobId: JOB,
      actor: "headhunter-mcp:tester",
      now: "2026-07-27T03:00:00.000Z",
      rationale: "weighted employer calibre over asserted keywords",
      ranking: [
        { submissionId: "b", rank: 2 },
        { submissionId: "a", rank: 1, note: "verified senior role" },
      ],
    })

    assert.equal(res.recorded, 2)
    const doc = (await mfs.collection("pa-job-rankings").doc(res.rankingId).get()).data() ?? {}
    const ranking = doc.ranking as Array<{ submissionId: string; rank: number }>
    assert.deepEqual(ranking.map((r) => r.submissionId), ["a", "b"], "stored in rank order")
    assert.equal(doc.source, "headhunter_mcp")

    // Ranking is an opinion; advancing is a separate decision.
    const sub = (await mfs.collection("pa-recruiter-submissions").doc("a").get()).data() ?? {}
    assert.equal(sub.status, undefined)
  })
})

describe("job brief + review write-back", () => {
  async function seedJobDoc(mfs: MockFirestore) {
    await mfs.collection("pa-jobs").doc(JOB).set({
      title: "Backend Engineer",
      company: "Photon",
      compSummary: "$180-250K",
      descriptionMd: "Build high-concurrency backend systems for messaging, phone and SMS.",
      recruiterBoard: {
        checklist: {
          groups: [
            { kind: "hard", heading: "Hard requirements", items: [{ id: "h1", text: "5+ years hands-on" }] },
            { kind: "anti", heading: "Anti-signals", items: [{ id: "a1", text: "Remote only" }] },
          ],
        },
      },
    })
  }

  it("sends the JD and rubric ONCE per call, not per candidate", async () => {
    const mfs = new MockFirestore()
    await seedJobDoc(mfs)
    await seed(mfs, "a", submission("a"), {
      experienceHighlights: [{ title: "SWE", company: "Acme", description: "Rust services." }],
    })

    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: JOB })
    assert.equal(r.job?.title, "Backend Engineer")
    assert.equal(r.job?.company, "Photon")
    assert.equal(r.job?.compensation, "$180-250K")
    assert.match(r.job?.descriptionMd ?? "", /high-concurrency/)
    const hard = r.job?.checklist.find((g) => g.kind === "hard")
    assert.deepEqual(hard?.items, ["5+ years hands-on"], "the client must see the bar it is judging against")
    assert.ok(r.job?.checklist.some((g) => g.kind === "anti"), "anti-signals must be visible too")
  })

  it("records a review alongside the batch evaluation, never over it", async () => {
    const mfs = new MockFirestore()
    await seedJobDoc(mfs)
    await seed(mfs, "a", submission("a"), { experienceHighlights: [] })

    const res = await runRecordCandidateReviews({
      db: asFirestore(mfs) as never,
      jobId: JOB,
      actor: "headhunter-mcp:tester",
      now: "2026-07-27T04:00:00.000Z",
      model: "claude-opus-5",
      reviews: [{
        submissionId: "a",
        verdict: "reject",
        score: 22,
        needsHumanAttention: false,
        reasons: ["no described backend ownership"],
        dimensions: { experience: "weak", companies: "adequate", school: "unknown", gpa: "unknown", skills: "weak" },
      }],
    })

    assert.equal(res.written, 1)
    assert.deepEqual(res.summary, { advance: 0, borderline: 0, reject: 1, needsAttention: 0 })
    const doc = (await mfs.collection("pa-recruiter-submissions").doc("a").get()).data() ?? {}
    const review = doc.claudeReview as Record<string, unknown>
    assert.equal(review.verdict, "reject")
    assert.equal(review.score, 22)
    assert.equal(review.model, "claude-opus-5")
    // The disagreement between the two judges is the point — the batch verdict must survive.
    assert.equal((doc.aiEvaluation as Record<string, unknown>).verdict, "borderline")
    // A review is an opinion; it must not advance or reject the actual person.
    assert.equal(doc.status, undefined)
  })

  it("refuses to write onto a submission belonging to another job", async () => {
    const mfs = new MockFirestore()
    await seedJobDoc(mfs)
    await mfs.collection("pa-recruiter-submissions").doc("other").set({ ...submission("other"), jobId: "some-other-job" })

    const res = await runRecordCandidateReviews({
      db: asFirestore(mfs) as never,
      jobId: JOB, actor: "t", now: "2026-07-27T04:00:00.000Z",
      reviews: [{ submissionId: "other", verdict: "reject", score: 10, needsHumanAttention: false }],
    })
    assert.equal(res.written, 0)
    assert.match(res.skipped[0]?.reason ?? "", /belongs_to_other_job/)
    assert.equal((await mfs.collection("pa-recruiter-submissions").doc("other").get()).data()?.claudeReview, undefined)
  })

  it("filter='needs_attention' returns only what was flagged, and says what it withheld", async () => {
    const mfs = new MockFirestore()
    await seedJobDoc(mfs)
    for (const n of ["flag", "quiet"]) {
      await seed(mfs, n, submission(n), {
        experienceHighlights: [{ title: "SWE", company: "Acme", description: "Rust services." }],
      })
    }
    await runRecordCandidateReviews({
      db: asFirestore(mfs) as never, jobId: JOB, actor: "t", now: "2026-07-27T04:00:00.000Z",
      reviews: [
        { submissionId: "flag", verdict: "advance", score: 88, needsHumanAttention: true, attentionReason: "rare messaging depth" },
        { submissionId: "quiet", verdict: "reject", score: 15, needsHumanAttention: false },
      ],
    })

    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: JOB, filter: "needs_attention" })
    assert.equal(r.returned, 1)
    assert.equal(r.rows[0]!.name, "Cand flag")
    assert.equal(r.dropped.reasons.not_flagged_for_attention, 1, "withheld rows are reported, not hidden")
  })

  it("filter='unreviewed' lets a partial pass resume without redoing work", async () => {
    const mfs = new MockFirestore()
    await seedJobDoc(mfs)
    for (const n of ["done", "todo"]) {
      await seed(mfs, n, submission(n), {
        experienceHighlights: [{ title: "SWE", company: "Acme", description: "Rust services." }],
      })
    }
    await runRecordCandidateReviews({
      db: asFirestore(mfs) as never, jobId: JOB, actor: "t", now: "2026-07-27T04:00:00.000Z",
      reviews: [{ submissionId: "done", verdict: "reject", score: 20, needsHumanAttention: false }],
    })

    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: JOB, filter: "unreviewed" })
    assert.equal(r.returned, 1)
    assert.equal(r.rows[0]!.name, "Cand todo")
    assert.equal(r.dropped.reasons.already_reviewed, 1)
  })
})

describe("the shortlist payload survives the MCP emitter", () => {
  // capForAgent slices ANY array over 25 rows. Applied to the shortlist it cut 248 candidates to
  // 25 while the body still read `returned: 248` — a confident, complete-looking, wrong view.
  // list_job_shortlist and get_candidate_evidence therefore emit uncapped; they bound and report
  // their own size. This test exists so nobody quietly routes them back through the cap.
  it("capForAgent would gut a large shortlist — proving why the uncapped emitter exists", async () => {
    const { capForAgent } = await import("../headhunter-mcp/tools.js")
    const payload = {
      returned: 248,
      rows: Array.from({ length: 248 }, (_, i) => ({ name: `cand-${i}` })),
    }
    const capped = capForAgent(payload) as { rows: unknown[]; returned: number }
    assert.equal(capped.rows.length, 25)
    assert.equal(capped.returned, 248, "the count stays 248 while only 25 rows survive — the trap")
  })

  it("the shortlist runner itself never exceeds its stated limit", async () => {
    const mfs = new MockFirestore()
    for (let i = 0; i < 40; i++) {
      await seed(mfs, `c${i}`, submission(`c${i}`), {
        experienceHighlights: [{ title: "SWE", company: "Acme", description: "Rust services." }],
      })
    }
    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: JOB, limit: 30 })
    assert.equal(r.rows.length, 30)
    assert.equal(r.returned, 30, "returned must equal rows.length — never a count the payload cannot back")
    assert.equal(r.dropped.reasons.over_limit, 10)
  })
})

describe("find_job", () => {
  async function seedJobs(mfs: MockFirestore) {
    await mfs.collection("pa-jobs").doc("photon-backend-engineer-high-concurrency")
      .set({ title: "Backend Engineer", companyName: "Photon", publicId: "pub-photon" })
    await mfs.collection("pa-jobs").doc("hs-11005382-invoko-product-designer")
      .set({ title: "Product Designer", companyName: "invoko.ai" })
    await mfs.collection("pa-jobs").doc("hyde-ai-builder-nyc")
      .set({ title: "AI Builder (NYC)", companyName: "Hyde" })
  }

  it("resolves plain words", async () => {
    const mfs = new MockFirestore()
    await seedJobs(mfs)
    const r = await runFindJob({ db: asFirestore(mfs) as never, query: "photon backend" })
    assert.equal(r.resolved?.jobId, "photon-backend-engineer-high-concurrency")
    assert.equal(r.resolved?.matchedVia, "title_company")
  })

  it("resolves a pasted URL by any path segment, not just the last", async () => {
    const mfs = new MockFirestore()
    await seedJobs(mfs)
    const r = await runFindJob({
      db: asFirestore(mfs) as never,
      query: "https://wekruit-pa.web.app/admin/recruiter-hub/photon-backend-engineer-high-concurrency?tab=board",
    })
    assert.equal(r.resolved?.jobId, "photon-backend-engineer-high-concurrency")
    assert.equal(r.resolved?.matchedVia, "url_segment")
  })

  it("resolves a publicId", async () => {
    const mfs = new MockFirestore()
    await seedJobs(mfs)
    const r = await runFindJob({ db: asFirestore(mfs) as never, query: "pub-photon" })
    assert.equal(r.resolved?.jobId, "photon-backend-engineer-high-concurrency")
    assert.equal(r.resolved?.matchedVia, "public_id")
  })

  it("returns the options instead of guessing when ambiguous", async () => {
    const mfs = new MockFirestore()
    await seedJobs(mfs)
    await mfs.collection("pa-jobs").doc("photon-ios").set({ title: "iOS Engineer", companyName: "Photon" })
    const r = await runFindJob({ db: asFirestore(mfs) as never, query: "photon" })
    assert.equal(r.resolved, undefined, "guessing here would score a pool against the wrong rubric")
    assert.equal(r.matches.length, 2)
    assert.match(r.note ?? "", /2 jobs matched/)
  })

  it("names the known jobs when nothing matches", async () => {
    const mfs = new MockFirestore()
    await seedJobs(mfs)
    const r = await runFindJob({ db: asFirestore(mfs) as never, query: "quantum blacksmith" })
    assert.deepEqual(r.matches, [])
    assert.match(r.note ?? "", /no job matched/)
    assert.match(r.note ?? "", /Backend Engineer @ Photon/)
  })

  it("list_job_shortlist accepts free text and reports what it resolved", async () => {
    const mfs = new MockFirestore()
    await seedJobs(mfs)
    await seed(mfs, "a", submission("a"), {
      experienceHighlights: [{ title: "SWE", company: "Acme", description: "Rust services." }],
    })
    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: "photon backend" })
    assert.equal(r.jobId, "photon-backend-engineer-high-concurrency")
    assert.match(r.resolvedFrom ?? "", /resolved "photon backend"/)
    assert.equal(r.returned, 1)
  })

  it("an ambiguous query returns jobCandidates rather than a wrong pool", async () => {
    const mfs = new MockFirestore()
    await seedJobs(mfs)
    await mfs.collection("pa-jobs").doc("photon-ios").set({ title: "iOS Engineer", companyName: "Photon" })
    const r = await runListJobShortlist({ db: asFirestore(mfs) as never, jobId: "photon" })
    assert.equal(r.returned, 0)
    assert.equal(r.jobCandidates?.length, 2)
  })
})
