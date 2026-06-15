#!/usr/bin/env node
/**
 * sim-legacy-always-ask-on-hardstop.mjs — IN-PROCESS sim of the ALWAYS_ASK fix on the LEGACY /
 * DETERMINISTIC-FSM prescreen path, for the EXACT live-bug scenario (Adam 2026-06-14).
 *
 * THE LIVE BUG: a gating MUST_HAVE question HARD_STOPs (e.g. q_consumer_product_experience s=0.25)
 * BEFORE the queue reaches the trailing AI question, so the FSM finalized the terminal and NEVER asked
 * the AI question — even though Adam wants it asked on EVERY screen regardless of pass/fail.
 *
 * THE FIX: q_ai_acceleration is now type ALWAYS_ASK. When the FSM is about to emit ANY terminal and the
 * ALWAYS_ASK question is still unanswered, the pipeline ASKS it FIRST (stashing the decided verdict),
 * then finalizes the SAME (unchanged) verdict once it is answered.
 *
 * The existing sim (sim-legacy-ai-acceleration-question.mjs) only covers the HAPPY path (gating PASS).
 * This sim proves the bug-class: gating HARD_STOP → AI question STILL asked → verdict UNCHANGED.
 *
 * Drives the REAL production modules end-to-end (NO network, NO live LLM):
 *   - withLegacyAiQuestion()-equivalent injection (legacyAiQuestionConfig / roleFunctionFromJob), exactly
 *     as prescreen-session-start.ts does (append LAST after zod parse).
 *   - PreScreenPipeline.runTurn (packages/pa-orchestrator) — the REAL legacy FSM with the ALWAYS_ASK
 *     deferral. A deterministic KeywordSetJudge STUB caller scripts the per-question scores.
 *
 * Run: node --import tsx tests/scenarios/prescreen/sim-legacy-always-ask-on-hardstop.mjs
 */
import {
  PreScreenPipeline,
  InMemoryPreScreenStore,
  emptyPreScreenState,
  parsePrescreenConfig,
  configToStateQuestions,
  KeywordSetJudge,
} from "../../../packages/pa-orchestrator/src/index.ts"
import {
  AI_QUESTION_QID,
  legacyAiQuestionConfig,
  roleFunctionFromJob,
} from "../../../apps/functions/src/claire-agent/prescreen-ai-question.ts"

let failures = 0
function expect(label, cond) {
  console.log(`   ${cond ? "✅" : "❌ FAIL"} ${label}`)
  if (!cond) failures++
}

/** Deterministic KeywordSetJudge stub: fixed match per qId, high confidence (no clarify churn). */
function makeStubCaller(qId, scoreByQId) {
  return {
    async score({ keywords }) {
      const s = scoreByQId[qId]
      if (s === undefined) throw new Error(`no stub score for qId=${qId}`)
      return {
        perKeyword: keywords.map((k) => ({
          keyword: k.keyword,
          match: s,
          confidence: 0.95,
          evidence: `stub evidence for ${qId}`,
          reasoning: `stub reasoning for ${qId} @ ${s}`,
        })),
        summary: `stub summary ${qId} s=${s}`,
      }
    },
  }
}

// A SWE screen with a gating MUST_HAVE the candidate will FAIL (mirrors the live q_consumer_product_experience).
const SWE_JOB = {
  id: "job_invoko_swe_hardstop",
  roleFunction: ["software_engineering"],
  prescreenConfig: {
    jobTitle: "Senior Software Engineer",
    company: "Invoko",
    roleFunction: ["software_engineering"],
    questions: [
      {
        qId: "q_consumer_product_experience",
        type: "MUST_HAVE",
        weight: 3,
        prompt: { en: "Tell me about consumer product experience you've shipped.", zh: "讲讲你交付过的消费级产品经验。" },
        clarifyPrompt: { en: "The closest example you owned.", zh: "你负责的最接近的例子。" },
        keywords: [{ keyword: "consumer", hint: "Shipped a consumer-facing product.", weight: 1 }],
      },
    ],
  },
}

const UID = "cand_legacy_always_ask"

/** Build the effective legacy config the way prescreen-session-start.ts does (append AI question LAST). */
function buildEffectiveLegacyCfg(job) {
  const cfg = parsePrescreenConfig(job.prescreenConfig)
  const aiQ = legacyAiQuestionConfig(roleFunctionFromJob(job, job.prescreenConfig))
  return { ...cfg, questions: [...cfg.questions, aiQ] }
}

console.log("══════════════════════════════════════════════════════════════════════")
console.log("LIVE BUG SCENARIO — gating MUST_HAVE HARD_STOPs; AI question MUST STILL be asked")
console.log("══════════════════════════════════════════════════════════════════════")

const cfg = buildEffectiveLegacyCfg(SWE_JOB)
expect("effective config order = [q_consumer_product_experience, q_ai_acceleration] (AI appended LAST)",
  cfg.questions.map((q) => q.qId).join(",") === `q_consumer_product_experience,${AI_QUESTION_QID}`)
expect("the appended AI question is type ALWAYS_ASK",
  cfg.questions.find((q) => q.qId === AI_QUESTION_QID)?.type === "ALWAYS_ASK")

// The gating question is scored 0.25 (the live failure) → HARD_STOPs after clarify rounds.
const scoreByQId = { q_consumer_product_experience: 0.25, [AI_QUESTION_QID]: 0.0 }
const questions = {}
for (const q of cfg.questions) {
  questions[q.qId] = {
    qId: q.qId,
    prompt: q.prompt,
    clarifyPrompt: q.clarifyPrompt,
    judge: new KeywordSetJudge({
      questionId: q.qId,
      keywords: q.keywords,
      questionPrompt: q.prompt.en,
      llmCaller: makeStubCaller(q.qId, scoreByQId),
    }),
  }
}
const psStore = new InMemoryPreScreenStore()
const pipeline = new PreScreenPipeline({ questions, store: psStore })
await psStore.save(
  emptyPreScreenState({
    sessionId: "ps_hardstop",
    userId: UID,
    jobId: SWE_JOB.id,
    questions: configToStateQuestions(cfg),
    threshold: cfg.threshold,
    confidenceThreshold: cfg.confidenceThreshold,
    maxClarifyRounds: cfg.maxClarifyRounds,
    nowIso: "2026-06-14T00:00:00.000Z",
  }),
)

const asked = []
const seed = await psStore.load("ps_hardstop")
asked.push(seed.currentQId)

let guard = 0
let last = null
let sawDeferral = false
while (guard++ < 12) {
  const cur = await psStore.load("ps_hardstop")
  if (cur.terminal !== null) break
  const qId = cur.currentQId
  const reply =
    qId === AI_QUESTION_QID
      ? "honestly i barely use AI yet — tried Copilot once."
      : "i mostly did internal tooling, not really consumer-facing."
  const r = await pipeline.runTurn({
    sessionId: "ps_hardstop",
    reply,
    lang: "en",
    nowIso: `2026-06-14T00:0${guard}:00.000Z`,
    judgeCtx: { userId: UID, turnId: `t_${guard}` },
  })
  last = r
  // The deferral turn: advance to the AI question with a stashed terminal.
  if (r.action.kind === "advance" && r.action.toQId === AI_QUESTION_QID && r.state.pendingTerminal) {
    sawDeferral = true
    console.log(`\n  ── DEFERRAL: terminal "${r.state.pendingTerminal.terminal}" stashed; asking AI question first ──`)
    console.log(`  CLAIRE [${AI_QUESTION_QID}]: ${r.text.slice(0, 90)}…`)
  }
  if (r.action.kind === "advance") asked.push(r.action.toQId)
  if (r.action.kind === "terminal") break
}

const finalState = await psStore.load("ps_hardstop")

console.log(`\n  Questions asked across the flow: ${asked.join(", ")}`)
console.log(`  Final terminal: ${finalState.terminal}  (reason: ${finalState.terminalReason})`)

expect("the gating MUST_HAVE was asked first", asked[0] === "q_consumer_product_experience")
expect("the verdict-deciding terminal was DEFERRED to ask the AI question (the fix)", sawDeferral === true)
expect("the AI question WAS ASKED despite the gating HARD_STOP (the live bug is fixed)",
  asked.includes(AI_QUESTION_QID))
expect("the AI question's answer was captured (answeredAt stamped)",
  Boolean(finalState.questions[AI_QUESTION_QID]?.answeredAt))
expect("the final verdict is HARD_STOP — the gating fail is UNCHANGED by asking the AI question",
  finalState.terminal === "HARD_STOP")
expect("the AI answer (weight 0) contributed nothing to score", finalState.score === 0)
expect("the deferral stash was cleared once the verdict finalized", finalState.pendingTerminal === undefined)
expect("the last turn surfaced the terminal", last?.action.kind === "terminal")

console.log("\n──────────────────────────────────────────────────────────────────────")
if (failures > 0) {
  console.log(`RESULT: ${failures} expectation(s) FAILED`)
  process.exit(1)
}
console.log("RESULT: all expectations passed")
