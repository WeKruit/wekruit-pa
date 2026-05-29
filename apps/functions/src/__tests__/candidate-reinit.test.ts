import { test } from "node:test"
import assert from "node:assert/strict"
import { reinitializeCandidate } from "../candidate-reinit.js"

// Minimal fake Firestore: "col/id" store + where/add/doc/set + batch.
function makeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(Object.entries(seed))
  let auto = 0
  const ref = (col: string, id: string) => ({
    _key: `${col}/${id}`,
    id,
    async get() { return { exists: store.has(`${col}/${id}`), id, data: () => store.get(`${col}/${id}`) } },
    async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
      store.set(`${col}/${id}`, { ...(opts?.merge ? store.get(`${col}/${id}`) || {} : {}), ...data })
    },
  })
  const collection = (col: string) => ({
    doc: (id: string) => ref(col, id),
    where: (field: string, _op: string, val: unknown) => ({
      async get() {
        const docs = [...store.entries()]
          .filter(([k, v]) => k.startsWith(`${col}/`) && (v as Record<string, unknown>)[field] === val)
          .map(([k, v]) => ({ id: k.split("/").slice(1).join("/"), data: () => v }))
        return { docs, size: docs.length, forEach: (f: (d: unknown) => void) => docs.forEach(f) }
      },
    }),
    async add(data: Record<string, unknown>) { const id = `auto${auto++}`; store.set(`${col}/${id}`, data); return { id } },
  })
  const batch = () => {
    const ops: Array<() => void> = []
    return {
      set: (r: { _key: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) =>
        ops.push(() => store.set(r._key, { ...(opts?.merge ? store.get(r._key) || {} : {}), ...data })),
      delete: (r: { _key: string }) => ops.push(() => store.delete(r._key)),
      async commit() { ops.forEach((o) => o()) },
    }
  }
  return { db: { collection, batch } as never, store }
}

const UID = "u1"

test("reinitializeCandidate: archives conversation, clears global profile, preserves résumé+matched-jobs, re-enriches tags", async () => {
  const { db, store } = makeDb({
    [`pa-users/${UID}`]: { id: UID, name: "Dev", tags: { targetRoleFunction: ["product_management"], careerStage: "junior" } },
    [`pa-messages/m1`]: { userId: UID, role: "user", text: "hi" },
    [`pa-messages/m2`]: { userId: UID, role: "assistant", text: "hey" },
    [`parsedCandidateResumes/${UID}`]: { userId: UID, topSkills: [{ name: "python" }, { name: "react" }], industryTags: ["software_and_saas"], totalYearsExperience: 3, experiences: [{ title: "SWE", company: "Tesla", description: "built x" }] },
    [`pa-job-profiles/j1`]: { userId: UID, jobId: "JOB1", score: 0.9 },
    [`pa-job-rec-explanations/e1`]: { userId: UID, jobId: "JOB1", reason: "match" },
    [`pa-prescreen-sessions/ps1`]: { userId: UID, jobId: "JOB1", terminal: null }, // MUST survive untouched
  })

  // clearMemory stub faithfully simulates the real wipe: nukes messages, résumé, job-rec, and tags.
  let clearCalled = false
  const clearMemory = async (userId: string) => {
    clearCalled = true
    for (const k of [...store.keys()]) {
      if (k.startsWith("pa-messages/") || k.startsWith("parsedCandidateResumes/") || k.startsWith("pa-job-profiles/") || k.startsWith("pa-job-rec-explanations/")) {
        if ((store.get(k) as Record<string, unknown>).userId === userId) store.delete(k)
      }
    }
    const u = store.get(`pa-users/${userId}`) as Record<string, unknown>
    if (u) { delete u.tags; delete u.name }
  }

  // mergeUserTags stub: proves the parsed-résumé input is composed + threaded through.
  const mergeUserTagsFn = ((input: { cv?: { candidateProfile?: { skills?: string[] }; totalYearsExperience?: number } }) => ({
    skills: input.cv?.candidateProfile?.skills ?? [],
    yoe: input.cv?.totalYearsExperience,
    targetRoleFunction: ["software_engineering"],
  })) as unknown as Parameters<typeof reinitializeCandidate>[1]["mergeUserTagsFn"]

  const res = await reinitializeCandidate(UID, { db, clearMemory, mergeUserTagsFn, nowIso: () => "2026-01-01T00:00:00Z" })

  // clearMemory ran
  assert.equal(clearCalled, true)
  // conversation archived (2 messages stored in archive, then originals gone)
  assert.equal(res.archivedMessages, 2)
  const archive = [...store.entries()].find(([k]) => k.startsWith("pa-conversation-archives/"))
  assert.ok(archive, "archive doc written")
  assert.equal((archive![1] as { messageCount: number }).messageCount, 2)
  assert.equal([...store.keys()].filter((k) => k.startsWith("pa-messages/")).length, 0, "active messages cleared after archive")

  // résumé PRESERVED (restored after wipe)
  assert.ok(store.has(`parsedCandidateResumes/${UID}`), "résumé restored")
  assert.equal(res.resumePreserved, true)

  // matched jobs / job-rec PRESERVED
  assert.ok(store.has("pa-job-profiles/j1"), "job-profile preserved")
  assert.ok(store.has("pa-job-rec-explanations/e1"), "job-rec-explanation preserved")
  assert.equal(res.jobRecPreserved["pa-job-profiles"], 1)

  // prescreen session UNTOUCHED (module must never clear it)
  assert.ok(store.has("pa-prescreen-sessions/ps1"), "prescreen session preserved")

  // tags RE-ENRICHED from résumé (old product_management gone; résumé-derived present)
  assert.equal(res.reEnriched, true)
  const tags = (store.get(`pa-users/${UID}`) as { tags: Record<string, unknown> }).tags
  assert.deepEqual(tags.skills, ["python", "react"])
  assert.equal(tags.yoe, 3)
  assert.deepEqual(tags.targetRoleFunction, ["software_engineering"])
  assert.equal(res.reEngageMode, "candidate_self_initiates")
})

test("reinitializeCandidate: no résumé on file → clears but reEnriched=false (no crash)", async () => {
  const { db, store } = makeDb({
    [`pa-users/${UID}`]: { id: UID, tags: { x: 1 } },
    [`pa-messages/m1`]: { userId: UID, text: "hi" },
  })
  const clearMemory = async (userId: string) => {
    for (const k of [...store.keys()]) if (k.startsWith("pa-messages/")) store.delete(k)
    delete (store.get(`pa-users/${userId}`) as Record<string, unknown>).tags
  }
  const res = await reinitializeCandidate(UID, { db, clearMemory, nowIso: () => "t" })
  assert.equal(res.reEnriched, false)
  assert.equal(res.resumePreserved, false)
  assert.equal(res.cleared, true)
  assert.ok((store.get(`pa-users/${UID}`) as { reinitializedAt?: string }).reinitializedAt)
})
