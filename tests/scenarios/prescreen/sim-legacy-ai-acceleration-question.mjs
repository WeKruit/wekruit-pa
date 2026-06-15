#!/usr/bin/env node
/**
 * sim-legacy-ai-acceleration-question.mjs — IN-PROCESS sim of the DEFAULT AI-acceleration question
 * on the LEGACY / DETERMINISTIC-FSM prescreen path (the path the dev demo actually ran).
 *
 * The thin-Claire path already appends the role-tailored "how do you use AI?" question. Real screens,
 * however, hit `deferToLegacy` in mode-selector.ts and run the DETERMINISTIC FSM
 * (packages/pa-orchestrator PreScreenPipeline.runTurn over pa-jobs/{jobId}.prescreenConfig.questions),
 * which historically had NO AI question. This sim proves the LEGACY seam now ALSO asks it.
 *
 * It drives the REAL production modules end-to-end (NO network, NO live LLM):
 *   - withLegacyAiQuestion()-equivalent injection — REUSES the live helpers
 *     legacyAiQuestionConfig / roleFunctionFromJob / shouldSkipAiQuestion (claire-agent/prescreen-ai-question.ts)
 *     exactly as prescreen-session-start.ts does (append LAST after zod parse).
 *   - PreScreenPipeline.runTurn (packages/pa-orchestrator/src/prescreen/pipeline.ts) — the REAL legacy
 *     FSM. We replay candidate replies turn-by-turn and read what Claire ASKS each turn.
 *   - applyPartialUserTags + mergeUserPrescreenSharedAnswers — the SAME writers the legacy finalize seam
 *     (prescreen-turn-handler.ts persistLegacyAiQuestionAnswer) uses, persisting the answer GLOBALLY.
 *
 * The in-tool LLM judge needs the network, so KeywordSetJudge gets a deterministic STUB caller (the
 * runner-prescreen.mjs pattern). This lets us prove the OBSERVABLE legacy candidate experience:
 *   VERIFY-A  the role-tailored AI question IS ASKED in the FSM turn flow, AFTER the config questions, LAST.
 *   VERIFY-B  NON-GATING: run the SAME screen twice (AI answer scored 0.0, then 1.0) → IDENTICAL verdict.
 *   VERIFY-C  ASK-ONCE: the answer persists tags.aiAccelerationUsage + prescreenSharedAnswers.ai_usage,
 *             and a SECOND legacy session for the same candidate SKIPS the AI question.
 *
 * Run: node --import tsx tests/scenarios/prescreen/sim-legacy-ai-acceleration-question.mjs
 */
import {
  PreScreenPipeline,
  InMemoryPreScreenStore,
  emptyPreScreenState,
  parsePrescreenConfig,
  configToStateQuestions,
  KeywordSetJudge,
  applyPartialUserTags,
  mergeUserPrescreenSharedAnswers,
  readUserPrescreenSharedAnswers,
  AI_USAGE_SHARED_KEY,
} from "../../../packages/pa-orchestrator/src/index.ts"
import {
  AI_QUESTION_QID,
  legacyAiQuestionConfig,
  roleFunctionFromJob,
  shouldSkipAiQuestion,
} from "../../../apps/functions/src/claire-agent/prescreen-ai-question.ts"

// ── in-memory Firestore fake (deep-merge to mirror Firestore set({merge:true}) incl. dotted paths) ──
function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (k.includes(".")) {
      const segs = k.split(".")
      let cur = out
      for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i]
        cur[s] = cur[s] && typeof cur[s] === "object" && !Array.isArray(cur[s]) ? { ...cur[s] } : {}
        cur = cur[s]
      }
      cur[segs[segs.length - 1]] = v
      continue
    }
    const cur = out[k]
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v)
    } else out[k] = v
  }
  return out
}
function makeDb(seed = {}) {
  const store = new Map(Object.entries(seed))
  const docRef = (col, id) => ({
    id,
    async get() {
      const path = `${col}/${id}`
      return { exists: store.has(path), id, data: () => store.get(path) }
    },
    async set(data, opts) {
      const path = `${col}/${id}`
      store.set(path, opts?.merge ? deepMerge(store.get(path) ?? {}, data) : { ...data })
    },
    async update(data) {
      const path = `${col}/${id}`
      store.set(path, deepMerge(store.get(path) ?? {}, data))
    },
  })
  return { db: { collection: (col) => ({ doc: (id) => docRef(col, id) }) }, store }
}

let failures = 0
function expect(label, cond) {
  console.log(`   ${cond ? "✅" : "❌ FAIL"} ${label}`)
  if (!cond) failures++
}

/** A deterministic KeywordSetJudge stub caller: returns a fixed score per qId (runner-prescreen pattern). */
function makeStubCaller(qId, scoreByQId) {
  return {
    async score({ keywords }) {
      const s = scoreByQId[qId]
      if (s === undefined) throw new Error(`no stub score for qId=${qId}`)
      // High confidence so the FSM never clarifies; match = the scripted score.
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

/**
 * Build the EFFECTIVE legacy config exactly as prescreen-session-start.ts withLegacyAiQuestion does:
 * parse the raw job config, resolve the ask-once skip with the REAL shouldSkipAiQuestion over the
 * candidate's tags + prescreenSharedAnswers + prior-session scan, and (unless skipped) append the
 * REAL legacyAiQuestionConfig LAST. Returns { cfg, appended }.
 */
async function buildEffectiveLegacyCfg(db, store, uid, job) {
  const cfg = parsePrescreenConfig(job.prescreenConfig)
  // ── ask-once resolution (mirror withLegacyAiQuestion's three signals) ──
  const userSnap = await db.collection("pa-users").doc(uid).get()
  const userTags = userSnap.exists ? (userSnap.data()?.tags ?? null) : null
  const sharedAnswers = await readUserPrescreenSharedAnswers(db, uid, {})
  const aiUsageCarried = Boolean(sharedAnswers[AI_USAGE_SHARED_KEY]?.reply)
  // prior-session scan: any prescreen session that already scored the AI qId.
  let priorScored = false
  for (const [path, data] of store.entries()) {
    if (!path.startsWith("pa-prescreen-sessions/")) continue
    const q = data?.questions
    if (q && typeof q === "object" && q[AI_QUESTION_QID]?.answeredAt) priorScored = true
  }
  const skip = aiUsageCarried || shouldSkipAiQuestion(userTags, priorScored)
  if (skip) return { cfg, appended: false }
  const aiQ = legacyAiQuestionConfig(roleFunctionFromJob(job, job.prescreenConfig))
  return {
    cfg: { ...cfg, questions: [...cfg.questions, aiQ] },
    appended: true,
  }
}

/**
 * Run a full LEGACY screen via the REAL PreScreenPipeline.runTurn. `aiScore` is the stub score the AI
 * question's reply is judged at. Returns the per-turn asked prompts + the final terminal state, and
 * persists the AI answer through the SAME writers the finalize seam uses (when the AI Q was answered).
 */
async function runLegacyScreen(db, store, uid, job, sessionId, { aiScore, gatingScore = 0.9, persistAi = true }) {
  const { cfg, appended } = await buildEffectiveLegacyCfg(db, store, uid, job)
  const psStore = new InMemoryPreScreenStore()

  // Stub scores: every gating config Q aced; the AI Q at the supplied aiScore.
  const scoreByQId = {}
  for (const q of cfg.questions) scoreByQId[q.qId] = q.qId === AI_QUESTION_QID ? aiScore : gatingScore

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
  const pipeline = new PreScreenPipeline({ questions, store: psStore })

  await psStore.save(
    emptyPreScreenState({
      sessionId,
      userId: uid,
      jobId: job.id,
      questions: configToStateQuestions(cfg),
      threshold: cfg.threshold,
      confidenceThreshold: cfg.confidenceThreshold,
      maxClarifyRounds: cfg.maxClarifyRounds,
      nowIso: "2026-06-14T00:00:00.000Z",
    }),
  )

  // The FIRST question text the candidate sees = qOrder[0].prompt (session start emits it; the
  // pipeline does not, so read it directly the way runPreScreenForUser does via firstQText).
  const asked = []
  const seedState = await psStore.load(sessionId)
  asked.push({ qId: seedState.currentQId, prompt: questions[seedState.currentQId].prompt.en })

  // Replay one reply per question. After each runTurn, the NEXT asked prompt is action.toQId (advance)
  // or the same Q (clarify) — we read state.currentQId to track what is asked next.
  const replies = {
    q_core: "I shipped the checkout redesign end-to-end: led the React rewrite, the API contract, and the rollout. Cut p95 latency 40%.",
    q_pm_core: "I owned the activation funnel PRD end-to-end: research, prioritization, the spec, and the launch that lifted D7 retention 12%.",
    [AI_QUESTION_QID]:
      "I drive Cursor + Claude as agents in my build loop — scaffold the failing test first, then impl to green. Shipped a webhook retry queue ~2x faster pairing with the agent on edge cases.",
  }

  let guard = 0
  let last = null
  while (guard++ < 12) {
    const cur = await psStore.load(sessionId)
    if (cur.terminal !== null) break
    const qId = cur.currentQId
    const reply = replies[qId] ?? "Here's a concrete recent example from a project I owned."
    const r = await pipeline.runTurn({
      sessionId,
      reply,
      lang: "en",
      nowIso: `2026-06-14T00:0${guard}:00.000Z`,
      judgeCtx: { userId: uid, turnId: `t_${guard}` },
    })
    last = r
    if (r.action.kind === "advance") {
      asked.push({ qId: r.action.toQId, prompt: questions[r.action.toQId].prompt.en })
    } else if (r.action.kind === "clarify") {
      asked.push({ qId: r.action.qId, prompt: `(clarify) ${r.text}` })
    }
    if (r.action.kind === "terminal") break
  }

  const finalState = await psStore.load(sessionId)

  // Persist the AI answer through the EXACT finalize-seam writers (only when the AI Q was answered).
  const aiQState = finalState.questions[AI_QUESTION_QID]
  if (persistAi && appended && aiQState?.answeredAt) {
    const aiReply = replies[AI_QUESTION_QID]
    const nowIso = "2026-06-14T01:00:00.000Z"
    await mergeUserPrescreenSharedAnswers(
      db,
      uid,
      {
        sharedKey: AI_USAGE_SHARED_KEY,
        reply: aiReply,
        evidenceReplies: [aiReply],
        ...(typeof aiQState.finalS === "number" ? { finalS: aiQState.finalS } : {}),
        sourceSessionId: sessionId,
        sourceJobId: job.id,
        answeredAt: nowIso,
        updatedAt: nowIso,
      },
      { nowIso },
    )
    await applyPartialUserTags(
      db,
      uid,
      { aiAccelerationUsage: { value: aiReply, updatedAt: nowIso } },
      { source: "chat", nowIso: () => nowIso },
    )
  }

  return { cfg, appended, asked, finalState, last }
}

// ── jobs (a SWE screen and a later PM screen for the SAME candidate) ─────────────────────────────────
const SWE_JOB = {
  id: "job_invoko_swe",
  roleFunction: ["software_engineering"],
  prescreenConfig: {
    jobTitle: "Senior Software Engineer",
    company: "Invoko",
    roleFunction: ["software_engineering"],
    questions: [
      {
        qId: "q_core",
        type: "MUST_HAVE",
        weight: 3,
        prompt: { en: "Walk me through a feature you shipped end-to-end.", zh: "讲讲你端到端交付的一个功能。" },
        clarifyPrompt: { en: "Your role, the stack, the outcome.", zh: "你的角色、技术栈、结果。" },
        keywords: [{ keyword: "shipped", hint: "Shipped a real user-facing feature.", weight: 1 }],
      },
    ],
  },
}
const PM_JOB = {
  id: "job_invoko_pm",
  roleFunction: ["product_management"],
  prescreenConfig: {
    jobTitle: "Product Manager",
    company: "Invoko",
    roleFunction: ["product_management"],
    questions: [
      {
        qId: "q_pm_core",
        type: "MUST_HAVE",
        weight: 3,
        prompt: { en: "Tell me about a product you owned end-to-end.", zh: "讲讲你端到端负责的一个产品。" },
        clarifyPrompt: { en: "The problem, your decisions, the outcome.", zh: "问题、你的决策、结果。" },
        keywords: [{ keyword: "owned", hint: "Owned a product end-to-end.", weight: 1 }],
      },
    ],
  },
}

const UID = "cand_legacy_ai_sim"

console.log("══════════════════════════════════════════════════════════════════════")
console.log("VERIFY-A — LEGACY/FSM screen ASKS the role-tailored AI question LAST (SWE job)")
console.log("══════════════════════════════════════════════════════════════════════")
const { db, store } = makeDb({ [`pa-users/${UID}`]: { userId: UID } })

let aiPromptAskedOnLegacy = ""
{
  // Run with the AI answer scored 1.0 (best case) — this is also the PASS-verdict baseline for VERIFY-B.
  const r = await runLegacyScreen(db, store, UID, SWE_JOB, "ps_swe_1", { aiScore: 1.0, persistAi: false })
  expect("legacy injection appended the AI question (skip=false on a fresh candidate)", r.appended === true)
  expect("effective legacy config order = [q_core, q_ai_acceleration] (AI appended LAST)",
    r.cfg.questions.map((q) => q.qId).join(",") === `q_core,${AI_QUESTION_QID}`)

  console.log("\n  ── FSM turn flow (what Claire ASKED each turn) ──")
  for (const a of r.asked) console.log(`  CLAIRE [${a.qId}]: ${a.prompt}`)

  const askedIds = r.asked.map((a) => a.qId)
  expect("Q1 asked is the job's real config question (q_core)", askedIds[0] === "q_core")
  expect("the AI question IS ASKED in the legacy FSM turn flow", askedIds.includes(AI_QUESTION_QID))
  expect("the AI question is asked LAST (after the config question)", askedIds[askedIds.length - 1] === AI_QUESTION_QID)

  const aiTurn = r.asked.find((a) => a.qId === AI_QUESTION_QID)
  aiPromptAskedOnLegacy = aiTurn.prompt
  expect("AI prompt is ENGINEER-tailored (software_engineering map entry)", /engineering work/i.test(aiTurn.prompt))
  expect("AI prompt is open-ended (asks for tools/workflows + a concrete example)",
    /tools and workflows/i.test(aiTurn.prompt) && /example/i.test(aiTurn.prompt))

  console.log(`\n  Final terminal: ${r.finalState.terminal}  score=${r.finalState.score}/${r.finalState.scoreMax}`)
  expect("verdict is PASS with the gating Q aced (baseline for the non-gating check)", r.finalState.terminal === "PASS")
}

console.log("\n══════════════════════════════════════════════════════════════════════")
console.log("VERIFY-B — NON-GATING: SAME screen, AI answer scored 0.0 vs 1.0 → IDENTICAL verdict")
console.log("══════════════════════════════════════════════════════════════════════")
{
  // Fresh candidate per run so the AI question is APPENDED both times (isolate the non-gating property).
  const a = makeDb({ [`pa-users/u_ai0`]: { userId: "u_ai0" } })
  const b = makeDb({ [`pa-users/u_ai1`]: { userId: "u_ai1" } })
  const r0 = await runLegacyScreen(a.db, a.store, "u_ai0", SWE_JOB, "ps_ai0", { aiScore: 0.0, persistAi: false })
  const r1 = await runLegacyScreen(b.db, b.store, "u_ai1", SWE_JOB, "ps_ai1", { aiScore: 1.0, persistAi: false })

  expect("both runs appended the AI question", r0.appended && r1.appended)
  expect("both runs ASKED the AI question (it advanced into the flow regardless of score)",
    r0.asked.some((x) => x.qId === AI_QUESTION_QID) && r1.asked.some((x) => x.qId === AI_QUESTION_QID))

  console.log(`  AI scored 0.0 → terminal=${r0.finalState.terminal}  score=${r0.finalState.score}/${r0.finalState.scoreMax}`)
  console.log(`  AI scored 1.0 → terminal=${r1.finalState.terminal}  score=${r1.finalState.score}/${r1.finalState.scoreMax}`)
  expect("terminal verdict IDENTICAL (AI score does not move PASS/FAIL)", r0.finalState.terminal === r1.finalState.terminal)
  expect("score IDENTICAL (AI contributes 0 to score: weight 0)", r0.finalState.score === r1.finalState.score)
  expect("scoreMax IDENTICAL (AI contributes 0 to scoreMax: weight 0)", r0.finalState.scoreMax === r1.finalState.scoreMax)
  expect("the AI question never HARD_STOPs (GOOD_TO_HAVE type gate threshold 0) even scored 0.0",
    r0.finalState.terminal === "PASS")
}

console.log("\n══════════════════════════════════════════════════════════════════════")
console.log("VERIFY-C — ASK-ONCE: answer persists globally; a SECOND legacy session SKIPS the AI question")
console.log("══════════════════════════════════════════════════════════════════════")
{
  // Re-run session 1 on the main (UID) db WITH persistence so the global store/tag get written.
  const r1 = await runLegacyScreen(db, store, UID, SWE_JOB, "ps_swe_persist", { aiScore: 1.0, persistAi: true })
  expect("session 1 (persisting) asked the AI question", r1.asked.some((x) => x.qId === AI_QUESTION_QID))

  const persistedTag = store.get(`pa-users/${UID}`)?.tags?.aiAccelerationUsage?.value
  const persistedShared = store.get(`pa-users/${UID}`)?.prescreenSharedAnswers?.ai_usage?.reply
  console.log(`\n  PERSISTED tags.aiAccelerationUsage.value = "${(persistedTag ?? "").slice(0, 60)}…"`)
  console.log(`  PERSISTED prescreenSharedAnswers.ai_usage.reply = "${(persistedShared ?? "").slice(0, 60)}…"`)
  expect("answer persisted to tags.aiAccelerationUsage (back-compat skip signal)", Boolean(persistedTag))
  expect("answer persisted to prescreenSharedAnswers.ai_usage (generalized store)", Boolean(persistedShared))

  // SECOND legacy session — DIFFERENT (PM) role, SAME candidate. The AI question must be SKIPPED.
  console.log("\n  ── SECOND legacy session (PM role, same candidate) ──")
  const r2 = await runLegacyScreen(db, store, UID, PM_JOB, "ps_pm_2", { aiScore: 1.0, persistAi: false })
  expect("session 2: ask-once skip → AI question NOT appended", r2.appended === false)
  expect("session 2: effective config has ONLY the PM job's own question",
    r2.cfg.questions.map((q) => q.qId).join(",") === "q_pm_core")
  const askedIds2 = r2.asked.map((a) => a.qId)
  console.log("  Asked:", askedIds2.join(", "))
  expect("session 2: the AI question is NOT re-asked", !askedIds2.includes(AI_QUESTION_QID))
  expect("session 2: the screen still completes (PM gating Q aced → PASS)", r2.finalState.terminal === "PASS")
}

console.log("\n──────────────────────────────────────────────────────────────────────")
if (failures > 0) {
  console.log(`RESULT: ${failures} expectation(s) FAILED`)
  process.exit(1)
}
console.log("RESULT: all expectations passed")
