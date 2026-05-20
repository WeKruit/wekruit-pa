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
