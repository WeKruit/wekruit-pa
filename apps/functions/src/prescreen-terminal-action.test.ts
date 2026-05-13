/**
 * v1.9 Phase 84 + hotfix — terminal action handler tests.
 *
 * Updated for new chain: PASS/FAIL/HARD_STOP → start PII confirm pipeline.
 * generateJobRecs fires async from PII onComplete hook (after 3 Qs).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { runPrescreenTerminalAction } from "./prescreen-terminal-action.js"

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
      sendSms: async () => undefined,
      startPii: async () => {
        throw new Error("pii boom")
      },
      generateJobRecs: async () => ({ ok: true, jobCount: 0 }),
    })
    assert.ok(updates.some((u) => "terminalActionFiredAt" in u.data))
    assert.equal(audit.length, 1)
  })
})
