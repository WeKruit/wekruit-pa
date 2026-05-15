import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { prescreenTurnRecordQId, runPrescreenTurnIfActive } from "./prescreen-turn-handler.js"
import type { KeywordSetLlmCaller, PreScreenClarifyComposer } from "@pa/pa-orchestrator"

type FakeDoc = { exists: boolean; data: Record<string, unknown> }

function makeFakeDb(seed: Record<string, Record<string, unknown>>) {
  const docs = new Map<string, FakeDoc>()
  for (const [path, data] of Object.entries(seed)) docs.set(path, { exists: true, data })

  function docRef(collection: string, id: string) {
    const path = `${collection}/${id}`
    return {
      id,
      async get() {
        const doc = docs.get(path) ?? { exists: false, data: {} }
        return { exists: doc.exists, data: () => (doc.exists ? doc.data : undefined) }
      },
      async set(data: Record<string, unknown>, options?: unknown) {
        const prev = docs.get(path)
        const merge = Boolean((options as { merge?: boolean } | undefined)?.merge)
        docs.set(path, { exists: true, data: merge ? { ...(prev?.data ?? {}), ...data } : data })
      },
      collection(subcollection: string) {
        return {
          async add(data: Record<string, unknown>) {
            const childId = `auto_${docs.size + 1}`
            docs.set(`${path}/${subcollection}/${childId}`, { exists: true, data })
            return { id: childId }
          },
        }
      },
    }
  }

  const db = {
    collection(collection: string) {
      const filters: Array<{ field: string; value: unknown }> = []
      let limitCount = Number.POSITIVE_INFINITY
      const query = {
        where(field: string, _op: string, value: unknown) {
          filters.push({ field, value })
          return query
        },
        orderBy() {
          return query
        },
        limit(value: number) {
          limitCount = value
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
          return { empty: out.length === 0, docs: out.slice(0, limitCount) }
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

  return { db: db as never, docs }
}

describe("runPrescreenTurnIfActive session boundaries", () => {
  it("records a candidate reply against the question that was active before the turn", () => {
    assert.equal(prescreenTurnRecordQId({ kind: "clarify", qId: "role_fit", kAfter: 1 }, "role_fit"), "role_fit")
    assert.equal(
      prescreenTurnRecordQId({ kind: "advance", fromQId: "role_fit", toQId: "technical_depth" }, "role_fit"),
      "role_fit",
    )
    assert.equal(
      prescreenTurnRecordQId({ kind: "terminal", terminal: "HARD_STOP", reason: "type_gate_fail" }, "role_fit"),
      "role_fit",
    )
    assert.equal(prescreenTurnRecordQId({ kind: "error", reason: "session_not_found" }, null), "terminal")
  })

  it("expires idle prescreen sessions instead of routing a late reply into the old job", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_old": {
        sessionId: "ps_old",
        userId: "u1",
        jobId: "job-old",
        terminal: null,
        currentQId: "role_fit",
        createdAt: twoHoursAgo,
        updatedAt: twoHoursAgo,
        workSession: { kind: "job_prescreen", status: "active", startedAt: twoHoursAgo, boundary: "trigger" },
      },
    })

    const terminalCalls: Array<Record<string, unknown>> = []
    const sent: string[] = []

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "following up later",
      runTerminalAction: async (args) => {
        terminalCalls.push(args as unknown as Record<string, unknown>)
        return { alreadyFired: false, level1Sent: false, jobRecsFired: false }
      },
      sendSms: async (args) => {
        sent.push(args.content)
        return {
          status: "queued",
          from_number: null,
          number: args.to,
          content: args.content,
          service: "iMessage",
          is_outbound: true,
        }
      },
    })

    assert.equal(result.handled, true)
    assert.equal(result.terminal, "PAUSE")
    assert.equal(terminalCalls.length, 1)
    assert.equal(terminalCalls[0].terminal, "PAUSE")
    assert.equal(terminalCalls[0].jobId, "job-old")
    assert.equal(sent.length, 1)
    assert.match(sent[0], /paused this role screen/)
    const session = docs.get("pa-prescreen-sessions/ps_old")?.data
    assert.equal(session?.terminal, "PAUSE")
    assert.equal(session?.terminalReason, "expired_inactive_prescreen_session")
    assert.equal((session?.workSession as { boundary?: string }).boundary, "timeout")
  })

  it("treats explicit user exit as a routing pause, not a business outcome", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_active": {
        sessionId: "ps_active",
        userId: "u1",
        jobId: "job-1",
        terminal: null,
        currentQId: "role_fit",
        createdAt: now,
        updatedAt: now,
        workSession: { kind: "job_prescreen", status: "active", startedAt: now, boundary: "trigger" },
        cfgSnapshot: {
          questions: [
            {
              qId: "role_fit",
              prompt: { en: "What matches?", zh: "What matches?" },
              clarifyPrompt: { en: "Tell me more.", zh: "Tell me more." },
              keywords: [],
            },
          ],
        },
      },
    })

    const terminalCalls: Array<Record<string, unknown>> = []
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "stop",
      runTerminalAction: async (args) => {
        terminalCalls.push(args as unknown as Record<string, unknown>)
        return { alreadyFired: false, level1Sent: false, jobRecsFired: false }
      },
      sendSms: async (args) => {
        sent.push(args.content)
        return {
          status: "queued",
          from_number: null,
          number: args.to,
          content: args.content,
          service: "iMessage",
          is_outbound: true,
        }
      },
    })

    assert.equal(result.handled, true)
    assert.equal(result.terminal, "PAUSE")
    assert.equal(terminalCalls.length, 1)
    assert.equal(terminalCalls[0].terminal, "PAUSE")
    assert.equal(sent.length, 1)
    assert.match(sent[0], /paused this role screen/)
    const session = docs.get("pa-prescreen-sessions/ps_active")?.data
    assert.equal(session?.terminal, "PAUSE")
    assert.equal(session?.terminalReason, "user_exit")
    assert.equal(session?.currentQId, null)
    assert.equal((session?.workSession as { status?: string }).status, "ended")
    assert.equal((session?.workSession as { boundary?: string }).boundary, "user_exit")
    assert.ok([...docs.keys()].some((path) => path.startsWith("pa-prescreen-sessions/ps_active/turns/")))
  })

  it("guards a recent terminal prescreen so follow-up texts do not fall into normal onboarding", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        terminal: "HARD_STOP",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
    })

    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "I still cannot relocate to New York.",
      sendSms: async (args) => {
        sent.push(args.content)
        return {
          status: "queued",
          from_number: null,
          number: args.to,
          content: args.content,
          service: "iMessage",
          is_outbound: true,
        }
      },
    })

    assert.equal(result.handled, true)
    assert.equal(result.sessionId, "ps_done")
    assert.equal(result.terminal, "HARD_STOP")
    assert.deepEqual(sent, [
      "Got it. This role screen is already paused; I will keep that constraint on your profile and use it for better-matched roles.",
    ])
    const session = docs.get("pa-prescreen-sessions/ps_done")?.data
    assert.equal(typeof session?.postTerminalFollowupAckAt, "string")
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_done/turns/"))
    assert.equal(turnEntries.length, 1)
    assert.equal((turnEntries[0][1].data.action as { kind?: string }).kind, "post_terminal_followup")

    const second = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "Remote Los Angeles only.",
      sendSms: async (args) => {
        sent.push(args.content)
        return {
          status: "queued",
          from_number: null,
          number: args.to,
          content: args.content,
          service: "iMessage",
          is_outbound: true,
        }
      },
    })

    assert.equal(second.handled, true)
    assert.equal(sent.length, 1, "second post-terminal follow-up should be handled silently")
  })

  it("handles a coalesced multi-message role-fit reply as one probe turn", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_active": {
        sessionId: "ps_active",
        userId: "u1",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        terminal: null,
        currentQId: "role_fit",
        createdAt: now,
        updatedAt: now,
        score: 0,
        scoreMax: 1,
        threshold: 0.65,
        confidenceThreshold: 0.7,
        maxClarifyRounds: 4,
        qOrder: ["role_fit"],
        questions: {
          role_fit: {
            qId: "role_fit",
            type: "MUST_HAVE",
            weight: 1,
            clarifyRounds: 0,
          },
        },
        workSession: { kind: "job_prescreen", status: "active", startedAt: now, boundary: "trigger" },
        cfgSnapshot: {
          questions: [
            {
              qId: "role_fit",
              prompt: { en: "What recent work best matches this software engineering role?", zh: "What recent work best matches this software engineering role?" },
              clarifyPrompt: { en: "Tell me more.", zh: "Tell me more." },
              keywords: [
                { keyword: "fullstack ownership", weight: 1 },
                { keyword: "API or data-system debugging", weight: 1 },
              ],
            },
          ],
        },
      },
    })

    const replyText = [
      "For OFO Delivery, I owned the merchant order dashboard and dispatch tooling.",
      "I built JavaScript screens, SQL reports, and scripts to trace failed orders.",
    ].join("\n")
    const caller: KeywordSetLlmCaller = {
      async score() {
        return {
          perKeyword: [
            { keyword: "fullstack ownership", match: 0.72, confidence: 0.74, evidence: "owned dashboard", reasoning: "adjacent ownership" },
            { keyword: "API or data-system debugging", match: 0.7, confidence: 0.74, evidence: "SQL reports", reasoning: "data debugging" },
          ],
          summary: "Adjacent dashboard/data ownership; needs one deeper systems example.",
          answered: true,
        }
      },
    }
    const clarifyComposer: PreScreenClarifyComposer = async (input) => {
      assert.equal(input.reply, replyText)
      assert.equal(input.clarifyRound, 1)
      return "That helps. What systems did that dashboard touch, and what changed after it shipped?"
    }
    const sent: string[] = []
    const terminalCalls: Array<Record<string, unknown>> = []

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText,
      keywordSetCaller: caller,
      clarifyComposer,
      runTerminalAction: async (args) => {
        terminalCalls.push(args as unknown as Record<string, unknown>)
        return { alreadyFired: false, level1Sent: false, jobRecsFired: false }
      },
      sendSms: async (args) => {
        sent.push(args.content)
        return {
          status: "queued",
          from_number: null,
          number: args.to,
          content: args.content,
          service: "iMessage",
          is_outbound: true,
        }
      },
    })

    assert.equal(result.handled, true)
    assert.equal(result.terminal, null)
    assert.deepEqual(terminalCalls, [])
    assert.deepEqual(sent, ["That helps. What systems did that dashboard touch, and what changed after it shipped?"])
    const session = docs.get("pa-prescreen-sessions/ps_active")?.data
    assert.equal(session?.terminal, null)
    assert.equal((session?.questions as Record<string, { clarifyRounds?: number }>).role_fit.clarifyRounds, 1)
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_active/turns/"))
    assert.equal(turnEntries.length, 1)
    assert.equal(turnEntries[0][1].data.reply, replyText)
    assert.equal((turnEntries[0][1].data.action as { kind?: string }).kind, "clarify")
  })
})
