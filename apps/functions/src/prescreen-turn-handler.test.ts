import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  normalizePrescreenClarifyTextForRound,
  prescreenClarifyRoundGuidance,
  prescreenSessionEvidenceContext,
  prescreenTurnRecordQId,
  runPrescreenTurnIfActive,
} from "./prescreen-turn-handler.js"
import { terminalText, type KeywordSetLlmCaller, type PreScreenClarifyComposer } from "@pa/pa-orchestrator"
import { SAFETY_CANNED_REPLIES } from "@pa/pa-safety"

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

function makeFakeDbThatRejectsOrderBy(seed: Record<string, Record<string, unknown>>) {
  const { docs } = makeFakeDb(seed)

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
          throw new Error("firestore_index_required_simulation")
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
  it("gives repeated prescreen probes distinct round guidance and non-repeated openers", () => {
    const guidance = [1, 2, 3, 4].map((round) => prescreenClarifyRoundGuidance(round, "en"))
    assert.equal(new Set(guidance).size, 4)
    assert.match(guidance[0], /closest relevant project/)
    assert.match(guidance[1], /ownership and system boundary/)
    assert.match(guidance[2], /hardest failure/)
    assert.match(guidance[3], /Final concrete check/)

    const repeated = [
      normalizePrescreenClarifyTextForRound("That's helpful — what did you personally build?", 1, "en"),
      normalizePrescreenClarifyTextForRound("That's helpful — what systems did it touch?", 2, "en"),
      normalizePrescreenClarifyTextForRound("That helps. What failure did you uncover?", 3, "en"),
      normalizePrescreenClarifyTextForRound("Thanks — what measurable result changed?", 4, "en"),
    ]
    assert.deepEqual(repeated, [
      "Got it - what did you personally build?",
      "The ownership piece matters here - what systems did it touch?",
      "The systems detail is the useful signal - what failure did you uncover?",
      "One last concrete check before I score it - what measurable result changed?",
    ])
  })

  it("keeps technical-depth probes from circling back to role-fit impact", () => {
    const guidance = prescreenClarifyRoundGuidance(1, "en", "technical_depth")
    assert.match(guidance, /weakest required technology/i)
    assert.match(guidance, /do not repeat role-fit impact\/ownership/i)

    const covered = prescreenSessionEvidenceContext(
      {
        questions: {
          role_fit: {
            evidenceReplies: [
              "I owned the dashboard and queries, not the backend service.",
              "The impact was faster triage and fewer unclear escalations.",
            ],
          },
          technical_depth: {
            evidenceReplies: ["SQL is strongest."],
          },
        },
      },
      "technical_depth",
    )
    assert.match(covered, /role_fit:/)
    assert.match(covered, /owned the dashboard/)
    assert.doesNotMatch(covered, /SQL is strongest/)
  })

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

  it("PASS terminal copy offers broader matching onboarding instead of implying an automatic next step", () => {
    const text = terminalText("PASS", "score_pass", "en")
    assert.match(text, /role-fit screen is complete/i)
    assert.match(text, /hiring manager/i)
    assert.match(text, /once (?:there's|there’s) a match/i)
    assert.match(text, /Do you want to proceed\?/)
    assert.doesNotMatch(text, /Sending the next step now/i)
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

  it("ignores stale prescreen docs whose active question is already cleared", async () => {
    const now = new Date().toISOString()
    const { db } = makeFakeDb({
      "pa-prescreen-sessions/ps_stale": {
        sessionId: "ps_stale",
        userId: "u1",
        jobId: "job-ended",
        terminal: null,
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, boundary: "terminal" },
      },
    })

    const terminalCalls: Array<Record<string, unknown>> = []
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "new layoff onboarding reply",
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

    assert.equal(result.handled, false)
    assert.equal(result.sessionId, "ps_stale")
    assert.equal(terminalCalls.length, 0)
    assert.equal(sent.length, 0)
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

  it("treats a natural pause request as a routing pause", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_active": {
        sessionId: "ps_active",
        userId: "u1",
        jobId: "job-1",
        terminal: null,
        currentQId: "technical_depth",
        createdAt: now,
        updatedAt: now,
        workSession: { kind: "job_prescreen", status: "active", startedAt: now, boundary: "trigger" },
        cfgSnapshot: {
          questions: [
            {
              qId: "technical_depth",
              prompt: { en: "Which skill?", zh: "Which skill?" },
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
      replyText: "Can we pause this for now? I’ll come back to the screen later.",
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
    assert.equal(sent.length, 1)
    const session = docs.get("pa-prescreen-sessions/ps_active")?.data
    assert.equal(session?.terminal, "PAUSE")
    assert.equal(session?.terminalReason, "user_exit")
    assert.equal(session?.currentQId, null)
    assert.equal((session?.workSession as { boundary?: string }).boundary, "user_exit")
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
    assert.equal(sent.length, 1)
    assert.match(sent[0] ?? "", /help find jobs/i)
    assert.match(sent[0] ?? "", /Do you want to proceed/i)
    const session = docs.get("pa-prescreen-sessions/ps_done")?.data
    assert.equal(typeof session?.postTerminalFollowupAckAt, "string")
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_done/turns/"))
    assert.equal(turnEntries.length, 1)
    assert.equal((turnEntries[0][1].data.action as { kind?: string }).kind, "post_prescreen_retention")

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
    assert.equal(sent.length, 2, "second post-terminal follow-up should stay in retention instead of normal onboarding")
    assert.match(sent[1] ?? "", /help find jobs/i)
    assert.match(sent[1] ?? "", /Do you want to proceed/i)
  })

  it("yields post-interview proceed yes to shared onboarding without daily subscription consent", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        id: "u1",
        phoneE164: "+13054507715",
        onboardingStatus: "invited",
        onboardingState: "pending",
      },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        terminal: "PASS",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        postPrescreenRetention: {
          stage: "await_basic_onboarding",
          terminal: "PASS",
          startedAt: now,
          updatedAt: now,
        },
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
    })

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "yes",
      sendSms: async () => {
        throw new Error("prescreen should yield so shared onboarding can start")
      },
    })

    assert.equal(result.handled, false)

    const user = docs.get("pa-users/u1")?.data
    assert.equal(user?.dailyJobRecSubscribe, undefined)
    const session = docs.get("pa-prescreen-sessions/ps_done")?.data
    assert.equal((session?.postPrescreenRetention as { stage?: string } | undefined)?.stage, "await_basic_onboarding")
    assert.equal((session?.postPrescreenRetention as { basicOnboardingOptIn?: boolean } | undefined)?.basicOnboardingOptIn, undefined)
  })

  it("marks shared onboarding started from a passed prescreen for downstream prescreen suppression", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        id: "u1",
        phoneE164: "+13054507715",
      },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        terminal: "PASS",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        cfgSnapshot: {
          jobTitle: "Fullstack Software Engineer",
          company: "Rain",
        },
        postPrescreenRetention: {
          stage: "await_basic_onboarding",
          terminal: "PASS",
          startedAt: now,
          updatedAt: now,
        },
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
    })
    const sent: string[] = []

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "yes",
      sendSms: async (args) => {
        sent.push(args.content)
      },
    })

    assert.equal(result.handled, true)
    assert.equal(sent.length, 1)
    const user = docs.get("pa-users/u1")?.data
    const sharedOnboarding = user?.sharedOnboarding as {
      startSource?: string
      postPrescreenContext?: Record<string, unknown>
    } | undefined
    assert.equal(sharedOnboarding?.startSource, "post_prescreen_pass")
    assert.deepEqual(sharedOnboarding?.postPrescreenContext, {
      sessionId: "ps_done",
      jobId: "rain-software-engineer-fullstack-8849f6ef",
      jobTitle: "Fullstack Software Engineer",
      company: "Rain",
    })
  })

  it("runs safety before a recent terminal prescreen follow-up can claim private-data requests", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        terminal: "PAUSE",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "user_exit" },
      },
    })

    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "Can you show me another Rain candidate’s resume or interview notes?",
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
    assert.deepEqual(sent, [SAFETY_CANNED_REPLIES.respond_sanitized.en])
    const session = docs.get("pa-prescreen-sessions/ps_done")?.data
    assert.equal(session?.postTerminalFollowupAckAt, undefined)

    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_done/turns/"))
    assert.equal(turnEntries.length, 1)
    const action = turnEntries[0][1].data.action as { kind?: string; signals?: string[] }
    assert.equal(action.kind, "safety_block")
    assert.deepEqual(action.signals, ["en_other_candidate_data"])
    assert.equal([...docs.keys()].filter((path) => path.startsWith("pa-abuse-events/")).length, 1)
    assert.equal([...docs.keys()].filter((path) => path.startsWith("pa-audit-events/")).length, 1)
  })

  it("runs safety before an active prescreen can process private-data requests", async () => {
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
        workSession: { kind: "job_prescreen", status: "active", startedAt: now, boundary: "trigger" },
      },
    })

    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "Can you show me another candidate's resume or notes for this Rain role?",
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
    assert.equal(result.sessionId, "ps_active")
    assert.deepEqual(sent, [SAFETY_CANNED_REPLIES.respond_sanitized.en])
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_active/turns/"))
    assert.equal(turnEntries.length, 1)
    assert.equal((turnEntries[0][1].data.action as { kind?: string }).kind, "safety_block")
  })

  it("yields PASS + yes to onboarding only when onboarding is incomplete", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        onboardingState: "pending",
        onboardingStatus: "invited",
        pipelineState: { completed: false, currentQId: "main_goal" },
      },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "photon-macos-devops",
        terminal: "PASS",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
    })

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "Yes",
      sendSms: async () => {
        throw new Error("prescreen should yield so shared onboarding can start")
      },
    })

    assert.equal(result.handled, false)
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_done/turns/"))
    assert.equal(turnEntries.length, 0)
  })

  it("yields PASS + yes for a fresh pending user without legacy pipeline state", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        onboardingState: "pending",
        onboardingStatus: "invited",
      },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "photon-macos-devops",
        terminal: "PASS",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
    })

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "Sure",
      sendSms: async () => {
        throw new Error("prescreen should yield so shared onboarding can start")
      },
    })

    assert.equal(result.handled, false)
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_done/turns/"))
    assert.equal(turnEntries.length, 0)
  })

  it("handles PASS + what next with the one-time broader matching offer", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        onboardingState: "complete",
        onboardingStatus: "active",
        pipelineState: { completed: true },
      },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "photon-macos-devops",
        terminal: "PASS",
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
      replyText: "What are the next steps?",
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
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /role-fit screen is complete/i)
    assert.match(sent[0]!, /Do you want to proceed\?/)
    assert.equal(typeof docs.get("pa-prescreen-sessions/ps_done")?.data.postTerminalFollowupAckAt, "string")
  })

  it("yields a recent terminal prescreen when a completed candidate asks for new job matches", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        onboardingState: "complete",
        onboardingStatus: "active",
        pipelineState: { completed: true },
        workSession: {
          kind: "job_prescreen",
          status: "ended",
          sessionId: "ps_done",
          jobId: "rain-software-engineer-fullstack-8849f6ef",
          endedAt: now,
          boundary: "terminal",
          terminal: "PASS",
        },
      },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        terminal: "PASS",
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
      replyText: "Can you find me a few software engineering roles that fit my resume?",
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

    assert.equal(result.handled, false)
    assert.deepEqual(sent, [])
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_done/turns/"))
    assert.equal(turnEntries.length, 0)
  })

  it("yields a recent terminal prescreen when a completed candidate asks to pull role matches", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        onboardingState: "complete",
        onboardingStatus: "active",
        pipelineState: { completed: true },
        workSession: {
          kind: "job_prescreen",
          status: "ended",
          sessionId: "ps_done",
          jobId: "rain-software-engineer-fullstack-8849f6ef",
          endedAt: now,
          boundary: "terminal",
          terminal: "PASS",
        },
      },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        terminal: "PASS",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
    })

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "Please pull fresh fullstack software engineer roles that fit me.",
      sendSms: async () => {
        throw new Error("should not send from prescreen")
      },
    })

    assert.equal(result.handled, false)
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_done/turns/"))
    assert.equal(turnEntries.length, 0)
  })

  it("yields a recent terminal prescreen when candidate asks why a role was recommended", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        onboardingState: "complete",
        onboardingStatus: "active",
        pipelineState: { completed: true },
        workSession: {
          kind: "job_prescreen",
          status: "ended",
          sessionId: "ps_done",
          jobId: "rain-software-engineer-fullstack-8849f6ef",
          endedAt: now,
          boundary: "terminal",
          terminal: "PASS",
        },
      },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        terminal: "PASS",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
    })

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "Why did you recommend Constant Contact and what part of my OFO work matched Rain? Also deprioritize internships.",
      sendSms: async () => {
        throw new Error("should not send from prescreen")
      },
    })

    assert.equal(result.handled, false)
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_done/turns/"))
    assert.equal(turnEntries.length, 0)
  })

  it("yields a recent terminal prescreen for the live multi-part job-fit wording", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        onboardingState: "complete",
        onboardingStatus: "active",
        pipelineState: { completed: true },
        workSession: {
          kind: "job_prescreen",
          status: "ended",
          sessionId: "ps_done",
          jobId: "rain-software-engineer-fullstack-8849f6ef",
          endedAt: now,
          boundary: "terminal",
          terminal: "HARD_STOP",
        },
      },
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

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText:
        "Please answer the three-part job-fit question directly: 1) best current match, 2) whether Rain fullstack still makes sense given what I shared, and 3) whether internships or co-op roles should be lower priority for me.",
      sendSms: async () => {
        throw new Error("should not send from prescreen")
      },
    })

    assert.equal(result.handled, false)
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_done/turns/"))
    assert.equal(turnEntries.length, 0)
  })

  it("yields a recent paused prescreen to an incomplete onboarding location answer", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        onboardingStatus: "in_progress",
        onboardingState: "q_location_asked",
        pipelineState: {
          completed: false,
          currentQId: "q_location",
          collected: { q_country: ["usa"] },
        },
        workSession: {
          kind: "job_prescreen",
          status: "ended",
          sessionId: "ps_done",
          jobId: "rain-software-engineer-fullstack-8849f6ef",
          endedAt: now,
          boundary: "user_exit",
          terminal: "PAUSE",
        },
      },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        terminal: "PAUSE",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "user_exit" },
      },
    })

    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "For location, I am targeting New York or remote.",
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

    assert.equal(result.handled, false)
    assert.deepEqual(sent, [])
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_done/turns/"))
    assert.equal(turnEntries.length, 0)
  })

  it("still finds the newest recent terminal session when the user has more than 50 historical screens", async () => {
    const seed: Record<string, Record<string, unknown>> = {}
    const baseMs = Date.now() - 55 * 60 * 1000
    for (let i = 0; i < 55; i += 1) {
      const iso = new Date(baseMs + i * 60 * 1000).toISOString()
      seed[`pa-prescreen-sessions/ps_old_${String(i).padStart(2, "0")}`] = {
        sessionId: `ps_old_${String(i).padStart(2, "0")}`,
        userId: "u1",
        jobId: `job-old-${i}`,
        terminal: "PAUSE",
        currentQId: null,
        createdAt: iso,
        updatedAt: iso,
        workSession: {
          kind: "job_prescreen",
          status: "ended",
          startedAt: iso,
          endedAt: iso,
          boundary: "user_exit",
        },
      }
    }

    const latestIso = new Date().toISOString()
    seed["pa-prescreen-sessions/ps_latest"] = {
      sessionId: "ps_latest",
      userId: "u1",
      jobId: "rain-software-engineer-fullstack-8849f6ef",
      terminal: "PAUSE",
      currentQId: null,
      createdAt: latestIso,
      updatedAt: latestIso,
      workSession: {
        kind: "job_prescreen",
        status: "ended",
        startedAt: latestIso,
        endedAt: latestIso,
        boundary: "user_exit",
      },
    }

    const { db, docs } = makeFakeDb(seed)
    const sent: string[] = []

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "Thanks",
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
    assert.equal(result.sessionId, "ps_latest")
    assert.equal(sent.length, 1)
    assert.match(sent[0] ?? "", /help find jobs/i)
    assert.match(sent[0] ?? "", /Do you want to proceed/i)
    assert.doesNotMatch(sent[0] ?? "", /daily/i)
    const latest = docs.get("pa-prescreen-sessions/ps_latest")?.data
    assert.equal(typeof latest?.postTerminalFollowupAckAt, "string")
  })

  it("routes an active prescreen without relying on a createdAt composite index", async () => {
    const now = new Date().toISOString()
    const { db } = makeFakeDbThatRejectsOrderBy({
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
              keywords: [{ keyword: "ownership", weight: 1 }],
            },
          ],
        },
      },
    })

    const caller: KeywordSetLlmCaller = {
      async score() {
        return {
          perKeyword: [
            { keyword: "ownership", match: 0.7, confidence: 0.8, evidence: "owned dashboard", reasoning: "clear ownership" },
          ],
          summary: "Needs one deeper example.",
          answered: true,
        }
      },
    }

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "I owned the dashboard and debugging workflow.",
      keywordSetCaller: caller,
      clarifyComposer: async () => "What systems did it touch end to end?",
      sendSms: async (args) => ({
        status: "queued",
        from_number: null,
        number: args.to,
        content: args.content,
        service: "iMessage",
        is_outbound: true,
      }),
    })

    assert.equal(result.handled, true)
    assert.equal(result.terminal, null)
    assert.equal(result.textSent, "What systems did it touch end to end?")
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

  it("writes a pending evaluation attempt for active terminal prescreen instead of firing terminal action", async () => {
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
        maxClarifyRounds: 2,
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
              keywords: [{ keyword: "ownership", weight: 1 }],
            },
          ],
        },
      },
    })

    const caller: KeywordSetLlmCaller = {
      async score() {
        return {
          perKeyword: [
            {
              keyword: "ownership",
              match: 1,
              confidence: 0.95,
              evidence: "owned the fullstack dashboard",
              reasoning: "strong ownership evidence",
            },
          ],
          summary: "Strong match.",
          answered: true,
        }
      },
    }
    const terminalCalls: Array<Record<string, unknown>> = []

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "I owned the fullstack dashboard end to end.",
      keywordSetCaller: caller,
      runTerminalAction: async (args) => {
        terminalCalls.push(args as unknown as Record<string, unknown>)
        return { alreadyFired: false, level1Sent: false, jobRecsFired: false }
      },
      sendSms: async (args) => ({
        status: "queued",
        from_number: null,
        number: args.to,
        content: args.content,
        service: "iMessage",
        is_outbound: true,
      }),
    })

    assert.equal(result.handled, true)
    assert.equal(result.terminal, "PASS")
    assert.deepEqual(terminalCalls, [])
    const session = docs.get("pa-prescreen-sessions/ps_active")?.data
    assert.equal(session?.terminalActionPendingReview, true)
    assert.equal(typeof session?.evaluationAttemptId, "string")
    assert.equal((session?.postPrescreenRetention as { stage?: string } | undefined)?.stage, "await_basic_onboarding")
    const user = docs.get("pa-users/u1")?.data
    assert.equal((user?.workSession as { kind?: string; status?: string } | undefined)?.kind, "job_prescreen")
    assert.equal((user?.workSession as { kind?: string; status?: string } | undefined)?.status, "ended")
    const attempts = [...docs.entries()].filter(([path]) => path.startsWith("pa-evaluation-attempts/"))
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0][1].data.source, "prescreen")
    const attemptDoc = attempts[0][1].data as {
      humanReview?: { status?: string }
      proposedOutcome?: { prescreenTerminal?: string }
    }
    assert.equal(attemptDoc.humanReview?.status, "pending")
    assert.equal(attemptDoc.proposedOutcome?.prescreenTerminal, "PASS")
  })

  it("yields an active prescreen when layoff onboarding owns the user turn", async () => {
    const now = new Date().toISOString()
    const { db } = makeFakeDb({
      "pa-users/u1": {
        source: "WeKruit_Laid_Off",
        onboardingState: "q_role_asked",
        workSession: {
          kind: "layoff_onboarding",
          status: "active",
          boundary: "WeKruit_LAID_OFF",
          startedAt: now,
        },
      },
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
            prompt: "What recent work best matches this role?",
            required: true,
            weight: 1,
            keywords: {
              must: ["react"],
              nice: [],
              negative: [],
            },
            scored: {
              attempts: 0,
              clarifyCount: 0,
              bestScore: 0,
              bestConfidence: 0,
              evidence: [],
            },
          },
        },
      },
    })

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "React TypeScript and Node dashboards.",
      sendSms: async () => {
        throw new Error("should not send from prescreen")
      },
    })

    assert.equal(result.handled, false)
  })
})
