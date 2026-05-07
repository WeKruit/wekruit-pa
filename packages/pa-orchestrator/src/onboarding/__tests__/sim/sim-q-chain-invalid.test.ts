/**
 * Layer 2 sim — invalid-reply re-ask + rotation verification.
 *
 * P7-6 task:
 *   1. Each Q gets 1 nonsense reply → pipeline re-asks → next reply correct
 *      → advances. (basic invalid-then-recovery)
 *   2. Re-ask rotation: ≥3 distinct phrasings used across 3 retries
 *      (DOD #3 — assert no exact-string repeat).
 *
 * "nonsense" differs from "typo" in that the judge returns reason="irrelevant"
 * (regex+LLM say nothing usable) rather than reason="unclear" (LLM understood
 * but flagged ambiguity). For most Qs the pipeline behavior is identical: bump
 * attempt counter, run rephraser, emit re-ask. The HybridRephraser uses
 * variants[attemptNum-1] for the first N attempts; afterward falls back.
 *
 * The rotation assertion specifically uses q_role with 3 nonsense replies
 * back-to-back, then inspects the 3 emitted re-asks. q_role uses
 * HybridRephraser with 4 variants — first 3 attempts MUST yield 3 distinct
 * strings.
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  buildPipeline,
  buildV2QuestionsWithStubs,
  stubExtractEmail,
  stubGuidedOpenProvided,
} from "./_helpers.js"
import type { ExtractIntentFn } from "../../judges/llm-relevance.js"
import type { LlmCallFn } from "../../judges/guided-open.js"

test("sim/q-chain-invalid: q_role nonsense → reask + recover", async () => {
  let roleCalls = 0
  const extractAnswerIntent: ExtractIntentFn = async (step, reply) => {
    if (step !== "ask_q_role") return null
    roleCalls++
    // First call: judge degrades to "irrelevant" because we return null.
    if (roleCalls === 1) return null
    return { intent: "provided", value: "engineer", confidence: 1.0 }
  }
  const questions = buildV2QuestionsWithStubs({ extractAnswerIntent })
  const built = buildPipeline({ questionsOverride: questions, extractAnswerIntent })

  // Pre-seed at q_role.
  const s0 = await built.state.load("u_sim")
  s0.currentQId = "q_role"
  await built.state.save("u_sim", s0)

  // Nonsense reply.
  await built.send("watermelon dance")
  assert.equal(built.peekState()?.currentQId, "q_role", "stays on q_role")
  // Recover.
  await built.send("engineer")
  assert.equal(built.peekState()?.currentQId, "q_yoe", "advances after recovery")

  const reasks = built.emitted.filter((e) => e.kind === "reask" && e.qId === "q_role")
  assert.equal(reasks.length, 1, "exactly one reask")
})

test("sim/q-chain-invalid: re-ask rotation — 3 attempts → 3 DISTINCT phrasings (DOD #3)", async () => {
  // Always return null → judge says irrelevant on every call → pipeline
  // re-asks every turn.
  const extractAnswerIntent: ExtractIntentFn = async () => null
  const questions = buildV2QuestionsWithStubs({ extractAnswerIntent })
  const built = buildPipeline({ questionsOverride: questions, extractAnswerIntent })

  // Pre-seed at q_role.
  const s0 = await built.state.load("u_sim")
  s0.currentQId = "q_role"
  await built.state.save("u_sim", s0)

  // Three nonsense replies → three re-asks emitted (attempt 1, 2, 3).
  await built.send("nonsense one")
  await built.send("nonsense two")
  await built.send("nonsense three")

  const reasks = built.emitted.filter((e) => e.kind === "reask" && e.qId === "q_role")
  assert.equal(reasks.length, 3, "three reasks emitted")

  const distinct = new Set(reasks.map((r) => r.text))
  assert.equal(
    distinct.size,
    3,
    `≥3 distinct phrasings across 3 retries — got ${distinct.size}`
  )

  // Defensive: confirm no exact-string duplicates pairwise.
  for (let i = 0; i < reasks.length; i++) {
    for (let j = i + 1; j < reasks.length; j++) {
      assert.notEqual(
        reasks[i]!.text,
        reasks[j]!.text,
        `re-ask ${i + 1} and ${j + 1} are identical — rotation violated`
      )
    }
  }
})

test("sim/q-chain-invalid: re-ask rotation also holds for q_location (GuidedOpenJudge)", async () => {
  // Always-unclear LLM stub. Bloom regex matches only anywhere/remote, so
  // generic nonsense replies fall through to the LLM and get unclear back.
  const locationLlm: LlmCallFn = async () => JSON.stringify({ intent: "unclear" })
  const questions = buildV2QuestionsWithStubs({ locationLlm })
  const built = buildPipeline({ questionsOverride: questions })

  const s0 = await built.state.load("u_sim")
  s0.currentQId = "q_location"
  await built.state.save("u_sim", s0)

  await built.send("noplace particular")
  await built.send("hmmm")
  await built.send("dunno")

  const reasks = built.emitted.filter(
    (e) => e.kind === "reask" && e.qId === "q_location"
  )
  assert.equal(reasks.length, 3)
  assert.equal(
    new Set(reasks.map((r) => r.text)).size,
    3,
    "3 distinct location re-ask phrasings"
  )
})

test("sim/q-chain-invalid: q_email nonsense → reask + recover (regex hit)", async () => {
  const built = buildPipeline({ extractEmailIntent: stubExtractEmail(null) })
  const s0 = await built.state.load("u_sim")
  s0.currentQId = "q_email"
  await built.state.save("u_sim", s0)

  await built.send("hello there friends") // no @ → regex misses, no LLM signal
  assert.equal(built.peekState()?.currentQId, "q_email")
  await built.send("alex@gmail.com") // regex hits → accept
  assert.equal(built.peekState()?.currentQId, "q_email_verify")

  const reasks = built.emitted.filter((e) => e.kind === "reask" && e.qId === "q_email")
  assert.equal(reasks.length, 1)
})
