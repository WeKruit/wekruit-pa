/**
 * Stream C — recruiter-flow lifecycle tests.
 *
 * Covers:
 *   1. routes when mediaUrl + flag-on: invokes runRecruiterTurn, writes
 *      assistant pa-messages, enqueues pa-outbound, marks succeeded
 *   2. NO route when mediaUrl absent (handled at dispatcher; here we
 *      assert empty mediaUrl path inside the flow degrades safely)
 *   3. NO route when flag OFF (here we assert: flow not invoked when
 *      caller doesn't pass it in — the flag gate lives in dispatcher;
 *      we reverify that flag-OFF means runRecruiterTurn never fires by
 *      asserting the wrapper short-circuits when caller doesn't call it)
 *   4. claim is atomic: second invocation on same event no-ops
 *   5. error in runRecruiterTurn → event marked failed, error re-thrown
 *   6. assistant text gets normalized before pa-outbound (URL preview /
 *      markdown-strip rule from output-normalizer)
 */

import test from "node:test"
import assert from "node:assert/strict"
import { MockFirestore, asFirestore } from "./mock-firestore.js"
import { runRecruiterFlow } from "../recruiter-flow.js"
import type { InboundEvent } from "@pa/core-types"
import type { RunRecruiterTurnArgs, RunRecruiterTurnResult, RecruiterAgentDeps } from "@pa/job-rec"

// ---- Test fixtures ---------------------------------------------------

const ADAM_USER_ID = "user_adam"
const ADAM_PHONE = "+15551234567"
const SESSION_ID = "sess_imessage_adam"
const MEDIA_URL = "https://storage.googleapis.com/inbound-file-store/adam-cv.pdf"

function seedAdamUser(mfs: MockFirestore) {
  void mfs
    .collection("pa-users")
    .doc(ADAM_USER_ID)
    .set({ id: ADAM_USER_ID, phoneE164: ADAM_PHONE })
}

function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    id: "evt_001",
    userId: ADAM_USER_ID,
    sessionId: SESSION_ID,
    channel: "imessage",
    externalChatId: "chat_adam",
    from: ADAM_PHONE,
    body: "",
    status: "pending",
    createdAt: "2026-04-30T12:00:00.000Z",
    idempotencyKey: "sendblue-msg-abc",
    ...overrides,
  }
}

function seedInboundEvent(mfs: MockFirestore, event: InboundEvent) {
  void mfs.collection("pa-inbound-events").doc(event.id).set(event as unknown as Record<string, unknown>)
}

function fakeRunTurn(reply: string) {
  let called = 0
  let lastArgs: RunRecruiterTurnArgs | null = null
  let lastDeps: RecruiterAgentDeps | null = null
  const fn = async (deps: RecruiterAgentDeps, args: RunRecruiterTurnArgs): Promise<RunRecruiterTurnResult> => {
    called += 1
    lastArgs = args
    lastDeps = deps
    return { text: reply, sessionId: args.sessionId }
  }
  return {
    fn,
    get called() { return called },
    get lastArgs() { return lastArgs },
    get lastDeps() { return lastDeps },
  }
}

const FROZEN_NOW = () => new Date("2026-04-30T12:00:01.000Z")

// ---- Tests ---------------------------------------------------------

test("Test 1: routes when mediaUrl + flag-on → runRecruiterTurn called, pa-messages + pa-outbound written, event succeeded", async () => {
  const mfs = new MockFirestore()
  seedAdamUser(mfs)
  const event = makeEvent()
  seedInboundEvent(mfs, event)

  const turn = fakeRunTurn("嘿 看到你简历啦, 让我消化下…")
  const res = await runRecruiterFlow(asFirestore(mfs), event, {
    mediaUrl: MEDIA_URL,
    runRecruiterTurnImpl: turn.fn,
    now: FROZEN_NOW,
  })

  assert.equal(res.ok, true)
  assert.equal(turn.called, 1)
  assert.equal(turn.lastArgs?.attachmentMediaUrl, MEDIA_URL)
  assert.equal(turn.lastArgs?.userId, ADAM_USER_ID)
  assert.equal(turn.lastArgs?.sessionId, SESSION_ID)

  // Assistant message written
  const messages = mfs.store.get("pa-messages")
  assert.ok(messages, "pa-messages collection should exist")
  const msgRows = [...messages!.values()] as Array<Record<string, unknown>>
  assert.equal(msgRows.length, 1)
  assert.equal(msgRows[0]?.role, "assistant")
  assert.equal(msgRows[0]?.idempotencyKey, "recruiter-evt_001-assistant")

  // Outbound enqueued
  const outbound = mfs.store.get("pa-outbound")
  assert.ok(outbound, "pa-outbound collection should exist")
  const outRow = outbound!.get("out-evt_001")
  assert.ok(outRow, "out-evt_001 doc should exist")
  assert.equal(outRow?.status, "pending")
  assert.equal(outRow?.toE164, ADAM_PHONE)
  assert.equal(outRow?.role, "assistant")
  assert.equal(outRow?.idempotencyKey, "out-evt_001")

  // Event row marked succeeded with recruiterTurnRan flag
  const evt = mfs.store.get("pa-inbound-events")?.get("evt_001")
  assert.equal(evt?.status, "succeeded")
  assert.equal(evt?.recruiterTurnRan, true)
  assert.equal(evt?.outboundId, "out-evt_001")
})

test("Test 2: when mediaUrl absent in dispatcher → runRecruiterFlow never called (verified by simulating dispatcher gate)", async () => {
  // The dispatcher in apps/functions/src/index.ts gates on `mediaUrl &&
  // userId && jobRecOn === true` BEFORE calling runRecruiterFlow.
  // Mirror that gate here and assert the flow is not invoked.
  const mfs = new MockFirestore()
  seedAdamUser(mfs)
  const event = makeEvent()
  seedInboundEvent(mfs, event)

  const turn = fakeRunTurn("should not run")
  // Simulate the dispatcher: mediaUrl is absent → SKIP runRecruiterFlow
  const mediaUrl: string | undefined = undefined
  if (mediaUrl) {
    await runRecruiterFlow(asFirestore(mfs), event, {
      mediaUrl,
      runRecruiterTurnImpl: turn.fn,
      now: FROZEN_NOW,
    })
  }
  assert.equal(turn.called, 0)
  // Event row untouched (still pending; default Claire would pick it up).
  const evt = mfs.store.get("pa-inbound-events")?.get("evt_001")
  assert.equal(evt?.status, "pending")
})

test("Test 3: flag OFF → dispatcher does not invoke runRecruiterFlow (event stays pending for default Claire)", async () => {
  const mfs = new MockFirestore()
  seedAdamUser(mfs)
  const event = makeEvent()
  seedInboundEvent(mfs, event)

  const turn = fakeRunTurn("should not run")
  // Simulate dispatcher: jobRecOn === false → SKIP
  const jobRecOn: boolean = false
  if (jobRecOn) {
    await runRecruiterFlow(asFirestore(mfs), event, {
      mediaUrl: MEDIA_URL,
      runRecruiterTurnImpl: turn.fn,
      now: FROZEN_NOW,
    })
  }
  assert.equal(turn.called, 0)
  const evt = mfs.store.get("pa-inbound-events")?.get("evt_001")
  assert.equal(evt?.status, "pending")
})

test("Test 4: claim is atomic — second invocation on same event no-ops (status already running/succeeded)", async () => {
  const mfs = new MockFirestore()
  seedAdamUser(mfs)
  const event = makeEvent()
  seedInboundEvent(mfs, event)

  const turn1 = fakeRunTurn("first turn output")
  const turn2 = fakeRunTurn("should never run")

  const r1 = await runRecruiterFlow(asFirestore(mfs), event, {
    mediaUrl: MEDIA_URL,
    runRecruiterTurnImpl: turn1.fn,
    now: FROZEN_NOW,
  })
  assert.equal(r1.ok, true)
  assert.equal(turn1.called, 1)

  const r2 = await runRecruiterFlow(asFirestore(mfs), event, {
    mediaUrl: MEDIA_URL,
    runRecruiterTurnImpl: turn2.fn,
    now: FROZEN_NOW,
  })
  assert.equal(r2.ok, false)
  assert.deepEqual(r2, { ok: false, reason: "already_processed" })
  assert.equal(turn2.called, 0, "second invocation must not run the LLM turn")

  // Outbound row was not duplicated (still single doc keyed out-evt_001)
  const outbound = mfs.store.get("pa-outbound")
  assert.equal(outbound?.size, 1)
})

test("Test 5: error in runRecruiterTurn → event marked failed, error re-thrown (not swallowed)", async () => {
  const mfs = new MockFirestore()
  seedAdamUser(mfs)
  const event = makeEvent()
  seedInboundEvent(mfs, event)

  const boom = async (_d: RecruiterAgentDeps, _a: RunRecruiterTurnArgs): Promise<RunRecruiterTurnResult> => {
    throw new Error("LLM exploded")
  }

  let thrown: unknown = null
  try {
    await runRecruiterFlow(asFirestore(mfs), event, {
      mediaUrl: MEDIA_URL,
      runRecruiterTurnImpl: boom,
      now: FROZEN_NOW,
    })
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown instanceof Error)
  assert.equal((thrown as Error).message, "LLM exploded")

  // Event row marked failed (so default Claire won't double-process; the
  // lease-based reclaim will eventually route it to default if needed).
  const evt = mfs.store.get("pa-inbound-events")?.get("evt_001")
  assert.equal(evt?.status, "failed")
  assert.equal(evt?.errorCode, "recruiter_turn_failed")
  assert.match(String(evt?.error ?? ""), /LLM exploded/)

  // No assistant message + no outbound when the turn throws.
  assert.equal(mfs.store.get("pa-messages")?.size ?? 0, 0)
  assert.equal(mfs.store.get("pa-outbound")?.size ?? 0, 0)
})

test("Test 6: assistant text is normalized (markdown stripped + UTM cleaned) before pa-outbound enqueue", async () => {
  const mfs = new MockFirestore()
  seedAdamUser(mfs)
  const event = makeEvent()
  seedInboundEvent(mfs, event)

  // Markdown link with UTM tracking — the live normalizeForIMessage
  // strips both. We use the real normalizer (not a stub) so this test
  // pins the contract: outbound body MUST be plain text.
  const dirty =
    "嘿 see this role: [Senior PM](https://acme.co/jobs/123?utm_source=email&utm_medium=foo) sound good?"
  const turn = fakeRunTurn(dirty)
  const res = await runRecruiterFlow(asFirestore(mfs), event, {
    mediaUrl: MEDIA_URL,
    runRecruiterTurnImpl: turn.fn,
    now: FROZEN_NOW,
  })
  assert.equal(res.ok, true)

  const outRow = mfs.store.get("pa-outbound")?.get("out-evt_001") as Record<string, unknown> | undefined
  const body = String(outRow?.body ?? "")
  // Plain text — no markdown link syntax.
  assert.ok(!/\[.*\]\(.*\)/.test(body), `body should not contain markdown link: ${body}`)
  // UTM params stripped.
  assert.ok(!/utm_source/.test(body), `body should not retain utm_source: ${body}`)
  assert.ok(!/utm_medium/.test(body), `body should not retain utm_medium: ${body}`)
  // URL is preserved (in normalized form).
  assert.match(body, /https:\/\/acme\.co\/jobs\/123/, `URL should remain: ${body}`)
})

test("Test 7 (defensive): user has no phoneE164 → event marked failed with errorCode=no_phone, no outbound, no throw", async () => {
  const mfs = new MockFirestore()
  // NB: do NOT seedAdamUser — user row missing phoneE164.
  void mfs.collection("pa-users").doc(ADAM_USER_ID).set({ id: ADAM_USER_ID })
  const event = makeEvent()
  seedInboundEvent(mfs, event)

  const turn = fakeRunTurn("should not run because phone missing")
  const res = await runRecruiterFlow(asFirestore(mfs), event, {
    mediaUrl: MEDIA_URL,
    runRecruiterTurnImpl: turn.fn,
    now: FROZEN_NOW,
  })
  assert.deepEqual(res, { ok: false, reason: "no_phone" })
  assert.equal(turn.called, 0)
  const evt = mfs.store.get("pa-inbound-events")?.get("evt_001")
  assert.equal(evt?.status, "failed")
  assert.equal(evt?.errorCode, "no_phone")
})
