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
      // RULE 2 race-closer — create-if-absent (Firestore semantics: code 6
      // ALREADY_EXISTS for the second writer) + delete, for the start lock.
      async create(data: Record<string, unknown>) {
        if (docs.get(path)?.exists) {
          const err = new Error(`already-exists:${path}`) as Error & { code?: number }
          err.code = 6
          throw err
        }
        docs.set(path, { exists: true, data: { ...data } })
        sets.push({ path, data, options: { create: true } })
      },
      async delete() {
        docs.delete(path)
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
        limit() {
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

describe("runPreScreenForUser RULE 2 — never restart a completed screen (2026-06-11 incident)", () => {
  const okSms = async ({ content }: { content: string }) => ({
    status: "queued", from_number: null, number: "+13054507715", content, service: "iMessage", is_outbound: true,
  })

  it("existing TERMINAL session for (user, job) → already_completed, NO send, NO new session", async () => {
    const { db, docs } = makeFakeDb({
      "pa-jobs/job-done": { prescreenConfig },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "job-done",
        terminal: "PASS",
        currentQId: null,
      },
    })
    let smsCount = 0
    const result = await runPreScreenForUser({
      db,
      jobId: "job-done",
      userId: "u1",
      toE164: "+13054507715",
      // The live violation came through the recovery sweep, which bypasses the
      // matched-gate — the terminal gate must run anyway.
      allowMatchedBypass: true,
      markStarted: async () => undefined,
      sendSms: async (a) => { smsCount++; return okSms(a) },
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, "already_completed")
    assert.equal(result.sessionId, "ps_done", "returns the EXISTING terminal session id")
    assert.equal(smsCount, 0, "sends NOTHING — no Q1 restart")
    const created = [...docs.entries()].find(
      ([path]) => path.startsWith("pa-prescreen-sessions/") && path !== "pa-prescreen-sessions/ps_done",
    )
    assert.equal(created, undefined, "no new session doc")
    // The terminal session itself is untouched.
    assert.equal(docs.get("pa-prescreen-sessions/ps_done")?.data.terminal, "PASS")
  })

  it("ops-VOIDED terminal session (voidedByOps) does NOT trip the gate — candidate never did that screen", async () => {
    const { db } = makeFakeDb({
      "pa-jobs/job-v": { prescreenConfig },
      // The 2026-06-11 replay duplicates were voided as PAUSE+voidedByOps; the
      // candidate never saw a question, so a fresh legit start must proceed.
      "pa-prescreen-sessions/ps_voided": {
        sessionId: "ps_voided",
        userId: "u1",
        jobId: "job-v",
        terminal: "PAUSE",
        voidedByOps: true,
        currentQId: null,
      },
    })
    let smsCount = 0
    const result = await runPreScreenForUser({
      db,
      jobId: "job-v",
      userId: "u1",
      toE164: "+13054507715",
      allowMatchedBypass: true,
      markStarted: async () => undefined,
      sendSms: async (a) => { smsCount++; return okSms(a) },
    })
    assert.equal(result.ok, true, "voided session must not block a real start")
    assert.equal(smsCount, 1, "Q1 goes out for the real start")
  })

  it("ACTIVE (terminal null) session for the same job → existing new-work-session behavior unchanged", async () => {
    const { db, docs } = makeFakeDb({
      "pa-jobs/job-a": { prescreenConfig },
      "pa-prescreen-sessions/ps_live": {
        sessionId: "ps_live", userId: "u1", jobId: "job-a", terminal: null, currentQId: "role_fit",
      },
    })
    const result = await runPreScreenForUser({
      db,
      jobId: "job-a",
      userId: "u1",
      toE164: "+13054507715",
      allowMatchedBypass: true,
      markStarted: async () => undefined,
      sendSms: okSms,
    })
    assert.equal(result.ok, true)
    assert.equal(result.reason, "started")
    // Old active session superseded (existing behavior preserved).
    assert.equal(docs.get("pa-prescreen-sessions/ps_live")?.data.terminal, "PAUSE")
  })

  it("RACE: two concurrent starts for the same (user, job) → ONE session, ONE Q1; loser gets start_in_progress", async () => {
    const { db, docs } = makeFakeDb({
      "pa-jobs/job-race": { prescreenConfig },
    })
    let smsCount = 0
    const slowSms = async (a: { content: string }) => {
      smsCount++
      // Keep the winner in-flight long enough that the loser hits the lock.
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      return okSms(a)
    }
    const startArgs = {
      db,
      jobId: "job-race",
      userId: "u1",
      toE164: "+13054507715",
      allowMatchedBypass: true,
      markStarted: async () => undefined,
      sendSms: slowSms,
    }
    const [r1, r2] = await Promise.all([
      runPreScreenForUser(startArgs),
      runPreScreenForUser(startArgs),
    ])
    const winners = [r1, r2].filter((r) => r.ok)
    const losers = [r1, r2].filter((r) => !r.ok)
    assert.equal(winners.length, 1, "exactly one start wins")
    assert.equal(losers.length, 1)
    assert.equal(losers[0].reason, "start_in_progress")
    assert.equal(smsCount, 1, "exactly one Q1 sent")
    const sessions = [...docs.entries()].filter(
      ([path, doc]) => path.startsWith("pa-prescreen-sessions/") && doc.exists,
    )
    assert.equal(sessions.length, 1, "exactly ONE session created")
    // Lock released on completion of the winning start.
    assert.equal(docs.get("pa-prescreen-sessions-lock/u1_job-race")?.exists ?? false, false, "lock deleted after start")
  })

  it("stale lock from a crashed start is taken over (start not wedged forever)", async () => {
    const { db } = makeFakeDb({
      "pa-jobs/job-stale": { prescreenConfig },
      "pa-prescreen-sessions-lock/u1_job-stale": {
        userId: "u1",
        jobId: "job-stale",
        sessionId: "ps_ghost",
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10min ago > 3min stale window
      },
    })
    const result = await runPreScreenForUser({
      db,
      jobId: "job-stale",
      userId: "u1",
      toE164: "+13054507715",
      allowMatchedBypass: true,
      markStarted: async () => undefined,
      sendSms: okSms,
    })
    assert.equal(result.ok, true, "stale lock must not block a fresh start")
    assert.equal(result.reason, "started")
  })

  it("FRESH lock held by another start → start_in_progress with the holder's session id", async () => {
    const { db, docs } = makeFakeDb({
      "pa-jobs/job-held": { prescreenConfig },
      "pa-prescreen-sessions-lock/u1_job-held": {
        userId: "u1",
        jobId: "job-held",
        sessionId: "ps_holder",
        createdAt: new Date().toISOString(),
      },
    })
    let smsCount = 0
    const result = await runPreScreenForUser({
      db,
      jobId: "job-held",
      userId: "u1",
      toE164: "+13054507715",
      allowMatchedBypass: true,
      markStarted: async () => undefined,
      sendSms: async (a) => { smsCount++; return okSms(a) },
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, "start_in_progress")
    assert.equal(result.sessionId, "ps_holder")
    assert.equal(smsCount, 0)
    const sessions = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/"))
    assert.equal(sessions.length, 0, "no session created while the lock is held")
  })
})
