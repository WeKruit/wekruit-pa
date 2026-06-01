import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { runPreScreenForUser, defaultIsJobMatchedToUser } from "./prescreen-session-start.js"

/**
 * Minimal fake for defaultIsJobMatchedToUser's three point-read arms:
 *   rec ledger: pa-user-job-recommendations/{uid}/jobs/{jid}.recommendationCount
 *   done it:    pa-prescreen-sessions where userId==&&jobId== limit 1
 *   invite:     pa-prescreen-pending-invites/{uid}.jobId
 */
function makeMatchFakeDb(opts: {
  rec?: { jobId: string; count: number }
  session?: { userId: string; jobId: string }
  invite?: { userId: string; jobId: string }
  throwOnRec?: boolean
}) {
  return {
    collection(c: string) {
      if (c === "pa-user-job-recommendations") {
        return {
          doc() {
            return {
              collection() {
                return {
                  doc(jid: string) {
                    return {
                      async get() {
                        if (opts.throwOnRec) throw new Error("firestore_down")
                        const hit = opts.rec && opts.rec.jobId === jid
                        return { exists: !!hit, data: () => (hit ? { recommendationCount: opts.rec!.count } : undefined) }
                      },
                    }
                  },
                }
              },
            }
          },
        }
      }
      if (c === "pa-prescreen-sessions") {
        const q = {
          where() { return q },
          limit() { return q },
          async get() {
            const hit = !!opts.session
            return { empty: !hit, docs: hit ? [{ id: "ps_x", data: () => opts.session }] : [] }
          },
        }
        return q
      }
      if (c === "pa-prescreen-pending-invites") {
        return {
          doc(uid: string) {
            return {
              async get() {
                const hit = opts.invite && opts.invite.userId === uid
                return { exists: !!hit, data: () => (hit ? { jobId: opts.invite!.jobId } : undefined) }
              },
            }
          },
        }
      }
      throw new Error(`unexpected collection ${c}`)
    },
  } as never
}

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

  it("reports send_failed when the missing-config notice cannot be sent", async () => {
    const { db } = makeFakeDb({
      "pa-jobs/job-new": { title: "Product Engineer" },
    })

    const result = await runPreScreenForUser({
      db,
      jobId: "job-new",
      userId: "u1",
      toE164: "+13054507715",
      sendSms: async () => {
        throw new Error("OPTED_OUT")
      },
    })

    assert.equal(result.ok, false)
    assert.equal(result.reason, "send_failed")
  })

  it("can start an active session without re-sending Q1 when the initial SMS already contains the first answer", async () => {
    const { db, docs } = makeFakeDb({
      "pa-jobs/job-new": { prescreenConfig },
    })
    let markStartedCalled = false
    const sent: string[] = []

    const result = await runPreScreenForUser({
      db,
      jobId: "job-new",
      userId: "u1",
      toE164: "+13054507715",
      suppressFirstQuestion: true,
      markStarted: async () => {
        markStartedCalled = true
      },
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
    assert.equal(result.firstQuestionSent, false)
    assert.equal(markStartedCalled, true)
    assert.equal(sent.length, 0)
    const started = docs.get(`pa-prescreen-sessions/${result.sessionId}`)?.data
    assert.ok(started)
    assert.equal(started.currentQId, "role_fit")
    assert.equal(started.terminal, null)
    assert.equal(started.firstQuestionSent, false)
    assert.equal(started.firstQuestionSuppressedByInitialReply, true)
    const userWorkSession = docs.get("pa-users/u1")?.data.workSession as Record<string, unknown>
    assert.equal(userWorkSession.status, "active")
    assert.equal(userWorkSession.sessionId, result.sessionId)
  })
})

describe("runPreScreenForUser MATCHED-GATE (2026-05-31)", () => {
  const okSms = async ({ content }: { content: string }) => ({
    status: "queued", from_number: null, number: "+13054507715", content, service: "iMessage", is_outbound: true,
  })

  it("REFUSES an unmatched job: no session created, no supersede of the active one", async () => {
    const { db, docs } = makeFakeDb({
      "pa-jobs/job-foreign": { prescreenConfig },
      // a legitimately in-progress prescreen for ANOTHER job — must NOT be paused.
      "pa-prescreen-sessions/ps_active": {
        sessionId: "ps_active", userId: "u1", jobId: "job-mine", terminal: null, currentQId: "role_fit",
      },
    })
    let smsCount = 0
    const result = await runPreScreenForUser({
      db,
      jobId: "job-foreign",
      userId: "u1",
      toE164: "+13054507715",
      // self copy-paste path: no bypass, no pending-invite. Foreign jobId not matched.
      isJobMatchedToUser: async () => false,
      markStarted: async () => undefined,
      sendSms: async (a) => { smsCount++; return okSms(a) },
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, "not_matched")
    // No new session doc for the user.
    const created = [...docs.entries()].find(
      ([path, doc]) => path.startsWith("pa-prescreen-sessions/") && path !== "pa-prescreen-sessions/ps_active" && doc.data.userId === "u1",
    )
    assert.equal(created, undefined, "no session created for an unmatched job")
    // The active session for the candidate's REAL job is untouched (not superseded/paused).
    assert.equal(docs.get("pa-prescreen-sessions/ps_active")?.data.terminal, null)
    // No opener SMS sent.
    assert.equal(smsCount, 0)
  })

  it("ALLOWS a matched job (isJobMatchedToUser=true) — session starts", async () => {
    const { db } = makeFakeDb({ "pa-jobs/job-mine": { prescreenConfig } })
    const result = await runPreScreenForUser({
      db, jobId: "job-mine", userId: "u1", toE164: "+13054507715",
      isJobMatchedToUser: async () => true,
      markStarted: async () => undefined,
      sendSms: okSms,
    })
    assert.equal(result.ok, true)
    assert.equal(result.reason, "started")
  })

  it("allowMatchedBypass=true skips the gate (admin/system) — gate fn not even called", async () => {
    const { db } = makeFakeDb({ "pa-jobs/job-x": { prescreenConfig } })
    let gateCalled = false
    const result = await runPreScreenForUser({
      db, jobId: "job-x", userId: "u1", toE164: "+13054507715",
      allowMatchedBypass: true,
      isJobMatchedToUser: async () => { gateCalled = true; return false },
      markStarted: async () => undefined,
      sendSms: okSms,
    })
    assert.equal(result.ok, true)
    assert.equal(gateCalled, false, "bypass must short-circuit the gate")
  })

  it("sourceRequestedUserId (public-page pending-invite) skips the gate", async () => {
    const { db } = makeFakeDb({ "pa-jobs/job-pub": { prescreenConfig } })
    let gateCalled = false
    const result = await runPreScreenForUser({
      db, jobId: "job-pub", userId: "u1", toE164: "+13054507715",
      sourceRequestedUserId: "wkr_abc",
      isJobMatchedToUser: async () => { gateCalled = true; return false },
      markStarted: async () => undefined,
      sendSms: okSms,
    })
    assert.equal(result.ok, true)
    assert.equal(gateCalled, false, "pending-invite is the match evidence; gate skipped")
  })
})

describe("defaultIsJobMatchedToUser — done-or-matched arms (Adam 2026-05-31)", () => {
  it("MATCHED arm: rec ledger recommendationCount>0 → true", async () => {
    const db = makeMatchFakeDb({ rec: { jobId: "job-a", count: 2 } })
    assert.equal(await defaultIsJobMatchedToUser(db, "u1", "job-a"), true)
  })
  it("MATCHED arm: recommendationCount 0 / different job → false", async () => {
    assert.equal(await defaultIsJobMatchedToUser(makeMatchFakeDb({ rec: { jobId: "job-a", count: 0 } }), "u1", "job-a"), false)
    assert.equal(await defaultIsJobMatchedToUser(makeMatchFakeDb({ rec: { jobId: "job-other", count: 3 } }), "u1", "job-a"), false)
  })
  it("DONE arm: an existing prescreen session for (user, job) → true", async () => {
    const db = makeMatchFakeDb({ session: { userId: "u1", jobId: "job-a" } })
    assert.equal(await defaultIsJobMatchedToUser(db, "u1", "job-a"), true)
  })
  it("PENDING-INVITE arm: invite for this job → true", async () => {
    const db = makeMatchFakeDb({ invite: { userId: "u1", jobId: "job-a" } })
    assert.equal(await defaultIsJobMatchedToUser(db, "u1", "job-a"), true)
  })
  it("none of the arms → false (must go to the website / formatted-text flow)", async () => {
    assert.equal(await defaultIsJobMatchedToUser(makeMatchFakeDb({}), "u1", "job-a"), false)
  })
  it("fail-OPEN on read error → true (availability beats blocking legit starts)", async () => {
    assert.equal(await defaultIsJobMatchedToUser(makeMatchFakeDb({ throwOnRec: true }), "u1", "job-a"), true)
  })
  it("missing ids → false", async () => {
    assert.equal(await defaultIsJobMatchedToUser(makeMatchFakeDb({}), "", "job-a"), false)
    assert.equal(await defaultIsJobMatchedToUser(makeMatchFakeDb({}), "u1", ""), false)
  })
})
