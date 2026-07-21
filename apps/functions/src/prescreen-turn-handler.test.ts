import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  normalizePrescreenClarifyTextForRound,
  prescreenClarifyRoundGuidance,
  prescreenSessionEvidenceContext,
  prescreenTurnRecordQId,
  runPrescreenTurnIfActive,
} from "./prescreen-turn-handler.js"
import type { KeywordSetLlmCaller, PreScreenClarifyComposer } from "@pa/pa-orchestrator"
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

  it("expires truly stale prescreen sessions and asks the candidate to restart the role screen", async () => {
    const stale = new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_old": {
        sessionId: "ps_old",
        userId: "u1",
        jobId: "job-old",
        terminal: null,
        currentQId: "role_fit",
        createdAt: stale,
        updatedAt: stale,
        workSession: { kind: "job_prescreen", status: "active", startedAt: stale, boundary: "trigger" },
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
    assert.match(sent[0], /reply "restart screen"/)
    const session = docs.get("pa-prescreen-sessions/ps_old")?.data
    assert.equal(session?.terminal, "PAUSE")
    assert.equal(session?.terminalReason, "expired_inactive_prescreen_session")
    assert.equal((session?.workSession as { boundary?: string }).boundary, "timeout")
  })

  it("expires a ZOMBIE prescreen (stale createdAt, FRESH updatedAt) and does NOT capture the turn", async () => {
    // Live +19196415056 / ps_hs-10996795-invoko-product-manager_…: createdAt days ago, but
    // updatedAt seconds ago because every captured turn (clarify loop on Q1) re-bumped it.
    // The updatedAt inactivity timeout therefore CANNOT fire — only the createdAt absolute
    // age cap catches it. The candidate had moved on to job recs; this turn ("yes") must NOT
    // be hijacked into a prescreen probe — the session is swept and we hand back a restart notice.
    const createdStale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() // 3 days
    const updatedFresh = new Date(Date.now() - 30 * 1000).toISOString() // 30s ago
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_zombie": {
        sessionId: "ps_zombie",
        userId: "u_zombie",
        jobId: "hs-10996795-invoko-product-manager",
        terminal: null,
        currentQId: "q_consumer_product_experience",
        createdAt: createdStale,
        updatedAt: updatedFresh,
        workSession: { kind: "job_prescreen", status: "active", startedAt: createdStale, boundary: "trigger" },
      },
    })

    const terminalCalls: Array<Record<string, unknown>> = []
    const sent: string[] = []

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u_zombie",
      toE164: "+13054507715",
      replyText: "yes", // job-rec follow-up reply, NOT a prescreen answer
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

    // Swept to a stale-closed terminal (PAUSE / expired_inactive) — NOT advanced as a live answer.
    assert.equal(result.terminal, "PAUSE")
    const session = docs.get("pa-prescreen-sessions/ps_zombie")?.data
    assert.equal(session?.terminal, "PAUSE")
    assert.equal(session?.terminalReason, "expired_inactive_prescreen_session")
    assert.equal((session?.workSession as { boundary?: string }).boundary, "timeout")
    // The candidate's "yes" was NOT scored against q_consumer_product_experience.
    assert.equal(session?.currentQId, null)

    // (1) NOTIFY exactly once — the warm timeout copy went out.
    assert.equal(sent.length, 1)
    assert.match(sent[0], /timed out/)
    assert.match(sent[0], /restart screen/)

    // (2) STORE PROPERLY — expiry fields stamped on the session doc.
    assert.equal(typeof session?.expiredAt, "string")
    assert.equal(typeof session?.expiryNoticeSentAt, "string")

    // (3) AUDIT — a session_expired_swept turn was written with the age + createdAt.
    const auditTurns = [...docs.entries()].filter(
      ([path]) => path.startsWith("pa-prescreen-sessions/ps_zombie/turns/"),
    )
    const sweepTurn = auditTurns
      .map(([, doc]) => doc.data)
      .find((d) => (d.action as { kind?: string } | undefined)?.kind === "session_expired_swept")
    assert.ok(sweepTurn, "expected a session_expired_swept audit turn")
    const action = sweepTurn!.action as { kind: string; detector: string; ageMs: number; createdAt: string }
    assert.equal(action.detector, "find_active_session")
    assert.equal(typeof action.ageMs, "number")
    assert.equal(action.ageMs > 2 * 24 * 60 * 60 * 1000, true) // > 2 days old
    assert.equal(action.createdAt, createdStale)
  })

  it("does NOT re-notify on a later turn once expiryNoticeSentAt is set (idempotent expiry)", async () => {
    // Second stale turn after the screen was already swept + the candidate already told. The session
    // is now terminal=null again only in a degenerate replay; we simulate the realistic case where a
    // residual terminal=null doc carries expiryNoticeSentAt → the notice must NOT fire again.
    const createdStale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_zombie2": {
        sessionId: "ps_zombie2",
        userId: "u_zombie2",
        jobId: "hs-10996795-invoko-product-manager",
        terminal: null, // still resolves via findActiveSession → kind:"expired"
        currentQId: "q_consumer_product_experience",
        createdAt: createdStale,
        updatedAt: new Date(Date.now() - 30 * 1000).toISOString(),
        expiryNoticeSentAt: new Date(Date.now() - 60 * 1000).toISOString(), // already notified once
        workSession: { kind: "job_prescreen", status: "active", startedAt: createdStale, boundary: "trigger" },
      },
    })

    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u_zombie2",
      toE164: "+13054507715",
      replyText: "yes",
      runTerminalAction: async () => ({ alreadyFired: false, level1Sent: false, jobRecsFired: false }),
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

    // NO second notice; the turn is released (handled:false) so the candidate's CURRENT intent
    // ("yes" to job recs) still gets handled downstream by triage/matching.
    assert.equal(sent.length, 0)
    assert.equal(result.handled, false)
    assert.equal(result.terminal, "PAUSE")
    // Session stays swept (terminal set by the sweep), not re-opened.
    const session = docs.get("pa-prescreen-sessions/ps_zombie2")?.data
    assert.equal(session?.terminal, "PAUSE")
  })

  it("keeps a two-hour-old active prescreen alive and advances to the next role question", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_invoko_live": {
        sessionId: "ps_invoko_live",
        userId: "wQfGZlttRQltMPv4NU6e",
        jobId: "hs-10996795-invoko-product-manager",
        terminal: null,
        currentQId: "q_consumer_product_experience",
        createdAt: twoHoursAgo,
        updatedAt: twoHoursAgo,
        score: 0,
        scoreMax: 3,
        threshold: 0.65,
        confidenceThreshold: 0.7,
        maxClarifyRounds: 3,
        qOrder: ["q_consumer_product_experience", "q_ship_taste"],
        questions: {
          q_consumer_product_experience: {
            qId: "q_consumer_product_experience",
            type: "MUST_HAVE",
            weight: 2,
            matchThreshold: 0.85,
            clarifyRounds: 0,
          },
          q_ship_taste: {
            qId: "q_ship_taste",
            type: "MUST_HAVE",
            weight: 1,
            matchThreshold: 0.85,
            clarifyRounds: 0,
          },
        },
        workSession: { kind: "job_prescreen", status: "active", startedAt: twoHoursAgo, boundary: "trigger" },
        cfgSnapshot: {
          questions: [
            {
              qId: "q_consumer_product_experience",
              prompt: {
                en: "Tell me about consumer product work you've done - PM, design, or eng role on a real user-facing product. What did you ship and what feedback did it drive?",
                zh: "Tell me about consumer product work you've done - PM, design, or eng role on a real user-facing product. What did you ship and what feedback did it drive?",
              },
              clarifyPrompt: { en: "What did you ship and what feedback did it drive?", zh: "What did you ship and what feedback did it drive?" },
              keywords: [{ keyword: "consumer_product_shipping", weight: 1 }],
            },
            {
              qId: "q_ship_taste",
              prompt: {
                en: "How do you decide what to ship next when you have more ideas than time? Walk me through your prioritization.",
                zh: "How do you decide what to ship next when you have more ideas than time? Walk me through your prioritization.",
              },
              clarifyPrompt: { en: "Give me the smallest slice you shipped and why.", zh: "Give me the smallest slice you shipped and why." },
              keywords: [{ keyword: "prioritization_taste", weight: 1 }],
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
              keyword: "consumer_product_shipping",
              match: 0.95,
              confidence: 0.9,
              evidence: "supported launch of user-facing dealership workflows",
              reasoning: "clear shipped user-facing product example",
            },
          ],
          summary: "Strong enough to advance to product judgment.",
          answered: true,
        }
      },
    }
    const sent: string[] = []
    const terminalCalls: Array<Record<string, unknown>> = []

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "wQfGZlttRQltMPv4NU6e",
      toE164: "+12026571666",
      replyText:
        "I supported a PoS platform for automotive dealerships, translated business needs into product requirements, worked with engineering through testing, and used post-launch feedback to prioritize workflow changes.",
      keywordSetCaller: caller,
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
    assert.equal(result.textSent, "How do you decide what to ship next when you have more ideas than time? Walk me through your prioritization.")
    assert.deepEqual(sent, ["How do you decide what to ship next when you have more ideas than time? Walk me through your prioritization."])
    assert.deepEqual(terminalCalls, [])
    const session = docs.get("pa-prescreen-sessions/ps_invoko_live")?.data
    assert.equal(session?.terminal, null)
    assert.equal(session?.currentQId, "q_ship_taste")
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_invoko_live/turns/"))
    assert.equal(turnEntries.length, 1)
    assert.deepEqual(turnEntries[0][1].data.action, {
      kind: "advance",
      fromQId: "q_consumer_product_experience",
      toQId: "q_ship_taste",
    })
  })

  it("image-only reply on a scoring question asks for text instead of scoring 0 → HARD_STOP (Robert 2026-06-19)", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_image_proof": {
        sessionId: "ps_image_proof",
        userId: "imgUser1",
        jobId: "wekruit-x-twitter-growth-lead",
        terminal: null,
        currentQId: "q_operated_account_proof",
        createdAt: twoHoursAgo,
        updatedAt: twoHoursAgo,
        score: 0,
        scoreMax: 1,
        threshold: 0.65,
        confidenceThreshold: 0.7,
        maxClarifyRounds: 2,
        qOrder: ["q_operated_account_proof"],
        questions: {
          q_operated_account_proof: {
            qId: "q_operated_account_proof",
            type: "MUST_HAVE",
            weight: 1,
            matchThreshold: 0.85,
            clarifyRounds: 0,
          },
        },
        workSession: { kind: "job_prescreen", status: "active", startedAt: twoHoursAgo, boundary: "trigger" },
        cfgSnapshot: {
          questions: [
            {
              qId: "q_operated_account_proof",
              prompt: { en: "Share a link or screenshot proving an X account you grew, with metrics.", zh: "" },
              clarifyPrompt: { en: "Which account, and what were the numbers?", zh: "" },
              keywords: [{ keyword: "operated_account_proof", weight: 1 }],
            },
          ],
        },
      },
    })

    let judgeCalled = false
    const caller: KeywordSetLlmCaller = {
      async score() {
        judgeCalled = true
        return { perKeyword: [], summary: "", answered: false }
      },
    }
    const sent: string[] = []
    const terminalCalls: Array<Record<string, unknown>> = []

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "imgUser1",
      toE164: "+12025550133",
      replyText: "", // image-only inbound: no usable text
      mediaUrl: "https://cdn.sendblue.co/media/screenshot-analytics-1",
      keywordSetCaller: caller,
      runTerminalAction: async (args) => {
        terminalCalls.push(args as unknown as Record<string, unknown>)
        return { alreadyFired: false, level1Sent: false, jobRecsFired: false }
      },
      sendSms: async (a) => {
        sent.push(a.content)
        return { status: "queued", from_number: null, number: a.to, content: a.content, service: "iMessage", is_outbound: true }
      },
    })

    assert.equal(result.handled, true)
    assert.equal(result.terminal, null, "must NOT terminal on an image-only reply")
    assert.equal(judgeCalled, false, "the judge must NOT score an empty image-only reply")
    assert.deepEqual(terminalCalls, [], "no terminal action fired")
    assert.equal(sent.length, 1, "exactly one ask sent")
    assert.match(sent[0], /screenshot|paste/i)
    const session = docs.get("pa-prescreen-sessions/ps_image_proof")?.data
    assert.equal(session?.terminal, null)
    assert.equal(session?.currentQId, "q_operated_account_proof", "question NOT advanced")
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_image_proof/turns/"))
    assert.equal(turnEntries.length, 1)
    assert.equal((turnEntries[0][1].data.action as { kind?: string }).kind, "image_proof_ask")
  })

  const VOICE_DEV_PHONE = "+14243201960"

  function seedActiveVoiceSession() {
    const now = new Date().toISOString()
    return makeFakeDb({
      "pa-prescreen-sessions/ps_sekai": {
        sessionId: "ps_sekai",
        userId: "u_voice",
        jobId: "sekai-ai-agent-engineer",
        terminal: null,
        currentQId: "technical_depth",
        createdAt: now,
        updatedAt: now,
        score: 0,
        scoreMax: 2,
        threshold: 0.65,
        confidenceThreshold: 0.7,
        maxClarifyRounds: 3,
        qOrder: ["technical_depth", "ownership"],
        questions: {
          technical_depth: { qId: "technical_depth", type: "MUST_HAVE", weight: 1, matchThreshold: 0.85, clarifyRounds: 0 },
          ownership: { qId: "ownership", type: "MUST_HAVE", weight: 1, matchThreshold: 0.85, clarifyRounds: 0 },
        },
        workSession: { kind: "job_prescreen", status: "active", startedAt: now, boundary: "trigger" },
        cfgSnapshot: {
          questions: [
            {
              qId: "technical_depth",
              prompt: { en: "What's the closest coding-agent project you've built?", zh: "What's the closest coding-agent project you've built?" },
              clarifyPrompt: { en: "Go deeper on the implementation.", zh: "Go deeper on the implementation." },
              keywords: [{ keyword: "coding_agent", weight: 1 }],
            },
            {
              qId: "ownership",
              prompt: { en: "What did you personally own?", zh: "What did you personally own?" },
              clarifyPrompt: { en: "Which part was yours end-to-end?", zh: "Which part was yours end-to-end?" },
              keywords: [{ keyword: "ownership", weight: 1 }],
            },
          ],
        },
      },
    })
  }

  it("yields an explicit phone-prescreen request to Claire's voice tools instead of scoring it as a text answer", async () => {
    const { db, docs } = seedActiveVoiceSession()
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u_voice",
      toE164: VOICE_DEV_PHONE,
      replyText: "I want to prescreen Sekai AI Agent Engineer (Coding Agent) on phone call",
      sendSms: async (args) => {
        sent.push(args.content)
        return { status: "queued", from_number: null, number: args.to, content: args.content, service: "iMessage", is_outbound: true }
      },
    })

    assert.equal(result.handled, false)
    assert.equal(result.sessionId, "ps_sekai")
    assert.equal(sent.length, 0)
    // Session untouched — no terminal, no advance, no turn appended.
    const session = docs.get("pa-prescreen-sessions/ps_sekai")?.data
    assert.equal(session?.terminal, null)
    assert.equal(session?.currentQId, "technical_depth")
    const turns = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_sekai/turns/"))
    assert.equal(turns.length, 0)
  })

  it("yields a yes that answers a live voice-call offer instead of scoring it as a text answer", async () => {
    const { db, docs } = seedActiveVoiceSession()
    docs.set("pa-voice-call-offers/offer-live", {
      exists: true,
      data: {
        userId: "u_voice",
        sessionId: "chat-voice",
        purpose: "prescreen",
        paJobId: "sekai-ai-agent-engineer",
        phoneE164: VOICE_DEV_PHONE,
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      },
    })
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u_voice",
      toE164: VOICE_DEV_PHONE,
      replyText: "yes",
      sendSms: async (args) => {
        sent.push(args.content)
        return { status: "queued", from_number: null, number: args.to, content: args.content, service: "iMessage", is_outbound: true }
      },
    })

    assert.equal(result.handled, false)
    assert.equal(result.sessionId, "ps_sekai")
    assert.equal(sent.length, 0)
    const session = docs.get("pa-prescreen-sessions/ps_sekai")?.data
    assert.equal(session?.currentQId, "technical_depth")
  })

  it("does NOT yield a normal prescreen answer on a dev phone (no voice intent, no offer)", async () => {
    const { db, docs } = seedActiveVoiceSession()
    const caller: KeywordSetLlmCaller = {
      async score() {
        return {
          perKeyword: [{ keyword: "coding_agent", match: 0.95, confidence: 0.9, evidence: "built a coding agent", reasoning: "clear" }],
          summary: "Strong.",
          answered: true,
        }
      },
    }
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u_voice",
      toE164: VOICE_DEV_PHONE,
      replyText: "I built an autonomous coding agent that plans, edits files, and runs tests in a loop.",
      keywordSetCaller: caller,
      runTerminalAction: async () => ({ alreadyFired: false, level1Sent: false, jobRecsFired: false }),
      sendSms: async (args) => {
        sent.push(args.content)
        return { status: "queued", from_number: null, number: args.to, content: args.content, service: "iMessage", is_outbound: true }
      },
    })

    assert.equal(result.handled, true)
    const session = docs.get("pa-prescreen-sessions/ps_sekai")?.data
    assert.equal(session?.currentQId, "ownership")
  })

  it("does NOT yield a bare yes on a dev phone when there is no pending voice-call offer", async () => {
    const { db } = seedActiveVoiceSession()
    const caller: KeywordSetLlmCaller = {
      async score() {
        return { perKeyword: [{ keyword: "coding_agent", match: 0.2, confidence: 0.9, evidence: "", reasoning: "low" }], summary: "Weak.", answered: false }
      },
    }
    const clarify: PreScreenClarifyComposer = async () => "Go deeper on the implementation."
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u_voice",
      toE164: VOICE_DEV_PHONE,
      replyText: "yes",
      keywordSetCaller: caller,
      clarifyComposer: clarify,
      sendSms: async (args) => {
        sent.push(args.content)
        return { status: "queued", from_number: null, number: args.to, content: args.content, service: "iMessage", is_outbound: true }
      },
    })

    assert.equal(result.handled, true)
    assert.equal(sent.length, 1)
  })

  function seedVoiceOptInTerminalSession() {
    const now = new Date().toISOString()
    return makeFakeDb({
      "pa-prescreen-sessions/ps_voice_optin": {
        sessionId: "ps_voice_optin",
        userId: "u_vopt",
        jobId: "sekai-ai-agent-engineer",
        terminal: "PASS",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        voicePostCallJobRecOptInPending: true,
        voicePostCallJobRecOptInAskedAt: now,
        workSession: { kind: "job_prescreen", status: "ended", endedAt: now, boundary: "terminal" },
      },
    })
  }

  it("fires find_match recs when the candidate says yes to the voice post-call job-rec offer", async () => {
    const { db, docs } = seedVoiceOptInTerminalSession()
    const recs: Array<{ userId: string; toE164: string }> = []
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u_vopt",
      toE164: "+13054507715",
      replyText: "yes",
      fireJobRecs: async (a) => {
        recs.push(a)
        return { ok: true, jobCount: 3 }
      },
      sendSms: async (a) => {
        sent.push(a.content)
        return { status: "queued", from_number: null, number: a.to, content: a.content, service: "iMessage", is_outbound: true }
      },
    })

    assert.equal(result.handled, true)
    assert.equal(recs.length, 1)
    assert.equal(recs[0].userId, "u_vopt")
    assert.match(sent[0] ?? "", /pulling a few roles/i)
    const session = docs.get("pa-prescreen-sessions/ps_voice_optin")?.data
    assert.equal(session?.voicePostCallJobRecOptInPending, false)
  })

  it("does not fire recs when the candidate declines the voice post-call job-rec offer", async () => {
    const { db, docs } = seedVoiceOptInTerminalSession()
    const recs: unknown[] = []
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u_vopt",
      toE164: "+13054507715",
      replyText: "no thanks",
      fireJobRecs: async (a) => {
        recs.push(a)
        return { ok: true, jobCount: 0 }
      },
      sendSms: async (a) => {
        sent.push(a.content)
        return { status: "queued", from_number: null, number: a.to, content: a.content, service: "iMessage", is_outbound: true }
      },
    })

    assert.equal(result.handled, true)
    assert.equal(recs.length, 0)
    assert.match(sent[0] ?? "", /on file/i)
    const session = docs.get("pa-prescreen-sessions/ps_voice_optin")?.data
    assert.equal(session?.voicePostCallJobRecOptInPending, false)
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
      "pa-users/u1": {
        postMatchRetention: {
          stage: "await_prescreen",
          startedAt: now,
          updatedAt: now,
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

  it("a bare 'Yes' accepting a post-terminal roles offer yields to runtime (find_match), not swallowed (Andrea 2026-06-23)", async () => {
    const now = new Date().toISOString()
    const { db } = makeFakeDb({
      "pa-prescreen-sessions/ps_andrea": {
        sessionId: "ps_andrea",
        userId: "u1",
        jobId: "wekruit-product-designer-ui-ux-new-grad",
        terminal: "HARD_STOP",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        // held for human review — the pending-review guard would normally OWN a bare affirmative.
        terminalActionPendingReview: true,
        review: { status: "pending" },
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
      // thin-Claire's post-terminal OFFER is the candidate's most recent context.
      "pa-outbound/ob_offer": {
        id: "ob_offer",
        userId: "u1",
        status: "sent",
        createdAt: now,
        body: "hey Andrea — totally, yes. you can apply to more than one WeKruit role. want me to pull a few other design roles that fit your UI/UX angle?",
      },
    })
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+16463292102",
      replyText: "Yes",
      sendSms: async (a) => {
        sent.push(a.content)
        return { status: "queued", from_number: null, number: a.to, content: a.content, service: "iMessage", is_outbound: true }
      },
    })
    // The accepted offer must YIELD to runtime (thin-Claire find_match), NOT be swallowed as a
    // terminal-ack. Before the fix this returned handled:true and sent nothing → candidate silence.
    assert.equal(result.handled, false, "a 'Yes' accepting our roles offer must yield, not be swallowed")
  })

  it("acknowledges a recent terminal prescreen pending WeKruit team review without sending retention outbound", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_pending_review": {
        sessionId: "ps_pending_review",
        userId: "u1",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        terminal: "PASS",
        currentQId: null,
        terminalActionPendingReview: true,
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
    assert.equal(result.sessionId, "ps_pending_review")
    assert.equal(result.terminal, "PASS")
    assert.match(result.textSent ?? "", /WeKruit team/i)
    assert.equal(sent.length, 1)
    assert.match(sent[0] ?? "", /WeKruit team/i)
    const session = docs.get("pa-prescreen-sessions/ps_pending_review")?.data
    assert.equal(session?.postPrescreenRetention, undefined)
    assert.equal(typeof session?.reviewPendingFollowupAt, "string")
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_pending_review/turns/"))
    assert.equal(turnEntries.length, 1)
    assert.equal((turnEntries[0][1].data.action as { reason?: string }).reason, "pending_wekruit_team_review")
  })

  it("turns a post-interview proceed yes into the gap-aware thin onboarding (role first when nothing on file), NOT the legacy main_goal wall", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        id: "u1",
        phoneE164: "+13054507715",
        onboardingStatus: "invited",
        onboardingState: "pending",
        // NO tags.targetRoleFunction / targetLocations → firstMissing = target_role.
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

    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "yes",
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
    // Wording-differs lock: still thanks them for the screen.
    assert.match(sent[0] ?? "", /thanks for completing the screen/i)
    // CONVERGES to the gap-aware thin set (target_role prompt), NOT the legacy main_goal wall.
    assert.match(sent[0] ?? "", /what kind of roles are you going for/i)
    assert.doesNotMatch(sent[0] ?? "", /what matters most/i)

    const user = docs.get("pa-users/u1")?.data
    assert.equal(user?.dailyJobRecSubscribe, undefined)
    assert.equal((user?.sharedOnboarding as { status?: string } | undefined)?.status, "active")
    assert.equal((user?.workSession as { kind?: string; status?: string } | undefined)?.kind, "shared_onboarding")
    assert.equal((user?.workSession as { kind?: string; status?: string } | undefined)?.status, "active")
    const session = docs.get("pa-prescreen-sessions/ps_done")?.data
    assert.equal((session?.postPrescreenRetention as { stage?: string } | undefined)?.stage, "onboarding_started")
    assert.equal((session?.postPrescreenRetention as { basicOnboardingOptIn?: boolean } | undefined)?.basicOnboardingOptIn, true)
  })

  it("does NOT match on a COURTESY ACK after a prescreen terminal — offers instead (Adam 2026-06-15 live bug)", async () => {
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
        // FIRST post-terminal turn — no proceed prompt asked yet (no postPrescreenRetention stage).
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
    })

    const sent: string[] = []
    let firedRecs = false
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      // The EXACT live-bug reply: a courtesy ack of the pending review, NOT a match request.
      replyText: "Sure. Looking forward for the update.",
      fireJobRecs: async () => {
        firedRecs = true
        return { ok: true, jobCount: 3 }
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
    assert.equal(sent.length, 1)
    // OFFER is made; NO "pulling matches" / onboarding bridge fired.
    assert.match(sent[0] ?? "", /Do you want to proceed/i)
    assert.doesNotMatch(sent[0] ?? "", /pull a few matches/i)
    assert.doesNotMatch(sent[0] ?? "", /thanks for completing the screen/i)
    assert.equal(firedRecs, false, "a courtesy ack must NOT fire find_match")
    // Stays in the offer stage so an explicit yes next turn can proceed.
    const session = docs.get("pa-prescreen-sessions/ps_done")?.data
    assert.equal((session?.postPrescreenRetention as { stage?: string } | undefined)?.stage, "await_basic_onboarding")
  })

  it("an EXPLICIT matching request after a terminal yields to the agent (find_match path), not the courtesy-ack offer", async () => {
    const now = new Date().toISOString()
    const { db } = makeFakeDb({
      "pa-users/u1": {
        id: "u1",
        phoneE164: "+13054507715",
        onboardingStatus: "invited",
        onboardingState: "pending",
        tags: {
          targetRoleFunction: ["software_engineering"],
          targetLocations: ["san_francisco_bay_area"],
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
      // An explicit new matching intent is recognized as such → the deterministic
      // retention branch yields (handled:false) so the agent's find_match handles it.
      // It must NOT be swallowed by the courtesy-ack offer prompt.
      replyText: "yes, pull some roles for me",
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

    // Explicit intent → yields to runtime (the agent owns matching). The deterministic
    // path does NOT send the "Do you want to proceed?" courtesy-ack offer here.
    assert.equal(result.handled, false)
    assert.equal(sent.length, 0)
  })

  it("converges to ONLY the location ask when role is already derived (LinkedIn/résumé enrich) — never re-asks role", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        id: "u1",
        phoneE164: "+13054507715",
        onboardingStatus: "invited",
        onboardingState: "pending",
        // Role auto-derived at enrich (#2) → target_role satisfied; location still missing.
        tags: { targetRoleFunction: ["software_engineering"] },
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

    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "yes",
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
    assert.match(sent[0] ?? "", /thanks for completing the screen/i)
    // ONLY the location ask — role is suppressed (already on file).
    assert.match(sent[0] ?? "", /where in the US/i)
    assert.doesNotMatch(sent[0] ?? "", /what kind of roles are you going for/i)
    assert.doesNotMatch(sent[0] ?? "", /what matters most/i)
    void docs
  })

  it("bridges straight to recs (find_match) when role AND location are both already known — no question asked", async () => {
    const now = new Date().toISOString()
    const { db } = makeFakeDb({
      "pa-users/u1": {
        id: "u1",
        phoneE164: "+13054507715",
        onboardingStatus: "invited",
        onboardingState: "pending",
        tags: {
          targetRoleFunction: ["software_engineering"],
          targetLocations: ["san_francisco_bay_area"],
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
    let firedRecsForUser: string | null = null
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "yes",
      // Inject the rec-firer so we can assert it's called exactly once without a real find_match.
      fireJobRecs: async (a) => {
        firedRecsForUser = a.userId
        return { ok: true, jobCount: 3 }
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
    assert.equal(sent.length, 1)
    assert.match(sent[0] ?? "", /pull a few matches for you now/i)
    // No question asked at all.
    assert.doesNotMatch(sent[0] ?? "", /what kind of roles/i)
    assert.doesNotMatch(sent[0] ?? "", /where in the US/i)
    // Recs fired exactly once for this user (the SAME find_match path the FAIL terminal uses).
    assert.equal(firedRecsForUser, "u1")
  })

  it("yields a recent terminal prescreen when user-level post-match retention is active", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        onboardingState: "complete",
        onboardingStatus: "active",
        pipelineState: { completed: true },
        postMatchRetention: {
          stage: "await_liked",
          startedAt: now,
          updatedAt: now,
          recCount: 2,
        },
      },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "hs-11005308-paradigm-gtm-growth",
        terminal: "PASS",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        postTerminalFollowupAckAt: now,
        postPrescreenRetention: {
          stage: "onboarding_started",
          terminal: "PASS",
          basicOnboardingOptIn: true,
          startedAt: now,
          updatedAt: now,
        },
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
    })

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+12036716555",
      replyText: "These roles feel useful and I will look into them",
      sendSms: async () => {
        throw new Error("post-match retention should own this reply")
      },
    })

    assert.equal(result.handled, false)
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_done/turns/"))
    assert.equal(turnEntries.length, 0)
  })

  it("does not silently complete a recent terminal courtesy reply after retention is closed", async () => {
    const now = new Date().toISOString()
    const { db } = makeFakeDb({
      "pa-users/u1": {
        onboardingState: "complete",
        onboardingStatus: "active",
        pipelineState: { completed: true },
      },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "hs-11005308-paradigm-gtm-growth",
        terminal: "PASS",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        postTerminalFollowupAckAt: now,
        postPrescreenRetention: {
          stage: "onboarding_declined",
          terminal: "PASS",
          basicOnboardingOptIn: false,
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
      toE164: "+19406296706",
      replyText: "Sure thank you",
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
    assert.match(sent[0] ?? "", /welcome|got it/i)
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

  it("yields a recent terminal prescreen when a completed candidate corrects target seniority", async () => {
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
        terminalActionPendingReview: true,
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
    })

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "I need roles which require 1-2 or 1-3 years of experience",
      sendSms: async () => {
        throw new Error("should not send from prescreen")
      },
    })

    assert.equal(result.handled, false)
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

  it("yields a recent terminal prescreen when candidate asks about the company", async () => {
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
        terminalActionPendingReview: true,
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
    })

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "Can you tell me a bit about the company that I was interviewing for",
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

  it("answers a recent terminal fit-improvement question before shared onboarding can consume it", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-users/u1": {
        onboardingState: "pending",
        onboardingStatus: "invited",
        sharedOnboarding: {
          status: "active",
          currentQuestionId: "industry_interest",
          completed: false,
          answers: {
            main_goal: { answer: "Career growth" },
            culture_stage: { answer: "strategy or product management" },
          },
        },
        workSession: {
          kind: "shared_onboarding",
          status: "active",
          currentQuestionId: "industry_interest",
        },
        postMatchRetention: {
          stage: "await_liked",
          startedAt: now,
          updatedAt: now,
          recCount: 2,
        },
      },
      "pa-prescreen-sessions/ps_done": {
        sessionId: "ps_done",
        userId: "u1",
        jobId: "rain-product-manager-cards-95ae1a01",
        terminal: "PAUSE",
        terminalReason: "S+R_max=3.62 < T*S_max=3.80",
        currentQId: null,
        createdAt: now,
        updatedAt: now,
        cfgSnapshot: {
          jobTitle: "Product Manager, Cards",
          company: "Rain",
        },
        questions: {
          role_fit: {
            qId: "role_fit",
            type: "MUST_HAVE",
            finalS: 0.9,
            finalC: 0.78,
            scored: {
              kind: "scored",
              answered: true,
              aggregate: {
                s: 0.9,
                c: 0.78,
                summary: "Strong PM role fit: end-to-end ownership and measurable impact.",
              },
              perKeyword: [],
            },
          },
          technical_depth: {
            qId: "technical_depth",
            type: "PROBING",
            finalS: 0.72,
            finalC: 0.66,
            terminalCause: "viability_fail",
            scored: {
              kind: "scored",
              answered: true,
              aggregate: {
                s: 0.72,
                c: 0.66,
                summary: "Mentions data-flow design, but lacks concrete implementation depth.",
              },
              perKeyword: [],
            },
          },
        },
        workSession: { kind: "job_prescreen", status: "ended", startedAt: now, endedAt: now, boundary: "terminal" },
      },
    })

    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+15109136602",
      replyText: "Could you help me understand how I could have improved my fit for the above role at Rain?",
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
    assert.equal(result.terminal, "PAUSE")
    assert.equal(sent.length, 1)
    assert.match(sent[0] ?? "", /Product Manager, Cards at Rain/)
    assert.match(sent[0] ?? "", /strongest signal was Role Fit/i)
    assert.match(sent[0] ?? "", /main gap was Technical Depth/i)
    assert.match(sent[0] ?? "", /implementation or tradeoff/i)

    const user = docs.get("pa-users/u1")?.data
    assert.equal((user?.sharedOnboarding as { currentQuestionId?: string } | undefined)?.currentQuestionId, "industry_interest")
    assert.equal(
      ((user?.sharedOnboarding as { answers?: Record<string, unknown> } | undefined)?.answers ?? {}).industry_interest,
      undefined,
    )
    const session = docs.get("pa-prescreen-sessions/ps_done")?.data
    assert.equal(typeof session?.outcomeExplanationFollowupAt, "string")
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_done/turns/"))
    assert.equal(turnEntries.length, 1)
    assert.equal((turnEntries[0][1].data.action as { kind?: string }).kind, "post_terminal_outcome_explanation")
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
    const reviewPendingCalls: Array<Record<string, unknown>> = []
    const sent: string[] = []

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
      markReviewPending: async (args) => {
        reviewPendingCalls.push(args as unknown as Record<string, unknown>)
        docs.set(`pa-candidate-job-states/${args.userId}__${args.jobId}`, {
          exists: true,
          data: {
            id: `${args.userId}__${args.jobId}`,
            candidateId: args.userId,
            jobId: args.jobId,
            state: "prescreen_review_pending",
            prescreenSessionId: args.sessionId,
            stateUpdatedAt: args.occurredAt,
          },
        })
        return { changed: true }
      },
      sendSms: async (args) => {
        sent.push(args.content)
        return {
          id: "out-review-pending",
          created: true,
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
    assert.equal(result.terminal, "PASS")
    assert.deepEqual(terminalCalls, [])
    assert.equal(reviewPendingCalls.length, 1)
    assert.equal(reviewPendingCalls[0]?.terminal, "PASS")
    assert.equal(sent.length, 1)
    assert.match(sent[0] ?? "", /WeKruit team/i)
    assert.match(sent[0] ?? "", /pitch the hiring manager/i)
    assert.match(sent[0] ?? "", /next step here/i)
    assert.doesNotMatch(sent[0] ?? "", /pass|not a fit|recommend|salary|proceed/i)
    const session = docs.get("pa-prescreen-sessions/ps_active")?.data
    assert.equal(session?.terminalActionPendingReview, true)
    assert.equal(typeof session?.evaluationAttemptId, "string")
    assert.equal((session?.review as { status?: string; pendingAckOutboundId?: string } | undefined)?.status, "pending")
    assert.equal((session?.review as { status?: string; pendingAckOutboundId?: string } | undefined)?.pendingAckOutboundId, "out-review-pending")
    assert.equal(session?.postPrescreenRetention, undefined)
    const jobState = docs.get("pa-candidate-job-states/u1__rain-software-engineer-fullstack-8849f6ef")?.data
    assert.equal(jobState?.state, "prescreen_review_pending")
    const user = docs.get("pa-users/u1")?.data
    assert.equal((user?.workSession as { kind?: string; status?: string } | undefined)?.kind, "job_prescreen")
    assert.equal((user?.workSession as { kind?: string; status?: string } | undefined)?.status, "ended")
    assert.equal(user?.postMatchRetention, null)
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

  it("a NOT_PASS (FAIL) terminal sends verdict-aware honest holding copy, never the PASS pitch framing", async () => {
    // Live trust bug 2026-06-19 (+13055102017): a HARD_STOP/FAIL outcome held for human review was
    // told "nice work — pitching you to the hiring manager" (a fabricated pass on a rejection).
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
            // clarify budget already exhausted → a confident low score terminates non-PASS now.
            clarifyRounds: 2,
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
              match: 0,
              confidence: 0.95,
              evidence: "no relevant engineering ownership",
              reasoning: "confident non-match",
            },
          ],
          summary: "Confident mismatch.",
          answered: true,
        }
      },
    }
    const sent: string[] = []

    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "I have never done software engineering.",
      keywordSetCaller: caller,
      runTerminalAction: async () => ({ alreadyFired: false, level1Sent: false, jobRecsFired: false }),
      markReviewPending: async () => ({ changed: true }),
      sendSms: async (args) => {
        sent.push(args.content)
        return {
          id: "out-not-pass",
          created: true,
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
    assert.notEqual(result.terminal, "PASS")
    assert.equal(sent.length, 1)
    // Honest holding copy: warm, review-pending, retention — but NEVER a fabricated pass.
    assert.match(sent[0] ?? "", /WeKruit team/i)
    assert.match(sent[0] ?? "", /review/i)
    assert.doesNotMatch(sent[0] ?? "", /pitch the hiring manager/i)
    assert.doesNotMatch(sent[0] ?? "", /pitch you to the hiring manager/i)
    assert.doesNotMatch(sent[0] ?? "", /nice work/i)
    const session = docs.get("pa-prescreen-sessions/ps_active")?.data
    assert.equal(session?.terminalActionPendingReview, true)
  })

  it("a recent NOT_PASS pending-review follow-up ack is honest, never the PASS pitch framing", async () => {
    const now = new Date().toISOString()
    const { db } = makeFakeDb({
      "pa-prescreen-sessions/ps_pending_review_notpass": {
        sessionId: "ps_pending_review_notpass",
        userId: "u1",
        jobId: "rain-software-engineer-fullstack-8849f6ef",
        terminal: "HARD_STOP",
        currentQId: null,
        terminalActionPendingReview: true,
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
      // A non-explicit-new-intent follow-up: prescreen owns the thread (suppresses thin re-engagement).
      replyText: "ok thanks",
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
    assert.equal(result.terminal, "HARD_STOP")
    assert.equal(sent.length, 1)
    assert.match(sent[0] ?? "", /WeKruit team/i)
    assert.doesNotMatch(sent[0] ?? "", /pitch the hiring manager/i)
    assert.doesNotMatch(sent[0] ?? "", /pitch you to the hiring manager/i)
    assert.doesNotMatch(sent[0] ?? "", /nice work/i)
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

// ── Adam 2026-06-12: prescreen OWNERSHIP + state-accurate status copy ─────────────────────────────
// Live failure (+12026571666 / wQfGZlttRQltMPv4NU6e / hs-10996795-invoko-product-manager): mid-screen
// status questions were scored as answers, and a timed-out PAUSE got a matching offer + a false
// "under review" claim. These tests lock the new deterministic layers.
import {
  composePrescreenStatusAnswer,
  isPrescreenRoleIdentityQuestion,
  isPrescreenScreenStatusQuestion,
} from "./prescreen-turn-handler.js"

const ENTRY_UX_CANARY_UID = "8fEwIduUrzxZsblHHsNz" // CANARY_UIDS dev cohort (env-independent)

function seedInvokoActiveSession(userId: string, sessionId: string) {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  return {
    [`pa-prescreen-sessions/${sessionId}`]: {
      sessionId,
      userId,
      jobId: "hs-10996795-invoko-product-manager",
      terminal: null,
      currentQId: "q_consumer_product_experience",
      createdAt: twoHoursAgo,
      updatedAt: twoHoursAgo,
      score: 0,
      scoreMax: 3,
      threshold: 0.65,
      confidenceThreshold: 0.7,
      maxClarifyRounds: 3,
      qOrder: ["q_consumer_product_experience", "q_ship_taste"],
      questions: {
        q_consumer_product_experience: {
          qId: "q_consumer_product_experience",
          type: "MUST_HAVE",
          weight: 2,
          matchThreshold: 0.85,
          clarifyRounds: 0,
        },
        q_ship_taste: {
          qId: "q_ship_taste",
          type: "MUST_HAVE",
          weight: 1,
          matchThreshold: 0.85,
          clarifyRounds: 0,
        },
      },
      workSession: { kind: "job_prescreen", status: "active", startedAt: twoHoursAgo, boundary: "trigger" },
      cfgSnapshot: {
        jobTitle: "Product Manager",
        company: "Invoko",
        questions: [
          {
            qId: "q_consumer_product_experience",
            prompt: {
              en: "Tell me about consumer product work you've done - what did you ship and what feedback did it drive?",
              zh: "Tell me about consumer product work you've done - what did you ship and what feedback did it drive?",
            },
            clarifyPrompt: { en: "What did you ship?", zh: "What did you ship?" },
            keywords: [{ keyword: "consumer_product_shipping", weight: 1 }],
          },
          {
            qId: "q_ship_taste",
            prompt: {
              en: "How do you decide what to ship next when you have more ideas than time?",
              zh: "How do you decide what to ship next when you have more ideas than time?",
            },
            clarifyPrompt: { en: "Smallest slice you shipped and why?", zh: "Smallest slice you shipped and why?" },
            keywords: [{ keyword: "prioritization_taste", weight: 1 }],
          },
        ],
      },
    },
  }
}

describe("mid-screen status/identity questions (isClaireEntryUxCanary)", () => {
  it("answers 'is the screening over?' from state — not yet + pending question; nothing scored", async () => {
    const { db, docs } = makeFakeDb(seedInvokoActiveSession(ENTRY_UX_CANARY_UID, "ps_invoko_status"))
    const sent: string[] = []
    let judgeCalled = false
    const caller: KeywordSetLlmCaller = {
      async score() {
        judgeCalled = true
        throw new Error("status question must not reach the judge")
      },
    }
    const result = await runPrescreenTurnIfActive({
      db,
      userId: ENTRY_UX_CANARY_UID,
      toE164: "+14243201960",
      replyText: "is the screening over?",
      keywordSetCaller: caller,
      sendSms: async (args) => {
        sent.push(args.content)
        return { status: "queued" }
      },
    })
    assert.equal(result.handled, true)
    assert.equal(result.terminal, null)
    assert.equal(judgeCalled, false)
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /^not yet/)
    assert.match(sent[0]!, /Product Manager @ Invoko/)
    assert.match(sent[0]!, /consumer product work/)
    // session still active on the SAME pending question — the screen kept ownership.
    const session = docs.get("pa-prescreen-sessions/ps_invoko_status")?.data
    assert.equal(session?.terminal, null)
    assert.equal(session?.currentQId, "q_consumer_product_experience")
    // no matching offer leaked into the reply.
    assert.doesNotMatch(sent[0]!, /jobs|roles|matches/i)
    const turnEntries = [...docs.entries()].filter(([path]) => path.startsWith("pa-prescreen-sessions/ps_invoko_status/turns/"))
    assert.equal(turnEntries.length, 1)
    assert.deepEqual(turnEntries[0]![1].data.action, { kind: "status_answered", reason: "screen_over" })
  })

  it("answers 'is this for the invoko PM role?' with the real role and continues the screen", async () => {
    const { db, docs } = makeFakeDb(seedInvokoActiveSession(ENTRY_UX_CANARY_UID, "ps_invoko_identity"))
    const sent: string[] = []
    const caller: KeywordSetLlmCaller = {
      async score() {
        throw new Error("identity question must not reach the judge")
      },
    }
    const result = await runPrescreenTurnIfActive({
      db,
      userId: ENTRY_UX_CANARY_UID,
      toE164: "+14243201960",
      replyText: "is this for the invoko PM role?",
      keywordSetCaller: caller,
      sendSms: async (args) => {
        sent.push(args.content)
        return { status: "queued" }
      },
    })
    assert.equal(result.handled, true)
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /this screen is for Product Manager @ Invoko/)
    assert.match(sent[0]!, /consumer product work/)
    const session = docs.get("pa-prescreen-sessions/ps_invoko_identity")?.data
    assert.equal(session?.currentQId, "q_consumer_product_experience")
  })

  it("non-canary user keeps the legacy path byte-for-byte (the reply is judged as before)", async () => {
    const { db } = makeFakeDb(seedInvokoActiveSession("u1", "ps_invoko_legacy"))
    const sent: string[] = []
    let judgeCalled = false
    const caller: KeywordSetLlmCaller = {
      async score() {
        judgeCalled = true
        return {
          perKeyword: [
            { keyword: "consumer_product_shipping", match: 0.95, confidence: 0.9, evidence: "x", reasoning: "y" },
          ],
          summary: "ok",
          answered: true,
        }
      },
    }
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "is the screening over?",
      keywordSetCaller: caller,
      sendSms: async (args) => {
        sent.push(args.content)
        return { status: "queued" }
      },
    })
    assert.equal(result.handled, true)
    assert.equal(judgeCalled, true, "legacy path still routes through the judge")
  })

  it("a real ANSWER containing a question mark falls through to the judge even for canary", async () => {
    const { db } = makeFakeDb(seedInvokoActiveSession(ENTRY_UX_CANARY_UID, "ps_invoko_answerq"))
    const sent: string[] = []
    let judgeCalled = false
    const caller: KeywordSetLlmCaller = {
      async score() {
        judgeCalled = true
        return {
          perKeyword: [
            { keyword: "consumer_product_shipping", match: 0.95, confidence: 0.9, evidence: "x", reasoning: "y" },
          ],
          summary: "ok",
          answered: true,
        }
      },
    }
    await runPrescreenTurnIfActive({
      db,
      userId: ENTRY_UX_CANARY_UID,
      toE164: "+14243201960",
      replyText: "I shipped a dealership PoS platform and drove the post-launch feedback loop. does that count as consumer product work?",
      keywordSetCaller: caller,
      sendSms: async (args) => {
        sent.push(args.content)
        return { status: "queued" }
      },
    })
    assert.equal(judgeCalled, true, "an answer with a trailing question must still be scored")
  })

  it("detectors: narrow shapes match, answers do not", () => {
    assert.equal(isPrescreenScreenStatusQuestion("is the screening over?"), true)
    assert.equal(isPrescreenScreenStatusQuestion("are we done?"), true)
    assert.equal(isPrescreenScreenStatusQuestion("how many more questions?"), true)
    assert.equal(isPrescreenScreenStatusQuestion("I completed the migration end to end."), false)
    assert.equal(isPrescreenScreenStatusQuestion("I finished the rollout — is that the kind of example you want?"), false)
    assert.equal(isPrescreenRoleIdentityQuestion("is this for the invoko PM role?"), true)
    assert.equal(isPrescreenRoleIdentityQuestion("which job is this for?"), true)
    assert.equal(isPrescreenRoleIdentityQuestion("I led the product launch for our dealership platform"), false)
    const text = composePrescreenStatusAnswer({
      kind: "screen_over",
      jobTitle: "Product Manager",
      company: "Invoko",
      pendingPrompt: "Next question?",
    })
    assert.match(text, /not yet/)
    assert.match(text, /Product Manager @ Invoko/)
  })
})

describe("stale-timeout PAUSE follow-up (universal copy-accuracy)", () => {
  it("answers a follow-up after a timed-out PAUSE with the restart path — never a matching offer", async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_timedout": {
        sessionId: "ps_timedout",
        userId: "u1",
        jobId: "hs-10996795-invoko-product-manager",
        terminal: "PAUSE",
        terminalReason: "expired_inactive_prescreen_session",
        currentQId: null,
        updatedAt: fiveMinAgo,
        workSession: { kind: "job_prescreen", status: "ended", endedAt: fiveMinAgo, boundary: "timeout" },
        cfgSnapshot: { jobTitle: "Product Manager", company: "Invoko", questions: [] },
      },
      "pa-users/u1": { userId: "u1" },
    })
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+12026571666",
      replyText: "ok",
      sendSms: async (args) => {
        sent.push(args.content)
        return { status: "queued" }
      },
    })
    assert.equal(result.handled, true)
    assert.equal(result.terminal, "PAUSE")
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /timed out/)
    assert.match(sent[0]!, /restart screen/)
    // NEVER the legacy matching offer, NEVER a review claim (nothing was submitted).
    assert.doesNotMatch(sent[0]!, /help find jobs|meet your expectations|pull roles/i)
    assert.doesNotMatch(sent[0]!, /review/i)
    const session = docs.get("pa-prescreen-sessions/ps_timedout")?.data
    assert.equal(typeof session?.postTerminalFollowupAckAt, "string")
  })

  it("a non-stale user-exit PAUSE keeps the existing retention prompt", async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const { db } = makeFakeDb({
      "pa-prescreen-sessions/ps_userexit": {
        sessionId: "ps_userexit",
        userId: "u1",
        jobId: "job-x",
        terminal: "PAUSE",
        terminalReason: "user_exit",
        currentQId: null,
        updatedAt: fiveMinAgo,
        workSession: { kind: "job_prescreen", status: "ended", endedAt: fiveMinAgo, boundary: "user_exit" },
        cfgSnapshot: { jobTitle: "X", company: "Y", questions: [] },
      },
      "pa-users/u1": { userId: "u1" },
    })
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: "u1",
      toE164: "+13054507715",
      replyText: "ok",
      sendSms: async (args) => {
        sent.push(args.content)
        return { status: "queued" }
      },
    })
    assert.equal(result.handled, true)
    assert.equal(sent.length, 1)
    // POST-TERMINAL MATCHING IS OPT-IN (Adam 2026-06-15): a bare "ok" on the FIRST
    // post-terminal turn is a courtesy ack, NOT a request to match — Claire OFFERS
    // ("Do you want to proceed?") instead of bridging into onboarding/matching. The
    // retention flow still engages (offer is made); the stale-timeout suppression
    // must NOT touch a deliberate user-exit pause (that part is unchanged).
    assert.match(sent[0]!, /Do you want to proceed/i)
  })
})
