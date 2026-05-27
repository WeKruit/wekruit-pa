import assert from "node:assert/strict"
import test from "node:test"
import {
  detectRecBatchSentiment,
  detectYesNoIntent,
  handlePostMatchRetentionReply,
  startPostMatchRetentionAfterJobRecs,
  writePostMatchRetention,
} from "../post-match-retention.js"

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

test("detectRecBatchSentiment classifies dislike", () => {
  assert.equal(detectRecBatchSentiment("I don't like this"), "negative")
  assert.equal(detectRecBatchSentiment("不太行"), "negative")
  assert.equal(detectRecBatchSentiment("useful thanks"), "positive")
})

test("detectYesNoIntent", () => {
  assert.equal(detectYesNoIntent("yes please"), "yes")
  assert.equal(detectYesNoIntent("先不用"), "no")
  assert.equal(detectYesNoIntent("I'm good for now."), "no")
  assert.equal(detectYesNoIntent("no thanks, not right now"), "no")
  assert.equal(detectYesNoIntent("Pass"), "no")
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
