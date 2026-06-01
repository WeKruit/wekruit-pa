import assert from "node:assert/strict"
import test from "node:test"
import {
  handlePostMatchRetentionReply,
  startPostMatchRetentionAfterJobRecs,
  writePostMatchRetention,
} from "../post-match-retention.js"
import type { FeedbackLlmCall } from "../match-feedback-extractor.js"

/**
 * Deterministic LLM stub for the no-regex (2026-05-30) feedback classifier.
 * Returns the canonical structured feedback JSON the orchestrator validates.
 */
function stubClassify(json: Record<string, unknown>): FeedbackLlmCall {
  return async () => ({ json })
}

/** Seed a docs map with the retention flag on + a user's retention state. */
function makeRetentionDocs(
  userId: string,
  state: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  return new Map<string, Record<string, unknown>>([
    [
      "pa-feature-flags/paPostMatchRetentionEnabled",
      { key: "paPostMatchRetentionEnabled", value: true, type: "bool", scope: "global" },
    ],
    [
      `pa-users/${userId}`,
      { postMatchRetention: { startedAt: "2026-05-21T16:00:00.000Z", updatedAt: "2026-05-21T16:00:00.000Z", ...state } },
    ],
  ])
}

/** Minimal in-memory Firestore over a docs map (get/set merge). */
function makeRetentionDb(docs: Map<string, Record<string, unknown>>): never {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docs.get(`${name}/${id}`)
          return { exists: data !== undefined, data: () => data }
        },
        set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          const key = `${name}/${id}`
          docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : data)
        },
      }),
    }),
  } as never
}

test("startPostMatchRetentionAfterJobRecs is no-op when flag off", async () => {
  let setCalls = 0
  const db = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => ({}) }),
        set: async () => {
          setCalls += 1
        },
      }),
    }),
  } as never
  await startPostMatchRetentionAfterJobRecs({ db, userId: "u1", recCount: 2 })
  assert.equal(setCalls, 0)
})

test("await_liked uses LLM-classified sentiment (no regex) → dislike branches to reason", async () => {
  const docs = makeRetentionDocs("u_neg", { stage: "await_liked", recCount: 2 })
  const db = makeRetentionDb(docs)
  const sent: string[] = []
  const handled = await handlePostMatchRetentionReply(
    { id: "e1", userId: "u_neg", sessionId: "s1", from: "+14243201960", body: "these were kinda off", channel: "imessage" } as never,
    {
      db,
      nowIso: () => "2026-05-21T16:01:00.000Z",
      log: () => {},
      getOnboardingUser: async () => ({ onboardingState: "complete" }),
      classifyFeedback: stubClassify({ replyKind: "feedback_answer", sentiment: "negative" }),
      enqueueOutbound: async (_u, _t, body) => {
        sent.push(body)
      },
      updateTurn: async () => {},
      markEventSucceeded: async () => {},
    },
    "t1",
  )
  assert.equal(handled, true)
  assert.equal((docs.get("pa-users/u_neg")?.postMatchRetention as { stage?: string; sentiment?: string }).stage, "await_dislike_reason")
  assert.equal((docs.get("pa-users/u_neg")?.postMatchRetention as { sentiment?: string }).sentiment, "negative")
  assert.equal(sent.length, 1)
})

test("dislike reason → LLM reasonCategory + canonical tag deltas persisted (no regex)", async () => {
  const docs = makeRetentionDocs("u_reason", { stage: "await_dislike_reason", recCount: 2, jobIds: ["j1"] })
  const db = makeRetentionDb(docs)
  const handled = await handlePostMatchRetentionReply(
    { id: "e1", userId: "u_reason", sessionId: "s1", from: "+14243201960", body: "all fintech, I'm actually into healthcare", channel: "imessage" } as never,
    {
      db,
      nowIso: () => "2026-05-21T16:01:00.000Z",
      log: () => {},
      getOnboardingUser: async () => ({ onboardingState: "complete" }),
      classifyFeedback: stubClassify({
        replyKind: "feedback_answer",
        sentiment: "negative",
        reasonCategory: "wrong_industry",
        tagDeltas: {
          industrySector: ["healthcare_and_life_sciences"],
          negativeIndustrySector: ["financial_technology"],
        },
      }),
      enqueueOutbound: async () => {},
      updateTurn: async () => {},
      markEventSucceeded: async () => {},
    },
    "t1",
  )
  assert.equal(handled, true)
  const post = docs.get("pa-users/u_reason")?.postMatchRetention as { reasonCategory?: string; stage?: string }
  assert.equal(post.reasonCategory, "wrong_industry")
  assert.equal(post.stage, "await_subscribe")
  // The LLM-extracted canonical tag deltas were written to pa-users.tags via the sole writer.
  const tags = docs.get("pa-users/u_reason")?.tags as { industrySector?: string[]; negativeIndustrySector?: string[] }
  assert.deepEqual(tags.industrySector, ["healthcare_and_life_sciences"])
  assert.deepEqual(tags.negativeIndustrySector, ["financial_technology"])
})

test("ambiguous sentiment (no classifier wired) re-asks without advancing", async () => {
  const docs = makeRetentionDocs("u_amb", { stage: "await_liked", recCount: 2 })
  const db = makeRetentionDb(docs)
  const sent: string[] = []
  const handled = await handlePostMatchRetentionReply(
    { id: "e1", userId: "u_amb", sessionId: "s1", from: "+14243201960", body: "hmm", channel: "imessage" } as never,
    {
      db,
      nowIso: () => "2026-05-21T16:01:00.000Z",
      log: () => {},
      getOnboardingUser: async () => ({ onboardingState: "complete" }),
      // No classifyFeedback → fail-open to ambiguous → re-ask, stay on await_liked.
      enqueueOutbound: async (_u, _t, body) => {
        sent.push(body)
      },
      updateTurn: async () => {},
      markEventSucceeded: async () => {},
    },
    "t1",
  )
  assert.equal(handled, true)
  assert.equal((docs.get("pa-users/u_amb")?.postMatchRetention as { stage?: string }).stage, "await_liked")
  assert.equal(sent.length, 1)
})

test("handlePostMatchRetentionReply returns false without db", async () => {
  const handled = await handlePostMatchRetentionReply(
    {
      id: "e1",
      userId: "u1",
      sessionId: "s1",
      from: "+1",
      body: "good",
      channel: "imessage",
    } as never,
    {
      nowIso: () => new Date().toISOString(),
      log: () => {},
      getOnboardingUser: async () => ({ onboardingState: "complete" }),
      updateTurn: async () => {},
      markEventSucceeded: async () => {},
    },
    "t1"
  )
  assert.equal(handled, false)
})

test("handlePostMatchRetentionReply yields explicit saved-preference question", async () => {
  const docs = new Map<string, Record<string, unknown>>([
    [
      "pa-feature-flags/paPostMatchRetentionEnabled",
      { key: "paPostMatchRetentionEnabled", value: true, type: "bool", scope: "global" },
    ],
    [
      "pa-users/u1",
      {
        postMatchRetention: {
          stage: "await_liked",
          startedAt: "2026-05-21T16:00:00.000Z",
          updatedAt: "2026-05-21T16:00:00.000Z",
          recCount: 2,
        },
      },
    ],
  ])
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docs.get(`${name}/${id}`)
          return { exists: data !== undefined, data: () => data }
        },
        set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          const key = `${name}/${id}`
          docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : data)
        },
      }),
    }),
  } as never
  const sent: string[] = []
  const handled = await handlePostMatchRetentionReply(
    {
      id: "e1",
      userId: "u1",
      sessionId: "s1",
      from: "+14243201960",
      body: "hat did you save about my job preferences",
      channel: "imessage",
    } as never,
    {
      db,
      nowIso: () => "2026-05-21T16:01:00.000Z",
      log: () => {},
      getOnboardingUser: async () => ({ onboardingState: "complete" }),
      classifyFeedback: stubClassify({ replyKind: "explicit_question" }),
      enqueueOutbound: async (_userId, _to, body) => {
        sent.push(body)
      },
      updateTurn: async () => {},
      markEventSucceeded: async () => {},
    },
    "t1"
  )

  assert.equal(handled, false)
  assert.deepEqual(sent, [])
})

test("handlePostMatchRetentionReply yields matching preference reminder", async () => {
  const docs = new Map<string, Record<string, unknown>>([
    [
      "pa-feature-flags/paPostMatchRetentionEnabled",
      { key: "paPostMatchRetentionEnabled", value: true, type: "bool", scope: "global" },
    ],
    [
      "pa-users/u1",
      {
        postMatchRetention: {
          stage: "await_liked",
          startedAt: "2026-05-27T23:00:00.000Z",
          updatedAt: "2026-05-27T23:00:00.000Z",
          recCount: 2,
        },
      },
    ],
  ])
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docs.get(`${name}/${id}`)
          return { exists: data !== undefined, data: () => data }
        },
        set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          const key = `${name}/${id}`
          docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : data)
        },
      }),
    }),
  } as never
  const sent: string[] = []
  const handled = await handlePostMatchRetentionReply(
    {
      id: "e-preference-reminder",
      userId: "u1",
      sessionId: "s1",
      from: "+14243201960",
      body: "Quick reminder what preferences are you using for matching",
      channel: "imessage",
    } as never,
    {
      db,
      nowIso: () => "2026-05-27T23:01:00.000Z",
      log: () => {},
      getOnboardingUser: async () => ({ onboardingState: "complete" }),
      classifyFeedback: stubClassify({ replyKind: "explicit_question" }),
      enqueueOutbound: async (_userId, _to, body) => {
        sent.push(body)
      },
      updateTurn: async () => {},
      markEventSucceeded: async () => {},
    },
    "t1"
  )

  assert.equal(handled, false)
  assert.deepEqual(sent, [])
})

test("writePostMatchRetention clears state when null", async () => {
  let payload: unknown
  const db = {
    collection: () => ({
      doc: () => ({
        set: async (data: unknown) => {
          payload = data
        },
      }),
    }),
  } as never
  await writePostMatchRetention(db, "u1", null)
  assert.deepEqual(payload, { postMatchRetention: null })
})

test("handlePostMatchRetentionReply sends an immediate match batch and completes after daily opt-in", async () => {
  const docs = new Map<string, Record<string, unknown>>([
    [
      "pa-feature-flags/paPostMatchRetentionEnabled",
      { key: "paPostMatchRetentionEnabled", value: true, type: "bool", scope: "global" },
    ],
    [
      "pa-users/u_subscribe",
      {
        postMatchRetention: {
          stage: "await_subscribe",
          startedAt: "2026-05-21T16:00:00.000Z",
          updatedAt: "2026-05-21T16:00:00.000Z",
          recCount: 2,
          jobIds: ["j1"],
        },
      },
    ],
  ])
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docs.get(`${name}/${id}`)
          return { exists: data !== undefined, data: () => data }
        },
        set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          const key = `${name}/${id}`
          docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : data)
        },
      }),
    }),
  } as never
  const sent: Array<{ body: string; extra?: Record<string, unknown> }> = []
  let generateOpts: unknown
  const handled = await handlePostMatchRetentionReply(
    {
      id: "e1",
      userId: "u_subscribe",
      sessionId: "s1",
      from: "+14243201960",
      body: "yes",
      channel: "imessage",
    } as never,
    {
      db,
      nowIso: () => "2026-05-21T16:01:00.000Z",
      log: () => {},
      getOnboardingUser: async () => ({ onboardingState: "complete" }),
      classifyFeedback: stubClassify({ replyKind: "feedback_answer", intent: "yes" }),
      generateJobRecs: async (_userId, _lang, opts) => {
        generateOpts = opts
        return { message: "two fresh software roles", recCount: 2 }
      },
      enqueueOutbound: async (_userId, _to, body, extra) => {
        sent.push({ body, extra })
      },
      updateTurn: async () => {},
      markEventSucceeded: async () => {},
    },
    "t1"
  )

  assert.equal(handled, true)
  assert.deepEqual(generateOpts, { force: true, requestedCount: 2 })
  assert.equal(sent[0]?.body, "two fresh software roles")
  assert.equal(sent[0]?.extra?.runtimeSource, "post_match_retention_subscribe_match")
  assert.equal(sent[1]?.extra?.runtimeSource, "post_match_retention")
  assert.doesNotMatch(sent[1]?.body ?? "", /partner|prescreen|screen|合作|初筛/i)
  assert.equal((docs.get("pa-job-profiles/u_subscribe") as { status?: string } | undefined)?.status, "active")
  assert.equal((docs.get("pa-users/u_subscribe")?.postMatchRetention as { stage?: string } | null)?.stage, "complete")
})

test("handlePostMatchRetentionReply completes daily opt-out without offering prescreen", async () => {
  const docs = new Map<string, Record<string, unknown>>([
    [
      "pa-feature-flags/paPostMatchRetentionEnabled",
      { key: "paPostMatchRetentionEnabled", value: true, type: "bool", scope: "global" },
    ],
    [
      "pa-users/u_decline",
      {
        postMatchRetention: {
          stage: "await_subscribe",
          startedAt: "2026-05-21T16:00:00.000Z",
          updatedAt: "2026-05-21T16:00:00.000Z",
          recCount: 2,
          jobIds: ["job_decline"],
        },
      },
    ],
  ])
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docs.get(`${name}/${id}`)
          return { exists: data !== undefined, data: () => data }
        },
        set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          const key = `${name}/${id}`
          docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : data)
        },
      }),
    }),
  } as never
  const sent: Array<{ body: string; extra?: Record<string, unknown> }> = []
  const handled = await handlePostMatchRetentionReply(
    {
      id: "e-decline",
      userId: "u_decline",
      sessionId: "s1",
      from: "+14243201960",
      body: "pass",
      channel: "imessage",
    } as never,
    {
      db,
      nowIso: () => "2026-05-21T16:01:00.000Z",
      log: () => {},
      getOnboardingUser: async () => ({ onboardingState: "complete" }),
      classifyFeedback: stubClassify({ replyKind: "feedback_answer", intent: "no" }),
      enqueueOutbound: async (_userId, _to, body, extra) => {
        sent.push({ body, extra })
      },
      updateTurn: async () => {},
      markEventSucceeded: async () => {},
    },
    "t-decline"
  )

  assert.equal(handled, true)
  assert.equal(sent.length, 1)
  assert.doesNotMatch(sent[0]?.body ?? "", /partner|prescreen|screen|合作|初筛/i)
  assert.equal((docs.get("pa-users/u_decline")?.postMatchRetention as { stage?: string } | null)?.stage, "complete")
})

test("handlePostMatchRetentionReply clears stale prescreen-offer state without sending another ask", async () => {
  const docs = new Map<string, Record<string, unknown>>([
    [
      "pa-feature-flags/paPostMatchRetentionEnabled",
      { key: "paPostMatchRetentionEnabled", value: true, type: "bool", scope: "global" },
    ],
    [
      "pa-users/u_stale",
      {
        postMatchRetention: {
          stage: "await_prescreen",
          startedAt: "2026-05-21T16:00:00.000Z",
          updatedAt: "2026-05-21T16:00:00.000Z",
          recCount: 2,
          jobIds: ["job_stale"],
        },
      },
    ],
  ])
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docs.get(`${name}/${id}`)
          return { exists: data !== undefined, data: () => data }
        },
        set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          const key = `${name}/${id}`
          docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : data)
        },
      }),
    }),
  } as never
  const sent: Array<{ body: string; extra?: Record<string, unknown> }> = []
  const handled = await handlePostMatchRetentionReply(
    {
      id: "e-prescreen-stale",
      userId: "u_stale",
      sessionId: "s1",
      from: "+14243201960",
      body: "yes",
      channel: "imessage",
    } as never,
    {
      db,
      nowIso: () => "2026-05-21T16:01:00.000Z",
      log: () => {},
      getOnboardingUser: async () => ({ onboardingState: "complete" }),
      enqueueOutbound: async (_userId, _to, body, extra) => {
        sent.push({ body, extra })
      },
      updateTurn: async () => {},
      markEventSucceeded: async () => {},
    },
    "t-prescreen-stale"
  )

  assert.equal(handled, true)
  assert.equal(sent.length, 1)
  assert.doesNotMatch(sent[0]?.body ?? "", /partner|prescreen|screen|合作|初筛/i)
  assert.equal((docs.get("pa-users/u_stale")?.postMatchRetention as { stage?: string } | null)?.stage, "complete")
})
