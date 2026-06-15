#!/usr/bin/env node
/**
 * sim-cross-session-shared-answer.mjs — IN-PROCESS 2-session sim of the GENERALIZED
 * cross-session prescreen shared-answer store (SPEC cross-session-prescreen-answer-reuse).
 *
 * VERIFY 1 (build-phase agent): prove the full carry-over contract end-to-end through the
 * REAL production seams (NO network, NO live LLM), for BOTH:
 *
 *   A) the INFORMATIONAL ai_usage question (non-gating) — answered in session 1 for job A,
 *      persisted GLOBALLY to pa-users.prescreenSharedAnswers["ai_usage"] via the SOLE WRITER
 *      mergeUserPrescreenSharedAnswers (the exact lib score_prescreen_answer calls), then in
 *      session 2 for job B it is NOT asked and Claire REFERENCES it naturally (carriedReferences).
 *
 *   B) a GATING shared question — its stored reply is RE-JUDGED against THIS job's rubric (a FRESH
 *      score is produced, NOT the source job's score blind-carried), and that fresh score flows into
 *      the deterministic PASS/FAIL rollup so carry-over actually affects the verdict.
 *
 * Real seams driven:
 *   - mergeUserPrescreenSharedAnswers (sole writer)        → the WRITE path (verbatim, what the tool calls)
 *   - readUserPrescreenSharedAnswers                       → the READ path at session start
 *   - buildThinPrescreenSeed(..., { sharedAnswers, reJudgedScores })  → carry-over + re-judge override
 *   - ask_next_prescreen_question (process-tools.ts)       → proves the candidate is NOT re-asked
 *   - recordPrescreenScore (prescreen-fsm.ts)              → proves the carried gating score gates PASS/FAIL
 *
 * The in-tool LLM judge needs the network, so the RE-JUDGE is supplied by a deterministic stub judge
 * (the same shape mode-selector would wire as carryOver.reJudgedScores for a gating key). This proves
 * the re-judge is a FRESH score against THIS job — not the old one — without a live model call.
 *
 * Run: node --import tsx tests/scenarios/prescreen/sim-cross-session-shared-answer.mjs
 */
import { buildThinPrescreenSeed } from "../../../apps/functions/src/claire-agent/prescreen-config.ts"
import {
  AI_QUESTION_QID,
  roleFunctionFromJob,
  shouldSkipAiQuestion,
} from "../../../apps/functions/src/claire-agent/prescreen-ai-question.ts"
import {
  buildProcessTools,
  emptyProcessStore,
} from "../../../apps/functions/src/claire-agent/tools/process-tools.ts"
import { recordPrescreenScore } from "../../../apps/functions/src/claire-agent/reducers/prescreen-fsm.ts"
import {
  mergeUserPrescreenSharedAnswers,
  readUserPrescreenSharedAnswers,
  AI_USAGE_SHARED_KEY,
} from "../../../packages/pa-orchestrator/src/index.ts"

// ── in-memory Firestore fake. Mirrors Firestore set({merge:true}) deep-merge for plain maps, AND the
// DOTTED-PATH write (`prescreenSharedAnswers.ai_usage`) the sole writer uses (set a nested key). ──────
function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (k.includes(".")) {
      // dotted path → set a nested key without clobbering siblings (Firestore field-path semantics).
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
  })
  return { db: { collection: (col) => ({ doc: (id) => docRef(col, id) }) }, store }
}

let failures = 0
function expect(label, cond) {
  console.log(`   ${cond ? "✅" : "❌ FAIL"} ${label}`)
  if (!cond) failures++
}
async function invokeAsk(toolObj) {
  const r = await toolObj.invoke({}, "{}")
  return typeof r === "string" ? JSON.parse(r) : r
}

const UID = "cand_xsess_sim"

// JOB A (session 1): a SWE screen with a gating core Q + a GATING shared question (sharedKey ai_usage
// on a NON-appended, gating qId q_ai_practice) + the appended informational ai_usage question. Reusing
// the registered `ai_usage` key on a gating question is the spec's "author a test gating sharedKey"
// without polluting the global registry (mirrors prescreen-config.test.ts's q_ai_native pattern).
const JOB_A = {
  id: "job_A_swe",
  roleFunction: ["software_engineering"],
  prescreenConfig: {
    questions: [
      {
        qId: "q_core",
        type: "MUST_HAVE",
        prompt: { en: "Walk me through a feature you shipped end-to-end recently." },
        keywords: [{ hint: "Shipped a real user-facing feature.", weight: 1, keyword: "shipped" }],
      },
      {
        // GATING shared question (carries sharedKey, NOT the appended informational one).
        qId: "q_ai_practice",
        type: "MUST_HAVE",
        sharedKey: "ai_usage",
        prompt: { en: "How concretely do you use AI agents in your build loop?" },
        keywords: [{ hint: "Concrete agentic workflow with a real example.", weight: 1, keyword: "agents" }],
      },
    ],
  },
}

// JOB B (session 2): a DESIGN screen. It ALSO declares a gating q with sharedKey ai_usage (different
// qId) so the stored reply must be RE-JUDGED against THIS (design) job's rubric. Plus its own gating
// core Q. The appended informational ai_usage question must be SKIPPED (already answered).
const JOB_B = {
  id: "job_B_design",
  roleFunction: ["creatives_and_design"],
  prescreenConfig: {
    questions: [
      {
        qId: "q_design_core",
        type: "MUST_HAVE",
        prompt: { en: "Show me a design you owned end-to-end." },
        keywords: [{ hint: "Owned a design end-to-end.", weight: 1, keyword: "owned_design" }],
      },
      {
        qId: "q_ai_in_design", // different qId, SAME sharedKey → must carry + re-judge
        type: "MUST_HAVE",
        sharedKey: "ai_usage",
        prompt: { en: "How do you use AI in your design workflow?" },
        keywords: [{ hint: "AI applied to DESIGN ideation/assets, with an example.", weight: 1, keyword: "ai_design" }],
      },
    ],
  },
}

// Build the cross-session skip decision + carry-over read exactly as mode-selector does.
async function readCarryOver(db, store) {
  const userSnap = await db.collection("pa-users").doc(UID).get()
  const userTags = userSnap.exists ? (userSnap.data()?.tags ?? null) : null
  let priorAi = false
  for (const [path, data] of store.entries()) {
    if (!path.startsWith("pa-prescreen-sessions/")) continue
    const scored = data.scored ?? data.scores
    if (scored && typeof scored === "object" && AI_QUESTION_QID in scored) priorAi = true
  }
  const sharedAnswers = await readUserPrescreenSharedAnswers(db, UID, {})
  const aiUsageCarried = Boolean(sharedAnswers[AI_USAGE_SHARED_KEY]?.reply)
  const append = !aiUsageCarried && !shouldSkipAiQuestion(userTags, priorAi)
  return { sharedAnswers, append }
}

console.log("══════════════════════════════════════════════════════════════════════")
console.log("SESSION 1 — job A (SWE). Candidate answers the GATING + INFORMATIONAL ai_usage questions.")
console.log("══════════════════════════════════════════════════════════════════════")
const { db, store } = makeDb({ [`pa-users/${UID}`]: { userId: UID } })

const AI_ANSWER =
  "I drive Cursor + Claude as agents in my build loop: I have them scaffold the failing test first, " +
  "then write the impl to green, and I review the diff. Last sprint I shipped a webhook retry queue ~2x " +
  "faster by pairing with the agent on the edge cases and letting it generate the backoff table tests."

{
  const { sharedAnswers, append } = await readCarryOver(db, store)
  expect("session 1: nothing carried yet (fresh candidate)", Object.keys(sharedAnswers).length === 0)
  expect("session 1: appends the informational ai_usage question (not yet answered)", append === true)

  const seed = buildThinPrescreenSeed(JOB_A.prescreenConfig, null, "en", {
    append,
    roleFunction: roleFunctionFromJob(JOB_A, JOB_A.prescreenConfig),
  }, { sharedAnswers })

  console.log(`  Seed questionIds: [${seed.questionIds.join(", ")}]`)
  expect(
    "session 1: q_core, q_ai_practice (gating), then appended informational q_ai_acceleration",
    seed.questionIds.join(",") === `q_core,q_ai_practice,${AI_QUESTION_QID}`,
  )
  expect("session 1: gating q_ai_practice carries sharedKey ai_usage", seed.sharedKeys["q_ai_practice"] === "ai_usage")
  expect("session 1: appended question carries sharedKey ai_usage", seed.sharedKeys[AI_QUESTION_QID] === "ai_usage")
  expect("session 1: q_ai_practice NOT informational (gating)", !(seed.prescreen.informational ?? []).includes("q_ai_practice"))
  expect("session 1: appended ai question IS informational", (seed.prescreen.informational ?? []).includes(AI_QUESTION_QID))
  expect("session 1: nothing carried (no stored answers)", seed.carriedQuestionIds.length === 0)

  // Persist the GATING shared answer to the GLOBAL store via the SOLE WRITER (what the score tool does).
  // Source job A's judge scored it 0.85 — stored for provenance only (NOT blind-carried into job B).
  const w = await mergeUserPrescreenSharedAnswers(
    db, UID,
    {
      sharedKey: "ai_usage",
      reply: AI_ANSWER,
      summary: "Uses Cursor+Claude as agents; TDD loop; shipped retry queue 2x faster.",
      finalS: 0.85,
      evidenceReplies: [AI_ANSWER],
      sourceSessionId: "sess_A",
      sourceJobId: JOB_A.id,
      answeredAt: "2026-06-14T00:05:00.000Z",
      updatedAt: "2026-06-14T00:05:00.000Z",
    },
    { nowIso: "2026-06-14T00:05:00.000Z" },
  )
  expect("session 1: shared answer written to global store", w.ok === true && w.sharedKey === "ai_usage")
  console.log(`  USER (ai_usage answer): ${AI_ANSWER.slice(0, 70)}…`)
}

// Inspect the stored doc shape.
const storedDoc = store.get(`pa-users/${UID}`)?.prescreenSharedAnswers?.ai_usage
console.log("\n  STORED pa-users.prescreenSharedAnswers.ai_usage =")
console.log("  " + JSON.stringify(storedDoc, null, 2).split("\n").join("\n  "))
expect("stored doc: sharedKey", storedDoc?.sharedKey === "ai_usage")
expect("stored doc: reply verbatim", storedDoc?.reply === AI_ANSWER)
expect("stored doc: source job A provenance", storedDoc?.sourceJobId === JOB_A.id && storedDoc?.sourceSessionId === "sess_A")
expect("stored doc: source-job finalS kept (provenance only)", storedDoc?.finalS === 0.85)

console.log("\n══════════════════════════════════════════════════════════════════════")
console.log("SESSION 2 — job B (DESIGN). ai_usage carried; gating q_ai_in_design RE-JUDGED vs job B.")
console.log("══════════════════════════════════════════════════════════════════════")
{
  const { sharedAnswers, append } = await readCarryOver(db, store)
  expect("session 2: ai_usage present in the global store", Boolean(sharedAnswers.ai_usage?.reply))
  expect("session 2: appended informational ai_usage question is SKIPPED (already answered)", append === false)

  // DETERMINISTIC STUB JUDGE — re-judge the STORED reply against JOB B's (design) rubric. The stored
  // answer is engineering-flavoured (Cursor/agents/TDD), weak on DESIGN ideation/assets, so job B's
  // design rubric scores it LOWER than the source job A score (0.85). This is the FRESH score — proving
  // we re-judge against THIS job, not blind-carry. (mode-selector wires this same callback for a gating
  // key; the real judge is the in-tool LLM, stubbed here to stay hermetic.)
  function reJudgeAgainstJobB({ rubric, reply }) {
    const designSignals = /design|ideation|asset|mockup|figma/i.test(`${reply} ${rubric}`)
    const replyMentionsDesign = /design|ideation|mockup|asset|figma/i.test(reply)
    // Rubric is about AI-in-DESIGN; the stored reply is about AI-in-ENGINEERING → partial credit.
    return designSignals && replyMentionsDesign ? 0.8 : 0.35
  }

  // Build the seed first to learn the carried qId + its job-B rubric, then compute reJudgedScores and
  // rebuild with the override (mirrors mode-selector computing reJudgedScores before the final seed).
  const probe = buildThinPrescreenSeed(JOB_B.prescreenConfig, null, "en", { append, roleFunction: roleFunctionFromJob(JOB_B, JOB_B.prescreenConfig) }, { sharedAnswers })
  expect("session 2: q_ai_in_design is the carried (pre-answered) question", probe.carriedQuestionIds.includes("q_ai_in_design"))
  const carriedQid = "q_ai_in_design"
  const freshScore = reJudgeAgainstJobB({ rubric: probe.judgeContext[carriedQid], reply: sharedAnswers.ai_usage.reply })
  console.log(`  RE-JUDGE: stored ai_usage reply vs job-B design rubric → fresh score ${freshScore} (source-job score was ${sharedAnswers.ai_usage.finalS})`)
  expect("session 2: re-judged score is FRESH (≠ blind-carried source-job finalS 0.85)", freshScore !== sharedAnswers.ai_usage.finalS)

  const seed = buildThinPrescreenSeed(
    JOB_B.prescreenConfig, null, "en",
    { append, roleFunction: roleFunctionFromJob(JOB_B, JOB_B.prescreenConfig) },
    { sharedAnswers, reJudgedScores: { [carriedQid]: freshScore } },
  )
  console.log(`  Seed questionIds: [${seed.questionIds.join(", ")}]`)
  expect("session 2: appended ai_usage question NOT in the screen (skipped)", !seed.questionIds.includes(AI_QUESTION_QID))
  expect("session 2: carried qid pre-answered (in scores)", carriedQid in seed.prescreen.scores)
  expect(
    "session 2: carried score is the FRESH re-judge, not the source-job 0.85",
    seed.prescreen.scores[carriedQid].score === freshScore,
  )
  expect("session 2: carriedFrom-style reference produced for natural mention", typeof seed.carriedReferences[carriedQid] === "string")
  expect("session 2: reference quotes the prior answer naturally", /Cursor/i.test(seed.carriedReferences[carriedQid]))
  console.log(`  CLAIRE references (instead of re-asking): ${seed.carriedReferences[carriedQid].slice(0, 110)}…`)

  // Drive the REAL ask_next tool: the candidate must NOT be asked the carried gating question.
  const procStore = emptyProcessStore()
  procStore.prescreen = seed.prescreen
  const ctx = {
    db, userId: UID, sessionId: "s2", nowIso: () => "2026-06-20T00:00:00.000Z", log: () => {},
    judgeModel: "gpt-4.1-mini", processStore: procStore,
  }
  const tools = buildProcessTools(ctx, seed.prompts, seed.judgeContext)
  const askNext = tools.find((t) => t.name === "ask_next_prescreen_question")
  const q1 = await invokeAsk(askNext)
  console.log(`  CLAIRE (Q1): ${q1.prompt}`)
  expect("session 2: first asked Q is the design core (NOT the carried ai question)", q1.pending === "q_design_core")

  // Candidate answers the design core question (drive the FSM rollup → prove the CARRIED score gates).
  // Source job A score was 0.85; the re-judge dropped the ai_usage contribution to 0.35. With a weak
  // live design-core answer (0.55), the average including the carried 0.35 must land BELOW threshold.
  const r1 = recordPrescreenScore(procStore.prescreen, "q_design_core", { score: 0.55, evidence: "thin design story" })
  console.log(`  FSM after design core (0.55): pending=${r1.pending} terminal=${r1.terminal}`)
  expect("session 2: no further question pending after design core (carried gating Q already scored)", r1.pending === null)
  // avg of gating {q_design_core:0.55, q_ai_in_design:0.35} = 0.45 < 0.6 → FAIL.
  expect("session 2: carried RE-JUDGED gating score FLOWS INTO the verdict (FAIL on the low re-judge)", r1.terminal === "FAIL")

  // Control: had we BLIND-CARRIED the source-job 0.85, the avg {0.55,0.85}=0.70 ≥ 0.6 would PASS.
  // The fact the verdict is FAIL proves the FRESH re-judge (0.35), not the blind-carry, drove it.
  const blindAvg = (0.55 + 0.85) / 2
  const reJudgeAvg = (0.55 + freshScore) / 2
  console.log(`  PROOF: blind-carry avg=${blindAvg.toFixed(2)} (would PASS) vs re-judge avg=${reJudgeAvg.toFixed(2)} (FAIL). Verdict followed the re-judge.`)
  expect("session 2: verdict matches the RE-JUDGE math, not the blind-carry math", blindAvg >= 0.6 && reJudgeAvg < 0.6 && r1.terminal === "FAIL")
}

console.log("\n══════════════════════════════════════════════════════════════════════")
console.log("REGRESSION — ai_usage ask-once is not broken (the MVP skip still holds).")
console.log("══════════════════════════════════════════════════════════════════════")
{
  // A THIRD plain job with only a core Q + the appended ai question: the appended ai_usage MUST be
  // skipped because the global store carries it (no re-ask across the candidate's lifetime).
  const PLAIN_JOB = {
    id: "job_C",
    roleFunction: ["product_management"],
    prescreenConfig: { questions: [{ qId: "q_pm_core", type: "MUST_HAVE", prompt: { en: "PM core." } }] },
  }
  const { sharedAnswers, append } = await readCarryOver(db, store)
  expect("regression: append stays FALSE (ai_usage carried lifetime-wide)", append === false)
  const seed = buildThinPrescreenSeed(PLAIN_JOB.prescreenConfig, null, "en", { append, roleFunction: PLAIN_JOB.roleFunction }, { sharedAnswers })
  expect("regression: appended ai_usage question NOT asked again", !seed.questionIds.includes(AI_QUESTION_QID))
  expect("regression: only the job's own question remains", seed.questionIds.join(",") === "q_pm_core")
}

console.log("\n──────────────────────────────────────────────────────────────────────")
if (failures > 0) {
  console.log(`RESULT: ${failures} expectation(s) FAILED`)
  process.exit(1)
}
console.log("RESULT: all expectations passed")
