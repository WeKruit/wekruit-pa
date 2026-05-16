import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { runPreScreenForUser } from "./prescreen-session-start.js"

type FakeDoc = { exists: boolean; data: Record<string, unknown> }

function makeFakeDb(seed: Record<string, Record<string, unknown>>) {
  const docs = new Map<string, FakeDoc>()
  for (const [path, data] of Object.entries(seed)) docs.set(path, { exists: true, data })
  const sets: Array<{ path: string; data: Record<string, unknown>; options?: unknown }> = []

  function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
  }

  function deepMerge(prev: Record<string, unknown>, next: Record<string, unknown>) {
    const out: Record<string, unknown> = { ...prev }
    for (const [key, value] of Object.entries(next)) {
      if (isPlainObject(value) && isPlainObject(out[key])) {
        out[key] = deepMerge(out[key], value)
      } else {
        out[key] = value
      }
    }
    return out
  }

  function docRef(collection: string, id: string) {
    const path = `${collection}/${id}`
    return {
      id,
      async get() {
        const doc = docs.get(path) ?? { exists: false, data: {} }
        return { exists: doc.exists, data: () => (doc.exists ? doc.data : undefined) }
      },
      async update(data: Record<string, unknown>) {
        const prev = docs.get(path)
        if (!prev?.exists) throw new Error(`not-found:${path}`)
        docs.set(path, { exists: true, data: { ...prev.data, ...data } })
        sets.push({ path, data, options: { update: true } })
      },
      async set(data: Record<string, unknown>, options?: unknown) {
        const prev = docs.get(path)
        const opts = options as { merge?: boolean; mergeFields?: string[] } | undefined
        let next = data
        if (opts?.mergeFields) {
          next = { ...(prev?.data ?? {}) }
          for (const field of opts.mergeFields) {
            next[field] = data[field]
          }
        } else if (opts?.merge) {
          next = deepMerge(prev?.data ?? {}, data)
        }
        docs.set(path, { exists: true, data: next })
        sets.push({ path, data, options })
      },
    }
  }

  const db = {
    collection(collection: string) {
      const filters: Array<{ field: string; value: unknown }> = []
      const query = {
        where(field: string, _op: string, value: unknown) {
          filters.push({ field, value })
          return query
        },
        async get() {
          const out = []
          for (const [path, doc] of docs.entries()) {
            if (!path.startsWith(`${collection}/`) || !doc.exists) continue
            if (filters.every((f) => doc.data[f.field] === f.value)) {
              const id = path.slice(collection.length + 1)
              out.push({ id, data: () => doc.data, ref: docRef(collection, id) })
            }
          }
          return { docs: out }
        },
      }
      return {
        doc(id: string) {
          return docRef(collection, id)
        },
        where: query.where,
      }
    },
  }

  return { db: db as never, docs, sets }
}

const prescreenConfig = {
  version: 1,
  jobTitle: "Technical Account Manager",
  company: "Rain",
  threshold: 0.65,
  confidenceThreshold: 0.7,
  maxClarifyRounds: 2,
  voiceMode: "professional_prescreen",
  questions: [
    {
      qId: "role_fit",
      type: "MUST_HAVE",
      weight: 1,
      matchThreshold: 0.85,
      prompt: { en: "What recent work best matches this technical account management role?", zh: "What recent work best matches this technical account management role?" },
      clarifyPrompt: { en: "Share the closest customer or API support project.", zh: "Share the closest customer or API support project." },
      keywords: [{ keyword: "role_fit", weight: 1, hint: "role fit" }],
    },
  ],
}

describe("runPreScreenForUser session boundaries", () => {
  it("starts a fresh work session and supersedes older active prescreens for the user", async () => {
    const { db, docs } = makeFakeDb({
      "pa-jobs/job-new": { prescreenConfig },
      "pa-prescreen-sessions/ps_old": {
        sessionId: "ps_old",
        userId: "u1",
        jobId: "job-old",
        terminal: null,
        currentQId: "role_fit",
      },
    })
    const sent: string[] = []
    const result = await runPreScreenForUser({
      db,
      jobId: "job-new",
      userId: "u1",
      toE164: "+13054507715",
      markStarted: async () => undefined,
      sendSms: async ({ content }) => {
        sent.push(content)
        return {
          status: "queued",
          from_number: null,
          number: "+13054507715",
          content,
          service: "iMessage",
          is_outbound: true,
        }
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.reason, "started")
    assert.match(sent[0], /Technical Account Manager/)
    assert.equal(docs.get("pa-prescreen-sessions/ps_old")?.data.terminal, "PAUSE")
    assert.equal(docs.get("pa-prescreen-sessions/ps_old")?.data.currentQId, null)
    assert.match(String(docs.get("pa-prescreen-sessions/ps_old")?.data.terminalReason), /superseded_by_new_prescreen_session/)
    assert.equal((docs.get("pa-prescreen-sessions/ps_old")?.data.workSession as { status?: string }).status, "ended")
    assert.equal((docs.get("pa-prescreen-sessions/ps_old")?.data.workSession as { boundary?: string }).boundary, "superseded")
    const started = [...docs.entries()].find(([path, doc]) => path !== "pa-prescreen-sessions/ps_old" && path.startsWith("pa-prescreen-sessions/") && doc.data.userId === "u1")
    assert.ok(started, "fresh prescreen session was written")
    assert.equal((started[1].data.workSession as { status?: string }).status, "active")
    assert.equal(started[1].data.maxClarifyRounds, 4)
  })

  it("claims the canonical user-level work session when a job prescreen starts", async () => {
    const { db, docs } = makeFakeDb({
      "pa-jobs/job-new": { prescreenConfig },
      "pa-users/u1": {
        workSession: {
          kind: "layoff_onboarding",
          status: "active",
          boundary: "WeKruit_LAID_OFF",
          startedAt: "2026-05-16T10:00:00.000Z",
        },
      },
    })

    const result = await runPreScreenForUser({
      db,
      jobId: "job-new",
      userId: "u1",
      toE164: "+13054507715",
      markStarted: async () => undefined,
      sendSms: async ({ content }) => ({
        status: "queued",
        from_number: null,
        number: "+13054507715",
        content,
        service: "iMessage",
        is_outbound: true,
      }),
    })

    assert.equal(result.ok, true)
    const user = docs.get("pa-users/u1")?.data
    assert.ok(user)
    assert.deepEqual(user.workSession, {
      kind: "job_prescreen",
      status: "active",
      startedAt: user.workSession && typeof user.workSession === "object"
        ? (user.workSession as { startedAt?: string }).startedAt
        : undefined,
      boundary: "trigger",
      sessionId: result.sessionId,
      jobId: "job-new",
    })
  })

  it("replaces stale user-level terminal fields when a new prescreen starts", async () => {
    const { db, docs } = makeFakeDb({
      "pa-jobs/job-new": { prescreenConfig },
      "pa-users/u1": {
        workSession: {
          kind: "job_prescreen",
          status: "ended",
          boundary: "terminal",
          terminal: "PASS",
          endedAt: "2026-05-16T10:00:00.000Z",
          sessionId: "ps_old",
          jobId: "job-old",
        },
      },
    })

    const result = await runPreScreenForUser({
      db,
      jobId: "job-new",
      userId: "u1",
      toE164: "+13054507715",
      markStarted: async () => undefined,
      sendSms: async ({ content }) => ({
        status: "queued",
        from_number: null,
        number: "+13054507715",
        content,
        service: "iMessage",
        is_outbound: true,
      }),
    })

    assert.equal(result.ok, true)
    const workSession = docs.get("pa-users/u1")?.data.workSession as Record<string, unknown>
    assert.equal(workSession.status, "active")
    assert.equal(workSession.boundary, "trigger")
    assert.equal(workSession.sessionId, result.sessionId)
    assert.equal(workSession.jobId, "job-new")
    assert.equal("terminal" in workSession, false)
    assert.equal("endedAt" in workSession, false)
  })

  it("ends the fresh work session when the first question cannot be sent", async () => {
    const { db, docs } = makeFakeDb({
      "pa-jobs/job-new": { prescreenConfig },
      "pa-users/u1": {
        workSession: {
          kind: "layoff_onboarding",
          status: "active",
          boundary: "WeKruit_LAID_OFF",
          startedAt: "2026-05-16T10:00:00.000Z",
        },
      },
    })
    let markStartedCalled = false

    const result = await runPreScreenForUser({
      db,
      jobId: "job-new",
      userId: "u1",
      toE164: "+13054507715",
      markStarted: async () => {
        markStartedCalled = true
      },
      sendSms: async () => {
        throw new Error("OPTED_OUT")
      },
    })

    assert.equal(result.ok, false)
    assert.equal(result.reason, "send_failed")
    assert.equal(markStartedCalled, false)
    const started = docs.get(`pa-prescreen-sessions/${result.sessionId}`)?.data
    assert.ok(started)
    assert.equal(started.terminal, "PAUSE")
    assert.equal(started.currentQId, null)
    assert.match(String(started.terminalReason), /send_failed: OPTED_OUT/)
    assert.equal(started.firstQuestionSent, false)
    assert.equal(started.firstQuestionSendError, "OPTED_OUT")
    assert.equal((started.workSession as { status?: string }).status, "ended")
    assert.equal((started.workSession as { boundary?: string }).boundary, "send_failed")

    const userWorkSession = docs.get("pa-users/u1")?.data.workSession as Record<string, unknown>
    assert.equal(userWorkSession.status, "ended")
    assert.equal(userWorkSession.boundary, "send_failed")
    assert.equal(userWorkSession.sessionId, result.sessionId)
    assert.equal(userWorkSession.jobId, "job-new")
  })
})
