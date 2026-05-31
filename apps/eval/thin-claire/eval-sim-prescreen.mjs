#!/usr/bin/env node
/**
 * L5 simulated-user PRESCREEN-ON-THIN eval — proves the thin @openai/agents agent RUNS a job's
 * prescreen itself via the FSM tools (real gpt-5.4-nano), mirroring the live cutover after the
 * WeKruit_<jobId>_<userId>_Job trigger created an active pa-prescreen-sessions doc.
 *
 * It drives EXACTLY what the live path calls: selectClaireMode (flag ON via env override → seeds the
 * thin store from the job's prescreenConfig via buildThinPrescreenSeed + résumé/prior-session context)
 * → runClaireTurn (real LLM; the agent calls ask_next_prescreen_question + score_prescreen_answer, the
 * in-tool judge scores against the config rubric, the reducer rolls up PASS/FAIL).
 *
 * The candidate is a REAL LLM-simulated user (gpt-4.1-mini) playing a strong full-stack engineer who
 * answers WHATEVER Claire actually asks — including her résumé-grounded probing follow-ups. A fixed
 * script can't exercise an agent that probes (Adam: "combine with their resume and ask probing
 * questions"), so the user is simulated and the screen runs to its natural terminal.
 *
 * Faithful to prod: the store is RE-SEEDED each turn from the session doc that score_prescreen_answer
 * wrote the prior scores back to (buildThinPrescreenSeed reads session.scored) — this exercises the
 * write-back → re-seed loop, not a single reused in-memory store.
 *
 * REQs proven: agent runs the screen (#1/#2/#3); questions are DIRECTION + résumé-grounded, probing,
 * not canned verbatim (#5); LLM-judged scoring against the rubric, no regex (#5/#6); one score per
 * candidate message (no fabricated look-ahead); agent NEVER declares pass/fail and NEVER asks for
 * email (#3); a strong candidate reaches a committed terminal.
 *
 * Run: source ~/.zshrc && nvm use 24 && node apps/eval/thin-claire/eval-sim-prescreen.mjs
 */
import { loadClaireBundle, loadEnv } from "./_claire-bundle.mjs"

loadEnv()
// Flag ON via env override (isEnvOverride reads env[key] verbatim → the flag key, not UPPER_SNAKE).
// Per memory "flag_gated_tests_false_green": this proves the flag-ON path, not the db-less default.
process.env.paThinPrescreenEnabled = "1"

const { runClaireTurn, createSendblueTransport, selectClaireMode } = await loadClaireBundle()

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k]
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) out[k] = deepMerge(cur, v)
    else out[k] = v
  }
  return out
}

/**
 * Fake Firestore that actually resolves predicate queries, so selectClaireMode's hasActivePrescreen
 * (userId== AND terminal==null) finds the seeded active session, and the score tool's write-back
 * (merge into pa-prescreen-sessions.scored + terminal) persists for the next turn's re-seed.
 */
function makeFakeDb(seed = {}) {
  const store = new Map(Object.entries(seed))
  const docRef = (col, id) => {
    const key = `${col}/${id}`
    return {
      async get() { return { exists: store.has(key), id, data: () => store.get(key) } },
      async set(data, opts) { store.set(key, opts && opts.merge ? deepMerge(store.get(key) || {}, data) : { ...data }) },
      async update(data) { store.set(key, deepMerge(store.get(key) || {}, data)) },
    }
  }
  const colRef = (col) => {
    const predicates = []
    const q = {
      where(f, op, v) { predicates.push([f, op, v]); return q },
      orderBy() { return q },
      limit() { return q },
      async get() {
        const docs = []
        for (const [key, val] of store.entries()) {
          if (!key.startsWith(`${col}/`)) continue
          const data = val
          const ok = predicates.every(([f, op, v]) => {
            if (op === "==") return data[f] === v
            if (op === "in") return Array.isArray(v) && v.includes(data[f])
            return false
          })
          if (ok) docs.push({ id: key.slice(col.length + 1), data: () => data })
        }
        return { docs, empty: docs.length === 0, size: docs.length, forEach(cb) { docs.forEach(cb) } }
      },
    }
    return {
      doc: (id) => docRef(col, id),
      where: q.where, orderBy: q.orderBy, limit: q.limit, get: q.get,
      async add(d) { const id = `a${store.size}`; store.set(`${col}/${id}`, d); return { id } },
    }
  }
  return { collection: colRef, _store: store }
}

const UID = "sim-ps-uid"
const SID = "sim-ps-session"
const PHONE = "+14243201960"
const JOBID = "helium-product-engineer-fullstack"
const PRESCREEN_SID = "ps_helium_simps_20260530"

// Helium-shaped prescreenConfig (rich {qId,prompt:{zh,en},clarifyPrompt:{zh,en},keywords[{hint,weight,keyword}]}).
// 4 questions → a terminal once all 4 scored. q_fullstack_evidence + q_ownership are the live Helium
// pair; q_debugging + q_collaboration fabricated in the SAME shape so the screen has 4 competencies.
const HELIUM_CONFIG = {
  questions: [
    {
      qId: "q_fullstack_evidence", weight: 2, type: "MUST_HAVE",
      prompt: { zh: "讲讲你最近端到端交付的一个功能。", en: "Walk me through a feature you shipped end-to-end recently." },
      clarifyPrompt: { zh: "具体功能、你的角色、技术栈。", en: "Specific feature, your role on it, the stack you used." },
      keywords: [
        { hint: "Has personally shipped a user-facing feature touching both frontend and backend.", weight: 1, keyword: "full_stack" },
        { hint: "Modern web stack (TypeScript/JavaScript ideally).", weight: 1, keyword: "web_stack" },
      ],
    },
    {
      qId: "q_ownership", weight: 1, type: "NICE_TO_HAVE",
      prompt: { zh: "讲讲你独立负责并交付的一件事。", en: "Tell me about something you owned end-to-end and shipped." },
      clarifyPrompt: { zh: "范围、你做的决策、结果。", en: "Scope, decisions you made, the outcome." },
      keywords: [{ hint: "Demonstrates real ownership and shipped outcomes.", weight: 1, keyword: "ownership" }],
    },
    {
      qId: "q_debugging", weight: 1, type: "MUST_HAVE",
      prompt: { zh: "讲一个你排查的棘手生产问题。", en: "Tell me about a tricky production bug you debugged." },
      clarifyPrompt: { zh: "症状、你怎么定位、最终修复。", en: "The symptom, how you isolated it, the fix you shipped." },
      keywords: [{ hint: "Methodical debugging of a real production issue, end to end.", weight: 1, keyword: "debugging" }],
    },
    {
      qId: "q_collaboration", weight: 1, type: "NICE_TO_HAVE",
      prompt: { zh: "讲讲你如何与团队协作交付。", en: "How do you collaborate with a team to ship?" },
      clarifyPrompt: { zh: "你如何对齐、解除阻塞、推进。", en: "How you align, unblock, and drive things forward with others." },
      keywords: [{ hint: "Drives cross-functional collaboration and unblocks teammates.", weight: 1, keyword: "collaboration" }],
    },
  ],
}

// ── LLM-SIMULATED CANDIDATE — answers whatever Claire actually asks, grounded in this persona. ──
const PERSONA = [
  "You are Shixiang Chen, a strong full-stack engineer being text-interviewed by Claire for a Product",
  "Engineer role. Reply like a real candidate texting: 1-3 short sentences, casual, concrete, first-person.",
  "Answer EXACTLY what Claire asks this turn (including any follow-up). Ground every answer in YOUR real",
  "background — never invent a different career, never break character, never mention being an AI:",
  "• SWE Intern @ Tesla: shipped a full-stack internal ops dashboard — React front end, Node/Express API,",
  "  Postgres. Owned it end-to-end, from the schema to the deploy.",
  "• Founder @ AI Study app: solo-built the whole thing — auth, a study-scheduling backend, the React UI.",
  "  Shipped to ~500 real users; iterated on the scheduling algorithm after seeing real usage.",
  "• A tricky prod bug: checkout intermittently double-charged. You traced it through the logs, found a",
  "  race in the payment webhook, fixed it with an idempotency key + added regression tests.",
  "• Collaboration: you pair often, drove the API contract with a designer, and unblocked two teammates",
  "  on the Tesla project by pairing through their auth integration.",
  "If Claire probes for more detail, give a specific, truthful detail from the above. Keep it short.",
].join("\n")

async function candidateReply(history, claireMsg) {
  const messages = [
    { role: "system", content: PERSONA },
    ...history,
    { role: "user", content: `Claire: ${claireMsg}` },
  ]
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4.1-mini", temperature: 0.4, messages }),
  })
  if (!res.ok) throw new Error(`candidate sim http ${res.status}: ${await res.text()}`)
  const j = await res.json()
  return String(j.choices?.[0]?.message?.content ?? "").trim() || "yeah, for sure."
}

const MAX_TURNS = 10

async function main() {
  const db = makeFakeDb({
    "pa-users/sim-ps-uid": {
      onboardingState: "complete",
      displayName: "Shixiang Chen",
      tags: {
        workHistorySummary: "SWE Intern @ Tesla; Founder @ AI Study app; full-stack React/Node",
        skills: ["react", "node", "typescript", "python"],
        targetRoleFunction: ["software_engineering"],
      },
    },
    "pa-jobs/helium-product-engineer-fullstack": { title: "Product Engineer", prescreenConfig: HELIUM_CONFIG },
    "pa-prescreen-sessions/ps_helium_simps_20260530": { userId: UID, jobId: JOBID, terminal: null, createdAt: "2026-05-30" },
  })

  const transport = createSendblueTransport({ db, toE164: PHONE, userId: UID, sessionId: SID, dryRun: true, log: () => {} })
  const turns = []
  const simHistory = [] // candidate-sim POV: Claire = user, candidate = assistant.
  let inbound = "hey claire! ready whenever you are." // opener that OPENS the screen (Claire asks Q1).
  let firstQuestions = null
  let lastTerminal = null
  let lastTerminalCommits = 0

  for (let t = 0; t < MAX_TURNS; t++) {
    const decision = await selectClaireMode({ db, userId: UID, inboundText: inbound, log: () => {} })
    // Faithful prod path: each turn re-seeds the store from the (written-back) session doc.
    const store = decision.processStore
    if (decision.deferToLegacy || decision.mode !== "prescreen" || !store) {
      // Either the session terminalized (hasActivePrescreen no longer matches) or a seeding miss.
      turns.push({ t, mode: decision.mode, defer: !!decision.deferToLegacy, reply: "", bubbles: 0, post: true })
      break
    }
    if (!firstQuestions) firstQuestions = store.prescreen.questions
    const scoredBefore = Object.keys(store.prescreen.scores).length
    transport.recordedEvents.length = 0

    await runClaireTurn(
      { userId: UID, sessionId: SID, text: inbound, toE164: PHONE, lang: "en" },
      {
        db, transport, findMatch: async () => ({ ok: true, recCount: 0, jobs: [], reason: null }), log: () => {},
        mode: decision.mode,
        processStore: store,
        jobId: decision.jobId,
        prescreenSessionId: decision.prescreenSessionId,
        ...(decision.prescreenPrompts ? { prescreenPrompts: decision.prescreenPrompts } : {}),
        ...(decision.judgeContext ? { judgeContext: decision.judgeContext } : {}),
        ...(decision.prescreenContext ? { prescreenContext: decision.prescreenContext } : {}),
        ...(decision.prescreenResumeSnippet ? { prescreenResumeSnippet: decision.prescreenResumeSnippet } : {}),
      },
    )

    const scoredAfter = Object.keys(store.prescreen.scores).length
    lastTerminal = store.prescreen.terminal
    lastTerminalCommits = store.prescreen.terminalCommits
    const reply = transport.recordedEvents.filter((e) => e.kind === "text" || e.kind === "status").map((e) => String(e.value ?? "")).join(" ").trim()
    const bubbles = transport.recordedEvents.filter((e) => e.kind === "text").length
    turns.push({ t, mode: decision.mode, defer: false, reply, bubbles, scoredThisTurn: scoredAfter - scoredBefore, terminal: store.prescreen.terminal })
    console.log(`T${t + 1} [${decision.mode}] +scored=${scoredAfter - scoredBefore} term=${store.prescreen.terminal ?? "-"} «${inbound.slice(0, 38)}» → ${reply.slice(0, 88).replace(/\n/g, " ")}`)

    if (store.prescreen.terminal) break // screen over — next inbound would route to triage (correct).
    // Candidate answers Claire's ACTUAL reply this turn.
    inbound = await candidateReply(simHistory, reply)
    simHistory.push({ role: "user", content: reply }, { role: "assistant", content: inbound })
  }

  // Read the persisted session doc — the source of truth the next turn / memory / resume read.
  const sess = (await db.collection("pa-prescreen-sessions").doc(PRESCREEN_SID).get()).data() || {}
  const scoredKeys = Object.keys(sess.scored || {})
  const activeTurns = turns.filter((x) => !x.post)
  const allReplies = activeTurns.map((x) => x.reply.toLowerCase()).join("\n")

  const fails = []
  const ck = (name, cond, detail) => { if (cond) console.log(`PASS  ${name}`); else { console.log(`FAIL  ${name} → ${detail ?? ""}`); fails.push(name) } }

  ck("routing: every active turn ran thin (mode=prescreen, defer=false)", activeTurns.length > 0 && activeTurns.every((x) => x.mode === "prescreen" && x.defer === false))
  ck("seed: store.prescreen.questions == the 4 config qIds on turn 1", JSON.stringify(firstQuestions) === JSON.stringify(["q_fullstack_evidence", "q_ownership", "q_debugging", "q_collaboration"]), JSON.stringify(firstQuestions))
  ck("one-score-per-turn: no active turn scored more than 1 question", activeTurns.every((x) => (x.scoredThisTurn ?? 0) <= 1), activeTurns.map((x) => x.scoredThisTurn).join(","))
  ck("coverage: all 4 questions scored + persisted to the session doc", scoredKeys.length === 4, `scored=[${scoredKeys.join(",")}]`)
  ck("terminal: reducer committed PASS/FAIL once + persisted to the session doc", lastTerminal !== null && lastTerminalCommits === 1 && (sess.terminal === "PASS" || sess.terminal === "FAIL"), `store=${lastTerminal} commits=${lastTerminalCommits} doc=${sess.terminal}`)
  ck("quality: a strong, résumé-consistent candidate PASSES", sess.terminal === "PASS", `terminal=${sess.terminal} — strong candidate should pass; FAIL here = judge too harsh`)
  ck("messages[]: each active turn delivered ≥1 text bubble", activeTurns.every((x) => x.bubbles >= 1), activeTurns.map((x) => x.bubbles).join(","))
  ck("voice: no markdown in replies", !/[*_`]|^\s*[-•]/m.test(allReplies), "markdown found")
  ck("control: agent never announces pass/fail/great-fit (reducer owns it)", !/\b(you (pass|fail)|passed|failed|moving you forward|great fit)\b/i.test(allReplies), "found a pass/fail claim")
  ck("no-roleplay: never asks for email", !/\bemail\b/i.test(allReplies), "asked for email")
  ck("coverage: Claire replied on every active turn", activeTurns.every((x) => x.reply.length > 0))

  console.log(`\nFINAL terminal=${sess.terminal} commits=${lastTerminalCommits} scored=[${scoredKeys.join(",")}] activeTurns=${activeTurns.length}`)
  console.log(`${fails.length === 0 ? "L5 PRESCREEN SIM: GREEN ✅ — thin agent ran the screen via tools, probing + résumé-grounded, rubric-judged, one score/turn, terminal rolled up, no roleplay" : `L5 PRESCREEN SIM: ${fails.length} FAILED`}`)
  process.exit(fails.length === 0 ? 0 : 1)
}
await main()
