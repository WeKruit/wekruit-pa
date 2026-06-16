import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { runPrescreenCandidateEval, summarizeChecklistEval } from "./prescreen-candidate-eval.js"
import type { CoresignalEmployeeCollectV2 } from "@pa/external-supply"

const NOW = "2026-06-14T19:00:00.000Z"

type Doc = Record<string, unknown>

/** Mock Firestore: collection/doc/get/set + a doc().collection() returning empty (transcript). */
function makeDb(seed: Record<string, Record<string, Doc>>): { db: Firestore; stores: Map<string, Map<string, Doc>> } {
  const stores = new Map<string, Map<string, Doc>>()
  for (const [c, rows] of Object.entries(seed)) stores.set(c, new Map(Object.entries(rows)))
  const bucket = (c: string) => { if (!stores.has(c)) stores.set(c, new Map()); return stores.get(c)! }
  function collection(name: string): unknown {
    return {
      doc(id: string) {
        return {
          async get() { const d = bucket(name).get(id); return { exists: d !== undefined, data: () => d, id } },
          async set(v: Doc, o?: { merge?: boolean }) {
            const prev = (bucket(name).get(id) ?? {}) as Doc
            if (o?.merge) {
              // shallow-merge top level, deep-merge `review` so candidateChecklistEval + autoDraft coexist
              const merged: Doc = { ...prev, ...v }
              if (prev.review && (v as Doc).review) merged.review = { ...(prev.review as Doc), ...((v as Doc).review as Doc) }
              bucket(name).set(id, merged)
            } else bucket(name).set(id, { ...v })
          },
          collection() {
            return { orderBy() { return { limit() { return { async get() { return { docs: [] } } } } } } }
          },
        }
      },
      where() { return { limit() { return { async get() { return { docs: [] } } } } } },
    }
  }
  return { db: { collection } as unknown as Firestore, stores }
}

const checklistGroups = [
  { kind: "hard", heading: "Must have", items: [{ id: "h1", text: "5+ yrs backend in production" }] },
  { kind: "fit", heading: "Ideal", items: [{ id: "f1", text: "TypeScript depth" }] },
  { kind: "anti", heading: "Red flags", items: [{ id: "a1", text: "only prompt demos" }] },
  { kind: "bonus", heading: "Nice", items: [{ id: "b1", text: "open source" }] },
]

function seed(extraSession: Doc = {}): Record<string, Record<string, Doc>> {
  return {
    "pa-prescreen-sessions": {
      "ps-1": {
        sessionId: "ps-1", userId: "cand-1", jobId: "job-1",
        terminal: "HARD_STOP", terminalActionPendingReview: true,
        evaluationAttemptId: "att-1", score: 0.2, scoreMax: 1,
        review: { proposedTerminal: "HARD_STOP", status: "pending" },
        ...extraSession,
      },
    },
    "pa-users": { "cand-1": { linkedinUrl: "https://www.linkedin.com/in/cand", recentRoleTitle: "Backend Intern" } },
    "pa-jobs": {
      "job-1": {
        recruiterBoard: { label: { title: "Senior Backend Engineer", company: "Acme" }, checklist: { groups: checklistGroups } },
      },
    },
  }
}

const employee = {
  id: 7, headline: "Backend Intern", linkedin_url: "https://www.linkedin.com/in/cand",
  experience: [{ company_name: "SmallCo", title: "Intern", date_from: "2025", active_experience: 1 }],
  education: [{ institution_name: "State U", degree: "BS CS" }],
  inferred_skills: ["node"],
} as unknown as CoresignalEmployeeCollectV2

const JUDGMENT = JSON.stringify({
  verdict: "reject", confidence: 0.8, summary: "Under-qualified for a senior backend role.",
  reasons: ["only intern-level backend"],
  checklist: {
    hard: { met: 0, total: 1, gaps: ["5+ yrs backend in production"] },
    fit: { met: 0, total: 1, gaps: ["TypeScript depth"] },
    bonus: { met: 0, total: 1, gaps: ["open source"] },
    anti: { flagged: 1, total: 1, flags: ["only prompt demos"] },
  },
  background: {
    school: { verdict: "weak", evidence: "State U" }, gpa: { verdict: "unknown", evidence: "not stated" },
    degree: { verdict: "strong", evidence: "BS CS" }, company: { verdict: "weak", evidence: "SmallCo" },
  },
})

describe("prescreen-candidate-eval", () => {
  it("enriches via Coresignal, judges vs the job checklist, stores it, and folds it into the draft", async () => {
    const { db, stores } = makeDb(seed())
    let judgeCalls = 0
    const redrafts: Array<Record<string, unknown>> = []
    const res = await runPrescreenCandidateEval("ps-1", {
      db, now: () => NOW,
      callJudge: async (a) => { judgeCalls += 1; assert.match(a.userText, /5\+ yrs backend/); assert.match(a.userText, /Prescreen transcript/); return { rawJson: JUDGMENT, usedModel: "gpt-5.4-nano" } },
      research: { apiKey: "k", searchEmployeeIdByLinkedinUrl: async () => 7, fetchEmployeeCollect: async () => employee },
      regenerateDraft: (async (args: Record<string, unknown>) => { redrafts.push(args); return { stored: true } }) as never,
    })
    assert.equal(res.status, "written")
    assert.equal(judgeCalls, 1)
    const stored = (stores.get("pa-prescreen-sessions")!.get("ps-1")!.review as Record<string, unknown>).candidateChecklistEval as Record<string, unknown>
    assert.ok(stored, "candidateChecklistEval stored")
    assert.equal(stored.verdict, "reject")
    assert.equal(stored.enriched, true)
    assert.equal(stored.jobId, "job-1")
    assert.equal(stored.candidateId, "cand-1")
    assert.ok((stored.research as Record<string, unknown>) !== undefined, "research attached")
    // per-item checklist detail (the recruiter-page-style requirements view)
    const detail = stored.checklistDetail as Array<{ kind: string; items: Array<{ text: string; status: string }> }>
    assert.ok(Array.isArray(detail) && detail.length === 4, "checklistDetail has all 4 tiers")
    const hard = detail.find((g) => g.kind === "hard")!
    assert.equal(hard.items[0].status, "gap", "the unmet hard item (in gaps) is marked gap")
    const anti = detail.find((g) => g.kind === "anti")!
    assert.equal(anti.items[0].status, "flag", "the flagged anti item is marked flag")
    // folded into the draft
    assert.equal(redrafts.length, 1)
    assert.match(String(redrafts[0]!.candidateChecklistSummary), /Hard 0\/1/)
    assert.match(String(redrafts[0]!.candidateChecklistSummary), /verdict=reject/)
    assert.equal(redrafts[0]!.terminal, "HARD_STOP")
  })

  it("judges transcript-only when there is no LinkedIn (enriched=false), still stores", async () => {
    const s = seed()
    s["pa-users"]["cand-1"] = { recentRoleTitle: "Intern" } // no linkedinUrl
    const { db, stores } = makeDb(s)
    const res = await runPrescreenCandidateEval("ps-1", {
      db, now: () => NOW,
      callJudge: async () => ({ rawJson: JUDGMENT, usedModel: "gpt-5.4-nano" }),
      research: { apiKey: "k", searchEmployeeIdByLinkedinUrl: async () => { throw new Error("should not be called") }, fetchEmployeeCollect: async () => employee },
      regenerateDraft: (async () => ({ stored: true })) as never,
    })
    assert.equal(res.status, "written")
    const stored = (stores.get("pa-prescreen-sessions")!.get("ps-1")!.review as Record<string, unknown>).candidateChecklistEval as Record<string, unknown>
    assert.equal(stored.enriched, false)
    assert.equal(stored.research, undefined)
  })

  it("uses the résumé / merged profile when there is no LinkedIn (enriched=true from résumé)", async () => {
    const s = seed()
    // no LinkedIn, but a merged LinkedIn+résumé experience on file
    s["pa-users"]["cand-1"] = {
      experienceHighlights: [
        { title: "Senior Software Engineer", company: "Tesla", startDate: "2026", currentRole: true, sourceLabel: "LinkedIn+Résumé" },
      ],
    }
    const { db, stores } = makeDb(s)
    let sawResume = false
    const res = await runPrescreenCandidateEval("ps-1", {
      db, now: () => NOW,
      callJudge: async (a) => { sawResume = /Tesla/.test(a.userText) && /merged LinkedIn\+résumé profile/.test(a.userText); return { rawJson: JUDGMENT, usedModel: "m" } },
      research: { apiKey: null, searchEmployeeIdByLinkedinUrl: async () => null, fetchEmployeeCollect: async () => employee },
      regenerateDraft: (async () => ({ stored: true })) as never,
    })
    assert.equal(res.status, "written")
    assert.ok(sawResume, "the résumé / merged profile was fed to the judge")
    const stored = (stores.get("pa-prescreen-sessions")!.get("ps-1")!.review as Record<string, unknown>).candidateChecklistEval as Record<string, unknown>
    assert.equal(stored.enriched, true, "résumé-only candidate is still profile-grounded")
  })

  it("evaluates background pillars even with NO job checklist (profile evidence present)", async () => {
    // A job with no recruiter checklist must STILL get the background pillars (school/degree/
    // company/gpa) + school prior — the eval no longer skips just because there's no checklist.
    const s = seed()
    s["pa-jobs"]["job-1"] = { recruiterBoard: { label: { title: "X" } } } // no checklist groups
    const { db, stores } = makeDb(s)
    let judged = false
    const res = await runPrescreenCandidateEval("ps-1", {
      db, now: () => NOW,
      callJudge: async () => { judged = true; return { rawJson: JUDGMENT, usedModel: "m" } },
      research: { apiKey: "k", searchEmployeeIdByLinkedinUrl: async () => 7, fetchEmployeeCollect: async () => employee },
      regenerateDraft: (async () => ({ stored: true })) as never,
    })
    assert.equal(res.status, "written")
    assert.ok(judged, "the judge runs to produce background pillars even without a checklist")
    const stored = (stores.get("pa-prescreen-sessions")!.get("ps-1")!.review as Record<string, unknown>).candidateChecklistEval as Record<string, unknown>
    assert.ok(stored.background, "background pillars stored even with no checklist")
  })

  it("skips only when there is no checklist AND no profile evidence", async () => {
    const s = seed()
    s["pa-jobs"]["job-1"] = { recruiterBoard: { label: { title: "X" } } } // no checklist groups
    s["pa-users"]["cand-1"] = {} // no LinkedIn, no merged experience → no profile evidence
    const { db } = makeDb(s)
    const res = await runPrescreenCandidateEval("ps-1", {
      db, now: () => NOW,
      callJudge: async () => { throw new Error("judge should not run") },
      // No linkedinUrl on the user → research is never fetched; these are type-valid no-ops.
      research: { apiKey: null, searchEmployeeIdByLinkedinUrl: async () => null, fetchEmployeeCollect: async () => employee },
    })
    assert.equal(res.status, "skipped_no_job_checklist")
  })

  it("is idempotent — skips a session already evaluated", async () => {
    const { db } = makeDb(seed({ review: { proposedTerminal: "HARD_STOP", candidateChecklistEval: { verdict: "reject" } } }))
    const res = await runPrescreenCandidateEval("ps-1", {
      db, now: () => NOW,
      callJudge: async () => { throw new Error("should not run") },
      research: { apiKey: "k", searchEmployeeIdByLinkedinUrl: async () => 7, fetchEmployeeCollect: async () => employee },
    })
    assert.equal(res.status, "skipped_existing")
  })

  it("skips a session not pending review", async () => {
    const { db } = makeDb(seed({ terminalActionPendingReview: false }))
    const res = await runPrescreenCandidateEval("ps-1", {
      db, now: () => NOW,
      callJudge: async () => { throw new Error("nope") },
      research: { apiKey: "k", searchEmployeeIdByLinkedinUrl: async () => 7, fetchEmployeeCollect: async () => employee },
    })
    assert.equal(res.status, "skipped_not_pending")
  })

  it("is fail-open — a judge error yields status error, no throw, no write", async () => {
    const { db, stores } = makeDb(seed())
    const res = await runPrescreenCandidateEval("ps-1", {
      db, now: () => NOW,
      callJudge: async () => { throw new Error("LLM down") },
      research: { apiKey: "k", searchEmployeeIdByLinkedinUrl: async () => 7, fetchEmployeeCollect: async () => employee },
      regenerateDraft: (async () => ({ stored: true })) as never,
    })
    assert.equal(res.status, "error")
    const review = stores.get("pa-prescreen-sessions")!.get("ps-1")!.review as Record<string, unknown>
    assert.equal(review.candidateChecklistEval, undefined)
  })

  it("summarizeChecklistEval renders a compact operator line", () => {
    const line = summarizeChecklistEval({
      verdict: "reject", confidence: 0.8, summary: "weak", reasons: [],
      checklist: { hard: { met: 0, total: 1, gaps: ["X"] }, fit: { met: 0, total: 1, gaps: [] }, bonus: { met: 0, total: 1, gaps: [] }, anti: { flagged: 1, total: 1, flags: ["Y"] } },
      background: { school: { verdict: "weak", evidence: "" }, gpa: { verdict: "unknown", evidence: "" }, degree: { verdict: "strong", evidence: "" }, company: { verdict: "weak", evidence: "" } },
      evaluatedAt: NOW, model: "m", version: "submission-eval-v2", jobId: "j", candidateId: "c", enriched: true, checklistDetail: [],
    })
    assert.match(line, /Hard 0\/1 — gaps: X/)
    assert.match(line, /Anti 1 flag\(s\): Y/)
    assert.match(line, /profile-grounded/)
  })
})
