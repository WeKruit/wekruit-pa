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

test("handlePostMatchRetentionReply sends an immediate match batch after daily opt-in", async () => {
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
  assert.match(sent[1]?.body ?? "", /partner|合作/)
  assert.equal((docs.get("pa-job-profiles/u_subscribe") as { status?: string } | undefined)?.status, "active")
})

test("handlePostMatchRetentionReply does not offer another prescreen when review is pending", async () => {
  const docs = new Map<string, Record<string, unknown>>([
    [
      "pa-feature-flags/paPostMatchRetentionEnabled",
      { key: "paPostMatchRetentionEnabled", value: true, type: "bool", scope: "global" },
    ],
    [
      "pa-users/u_pending",
      {
        postMatchRetention: {
          stage: "await_prescreen",
          startedAt: "2026-05-21T16:00:00.000Z",
          updatedAt: "2026-05-21T16:00:00.000Z",
          recCount: 2,
          jobIds: ["job_pending"],
        },
      },
    ],
  ])
  const prescreenSessions = [
    {
      id: "ps_pending",
      data: () => ({
        userId: "u_pending",
        jobId: "job_pending",
        terminal: "PASS",
        terminalActionPendingReview: true,
        updatedAt: "2026-05-21T16:00:00.000Z",
      }),
    },
  ]
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
      where: () => ({
        limit: () => ({
          get: async () => ({ empty: false, docs: prescreenSessions }),
        }),
      }),
    }),
  } as never
  const sent: Array<{ body: string; extra?: Record<string, unknown> }> = []
  let offerCalled = false
  const handled = await handlePostMatchRetentionReply(
    {
      id: "e-prescreen",
      userId: "u_pending",
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
      generateJobRecs: async () => {
        offerCalled = true
        return { message: "should not send partner offer", recCount: 1 }
      },
      enqueueOutbound: async (_userId, _to, body, extra) => {
        sent.push({ body, extra })
      },
      updateTurn: async () => {},
      markEventSucceeded: async () => {},
    },
    "t-prescreen"
  )

  assert.equal(handled, true)
  assert.equal(offerCalled, false)
  assert.equal(sent.length, 1)
  assert.match(sent[0]?.body ?? "", /already|review/i)
  assert.doesNotMatch(sent[0]?.body ?? "", /partner role|quick screen|top match/i)
  assert.equal((docs.get("pa-users/u_pending")?.postMatchRetention as { stage?: string } | null)?.stage, "complete")
})

test("handlePostMatchRetentionReply allows another prescreen when pending review is for a different job", async () => {
  const docs = new Map<string, Record<string, unknown>>([
    [
      "pa-feature-flags/paPostMatchRetentionEnabled",
      { key: "paPostMatchRetentionEnabled", value: true, type: "bool", scope: "global" },
    ],
    [
      "pa-users/u_multi",
      {
        postMatchRetention: {
          stage: "await_prescreen",
          startedAt: "2026-05-21T16:00:00.000Z",
          updatedAt: "2026-05-21T16:00:00.000Z",
          recCount: 2,
          jobIds: ["job_new"],
        },
      },
    ],
  ])
  const prescreenSessions = [
    {
      id: "ps_old_pending",
      data: () => ({
        userId: "u_multi",
        jobId: "job_old",
        terminal: "PASS",
        terminalActionPendingReview: true,
        updatedAt: "2026-05-21T16:00:00.000Z",
      }),
    },
  ]
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
      where: () => ({
        limit: () => ({
          get: async () => ({ empty: prescreenSessions.length === 0, docs: prescreenSessions }),
        }),
      }),
    }),
  } as never
  const sent: Array<{ body: string; extra?: Record<string, unknown> }> = []
  let generateOpts: unknown
  const handled = await handlePostMatchRetentionReply(
    {
      id: "e-prescreen-new",
      userId: "u_multi",
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
        return {
          message: "new partner match",
          recCount: 1,
          topJob: {
            jobId: "job_new",
            title: "Associate Data Analyst",
            company: "PartnerCo",
            score: 0.91,
          },
        }
      },
      enqueueOutbound: async (_userId, _to, body, extra) => {
        sent.push({ body, extra })
      },
      updateTurn: async () => {},
      markEventSucceeded: async () => {},
    },
    "t-prescreen-new"
  )

  assert.equal(handled, true)
  assert.deepEqual(generateOpts, {
    force: true,
    requestedCount: 3,
    collabPrescreenOnly: true,
  })
  assert.equal(sent[0]?.extra?.runtimeSource, "collab_match_invite_post_match")
  assert.match(sent[0]?.body ?? "", /Associate Data Analyst|PartnerCo/)
  assert.equal(sent[1]?.extra?.runtimeSource, "post_match_retention")
  assert.equal((docs.get("pa-users/u_multi")?.collabInvitePending as { jobId?: string } | null)?.jobId, "job_new")
  assert.equal((docs.get("pa-users/u_multi")?.postMatchRetention as { stage?: string } | null)?.stage, "complete")
})
