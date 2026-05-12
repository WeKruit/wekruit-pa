/**
 * v1.9 Phase 84 — terminal action handler tests.
 * Pure logic; fakes Firestore + send + generateJobRecs.
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
              return {
                exists: st.exists,
                data: () => (st.exists ? st.data : undefined),
              }
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

describe("runPrescreenTerminalAction — PASS branch", () => {
  it("sends Level 1 reveal then fires generateJobRecs + stamps idempotency", async () => {
    const docs = setupSession({
      sessionId: "s1",
      jobId: "j1",
      prescreenConfig: {
        jobTitle: "Senior FE",
        company: "Acme",
        level1Reveal: {
          applyUrl: "https://example.com/apply",
          salaryRange: "$140k-$180k",
        },
      },
    })
    const { db, audit, updates } = makeFakeDb(docs)
    const sent: Array<{ to: string; content: string }> = []
    let jobRecsCalled = false
    const r = await runPrescreenTerminalAction({
      db,
      sessionId: "s1",
      terminal: "PASS",
      userId: "u1",
      jobId: "j1",
      toE164: "+15555550000",
      lang: "en",
      sendSms: async (a) => {
        sent.push(a)
      },
      generateJobRecs: async () => {
        jobRecsCalled = true
        return { ok: true, jobCount: 3 }
      },
      now: () => new Date("2026-05-12T10:00:00Z"),
    })
    assert.equal(r.alreadyFired, false)
    assert.equal(r.level1Sent, true)
    assert.equal(r.jobRecsFired, true)
    assert.equal(r.jobRecsResult?.jobCount, 3)
    assert.equal(jobRecsCalled, true)
    assert.equal(sent.length, 1)
    assert.match(sent[0].content, /Acme/)
    assert.match(sent[0].content, /\$140k-\$180k/)
    assert.match(sent[0].content, /example\.com\/apply/)
    // idempotency stamp
    assert.ok(updates.some((u) => "terminalActionFiredAt" in u.data))
    // audit
    assert.equal(audit.length, 1)
    assert.equal(audit[0].kind, "prescreen.terminal_action")
  })

  it("idempotency — second call with same session no-ops", async () => {
    const docs = setupSession({
      sessionId: "s1",
      jobId: "j1",
      prescreenConfig: { jobTitle: "X" },
    })
    docs.set(`pa-prescreen-sessions/s1`, {
      exists: true,
      data: { terminalActionFiredAt: "2026-05-12T09:00:00Z" },
    })
    const { db, audit } = makeFakeDb(docs)
    let jobRecsCalled = false
    const r = await runPrescreenTerminalAction({
      db,
      sessionId: "s1",
      terminal: "PASS",
      userId: "u1",
      jobId: "j1",
      toE164: "+1",
      lang: "en",
      sendSms: async () => undefined,
      generateJobRecs: async () => {
        jobRecsCalled = true
        return { ok: true, jobCount: 0 }
      },
    })
    assert.equal(r.alreadyFired, true)
    assert.equal(jobRecsCalled, false)
    assert.equal(audit.length, 0)
  })

  it("PASS without level1Reveal config still sends fallback reveal", async () => {
    const docs = setupSession({
      sessionId: "s2",
      jobId: "j2",
      prescreenConfig: { jobTitle: "SDE" },
    })
    const { db } = makeFakeDb(docs)
    const sent: Array<{ content: string }> = []
    const r = await runPrescreenTerminalAction({
      db,
      sessionId: "s2",
      terminal: "PASS",
      userId: "u",
      jobId: "j2",
      toE164: "+1",
      lang: "en",
      sendSms: async (a) => {
        sent.push({ content: a.content })
      },
      generateJobRecs: async () => ({ ok: false, jobCount: 0, reason: "no_matches" }),
    })
    assert.equal(r.level1Sent, true)
    assert.match(sent[0].content, /SDE/)
  })
})

describe("runPrescreenTerminalAction — FAIL branch", () => {
  it("sends preamble + fires generateJobRecs", async () => {
    const docs = setupSession({
      sessionId: "s3",
      jobId: "j3",
      prescreenConfig: { jobTitle: "X" },
    })
    const { db } = makeFakeDb(docs)
    const sent: string[] = []
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
      generateJobRecs: async () => {
        jobRecsCalled = true
        return { ok: true, jobCount: 5 }
      },
    })
    assert.equal(r.level1Sent, false)
    assert.equal(r.jobRecsFired, true)
    assert.equal(jobRecsCalled, true)
    assert.match(sent[0], /better-aligned/i)
  })
})

describe("runPrescreenTerminalAction — HARD_STOP branch", () => {
  it("does NOT fire generateJobRecs; stamps idempotency only", async () => {
    const docs = setupSession({
      sessionId: "s4",
      jobId: "j4",
      prescreenConfig: { jobTitle: "X" },
    })
    const { db, updates } = makeFakeDb(docs)
    let jobRecsCalled = false
    const r = await runPrescreenTerminalAction({
      db,
      sessionId: "s4",
      terminal: "HARD_STOP",
      userId: "u",
      jobId: "j4",
      toE164: "+1",
      lang: "en",
      sendSms: async () => undefined,
      generateJobRecs: async () => {
        jobRecsCalled = true
        return { ok: true, jobCount: 0 }
      },
    })
    assert.equal(r.jobRecsFired, false)
    assert.equal(jobRecsCalled, false)
    assert.ok(updates.some((u) => "terminalActionFiredAt" in u.data))
  })
})

describe("runPrescreenTerminalAction — PAUSE branch", () => {
  it("writes pausedAt + no job rec fire", async () => {
    const docs = setupSession({
      sessionId: "s5",
      jobId: "j5",
      prescreenConfig: { jobTitle: "X" },
    })
    const { db, updates } = makeFakeDb(docs)
    const r = await runPrescreenTerminalAction({
      db,
      sessionId: "s5",
      terminal: "PAUSE",
      userId: "u",
      jobId: "j5",
      toE164: "+1",
      lang: "en",
      sendSms: async () => undefined,
      generateJobRecs: async () => ({ ok: true, jobCount: 0 }),
      now: () => new Date("2026-05-12T10:00:00Z"),
    })
    assert.equal(r.jobRecsFired, false)
    assert.ok(updates.some((u) => "pausedAt" in u.data))
  })
})

describe("runPrescreenTerminalAction — fail-open", () => {
  it("generateJobRecs throw does NOT block stamping", async () => {
    const docs = setupSession({
      sessionId: "s6",
      jobId: "j6",
      prescreenConfig: { jobTitle: "X" },
    })
    const { db, updates, audit } = makeFakeDb(docs)
    const r = await runPrescreenTerminalAction({
      db,
      sessionId: "s6",
      terminal: "PASS",
      userId: "u",
      jobId: "j6",
      toE164: "+1",
      lang: "en",
      sendSms: async () => undefined,
      generateJobRecs: async () => {
        throw new Error("boom")
      },
    })
    assert.equal(r.jobRecsFired, true)
    assert.equal(r.jobRecsResult?.ok, false)
    assert.equal(r.jobRecsResult?.reason, "exception")
    assert.ok(updates.some((u) => "terminalActionFiredAt" in u.data))
    assert.equal(audit.length, 1)
  })
})
