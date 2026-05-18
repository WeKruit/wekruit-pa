/**
 * Layer 2 sim — Cold-start.
 *
 * Beta task: pending → q_email_asked.
 *
 * Verifies:
 *   1. First-ever turn (state.currentQId === null) emits Q1 (q_email) prompt
 *      WITHOUT consulting the judge — pipeline returns immediately after
 *      setting currentQId.
 *   2. State after first turn: currentQId === "q_email", collected empty,
 *      attempts empty, halted null, completed false.
 *   3. Default lang on cold start is "en" — q_email prompt is emitted in EN.
 *   4. Re-running cold start with state already at q_email does NOT re-emit
 *      the prompt; it judges the reply (so a meaningless second cold call
 *      should ALSO not re-prompt — second turn judges, not prompts).
 */
import test from "node:test"
import assert from "node:assert/strict"

import { buildPipeline, TEST_USER } from "./_helpers.js"
import type { Question } from "../../question.js"

test("sim/cold-start: first turn emits q_email prompt + sets state.currentQId", async () => {
  const { send, peekState, emitted } = buildPipeline()

  const ev = await send("hi")

  assert.equal(ev?.kind, "first_prompt", "first turn = first_prompt kind")
  assert.equal(ev?.qId, "q_email", "first Q is q_email")
  assert.match(ev?.text ?? "", /email/i)

  const s = peekState()
  assert.equal(s?.currentQId, "q_email")
  assert.deepEqual(s?.collected, {}, "no answers captured yet")
  assert.deepEqual(s?.attempts, {}, "no attempts logged yet")
  assert.equal(s?.halted, null)
  assert.equal(s?.completed, false)
  assert.equal(s?.lang, "en", "default cold-start lang = en")

  assert.equal(emitted.length, 1, "exactly one outbound (the q_email prompt)")
})

test("sim/cold-start: cold pending → q_email pending state mirrors beta spec", async () => {
  // State at userId is non-existent before send(); after first send(), state
  // exists with currentQId = q_email_asked equivalent (in pipeline-speak,
  // state.currentQId === 'q_email').
  const { peekState, send } = buildPipeline()

  // Before any send: state is empty (InMemoryPipelineStateProvider returns
  // undefined from peek when never touched).
  assert.equal(peekState(TEST_USER), undefined, "pending: no state row yet")

  await send("anything")

  const s = peekState(TEST_USER)
  assert.ok(s, "state row exists after first turn")
  assert.equal(s?.currentQId, "q_email", "state advanced to q_email_asked equiv")
})

test("sim/cold-start: second turn moves OFF cold-start (judges reply, no re-prompt)", async () => {
  const { send, emitted } = buildPipeline()

  // Turn 1: emit q_email prompt
  await send("hi")
  // Turn 2: now state.currentQId = q_email. Reply 'pizza' is irrelevant
  // (EmailJudge will not match) → re-ask should fire.
  await send("pizza is fine")

  // Two emits total: 1 prompt + 1 re-ask. Crucially the second emit is NOT
  // another "first_prompt" — pipeline already past cold-start.
  assert.equal(emitted.length, 2)
  assert.equal(emitted[0]!.kind, "first_prompt")
  assert.equal(emitted[1]!.kind, "reask", "second turn judges + re-asks, no re-prompt")
})

test("sim/cold-start: lang preserved through cold-start (zh user pre-seeded)", async () => {
  const built = buildPipeline()
  // Manually seed state.lang = "zh" before first turn — production will set
  // This verifies the pipeline still honors an explicitly pre-seeded language;
  // production runtime normalizes beta onboarding to English before running it.
  const s0 = await built.state.load(TEST_USER)
  s0.lang = "zh"
  await built.state.save(TEST_USER, s0)

  await built.send("hi")

  assert.equal(built.emitted.length, 1)
  assert.match(built.emitted[0]!.text, /邮箱/, "zh email prompt emitted")
})

test("sim/completion: final accepted answer clears currentQId", async () => {
  const q: Question<unknown> = {
    id: "q_one",
    prompt: { en: "Question one?", zh: "问题一?" },
    judge: {
      kind: "test_accept",
      judge: async () => ({ accept: true, value: "accepted" }),
    },
    rephraser: {
      kind: "test_rephraser",
      rephrase: async () => "try again",
    },
  }
  const built = buildPipeline({ questionsOverride: [q] })

  await built.send("start")
  await built.send("answer")

  const s = built.peekState(TEST_USER)
  assert.equal(s?.completed, true)
  assert.equal(s?.currentQId, null)
})
