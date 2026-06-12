/**
 * post-prescreen-retention-handoff.test.ts — the PRESCREEN-SEAM RETENTION HANDOFF
 * (Adam-locked CONVERSATION-CONTEXT-FIRST-PRINCIPLE, 2026-06-05).
 *
 * THE LIVE BUG (Sai Spandana, +18578918525, uid JA0ZkGfkfQqw7OrtXNcK): a recently-terminal / PAUSED
 * prescreen turn was answered from ONLY the session doc + canned text + regex intent
 * (recentTerminalCourtesyAckText → "You're welcome — I'll keep this role screen closed."), dropping her
 * on-topic role answer ("UX designer, product designer with 5 or less years of experience"), surfacing
 * no real reason, and never matching her to OTHER product roles.
 *
 * THE FIX: for the dev cohort (isPrescreenRetentionHandoffCanary — CANARY_UIDS only, NOT swept by the
 * onboarding PA_ONBOARDING_RAMP_ALL prod env), the recent_terminal / user_exit / expired branches of
 * runPrescreenTurnIfActive STOP answering from canned text + regex and return { handled:false } so the
 * turn flows to the thin context-complete agent, which receives a buildCandidateContext block (global
 * profile ∪ per-job terminals/reasons/scores ∪ retention stage). The reducer (terminal/retain/match) is
 * BYTE-UNTOUCHED; non-canary keeps the legacy path byte-for-byte.
 *
 * These tests prove RED→GREEN at the routing seam (the flag_gated_tests_false_green memory): the
 * NON-canary path STILL cans (byte-identical legacy), the CANARY path DEFERS, and the deterministic
 * reducer fires identically on both. Plus a unit on the buildCandidateContext assembler.
 *
 * Run: node --import tsx --test apps/functions/src/claire-agent/__tests__/post-prescreen-retention-handoff.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { runPrescreenTurnIfActive } from "../../prescreen-turn-handler.js"
import { buildCandidateContext } from "../candidate-context.js"
import { CANARY_UIDS } from "../canary.js"

// A real dev-cohort uid (isPrescreenRetentionHandoffCanary === true). NOT env-dependent.
const CANARY_UID = [...CANARY_UIDS][0]! // "8fEwIduUrzxZsblHHsNz" (Adam)
const NON_CANARY_UID = "u1" // not in CANARY_UIDS; PA_ONBOARDING_RAMP_ALL unset in tests → non-canary

// The exact legacy string the Sai bug emitted (kept private in the handler) — asserted byte-identical
// for the non-canary path so a regression that changes it is caught.
const LEGACY_COURTESY_ACK =
  "You're welcome — I’ll keep this role screen closed. If you need anything later, message me here."

type FakeDoc = { exists: boolean; data: Record<string, unknown> }

/** Firestore stub — mirrors prescreen-turn-handler.test.ts (doc get/set + where/orderBy/limit query). */
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
            // sub-collection docs (…/turns/…) must NOT match a top-level collection query.
            const rest = path.slice(collection.length + 1)
            if (rest.includes("/")) continue
            if (filters.every((f) => doc.data[f.field] === f.value)) {
              out.push({ id: rest, data: () => doc.data, ref: docRef(collection, rest) })
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

const okSms = async (args: { to: string; content: string }) => {
  return {
    status: "queued",
    from_number: null,
    number: args.to,
    content: args.content,
    service: "iMessage",
    is_outbound: true,
  }
}

/** Seed Sai's shape: a PAUSED (user_exit) Product Designer screen + two close-FAIL UI/UX screens. */
function seedSaiTerminals(uid: string, recentTitle = "Product Designer"): Record<string, Record<string, unknown>> {
  const now = new Date().toISOString()
  const older = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const oldest = new Date(Date.now() - 45 * 60 * 1000).toISOString()
  return {
    [`pa-users/${uid}`]: {
      id: uid,
      displayName: "Sai Spandana",
      phoneE164: "+18578918525",
      onboardingStatus: "invited",
      tags: { recentRoleTitle: "Product Designer" },
    },
    "pa-prescreen-sessions/ps_paused": {
      sessionId: "ps_paused",
      userId: uid,
      jobId: "invoko-product-designer",
      terminal: "PAUSE",
      terminalReason: "user_exit",
      score: 1.8,
      currentQId: null,
      cfgSnapshot: { jobTitle: recentTitle, company: "Invoko" },
      createdAt: now,
      updatedAt: now,
      workSession: { kind: "job_prescreen", status: "ended", endedAt: now, boundary: "user_exit" },
    },
    "pa-prescreen-sessions/ps_fail_1": {
      sessionId: "ps_fail_1",
      userId: uid,
      jobId: "acme-uiux-1",
      terminal: "FAIL",
      terminalReason: "ratio=0.927 threshold=0.95",
      currentQId: null,
      cfgSnapshot: { jobTitle: "UI/UX Designer", company: "Acme" },
      questions: {
        portfolio_depth: { scored: { aggregate: { s: 0.927, c: 0.8, summary: "solid portfolio" } } },
        systems_thinking: { scored: { aggregate: { s: 0.91, c: 0.7, summary: "thin on systems" } } },
      },
      createdAt: older,
      updatedAt: older,
      workSession: { kind: "job_prescreen", status: "ended", endedAt: older, boundary: "terminal" },
    },
    "pa-prescreen-sessions/ps_fail_2": {
      sessionId: "ps_fail_2",
      userId: uid,
      jobId: "beta-uiux-2",
      terminal: "FAIL",
      terminalReason: "ratio=0.907 threshold=0.95",
      currentQId: null,
      cfgSnapshot: { jobTitle: "UI/UX Designer", company: "Beta" },
      questions: {
        craft: { scored: { aggregate: { s: 0.907, c: 0.75, summary: "close on craft" } } },
      },
      createdAt: oldest,
      updatedAt: oldest,
      workSession: { kind: "job_prescreen", status: "ended", endedAt: oldest, boundary: "terminal" },
    },
  }
}

describe("prescreen-seam retention handoff", () => {
  // ── T1 — Sai literal: canary post-PAUSE role answer DEFERS to thin (not the canned courtesy ack) ──
  it("T1: canary — Sai's on-topic role answer after a PAUSE defers to thin (handled:false), no canned ack", async () => {
    const { db } = makeFakeDb(seedSaiTerminals(CANARY_UID))
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: CANARY_UID,
      toE164: "+18578918525",
      replyText: "UX designer, product designer with 5 or less years of experience",
      sendSms: async (a) => {
        sent.push(a.content)
        return okSms(a)
      },
    })
    // The seam DEFERS: the thin context-complete agent (with buildCandidateContext) owns the reply.
    assert.equal(result.handled, false, "canary post-terminal turn must defer to thin")
    assert.equal(sent.length, 0, "no canned text sent on the canary defer (thin owns it)")
  })

  // ── T2 — non-canary unchanged: legacy courtesy ack, byte-identical ──
  it("T2: non-canary — same shape still emits the byte-identical legacy courtesy ack", async () => {
    const seed = seedSaiTerminals(NON_CANARY_UID)
    // Already acked once → the legacy retention prompt is skipped and a bare ack falls to the courtesy
    // ack (the exact Sai-bug string). This isolates the byte-identical legacy closer.
    ;(seed["pa-prescreen-sessions/ps_paused"] as Record<string, unknown>).postTerminalFollowupAckAt =
      new Date().toISOString()
    const { db } = makeFakeDb(seed)
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: NON_CANARY_UID,
      toE164: "+18578918525",
      // A bare ack so the legacy path falls to recentTerminalCourtesyAckText (not the retention branch).
      replyText: "thanks",
      sendSms: async (a) => {
        sent.push(a.content)
        return okSms(a)
      },
    })
    assert.equal(result.handled, true, "non-canary keeps the legacy handled path")
    assert.equal(result.textSent, LEGACY_COURTESY_ACK, "byte-identical legacy courtesy ack")
    assert.equal(sent[0], LEGACY_COURTESY_ACK)
  })

  // ── T3 — "why didn't I pass?" canary: defers to thin (which answers from the borderline context) ──
  it("T3: canary — a 'why didn't I pass?' question defers to thin (no canned outcome-explanation text)", async () => {
    const { db } = makeFakeDb(seedSaiTerminals(CANARY_UID))
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: CANARY_UID,
      toE164: "+18578918525",
      replyText: "why didn't I pass that screen?",
      sendSms: async (a) => {
        sent.push(a.content)
        return okSms(a)
      },
    })
    assert.equal(result.handled, false, "canary outcome-explanation defers to thin")
    assert.equal(sent.length, 0, "no canned recentTerminalOutcomeExplanationText on the canary path")
  })

  // ── T4 — pending review: the deterministic WeKruit-team review ack still fires (bypass does NOT) ──
  it("T4: canary — a pending-review terminal still gets the deterministic WeKruit-team review ack", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_pending": {
        sessionId: "ps_pending",
        userId: CANARY_UID,
        jobId: "invoko-product-designer",
        terminal: "PASS",
        currentQId: null,
        terminalActionPendingReview: true,
        createdAt: now,
        updatedAt: now,
        workSession: { kind: "job_prescreen", status: "ended", endedAt: now, boundary: "terminal" },
      },
    })
    const sent: string[] = []
    const result = await runPrescreenTurnIfActive({
      db,
      userId: CANARY_UID,
      toE164: "+18578918525",
      replyText: "thanks",
      sendSms: async (a) => {
        sent.push(a.content)
        return okSms(a)
      },
    })
    // The pending-review guard is reachable BEFORE the canary bypass → it still acks deterministically,
    // and never claims a decision (prescreen_pass_needs_hitl_commit memory).
    assert.equal(result.handled, true, "pending-review must NOT defer to thin")
    assert.match(result.textSent ?? "", /WeKruit team/i)
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /WeKruit team/i)
    const session = docs.get("pa-prescreen-sessions/ps_pending")?.data
    assert.equal(typeof session?.reviewPendingFollowupAt, "string")
  })

  // ── T5 — reducer untouched: a mid-screen expiry PAUSE still fires the deterministic terminal action ──
  it("T5: canary — an expired active screen still fires the deterministic PAUSE terminal action; only the reply defers", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_idle": {
        sessionId: "ps_idle",
        userId: CANARY_UID,
        jobId: "invoko-product-designer",
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
      userId: CANARY_UID,
      toE164: "+18578918525",
      replyText: "following up later",
      runTerminalAction: async (a) => {
        terminalCalls.push(a as unknown as Record<string, unknown>)
        return { alreadyFired: false, level1Sent: false, jobRecsFired: false }
      },
      sendSms: async (a) => {
        sent.push(a.content)
        return okSms(a)
      },
    })
    // The deterministic PAUSE write + retain/match action STILL fire (reducer owns state) …
    assert.equal(terminalCalls.length, 1, "deterministic terminal action must still fire on canary")
    assert.equal(terminalCalls[0]!.terminal, "PAUSE")
    const session = docs.get("pa-prescreen-sessions/ps_idle")?.data
    assert.equal(session?.terminal, "PAUSE")
    assert.equal(session?.terminalReason, "expired_inactive_prescreen_session")
    // … but the candidate-facing reply DEFERS to thin (no canned expiredSessionText).
    assert.equal(result.handled, false, "canary expired turn defers the reply to thin")
    assert.equal(sent.length, 0, "no canned expiredSessionText on the canary path")
  })

  // ── T6 — user_exit MEANING: an on-topic role answer is NOT regex-force-PAUSED for canary ──
  // A full valid PreScreenState so the reducer actually runs (qOrder/questions/thresholds), proving the
  // turn flows to the REDUCER pipeline (LLM-judged) instead of the bypassed regex PAUSE.
  function activeState(sessionId: string, uid: string, now: string): Record<string, unknown> {
    return {
      sessionId,
      userId: uid,
      jobId: "invoko-product-designer",
      terminal: null,
      currentQId: "role_fit",
      score: 0,
      scoreMax: 1,
      threshold: 0.65,
      confidenceThreshold: 0.7,
      maxClarifyRounds: 4,
      qOrder: ["role_fit"],
      questions: {
        role_fit: { qId: "role_fit", type: "MUST_HAVE", weight: 1, clarifyRounds: 0 },
      },
      createdAt: now,
      updatedAt: now,
      workSession: { kind: "job_prescreen", status: "active", startedAt: now, boundary: "trigger" },
      cfgSnapshot: {
        questions: [
          {
            qId: "role_fit",
            prompt: { en: "What recent work best matches this product design role?", zh: "What recent work best matches this product design role?" },
            clarifyPrompt: { en: "Tell me more.", zh: "Tell me more." },
            keywords: [{ keyword: "product design", weight: 1 }],
          },
        ],
      },
    }
  }

  it("T6: canary — an active-screen reply the user_exit REGEX would match is NOT force-PAUSED; it scores as an answer", async () => {
    const now = new Date().toISOString()
    // "pause" is a literal user_exit-regex hit, but here it is part of an ON-TOPIC answer.
    const replyText = "i'd pause to think, then i shipped the product design flow end to end"
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_active": activeState("ps_active", CANARY_UID, now),
    })
    const terminalCalls: Array<Record<string, unknown>> = []
    // Reducer-level keyword caller: a clear, on-topic answer (clarify, not terminal).
    const result = await runPrescreenTurnIfActive({
      db,
      userId: CANARY_UID,
      toE164: "+18578918525",
      replyText,
      runTerminalAction: async (a) => {
        terminalCalls.push(a as unknown as Record<string, unknown>)
        return { alreadyFired: false, level1Sent: false, jobRecsFired: false }
      },
      keywordSetCaller: {
        async score() {
          return {
            perKeyword: [
              { keyword: "product design", match: 0.7, confidence: 0.8, evidence: "shipped flow end to end", reasoning: "on-topic product design answer" },
            ],
            summary: "Clear on-topic product design answer.",
            answered: true,
          }
        },
      },
      clarifyComposer: async () => "what was the toughest tradeoff you owned?",
      sendSms: okSms,
    })
    // The regex did NOT short-circuit into a user_exit PAUSE: no PAUSE terminal action.
    const userExitPause = terminalCalls.find((c) => c.terminal === "PAUSE")
    assert.equal(userExitPause, undefined, "an on-topic answer must NOT be regex-force-PAUSED for canary")
    const session = docs.get("pa-prescreen-sessions/ps_active")?.data
    assert.notEqual(session?.terminalReason, "user_exit", "session must not be regex-PAUSED as user_exit")
    assert.equal(result.handled, true, "the active turn is scored by the reducer pipeline")
    // The reducer clarified (its own controller decision) — not the regex.
    assert.equal(result.textSent, "what was the toughest tradeoff you owned?")
  })

  // ── T7 — genuine exit: the reducer/pipeline (NOT the LLM, NOT the bypassed regex) owns the terminal ──
  it("T7: canary — a genuine 'stop' flows to the reducer; any terminal comes from the pipeline, never the user_exit regex", async () => {
    const now = new Date().toISOString()
    const { db, docs } = makeFakeDb({
      "pa-prescreen-sessions/ps_active2": activeState("ps_active2", CANARY_UID, now),
    })
    const terminalCalls: Array<Record<string, unknown>> = []
    // Low score from the judge → the reducer reaches a FINAL decision through the deterministic pipeline.
    const result = await runPrescreenTurnIfActive({
      db,
      userId: CANARY_UID,
      toE164: "+18578918525",
      replyText: "stop this screen for now",
      runTerminalAction: async (a) => {
        terminalCalls.push(a as unknown as Record<string, unknown>)
        return { alreadyFired: false, level1Sent: false, jobRecsFired: false }
      },
      markReviewPending: async () => ({ ok: true }),
      keywordSetCaller: {
        async score() {
          return {
            perKeyword: [
              { keyword: "product design", match: 0.0, confidence: 0.9, evidence: "asked to stop", reasoning: "no product design evidence" },
            ],
            summary: "Candidate asked to stop.",
            answered: true,
          }
        },
      },
      clarifyComposer: async () => "",
      sendSms: okSms,
    })
    // Whatever terminal results is driven by the REDUCER/pipeline, never by the LLM directly and never by
    // the bypassed regex. The handler handled the turn (the reducer is the controller).
    assert.equal(result.handled, true)
    // The terminal that fired (if any) came through the deterministic terminal-action seam, not a regex PAUSE.
    for (const c of terminalCalls) {
      assert.notEqual(
        (c as { reason?: string }).reason,
        "user_exit",
        "a terminal must come from the reducer/pipeline, never the bypassed user_exit regex",
      )
    }
  })

  // ── T8 — assembler unit: buildCandidateContext merges global + N sessions, computes borderline signals ──
  it("T8: buildCandidateContext — merges global + all sessions newest-first, computes strongest/weakest, surfaces pendingReview", async () => {
    const seed = seedSaiTerminals(CANARY_UID)
    // add a pending-review terminal to assert it surfaces.
    seed["pa-prescreen-sessions/ps_review"] = {
      sessionId: "ps_review",
      userId: CANARY_UID,
      jobId: "gamma-product",
      terminal: "PASS",
      terminalActionPendingReview: true,
      currentQId: null,
      cfgSnapshot: { jobTitle: "Senior Product Designer", company: "Gamma" },
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      workSession: {
        kind: "job_prescreen",
        status: "ended",
        endedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        boundary: "terminal",
      },
    }
    const { db } = makeFakeDb(seed)
    const ctx = await buildCandidateContext(db, CANARY_UID, { toE164: "+18578918525" })

    // all 4 sessions present, newest-first (ps_paused is newest).
    assert.equal(ctx.screens.length, 4)
    assert.equal(ctx.screens[0]!.sessionId, "ps_paused")
    assert.equal(ctx.mostRecentTerminal?.sessionId, "ps_paused")

    // the PAUSED screen carries its real reason.
    const paused = ctx.screens.find((s) => s.sessionId === "ps_paused")!
    assert.equal(paused.terminal, "PAUSE")
    assert.equal(paused.terminalReason, "user_exit")

    // borderline signals computed from the FAIL session's questions{}.scored.aggregate.
    const fail1 = ctx.screens.find((s) => s.sessionId === "ps_fail_1")!
    assert.equal(fail1.strongestSignal?.ratio, 0.927)
    assert.equal(fail1.weakestSignal?.ratio, 0.91)

    // pendingReview surfaced.
    const review = ctx.screens.find((s) => s.sessionId === "ps_review")!
    assert.equal(review.pendingReview, true)

    // rendered block names the prior screens + the capture/offer-other-roles directive + the review caveat.
    assert.match(ctx.prescreenContextText, /PRIOR JOB SCREENS/)
    assert.match(ctx.prescreenContextText, /Product Designer @ Invoko/)
    assert.match(ctx.prescreenContextText, /PAUSED/)
    assert.match(ctx.prescreenContextText, /find OTHER/)
    assert.match(ctx.prescreenContextText, /record_onboarding_answer/)
    assert.match(ctx.prescreenContextText, /UNDER WEKRUIT TEAM REVIEW/)
    // global context (from loadGlobalContext) is assembled too.
    assert.equal(typeof ctx.globalContextText, "string")
  })

  // ── T8b — assembler fail-soft: a read error returns a partial (never throws) ──
  it("T8b: buildCandidateContext — fail-soft on a session read error returns a partial (global-only)", async () => {
    const throwingDb = {
      collection(name: string) {
        if (name === "pa-prescreen-sessions") {
          return {
            where() {
              return {
                async get() {
                  throw new Error("simulated_index_error")
                },
              }
            },
          }
        }
        // pa-users / parsedCandidateResumes → empty (loadGlobalContext degrades gracefully).
        return {
          doc() {
            return { async get() { return { exists: false, data: () => undefined } } }
          },
          where() {
            return {
              orderBy() {
                return { limit() { return { async get() { return { docs: [] } } } } }
              },
              limit() {
                return { async get() { return { docs: [] } } }
              },
              async get() {
                return { docs: [] }
              },
            }
          },
        }
      },
    } as never
    const ctx = await buildCandidateContext(throwingDb, CANARY_UID)
    assert.equal(ctx.screens.length, 0, "session read error → empty screens, no throw")
    assert.equal(ctx.prescreenContextText, "", "no screens → empty rendered block")
    assert.equal(ctx.mostRecentTerminal, null)
  })
})
