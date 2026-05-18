/**
 * Layer 2 sim — happy path through ALL 10 active V2 Qs.
 *
 * Beta task: email → email_verify → tos → role → yoe → visa →
 * startup_pref → country → location → resume_asked.
 *
 * Setup:
 *   - EmailJudge: regex "alex@gmail.com" → captured (no LLM)
 *   - CodeJudge: no db wired in test → auto-accept (no_db_accept path)
 *   - YesNoJudge: "agree" → captured
 *   - GuidedOpenJudge V2 (q_role / q_yoe / q_visa / q_startup_pref /
 *     q_country / q_location):
 *     stub llmCallFactory → provided JSON
 *   - q_resume is REACHED but NOT answered — final state at q_resume_asked
 *     (matches task spec — `email → ... → location → resume_asked`).
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  buildPipeline,
  buildV2QuestionsWithStubs,
  stubGuidedOpenLLM,
  stubGuidedOpenProvided,
} from "./_helpers.js"

test("sim/q-chain-happy: full 10-Q chain runs to q_resume prompt without halt", async () => {
  // Track captured values via onAccepted hooks (where possible) + collected map.
  const collected: Record<string, unknown> = {}

  const roleLlm = stubGuidedOpenLLM({ engineer: stubGuidedOpenProvided("swe") })
  const yoeLlm = stubGuidedOpenLLM({ "5 years": stubGuidedOpenProvided(5) })
  const startupPrefLlm = stubGuidedOpenLLM({ either: stubGuidedOpenProvided("either") })
  const visaLlm = stubGuidedOpenLLM({
    "i'm a citizen": stubGuidedOpenProvided("citizen"),
  })
  const countryLlm = stubGuidedOpenLLM({
    "usa-only-please": stubGuidedOpenProvided("usa"),
  })
  const locationLlm = stubGuidedOpenLLM({
    "sf only": stubGuidedOpenProvided(["sf"]),
  })

  const questions = buildV2QuestionsWithStubs({
    roleLlm,
    yoeLlm,
    startupPrefLlm,
    visaLlm,
    countryLlm,
    locationLlm,
    onCountryAccepted: async (v) => { collected.country = v },
    onLocationAccepted: async (v) => { collected.location = v },
    onVisaAccepted: async (v) => { collected.visa = v },
  })

  const built = buildPipeline({ questionsOverride: questions })

  // Turn 1: cold start. emits q_email prompt.
  let ev = await built.send("hi")
  assert.equal(ev?.qId, "q_email", "turn 1 = q_email prompt")
  assert.equal(ev?.kind, "first_prompt")

  // Turn 2: answer q_email (regex hit, no LLM).
  ev = await built.send("alex@gmail.com")
  assert.equal(ev?.qId, "q_email_verify", "turn 2 advances to q_email_verify")

  // Turn 3: answer q_email_verify. CodeJudge with no db → auto-accept any 6-digit.
  ev = await built.send("123456")
  assert.equal(ev?.qId, "q_tos", "turn 3 advances to q_tos")

  // Turn 4: answer q_tos.
  ev = await built.send("agree")
  assert.equal(ev?.qId, "q_role", "turn 4 advances to q_role")

  // Turn 5: answer q_role via GuidedOpenJudge stub.
  ev = await built.send("I'm an engineer")
  assert.equal(ev?.qId, "q_yoe", "turn 5 advances to q_yoe")

  // Turn 6: answer q_yoe.
  ev = await built.send("5 years")
  assert.equal(ev?.qId, "q_visa", "turn 6 advances to q_visa")

  // Turn 7: answer q_visa via GuidedOpenJudge stub.
  ev = await built.send("i'm a citizen actually") // matches stub key 'i\'m a citizen'
  assert.equal(ev?.qId, "q_startup_pref", "turn 7 advances to q_startup_pref")

  // Turn 8: answer q_startup_pref.
  ev = await built.send("either is fine")
  assert.equal(ev?.qId, "q_country", "turn 8 advances to q_country")

  // Turn 9: answer q_country via GuidedOpenJudge stub. Use a phrase
  // that does NOT collide with bloom regex (which would short-circuit
  // before our stub runs). The bloom regex for "usa" matches /^\s*(usa|us|...)\s*$/i
  // — only when the reply is exactly that token. So our reply needs to be
  // something the bloom MISSES but our stub LLM accepts.
  ev = await built.send("usa-only-please") // bloom regex misses ("only-please" extra)
  assert.equal(ev?.qId, "q_location", "turn 9 advances to q_location")

  // Turn 10: answer q_location.
  // Bloom common matches anywhere/remote ONLY — "sf only" is NOT in bloom
  // → stub LLM is consulted (key match: "sf only").
  ev = await built.send("sf only")
  assert.equal(ev?.qId, "q_resume", "turn 10 advances to q_resume")
  assert.equal(ev?.kind, "first_prompt", "q_resume prompt emitted (resume_asked)")

  // Final state checks:
  const s = built.peekState()
  assert.equal(s?.currentQId, "q_resume", "final state at q_resume_asked")
  assert.equal(s?.completed, false, "not completed yet (resume still pending)")
  assert.equal(s?.halted, null, "no halts during chain")

  // Captured answers — values collected for the questions we passed
  // (email/email_verify/tos/role/yoe/visa/startup/country/location).
  assert.equal(s?.collected.q_email, "alex@gmail.com", "q_email captured")
  assert.equal(s?.collected.q_email_verify, "123456", "q_email_verify captured")
  assert.equal(s?.collected.q_tos, true, "q_tos captured")
  assert.deepEqual(s?.collected.q_role, ["swe"], "q_role captured")
  assert.equal(s?.collected.q_yoe, 5, "q_yoe captured")
  assert.equal(s?.collected.q_visa, "citizen", "q_visa captured")
  assert.equal(s?.collected.q_startup_pref, "either", "q_startup_pref captured")
  assert.deepEqual(s?.collected.q_country, ["usa"], "q_country captured")
  assert.deepEqual(s?.collected.q_location, ["sf"], "q_location captured")

  // onAccepted hooks fired for the V2 Qs we wired.
  assert.deepEqual(collected.country, ["usa"])
  assert.deepEqual(collected.location, ["sf"])
  assert.equal(collected.visa, "citizen")
})

test("sim/q-chain-happy: state machine emits exactly 10 events (1 cold + 9 advances)", async () => {
  const questions = buildV2QuestionsWithStubs({
    roleLlm: stubGuidedOpenLLM({ engineer: stubGuidedOpenProvided("swe") }),
    yoeLlm: stubGuidedOpenLLM({ "5 years": stubGuidedOpenProvided(5) }),
    startupPrefLlm: stubGuidedOpenLLM({ either: stubGuidedOpenProvided("either") }),
    visaLlm: stubGuidedOpenLLM({ "citizen ": stubGuidedOpenProvided("citizen") }),
    countryLlm: stubGuidedOpenLLM({ "usa-only-please": stubGuidedOpenProvided("usa") }),
    locationLlm: stubGuidedOpenLLM({ "sf only": stubGuidedOpenProvided(["sf"]) }),
  })
  const built = buildPipeline({ questionsOverride: questions })

  await built.send("hi")
  await built.send("alex@gmail.com")
  await built.send("123456")
  await built.send("agree")
  await built.send("I'm an engineer")
  await built.send("5 years")
  await built.send("citizen ")
  await built.send("either is fine")
  await built.send("usa-only-please")
  await built.send("sf only")

  // 10 events emitted: cold-start prompt + 9 next-Q prompts (1 per accept).
  assert.equal(built.emitted.length, 10, "10 emits = 1 cold-start + 9 advances")
  // None should be reasks or halts.
  const kinds = built.emitted.map((e) => e.kind)
  assert.equal(kinds.filter((k) => k === "reask").length, 0, "no reasks on happy path")
  assert.equal(kinds.filter((k) => k === "halt").length, 0, "no halts on happy path")
  assert.equal(
    kinds.filter((k) => k === "first_prompt").length,
    10,
    "all emits are first_prompt kind"
  )
})
