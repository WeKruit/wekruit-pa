/**
 * prescreen-context.test.ts — the résumé + prior-screen grounding loader (task #13).
 *
 * Proves loadPrescreenContext reads the cheapest résumé source first (tags.workHistorySummary), falls
 * back to parsedCandidateResumes, lists ONLY prior TERMINAL screens (excluding the current job + any
 * non-terminal), builds per-qId résumé hints by token overlap, and is fail-soft (never throws).
 */
import { strict as assert } from "node:assert"
import { test } from "node:test"
import { loadPrescreenContext } from "./prescreen-context.js"

/** Minimal in-memory Firestore fake: docRef.get + colRef.where(...).limit(...).get with in-memory match. */
function makeFakeDb(seed: Record<string, Record<string, unknown>> = {}, opts: { throwOn?: string } = {}) {
  const store = new Map(Object.entries(seed))
  let parsedResumesQueried = false
  const matchDocs = (col: string, predicates: Array<[string, string, unknown]>) => {
    const docs: Array<{ id: string; data: () => Record<string, unknown> }> = []
    for (const [key, val] of store.entries()) {
      if (!key.startsWith(`${col}/`)) continue
      const data = val as Record<string, unknown>
      const ok = predicates.every(([f, op, v]) => op === "==" && data[f] === v)
      if (ok) docs.push({ id: key.slice(col.length + 1), data: () => data })
    }
    return docs
  }
  const colRef = (col: string) => {
    if (opts.throwOn === col) {
      return {
        doc: () => ({ async get(): Promise<never> { throw new Error("boom") } }),
        where() { return this },
        limit() { return this },
        async get(): Promise<never> { throw new Error("boom") },
      }
    }
    const predicates: Array<[string, string, unknown]> = []
    const q: Record<string, unknown> = {
      where(f: string, op: string, v: unknown) {
        predicates.push([f, op, v])
        return q
      },
      limit() {
        return q
      },
      async get() {
        if (col === "parsedCandidateResumes") parsedResumesQueried = true
        const docs = matchDocs(col, predicates)
        return { docs, empty: docs.length === 0, size: docs.length }
      },
    }
    return {
      doc: (id: string) => ({
        async get() {
          const key = `${col}/${id}`
          return { exists: store.has(key), id, data: () => store.get(key) }
        },
      }),
      ...q,
    }
  }
  return { db: { collection: colRef } as never, parsedResumesQueried: () => parsedResumesQueried }
}

test("case 1: tags.workHistorySummary present → arc + first name; parsedCandidateResumes NOT queried", async () => {
  const f = makeFakeDb({
    "pa-users/u1": {
      displayName: "Shixiang Chen",
      tags: { workHistorySummary: "SWE Intern @ Tesla; Founder @ AI Study", skills: ["react", "typescript", "node"] },
    },
  })
  const r = await loadPrescreenContext(f.db, "u1", "jobX")
  assert.match(r.contextText, /Shixiang/)
  assert.match(r.contextText, /SWE Intern @ Tesla/)
  assert.match(r.contextText, /react/)
  assert.equal(f.parsedResumesQueried(), false, "must not query parsedCandidateResumes when tags arc present")
})

test("case 2: no workHistorySummary → parsedCandidateResumes experiences + summary fallback", async () => {
  const f = makeFakeDb({
    "pa-users/u2": { displayName: "Jane Doe", tags: { skills: [] } },
    "pcr1": {}, // unused
    "parsedCandidateResumes/pcr1": {
      userId: "u2",
      summary: "Full-stack engineer.",
      experiences: [
        { title: "Frontend Eng", company: "Acme" },
        { title: "Intern", company: "Beta" },
      ],
      topSkills: ["vue", "go"],
    },
  })
  const r = await loadPrescreenContext(f.db, "u2", "jobX")
  assert.equal(f.parsedResumesQueried(), true)
  assert.match(r.contextText, /Frontend Eng @ Acme/)
  assert.match(r.contextText, /vue/)
})

test("case 3: prior sessions listed (terminal only, current job + non-terminal excluded) with evidence", async () => {
  const f = makeFakeDb({
    "pa-users/u3": { displayName: "Sam", tags: { workHistorySummary: "Designer arc" } },
    "pa-prescreen-sessions/sA": {
      userId: "u3",
      jobId: "jobA",
      terminal: "PASS",
      createdAt: "2026-05-01",
      cfgSnapshot: { jobTitle: "Frontend Eng", company: "Acme" },
      questions: {
        q1: { scored: { aggregate: 0.9 }, evidenceReplies: ["built the design-system in 3 weeks"] },
      },
    },
    "pa-prescreen-sessions/sB": {
      userId: "u3",
      jobId: "jobB",
      terminal: "FAIL",
      createdAt: "2026-04-01",
      cfgSnapshot: { jobTitle: "Product Designer", company: "Invoko" },
      questions: { q1: { scored: { aggregate: 0.4 }, evidenceReplies: ["led the redesign of onboarding"] } },
    },
    "pa-prescreen-sessions/sCurrent": { userId: "u3", jobId: "jobCur", terminal: "PASS", createdAt: "2026-05-20" },
    "pa-prescreen-sessions/sActive": { userId: "u3", jobId: "jobC", terminal: null, createdAt: "2026-05-25" },
  })
  const r = await loadPrescreenContext(f.db, "u3", "jobCur")
  assert.match(r.contextText, /Frontend Eng @ Acme \(PASS\)/)
  assert.match(r.contextText, /design-system in 3 weeks/)
  assert.match(r.contextText, /Product Designer @ Invoko \(FAIL\)/)
  assert.doesNotMatch(r.contextText, /jobCur/, "current job session excluded")
  assert.doesNotMatch(r.contextText, /jobC\b/, "non-terminal session excluded")
})

test("case 4: questionDirections → resumeHintByQId maps overlap, omits non-overlap", async () => {
  const f = makeFakeDb({
    "pa-users/u4": {
      displayName: "Lee",
      tags: {
        workHistorySummary: "shipped checkout flow",
        recentRoleTitle: "Full-stack Engineer",
        recentCompany: "Tesla",
        skills: ["react", "payments"],
      },
    },
  })
  const r = await loadPrescreenContext(f.db, "u4", "jobX", {
    q_fullstack: "Tell me about a full-stack engineer role you owned",
    q_unrelated: "Describe your experience leading a marketing campaign",
  })
  assert.ok(r.resumeHintByQId.q_fullstack, "overlapping qId should get a hint")
  assert.match(r.resumeHintByQId.q_fullstack!, /Full-stack Engineer @ Tesla|react|payments/i)
  assert.equal(r.resumeHintByQId.q_unrelated, undefined, "non-overlapping qId omitted")
})

test("case 5: FAIL-SOFT — db throws → { contextText:'', resumeHintByQId:{} } (no throw)", async () => {
  const f = makeFakeDb({ "pa-users/u5": { tags: { workHistorySummary: "x" } } }, { throwOn: "pa-users" })
  const r = await loadPrescreenContext(f.db, "u5", "jobX", { q1: "anything" })
  assert.equal(r.contextText, "")
  assert.deepEqual(r.resumeHintByQId, {})
})

test("case 6: empty everything → contextText '' (so the prompt adds nothing)", async () => {
  const f = makeFakeDb({ "pa-users/u6": {} })
  const r = await loadPrescreenContext(f.db, "u6", "jobX")
  assert.equal(r.contextText, "")
})
