/**
 * Layer 2 sim — typo recovery on each Q.
 *
 * P7-6 task: each Q gets 1 typo'd reply, must auto-recover via LLM intent
 * (mocked). The typo turn returns "unclear" → pipeline re-asks → second turn
 * returns "provided" → advances.
 *
 * Strategy:
 *   - Per-Q: send a typo'd reply first (e.g. "engiener"). Stub LLM/judge
 *     returns unclear → pipeline emits a re-ask.
 *   - Send the proper reply. Stub returns provided → pipeline advances.
 *   - End state advances to next Q. Re-ask was emitted exactly once per Q.
 *
 * Tests are FOCUSED on representative probe Qs to avoid 22-step linear chain
 * fatigue:
 *   - q_email (regex hits clean form, but LLM stub catches typo'd shape)
 *   - q_role (LLMRelevanceJudge unclear → provided)
 *   - q_visa (GuidedOpenJudge unclear → provided)
 *   - q_country (GuidedOpenJudge unclear → provided)
 *   - q_location (GuidedOpenJudge unclear → provided)
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  buildPipeline,
  buildV2QuestionsWithStubs,
  stubExtractEmail,
  stubGuidedOpenProvided,
  stubGuidedOpenUnclear,
} from "./_helpers.js"
import type { ExtractIntentFn } from "../../judges/llm-relevance.js"
import type { ExtractEmailIntentFn, EmailIntentResult } from "../../judges/email.js"
import type { LlmCallFn } from "../../judges/guided-open.js"

test("sim/q-chain-typo: q_email typo → recovery", async () => {
  // Email: regex misses "alex@gmal" (no TLD). LLM 1st = typo with suggestion.
  // Then user resends 'alex@gmail.com' → regex hits.
  let emailLlmCall = 0
  const extractEmailIntent: ExtractEmailIntentFn = async () => {
    emailLlmCall++
    if (emailLlmCall === 1) {
      return {
        intent: "typo",
        original: "alex@gmal",
        suggestion: "alex@gmail.com",
      } as EmailIntentResult
    }
    return null // unused — second turn is regex hit
  }

  const built = buildPipeline({ extractEmailIntent })

  await built.send("hi") // q_lang prompt
  await built.send("english") // → q_email
  // Typo turn:
  await built.send("alex@gmal")
  let s = built.peekState()
  assert.equal(s?.currentQId, "q_email", "typo holds at q_email")
  assert.ok(s && (s.attempts.q_email ?? 0) >= 1, "attempt counter bumped")
  // Recovery turn:
  await built.send("alex@gmail.com")
  s = built.peekState()
  assert.equal(s?.currentQId, "q_email_verify", "advanced after recovery")

  // Verify exactly 1 reask was emitted for q_email.
  const reasks = built.emitted.filter((e) => e.kind === "reask" && e.qId === "q_email")
  assert.equal(reasks.length, 1, "exactly one reask between typo and recovery")
})

test("sim/q-chain-typo: q_role typo → recovery (LLMRelevanceJudge)", async () => {
  let roleCalls = 0
  const extractAnswerIntent: ExtractIntentFn = async (step, reply) => {
    if (step !== "ask_q_role") return null
    roleCalls++
    if (roleCalls === 1) {
      return { intent: "unclear", clarifyingQuestion: "did you mean engineer?" }
    }
    return { intent: "provided", value: "engineer", confidence: 1.0 }
  }

  // Skip ahead to q_role using pre-seeded state. Easier than typing all
  // earlier Qs by stubbing only what's necessary.
  const questions = buildV2QuestionsWithStubs({ extractAnswerIntent })
  const built = buildPipeline({ questionsOverride: questions, extractAnswerIntent })

  // Pre-seed state: q_role active.
  const s0 = await built.state.load("u_sim")
  s0.currentQId = "q_role"
  s0.lang = "en"
  await built.state.save("u_sim", s0)

  // Typo'd reply.
  await built.send("engiener pls")
  let s = built.peekState()
  assert.equal(s?.currentQId, "q_role", "stays on q_role")
  assert.ok(s && (s.attempts.q_role ?? 0) >= 1)

  // Recovery.
  await built.send("yes engineer")
  s = built.peekState()
  assert.equal(s?.currentQId, "q_yoe", "advanced after recovery")

  const reasks = built.emitted.filter((e) => e.kind === "reask" && e.qId === "q_role")
  assert.equal(reasks.length, 1)
})

test("sim/q-chain-typo: q_visa typo → recovery (GuidedOpenJudge)", async () => {
  let visaCalls = 0
  const visaLlm: LlmCallFn = async () => {
    visaCalls++
    if (visaCalls === 1) return stubGuidedOpenUnclear("did you mean citizen?")
    return stubGuidedOpenProvided("citizen")
  }

  const questions = buildV2QuestionsWithStubs({ visaLlm })
  const built = buildPipeline({ questionsOverride: questions })
  const s0 = await built.state.load("u_sim")
  s0.currentQId = "q_visa"
  await built.state.save("u_sim", s0)

  // Typo — bloom won't match "citzen actuallly" (extra letters trip the
  // anchored bloom regex), so LLM is consulted.
  await built.send("citzen actuallly")
  assert.equal(built.peekState()?.currentQId, "q_visa")

  await built.send("citizen!")
  assert.equal(built.peekState()?.currentQId, "q_startup_pref")

  const reasks = built.emitted.filter((e) => e.kind === "reask" && e.qId === "q_visa")
  assert.equal(reasks.length, 1)
})

test("sim/q-chain-typo: q_country typo → recovery (GuidedOpenJudge)", async () => {
  let countryCalls = 0
  const countryLlm: LlmCallFn = async () => {
    countryCalls++
    if (countryCalls === 1) return stubGuidedOpenUnclear()
    return stubGuidedOpenProvided("usa")
  }
  const questions = buildV2QuestionsWithStubs({ countryLlm })
  const built = buildPipeline({ questionsOverride: questions })
  const s0 = await built.state.load("u_sim")
  s0.currentQId = "q_country"
  await built.state.save("u_sim", s0)

  await built.send("amrika")
  assert.equal(built.peekState()?.currentQId, "q_country")

  await built.send("amrika no really")
  assert.equal(built.peekState()?.currentQId, "q_location")

  const reasks = built.emitted.filter((e) => e.kind === "reask" && e.qId === "q_country")
  assert.equal(reasks.length, 1)
})

test("sim/q-chain-typo: q_location typo → recovery (GuidedOpenJudge)", async () => {
  let locCalls = 0
  const locationLlm: LlmCallFn = async () => {
    locCalls++
    if (locCalls === 1) return stubGuidedOpenUnclear()
    return stubGuidedOpenProvided(["sf"])
  }
  const questions = buildV2QuestionsWithStubs({ locationLlm })
  const built = buildPipeline({ questionsOverride: questions })
  const s0 = await built.state.load("u_sim")
  s0.currentQId = "q_location"
  await built.state.save("u_sim", s0)

  await built.send("sfran maybe?")
  assert.equal(built.peekState()?.currentQId, "q_location")

  await built.send("sf def")
  assert.equal(built.peekState()?.currentQId, "q_resume")

  const reasks = built.emitted.filter((e) => e.kind === "reask" && e.qId === "q_location")
  assert.equal(reasks.length, 1)
})
