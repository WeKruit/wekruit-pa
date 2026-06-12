/**
 * v1.9 Phase 84 + hotfix — terminal action handler tests.
 *
 * Updated for new chain: PASS/FAIL/HARD_STOP → start PII confirm pipeline.
 * generateJobRecs fires async from PII onComplete hook for FAIL only.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  composeJobRecsMessage,
  runPrescreenTerminalAction,
  type RunPrescreenTerminalActionArgs,
} from "./prescreen-terminal-action.js"

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
    assert.equal(jobRecsCalled, false)
    assert.equal(r.jobRecsFired, false)
    assert.ok(updates.some((u) => "terminalActionFiredAt" in u.data))
    assert.ok(audit.some((a) => a.kind === "prescreen.terminal_action"))
  })

  it("keeps beta Level 1 reveal copy English even when the prescreen state is zh", async () => {
    const docs = setupSession({
      sessionId: "s1-zh",
      jobId: "j1",
      prescreenConfig: {
        jobTitle: "Senior FE",
        company: "Acme",
        level1Reveal: { applyUrl: "https://x.com", salaryRange: "$140k" },
      },
    })
    const { db } = makeFakeDb(docs)
    const sent: string[] = []
    await runPrescreenTerminalAction({
      db,
      sessionId: "s1-zh",
      terminal: "PASS",
      userId: "u1",
      jobId: "j1",
      toE164: "+1",
      lang: "zh",
      markOutcome: noopMarkOutcome,
      sendSms: async (a) => {
        sent.push(a.content)
      },
      startPii: async () => ({ ok: true, skipped: false }),
      generateJobRecs: async () => ({ ok: true, jobCount: 0 }),
    })

    assert.match(sent[0], /Employer: Acme/)
    assert.match(sent[0], /Job details: https:\/\/x\.com/)
    assert.doesNotMatch(sent[0], /\u62DB\u8058\u65B9|\u804C\u4F4D\u8BE6\u60C5|\u606D\u559C/)
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

  it("repairs a stale ended user-level work session when the current prescreen terminal fires", async () => {
    const docs = setupSession({
      sessionId: "s1c",
      jobId: "j1",
      prescreenConfig: {
        jobTitle: "Senior FE",
        company: "Acme",
      },
    })
    docs.set("pa-prescreen-sessions/s1c", {
      exists: true,
      data: {
        workSession: {
          kind: "job_prescreen",
          status: "ended",
          boundary: "user_exit",
          startedAt: "2026-05-12T09:50:00.000Z",
        },
      },
    })
    docs.set("pa-users/u1", {
      exists: true,
      data: {
        workSession: {
          kind: "job_prescreen",
          status: "ended",
          boundary: "terminal",
          startedAt: "2026-05-12T08:00:00.000Z",
          endedAt: "2026-05-12T08:10:00.000Z",
          sessionId: "older-session",
          jobId: "older-job",
          terminal: "HARD_STOP",
        },
        tags: { proposedTags: [] },
      },
    })
    const { db, docs: writtenDocs } = makeFakeDb(docs)

    await runPrescreenTerminalAction({
      db,
      sessionId: "s1c",
      terminal: "PAUSE",
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
      boundary: "user_exit",
      startedAt: "2026-05-12T09:50:00.000Z",
      endedAt: "2026-05-12T10:00:00.000Z",
      sessionId: "s1c",
      jobId: "j1",
      terminal: "PAUSE",
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
      lang: "zh",
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
    assert.match(sent[0], /what you shared in this screen/i)
    assert.match(sent[0], /job link and clear requirements/i)
    assert.doesNotMatch(sent[0], /\u521A\u624D\u8FD9\u6BB5|\u5C97\u4F4D\u94FE\u63A5|\u6838\u5FC3\u8981\u6C42/)
    assert.equal(piiCaptures[0].source, "fail")
    assert.equal(jobRecsCalled, true)
  })

  it("dev-phone rejected handoff gives feedback, asks for resume/LinkedIn, and waits for matching opt-in", async () => {
    const canaryUid = "8fEwIduUrzxZsblHHsNz"
    const docs = setupSession({
      sessionId: "s3-dev",
      jobId: "j3-dev",
      prescreenConfig: { jobTitle: "Product Manager" },
    })
    docs.set("pa-prescreen-sessions/s3-dev", {
      exists: true,
      data: {
        questions: {
          role_fit: {
            finalS: 0.28,
            finalC: 0.91,
            scored: {
              aggregate: {
                summary: "The answer stayed high-level and did not show enough product launch ownership.",
              },
            },
          },
        },
      },
    })
    docs.set(`pa-users/${canaryUid}`, { exists: true, data: {} })
    const { db, docs: writtenDocs } = makeFakeDb(docs)
    const sent: string[] = []
    const piiCaptures: Array<{ source: string; userId: string }> = []
    let jobRecsCalled = false

    const r = await runPrescreenTerminalAction({
      db,
      sessionId: "s3-dev",
      terminal: "FAIL",
      userId: canaryUid,
      jobId: "j3-dev",
      toE164: "+14243201960",
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

    assert.equal(r.jobRecsFired, false)
    assert.equal(piiCaptures.length, 0, "dev rejected handoff should not auto-start PII before opt-in")
    assert.equal(jobRecsCalled, false, "dev rejected handoff should not silently push recs")
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /WeKruit team notes/i)
    assert.match(sent[0]!, /product launch ownership/i)
    assert.match(sent[0]!, /LinkedIn or resume/i)
    assert.match(sent[0]!, /matching recommendations/i)
    const session = writtenDocs.get("pa-prescreen-sessions/s3-dev")?.data
    assert.equal(
      ((session?.postPrescreenRetention as Record<string, unknown> | undefined)?.stage),
      "await_profile_and_match_opt_in",
    )
  })

  it("forces post-terminal job rec generation to English for beta", async () => {
    const docs = setupSession({
      sessionId: "s3-lang",
      jobId: "j3",
      prescreenConfig: { jobTitle: "X" },
    })
    const { db } = makeFakeDb(docs)
    const piiCaptures: Array<{ source: string; userId: string }> = []
    let observedLang: unknown = null
    await runPrescreenTerminalAction({
      db,
      sessionId: "s3-lang",
      terminal: "FAIL",
      userId: "u",
      jobId: "j3",
      toE164: "+1",
      lang: "zh",
      markOutcome: noopMarkOutcome,
      sendSms: async () => undefined,
      startPii: fakePiiStart(piiCaptures),
      generateJobRecs: async (a) => {
        observedLang = a.lang
        return { ok: true, jobCount: 1 }
      },
    })
    assert.equal(observedLang, "en")
  })

  it("formats post-terminal job recommendations in English when prescreen lang is English", () => {
    const body = composeJobRecsMessage(
      [
        {
          jobTitle: "Backend Engineer",
          companyName: "Rain",
          atsApplyUrl: "https://example.com/job",
          requiredSkills: ["TypeScript", "Node.js"],
          reason: "Why match: your TypeScript aligns with JD core skills",
        },
      ],
      "en",
      { skills: ["TypeScript", "SQL"] },
    )

    assert.match(body, /I remember you mentioned TypeScript \/ SQL experience/)
    assert.match(body, /Backend Engineer @ Rain/)
    assert.match(body, /https:\/\/example\.com\/job/)
    assert.match(body, /requirements: TypeScript, Node\.js/)
    assert.match(body, /why: your TypeScript aligns with JD core skills/)
    assert.doesNotMatch(body, /\u5176\u4ED6\u53EF\u80FD\u5408\u9002|\u4E3A\u5565\u63A8|Why match:/)
  })
})

describe("runPrescreenTerminalAction — HARD_STOP branch (v1.9 hotfix)", () => {
  it("starts PII but does not send preamble or immediate job recs", async () => {
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
    assert.deepEqual(sent, [])
    assert.equal(piiCaptures[0].source, "fail")
    assert.equal(jobRecsCalled, false)
    assert.ok(updates.some((u) => "terminalActionFiredAt" in u.data))
    const terminalUpdate = updates.find((u) => u.path === "pa-prescreen-sessions/s4" && "terminalActionResult" in u.data)
    assert.equal((terminalUpdate?.data.terminalActionResult as { jobRecsFired?: boolean } | undefined)?.jobRecsFired, false)
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

  it("keeps latest prescreen evidence tags when proposedTags is already capped", async () => {
    const docs = setupSession({
      sessionId: "s4c",
      jobId: "rain-software-engineer-fullstack-8849f6ef",
      prescreenConfig: { jobTitle: "Software Engineer - Fullstack" },
    })
    docs.set("pa-prescreen-sessions/s4c", {
      exists: true,
      data: {
        questions: {
          role_fit: {
            finalS: 0.72,
            finalC: 0.78,
            scored: {
              aggregate: {
                summary: "Owned UI dashboard, SQL data workflows, and debugging workflows for operator tooling.",
              },
            },
          },
        },
      },
    })
    docs.set("pa-users/u", {
      exists: true,
      data: {
        tags: {
          proposedTags: Array.from({ length: 12 }, (_, index) => `old_signal_${index + 1}`),
        },
      },
    })
    const { db, updates } = makeFakeDb(docs)
    await runPrescreenTerminalAction({
      db,
      sessionId: "s4c",
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

    const tagUpdate = updates.find((u) => u.path === "pa-users/u" && "tags" in u.data)
    assert.ok(tagUpdate)
    assert.deepEqual((tagUpdate.data.tags as Record<string, unknown>).proposedTags, [
      "old_signal_1",
      "old_signal_2",
      "old_signal_3",
      "old_signal_4",
      "old_signal_5",
      "old_signal_6",
      "old_signal_7",
      "job_prescreen",
      "frontend_development",
      "data_workflows",
      "debugging_workflows",
      "operator_tools",
    ])
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

  it("does not archive user-exit off-topic scoring as profile evidence on PAUSE", async () => {
    const docs = setupSession({
      sessionId: "s5d",
      jobId: "j5d",
      prescreenConfig: { jobTitle: "Software Engineer - Fullstack" },
    })
    docs.set("pa-prescreen-sessions/s5d", {
      exists: true,
      data: {
        questions: {
          role_fit: {
            finalS: 0.78,
            finalC: 0.74,
            scored: {
              answered: true,
              aggregate: {
                summary: "Owned JS/Node + SQL dashboards for ops; reduced escalations ~30%.",
              },
            },
          },
          technical_depth: {
            finalS: 0,
            finalC: 0.95,
            scored: {
              answered: false,
              aggregate: {
                summary: "No relevant skills or examples; reply is a pause request.",
              },
              abortHint: { kind: "off_topic", reason: "Reply is a pause request." },
            },
          },
        },
      },
    })
    docs.set("pa-users/u", {
      exists: true,
      data: {
        lastPrescreenMemoryUpdate: {
          terminal: "PASS",
          summary: "Older pass evidence.",
          sessionId: "older-pass-session",
        },
        tags: { proposedTags: ["existing_signal"] },
      },
    })
    const { db, updates, docs: writtenDocs } = makeFakeDb(docs)

    await runPrescreenTerminalAction({
      db,
      sessionId: "s5d",
      terminal: "PAUSE",
      userId: "u",
      jobId: "j5d",
      toE164: "+1",
      lang: "en",
      markOutcome: noopMarkOutcome,
      sendSms: async () => undefined,
      startPii: fakePiiStart([]),
      generateJobRecs: async () => ({ ok: true, jobCount: 0 }),
      now: () => new Date("2026-05-12T10:00:00Z"),
    })

    const memory = writtenDocs.get("pa-prescreen-memory-events/s5d")?.data as {
      summary?: string
      scored?: Array<{ qId: string; summary: string }>
    }
    assert.equal(memory.summary, "Owned JS/Node + SQL dashboards for ops; reduced escalations ~30%.")
    assert.deepEqual(memory.scored?.map((q) => q.qId), ["role_fit"])
    assert.equal(
      updates.some((u) => u.path === "pa-users/u" && "lastPrescreenMemoryUpdate" in u.data),
      false,
    )
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
