/**
 * v1.9 Phase 84 + hotfix — terminal action handler tests.
 *
 * Updated for new chain: PASS/FAIL/HARD_STOP → start PII confirm pipeline.
 * generateJobRecs fires async from PII onComplete hook (after 3 Qs).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { runPrescreenTerminalAction, type RunPrescreenTerminalActionArgs } from "./prescreen-terminal-action.js"

interface FakeDocState {
  exists: boolean
  data: Record<string, unknown>
}

function makeFakeDb(docs: Map<string, FakeDocState>) {
  const audit: Array<Record<string, unknown>> = []
  const updates: Array<{ path: string; data: Record<string, unknown> }> = []
  const fakeDb = {
    collection(coll: string) {
      return {
        doc(id: string) {
          const path = `${coll}/${id}`
          return {
            async get() {
              const st = docs.get(path) ?? { exists: false, data: {} }
              return { exists: st.exists, data: () => (st.exists ? st.data : undefined) }
            },
            async update(patch: Record<string, unknown>) {
              const st = docs.get(path) ?? { exists: true, data: {} }
              docs.set(path, { exists: true, data: { ...st.data, ...patch } })
              updates.push({ path, data: patch })
            },
            async set(patch: Record<string, unknown>, opts?: { merge?: boolean }) {
              const st = docs.get(path) ?? { exists: true, data: {} }
              const data = opts?.merge ? { ...st.data, ...patch } : patch
              docs.set(path, { exists: true, data })
              updates.push({ path, data: patch })
            },
          }
        },
        async add(data: Record<string, unknown>) {
          if (coll === "pa-audit-events") audit.push(data)
          return { id: `audit_${audit.length}` }
        },
      }
    },
  }
  return { db: fakeDb as never, audit, updates, docs }
}

function setupSession(args: {
  sessionId: string
  jobId: string
  prescreenConfig: Record<string, unknown>
}): Map<string, FakeDocState> {
  const docs = new Map<string, FakeDocState>()
  docs.set(`pa-prescreen-sessions/${args.sessionId}`, { exists: true, data: {} })
  docs.set(`pa-jobs/${args.jobId}`, {
    exists: true,
    data: { prescreenConfig: args.prescreenConfig },
  })
  return docs
}

/** Test seam — stub PII start. */
function fakePiiStart(captures: Array<{ source: string; userId: string }>) {
  return async (a: {
    userId: string
    toE164: string
    jobId: string
    source: "pass" | "fail"
    onComplete: (b: { userId: string; toE164: string; jobId: string }) => Promise<void>
  }) => {
    captures.push({ source: a.source, userId: a.userId })
    // Simulate user completing all 3 Qs immediately so onComplete fires.
    await a.onComplete({ userId: a.userId, toE164: a.toE164, jobId: a.jobId })
    return { ok: true, skipped: false } as { ok: boolean; skipped: boolean }
  }
}

const noopMarkOutcome: NonNullable<RunPrescreenTerminalActionArgs["markOutcome"]> = async () => undefined

describe("runPrescreenTerminalAction — PASS branch (v1.9 hotfix)", () => {
  it("sends Level 1 reveal then starts PII pipeline (source=pass)", async () => {
    const docs = setupSession({
      sessionId: "s1",
      jobId: "j1",
      prescreenConfig: {
        jobTitle: "Senior FE",
        company: "Acme",
        level1Reveal: { applyUrl: "https://x.com", salaryRange: "$140k" },
      },
    })
    const { db, audit, updates } = makeFakeDb(docs)
    const sent: string[] = []
    const piiCaptures: Array<{ source: string; userId: string }> = []
    let jobRecsCalled = false
    const r = await runPrescreenTerminalAction({
      db,
      sessionId: "s1",
      terminal: "PASS",
      userId: "u1",
      jobId: "j1",
      toE164: "+1",
      lang: "en",
      markOutcome: noopMarkOutcome,
      sendSms: async (a) => {
        sent.push(a.content)
      },
      startPii: fakePiiStart(piiCaptures),
      generateJobRecs: async () => {
        jobRecsCalled = true
        return { ok: true, jobCount: 3 }
      },
    })
    assert.equal(r.level1Sent, true)
    assert.match(sent[0], /Acme/)
    assert.equal(piiCaptures.length, 1)
    assert.equal(piiCaptures[0].source, "pass")
    assert.equal(jobRecsCalled, true)
    assert.ok(updates.some((u) => "terminalActionFiredAt" in u.data))
    assert.ok(audit.some((a) => a.kind === "prescreen.terminal_action"))
  })

  it("ends the matching canonical user-level job_prescreen work session", async () => {
    const docs = setupSession({
      sessionId: "s1b",
      jobId: "j1",
      prescreenConfig: {
        jobTitle: "Senior FE",
        company: "Acme",
      },
    })
    docs.set("pa-users/u1", {
      exists: true,
      data: {
        workSession: {
          kind: "job_prescreen",
          status: "active",
          boundary: "trigger",
          startedAt: "2026-05-12T09:00:00.000Z",
          sessionId: "s1b",
          jobId: "j1",
        },
        tags: { proposedTags: [] },
      },
    })
    const { db, docs: writtenDocs } = makeFakeDb(docs)

    await runPrescreenTerminalAction({
      db,
      sessionId: "s1b",
      terminal: "PASS",
      userId: "u1",
      jobId: "j1",
      toE164: "+1",
      lang: "en",
      markOutcome: noopMarkOutcome,
      sendSms: async () => undefined,
      startPii: async () => ({ ok: true, skipped: false }),
      generateJobRecs: async () => ({ ok: true, jobCount: 0 }),
      now: () => new Date("2026-05-12T10:00:00.000Z"),
    })

    assert.deepEqual(writtenDocs.get("pa-users/u1")?.data.workSession, {
      kind: "job_prescreen",
      status: "ended",
      boundary: "terminal",
      startedAt: "2026-05-12T09:00:00.000Z",
      endedAt: "2026-05-12T10:00:00.000Z",
      sessionId: "s1b",
      jobId: "j1",
      terminal: "PASS",
    })
  })

  it("does not end a newer user-level job_prescreen work session from an old terminal action", async () => {
    const docs = setupSession({
      sessionId: "old-session",
      jobId: "j1",
      prescreenConfig: {
        jobTitle: "Senior FE",
        company: "Acme",
      },
    })
    docs.set("pa-users/u1", {
      exists: true,
      data: {
        workSession: {
          kind: "job_prescreen",
          status: "active",
          boundary: "trigger",
          startedAt: "2026-05-12T09:30:00.000Z",
          sessionId: "newer-session",
          jobId: "j2",
        },
        tags: { proposedTags: [] },
      },
    })
    const { db, docs: writtenDocs } = makeFakeDb(docs)

    await runPrescreenTerminalAction({
      db,
      sessionId: "old-session",
      terminal: "PASS",
      userId: "u1",
      jobId: "j1",
      toE164: "+1",
      lang: "en",
      markOutcome: noopMarkOutcome,
      sendSms: async () => undefined,
      startPii: async () => ({ ok: true, skipped: false }),
      generateJobRecs: async () => ({ ok: true, jobCount: 0 }),
      now: () => new Date("2026-05-12T10:00:00.000Z"),
    })

    assert.deepEqual(writtenDocs.get("pa-users/u1")?.data.workSession, {
      kind: "job_prescreen",
      status: "active",
      boundary: "trigger",
      startedAt: "2026-05-12T09:30:00.000Z",
      sessionId: "newer-session",
      jobId: "j2",
    })
  })
})

describe("runPrescreenTerminalAction — FAIL branch (v1.9 hotfix)", () => {
  it("sends preamble + starts PII pipeline (source=fail) + onComplete fires job recs", async () => {
    const docs = setupSession({
      sessionId: "s3",
      jobId: "j3",
      prescreenConfig: { jobTitle: "X" },
    })
    const { db } = makeFakeDb(docs)
    const sent: string[] = []
    const piiCaptures: Array<{ source: string; userId: string }> = []
    let jobRecsCalled = false
    const r = await runPrescreenTerminalAction({
      db,
      sessionId: "s3",
      terminal: "FAIL",
      userId: "u",
      jobId: "j3",
      toE164: "+1",
      lang: "en",
      markOutcome: noopMarkOutcome,
      sendSms: async (a) => {
        sent.push(a.content)
      },
      startPii: fakePiiStart(piiCaptures),
      generateJobRecs: async () => {
        jobRecsCalled = true
        return { ok: true, jobCount: 5 }
      },
    })
    assert.equal(r.level1Sent, false)
    assert.match(sent[0], /better-aligned/i)
    assert.equal(piiCaptures[0].source, "fail")
    assert.equal(jobRecsCalled, true)
  })
})

describe("runPrescreenTerminalAction — HARD_STOP branch (v1.9 hotfix)", () => {
  it("same as FAIL: preamble + PII (source=fail) + job recs", async () => {
    const docs = setupSession({
      sessionId: "s4",
      jobId: "j4",
      prescreenConfig: { jobTitle: "X" },
    })
    const { db, updates } = makeFakeDb(docs)
    const sent: string[] = []
    const piiCaptures: Array<{ source: string; userId: string }> = []
    let jobRecsCalled = false
    await runPrescreenTerminalAction({
      db,
      sessionId: "s4",
      terminal: "HARD_STOP",
      userId: "u",
      jobId: "j4",
      toE164: "+1",
      lang: "en",
      markOutcome: noopMarkOutcome,
      sendSms: async (a) => {
        sent.push(a.content)
      },
      startPii: fakePiiStart(piiCaptures),
      generateJobRecs: async () => {
        jobRecsCalled = true
        return { ok: true, jobCount: 4 }
      },
    })
    assert.match(sent[0], /better-aligned/i)
    assert.equal(piiCaptures[0].source, "fail")
    assert.equal(jobRecsCalled, true)
    assert.ok(updates.some((u) => "terminalActionFiredAt" in u.data))
  })

  it("does not derive positive skill tags from a low-score hard-stop or job id", async () => {
    const docs = setupSession({
      sessionId: "s4b",
      jobId: "rain-software-engineer-fullstack-8849f6ef",
      prescreenConfig: { jobTitle: "Software Engineer - Fullstack" },
    })
    docs.set("pa-prescreen-sessions/s4b", {
      exists: true,
      data: {
        questions: {
          role_fit: {
            finalS: 0.05,
            finalC: 0.9,
            scored: {
              aggregate: {
                summary: "Candidate reports no software engineering; only support and spreadsheets.",
              },
            },
          },
        },
      },
    })
    docs.set("pa-users/u", { exists: true, data: { tags: { proposedTags: [] } } })
    const { db, updates } = makeFakeDb(docs)
    await runPrescreenTerminalAction({
      db,
      sessionId: "s4b",
      terminal: "HARD_STOP",
      userId: "u",
      jobId: "rain-software-engineer-fullstack-8849f6ef",
      toE164: "+1",
      lang: "en",
      markOutcome: noopMarkOutcome,
      sendSms: async () => undefined,
      startPii: async () => ({ ok: true, skipped: false }),
      generateJobRecs: async () => ({ ok: true, jobCount: 0 }),
    })

    const userUpdate = updates.find((u) => u.path === "pa-users/u" && "lastPrescreenMemoryUpdate" in u.data)
    assert.ok(userUpdate)
    const memory = userUpdate.data.lastPrescreenMemoryUpdate as { evidenceTags: string[] }
    assert.deepEqual(memory.evidenceTags, ["job_prescreen"])
    const tagUpdate = updates.find((u) => u.path === "pa-users/u" && "tags" in u.data)
    assert.ok(tagUpdate)
    assert.deepEqual((tagUpdate.data.tags as Record<string, unknown>).proposedTags, ["job_prescreen"])
  })
})

describe("runPrescreenTerminalAction — PAUSE branch", () => {
  it("writes pausedAt; no PII start, no recs", async () => {
    const docs = setupSession({
      sessionId: "s5",
      jobId: "j5",
      prescreenConfig: { jobTitle: "X" },
    })
    const { db, updates } = makeFakeDb(docs)
    const piiCaptures: Array<{ source: string; userId: string }> = []
    let jobRecsCalled = false
    await runPrescreenTerminalAction({
      db,
      sessionId: "s5",
      terminal: "PAUSE",
      userId: "u",
      jobId: "j5",
      toE164: "+1",
      lang: "en",
      markOutcome: noopMarkOutcome,
      sendSms: async () => undefined,
      startPii: fakePiiStart(piiCaptures),
      generateJobRecs: async () => {
        jobRecsCalled = true
        return { ok: true, jobCount: 0 }
      },
      now: () => new Date("2026-05-12T10:00:00Z"),
    })
    assert.equal(piiCaptures.length, 0)
    assert.equal(jobRecsCalled, false)
    assert.ok(updates.some((u) => "pausedAt" in u.data))
  })

  it("ends the matching canonical user-level job_prescreen work session on PAUSE", async () => {
    const docs = setupSession({
      sessionId: "s5c",
      jobId: "j5",
      prescreenConfig: { jobTitle: "X" },
    })
    docs.set("pa-users/u", {
      exists: true,
      data: {
        workSession: {
          kind: "job_prescreen",
          status: "active",
          boundary: "trigger",
          startedAt: "2026-05-12T09:00:00.000Z",
          sessionId: "s5c",
          jobId: "j5",
        },
        tags: { proposedTags: [] },
      },
    })
    const { db, docs: writtenDocs } = makeFakeDb(docs)

    await runPrescreenTerminalAction({
      db,
      sessionId: "s5c",
      terminal: "PAUSE",
      userId: "u",
      jobId: "j5",
      toE164: "+1",
      lang: "en",
      markOutcome: noopMarkOutcome,
      sendSms: async () => undefined,
      startPii: fakePiiStart([]),
      generateJobRecs: async () => ({ ok: true, jobCount: 0 }),
      now: () => new Date("2026-05-12T10:00:00.000Z"),
    })

    assert.deepEqual(writtenDocs.get("pa-users/u")?.data.workSession, {
      kind: "job_prescreen",
      status: "ended",
      boundary: "user_exit",
      startedAt: "2026-05-12T09:00:00.000Z",
      endedAt: "2026-05-12T10:00:00.000Z",
      sessionId: "s5c",
      jobId: "j5",
      terminal: "PAUSE",
    })
  })

  it("archives PAUSE memory event without overwriting long-term profile evidence or tags", async () => {
    const docs = setupSession({
      sessionId: "s5b",
      jobId: "j5b",
      prescreenConfig: { jobTitle: "X" },
    })
    docs.set("pa-prescreen-sessions/s5b", {
      exists: true,
      data: {
        questions: {},
      },
    })
    docs.set("pa-users/u", {
      exists: true,
      data: {
        lastPrescreenMemoryUpdate: {
          terminal: "PASS",
          summary: "Strong React and SQL evidence.",
          sessionId: "older-pass-session",
        },
        tags: { proposedTags: ["existing_signal"] },
      },
    })
    const { db, updates, docs: writtenDocs } = makeFakeDb(docs)
    await runPrescreenTerminalAction({
      db,
      sessionId: "s5b",
      terminal: "PAUSE",
      userId: "u",
      jobId: "j5b",
      toE164: "+1",
      lang: "en",
      markOutcome: noopMarkOutcome,
      sendSms: async () => undefined,
      startPii: fakePiiStart([]),
      generateJobRecs: async () => ({ ok: true, jobCount: 0 }),
      now: () => new Date("2026-05-12T10:00:00Z"),
    })

    assert.ok(writtenDocs.get("pa-prescreen-memory-events/s5b")?.exists)
    assert.equal(
      updates.some((u) => u.path === "pa-users/u" && "lastPrescreenMemoryUpdate" in u.data),
      false,
    )
    assert.equal(updates.some((u) => u.path === "pa-users/u" && "tags" in u.data), false)
  })
})

describe("runPrescreenTerminalAction — idempotency", () => {
  it("second call no-ops when terminalActionFiredAt already stamped", async () => {
    const docs = setupSession({
      sessionId: "s6",
      jobId: "j6",
      prescreenConfig: { jobTitle: "X" },
    })
    docs.set(`pa-prescreen-sessions/s6`, {
      exists: true,
      data: { terminalActionFiredAt: "2026-05-12T09:00:00Z" },
    })
    const { db } = makeFakeDb(docs)
    const piiCaptures: Array<{ source: string; userId: string }> = []
    const r = await runPrescreenTerminalAction({
      db,
      sessionId: "s6",
      terminal: "PASS",
      userId: "u",
      jobId: "j6",
      toE164: "+1",
      lang: "en",
      markOutcome: noopMarkOutcome,
      sendSms: async () => undefined,
      startPii: fakePiiStart(piiCaptures),
      generateJobRecs: async () => ({ ok: true, jobCount: 0 }),
    })
    assert.equal(r.alreadyFired, true)
    assert.equal(piiCaptures.length, 0)
  })
})

describe("runPrescreenTerminalAction — fail-open", () => {
  it("PII start failure does NOT block stamp/audit", async () => {
    const docs = setupSession({
      sessionId: "s7",
      jobId: "j7",
      prescreenConfig: { jobTitle: "X" },
    })
    const { db, updates, audit } = makeFakeDb(docs)
    await runPrescreenTerminalAction({
      db,
      sessionId: "s7",
      terminal: "PASS",
      userId: "u",
      jobId: "j7",
      toE164: "+1",
      lang: "en",
      markOutcome: noopMarkOutcome,
      sendSms: async () => undefined,
      startPii: async () => {
        throw new Error("pii boom")
      },
      generateJobRecs: async () => ({ ok: true, jobCount: 0 }),
    })
    assert.ok(updates.some((u) => "terminalActionFiredAt" in u.data))
    assert.equal(audit.length, 1)
  })

  it("outcome marker failure does NOT block memory update or terminal stamp", async () => {
    const docs = setupSession({
      sessionId: "s8",
      jobId: "j8",
      prescreenConfig: { jobTitle: "X" },
    })
    docs.set("pa-prescreen-sessions/s8", {
      exists: true,
      data: {
        questions: {
          role_fit: {
            finalS: 0.78,
            finalC: 0.74,
            scored: { aggregate: { summary: "Relevant UI and SQL ownership." } },
          },
        },
      },
    })
    docs.set("pa-users/u", {
      exists: true,
      data: {
        tags: {
          proposedTags: ["existing_signal"],
        },
      },
    })
    const { db, updates, docs: writtenDocs } = makeFakeDb(docs)
    const logs: Array<{ event: string; payload: Record<string, unknown> }> = []
    await runPrescreenTerminalAction({
      db,
      sessionId: "s8",
      terminal: "PASS",
      userId: "u",
      jobId: "j8",
      toE164: "+1",
      lang: "en",
      markOutcome: async () => {
        throw new Error("candidate_job_not_passable:invalid_pass_transition")
      },
      sendSms: async () => undefined,
      startPii: async () => ({ ok: true, skipped: false }),
      generateJobRecs: async () => ({ ok: true, jobCount: 0 }),
      log: (event, payload) => logs.push({ event, payload }),
    })

    assert.ok(logs.some((l) => l.event === "prescreen.terminal_action.outcome_mark_failed"))
    assert.ok(logs.some((l) => l.event === "prescreen.terminal_action.memory_updated"))
    const userUpdate = updates.find((u) => u.path === "pa-users/u" && "lastPrescreenMemoryUpdate" in u.data)
    assert.ok(userUpdate)
    assert.ok("conversationDerivedPreferences" in userUpdate.data)
    const tagUpdate = updates.find((u) => u.path === "pa-users/u" && "tags" in u.data)
    assert.ok(tagUpdate)
    assert.deepEqual((tagUpdate.data.tags as Record<string, unknown>).proposedTags, [
      "existing_signal",
      "job_prescreen",
      "frontend_development",
      "data_workflows",
    ])
    assert.ok(writtenDocs.get("pa-prescreen-memory-events/s8")?.exists)
    assert.ok(updates.some((u) => "terminalActionFiredAt" in u.data))
  })
})
