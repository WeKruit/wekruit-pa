#!/usr/bin/env node
/**
 * sim-claire-prescreen-ownership.mjs — IN-PROCESS simulation of the 2026-06-12 Invoko PM live
 * failure shape (+12026571666 / wQfGZlttRQltMPv4NU6e / hs-10996795-invoko-product-manager),
 * driving the REAL production seam (`runPrescreenTurnIfActive` from prescreen-turn-handler.ts +
 * the REAL `runPrescreenTerminalAction`) against an in-memory Firestore fake — same pattern as
 * prescreen-turn-handler.test.ts. The keyword judge LLM is stubbed (deterministic, no network);
 * everything else is production code.
 *
 * Legs:
 *   A (dev-canary uid — isClaireEntryUxCanary):
 *     A1: late Q1 answer (2h, within 21d)         → Q1 scored, Q2 asked, NO matching offer
 *     A2: "is this for the invoko PM role?"       → yes + continue (state-accurate, not scored)
 *     A3: "is the screening over?"                → "not yet" + pending question
 *   B (legacy non-canary uid):
 *     B1: reply lands on a 22d-stale session      → timeout close, "restart screen" copy,
 *                                                   PAUSE terminal, generateJobRecs NEVER fires
 *     B2: follow-up "ok" after the timeout        → stale restart copy, NO matching offer
 *   C: the context block the thin agent receives for the timed-out screen (what prod-ramped
 *      handoff users' model sees) — must carry the restart directive + no-matching + no-review.
 *
 * Run: node --import tsx tests/scenarios/prescreen/sim-claire-prescreen-ownership.mjs
 */
import { runPrescreenTurnIfActive } from "../../../apps/functions/src/prescreen-turn-handler.ts"
import { runPrescreenTerminalAction } from "../../../apps/functions/src/prescreen-terminal-action.ts"
import { renderPrescreenContextText } from "../../../apps/functions/src/claire-agent/candidate-context.ts"

// ── in-memory Firestore fake (mirrors prescreen-turn-handler.test.ts) ───────────────────────────
function makeFakeDb(seed) {
  const docs = new Map()
  for (const [path, data] of Object.entries(seed)) docs.set(path, { exists: true, data })
  function docRef(collection, id) {
    const path = `${collection}/${id}`
    return {
      id,
      async get() {
        const doc = docs.get(path) ?? { exists: false, data: {} }
        return { exists: doc.exists, data: () => (doc.exists ? doc.data : undefined) }
      },
      async set(data, options) {
        const prev = docs.get(path)
        const merge = Boolean(options?.merge)
        docs.set(path, { exists: true, data: merge ? { ...(prev?.data ?? {}), ...data } : data })
      },
      async update(patch) {
        const prev = docs.get(path) ?? { exists: true, data: {} }
        docs.set(path, { exists: true, data: { ...prev.data, ...patch } })
      },
      collection(subcollection) {
        return {
          async add(data) {
            const childId = `auto_${docs.size + 1}`
            docs.set(`${path}/${subcollection}/${childId}`, { exists: true, data })
            return { id: childId }
          },
          orderBy() {
            return { limit: () => ({ async get() { return { docs: [] } } }) }
          },
        }
      },
    }
  }
  const db = {
    collection(collection) {
      const filters = []
      let limitCount = Number.POSITIVE_INFINITY
      const query = {
        where(field, _op, value) {
          filters.push({ field, value })
          return query
        },
        orderBy() {
          return query
        },
        limit(value) {
          limitCount = value
          return query
        },
        async get() {
          const out = []
          for (const [path, doc] of docs.entries()) {
            if (!path.startsWith(`${collection}/`) || !doc.exists) continue
            if (path.slice(collection.length + 1).includes("/")) continue
            if (filters.every((f) => doc.data[f.field] === f.value)) {
              const id = path.slice(collection.length + 1)
              out.push({ id, data: () => doc.data, ref: docRef(collection, id) })
            }
          }
          return { empty: out.length === 0, docs: out.slice(0, limitCount) }
        },
      }
      return {
        doc(id) {
          return docRef(collection, id)
        },
        where: query.where,
        async add(data) {
          const id = `auto_${docs.size + 1}`
          docs.set(`${collection}/${id}`, { exists: true, data })
          return { id }
        },
      }
    },
  }
  return { db, docs }
}

const INVOKO_CFG = {
  jobTitle: "Product Manager",
  company: "Invoko",
  questions: [
    {
      qId: "q_consumer_product_experience",
      prompt: {
        en: "Tell me about consumer product work you've done - PM, design, or eng role on a real user-facing product. What did you ship and what feedback did it drive?",
        zh: "Tell me about consumer product work you've done - PM, design, or eng role on a real user-facing product. What did you ship and what feedback did it drive?",
      },
      clarifyPrompt: { en: "What did you ship and what feedback did it drive?", zh: "What did you ship and what feedback did it drive?" },
      keywords: [{ keyword: "consumer_product_shipping", weight: 1 }],
    },
    {
      qId: "q_ship_taste",
      prompt: {
        en: "How do you decide what to ship next when you have more ideas than time? Walk me through your prioritization.",
        zh: "How do you decide what to ship next when you have more ideas than time? Walk me through your prioritization.",
      },
      clarifyPrompt: { en: "Give me the smallest slice you shipped and why.", zh: "Give me the smallest slice you shipped and why." },
      keywords: [{ keyword: "prioritization_taste", weight: 1 }],
    },
  ],
}

function invokoSession(userId, sessionId, agoMs) {
  const at = new Date(Date.now() - agoMs).toISOString()
  return {
    sessionId,
    userId,
    jobId: "hs-10996795-invoko-product-manager",
    terminal: null,
    currentQId: "q_consumer_product_experience",
    createdAt: at,
    updatedAt: at,
    score: 0,
    scoreMax: 3,
    threshold: 0.65,
    confidenceThreshold: 0.7,
    maxClarifyRounds: 3,
    qOrder: ["q_consumer_product_experience", "q_ship_taste"],
    questions: {
      q_consumer_product_experience: { qId: "q_consumer_product_experience", type: "MUST_HAVE", weight: 2, matchThreshold: 0.85, clarifyRounds: 0 },
      q_ship_taste: { qId: "q_ship_taste", type: "MUST_HAVE", weight: 1, matchThreshold: 0.85, clarifyRounds: 0 },
    },
    workSession: { kind: "job_prescreen", status: "active", startedAt: at, boundary: "trigger" },
    cfgSnapshot: INVOKO_CFG,
  }
}

const strongJudge = {
  async score({ keywords }) {
    return {
      perKeyword: keywords.map((k) => ({
        keyword: k.keyword,
        match: 0.95,
        confidence: 0.9,
        evidence: "shipped a real user-facing dealership workflow",
        reasoning: "clear shipped consumer product example",
      })),
      summary: "Strong, concrete shipped example.",
      answered: true,
    }
  },
}

const CANARY = "8fEwIduUrzxZsblHHsNz" // entry-UX dev cohort
const LEGACY = "u_legacy_invoko"

let failures = 0
function expect(label, cond) {
  console.log(`   ${cond ? "✅" : "❌ FAIL"} ${label}`)
  if (!cond) failures++
}

function transcriptLine(who, text) {
  console.log(`${who}: ${text}`)
}

async function turn({ db, userId, reply, judge, onTerminalAction }) {
  const sent = []
  const result = await runPrescreenTurnIfActive({
    db,
    userId,
    toE164: "+12026571666",
    replyText: reply,
    ...(judge ? { keywordSetCaller: judge } : {}),
    ...(onTerminalAction ? { runTerminalAction: onTerminalAction } : {}),
    sendSms: async (args) => {
      sent.push(args.content)
      return { status: "queued" }
    },
    log: () => {},
  })
  transcriptLine("  USER  ", reply)
  for (const s of sent) transcriptLine("  CLAIRE", s)
  if (sent.length === 0) transcriptLine("  CLAIRE", `(no deterministic reply — handled=${result.handled}${result.handled ? "" : ", falls through to thin agent"})`)
  return { result, sent }
}

console.log("══════════════════════════════════════════════════════════════════════")
console.log("LEG A — dev-canary user, ACTIVE Invoko PM screen (status ownership)")
console.log("══════════════════════════════════════════════════════════════════════")
{
  const { db, docs } = makeFakeDb({
    [`pa-prescreen-sessions/ps_A`]: invokoSession(CANARY, "ps_A", 2 * 60 * 60 * 1000), // 2h-late Q1 answer
    [`pa-users/${CANARY}`]: { userId: CANARY },
  })

  console.log("\nA1 — late Q1 answer (2h, well within the 21d window):")
  const a1 = await turn({
    db,
    userId: CANARY,
    judge: strongJudge,
    reply:
      "I supported a PoS platform for automotive dealerships, translated business needs into product requirements, worked with engineering through testing, and used post-launch feedback to prioritize workflow changes.",
  })
  expect("Q1 scored + screen advanced to Q2 (currentQId=q_ship_taste)", docs.get("pa-prescreen-sessions/ps_A")?.data.currentQId === "q_ship_taste")
  expect("reply IS the next screen question", /how do you decide what to ship next/i.test(a1.sent[0] ?? ""))
  expect("NO matching offer in the reply", !/jobs|roles|matches|recommend/i.test(a1.sent[0] ?? ""))
  expect("session still active (terminal=null)", (docs.get("pa-prescreen-sessions/ps_A")?.data.terminal ?? null) === null)

  console.log("\nA2 — mid-screen identity question:")
  const a2 = await turn({ db, userId: CANARY, judge: strongJudge, reply: "is this for the invoko PM role?" })
  expect("confirms the REAL role (Product Manager @ Invoko)", /this screen is for Product Manager @ Invoko/.test(a2.sent[0] ?? ""))
  expect("continues the screen (pending Q2 re-asked)", /what to ship next/i.test(a2.sent[0] ?? ""))
  expect("NOT scored as an answer (still on Q2)", docs.get("pa-prescreen-sessions/ps_A")?.data.currentQId === "q_ship_taste")

  console.log("\nA3 — mid-screen 'is the screening over?':")
  const a3 = await turn({ db, userId: CANARY, judge: strongJudge, reply: "is the screening over?" })
  expect("answers 'not yet'", /^not yet/.test(a3.sent[0] ?? ""))
  expect("names the pending question", /what to ship next/i.test(a3.sent[0] ?? ""))
  expect("no review claim", !/review/i.test(a3.sent[0] ?? ""))
  expect("screen still active and on Q2", docs.get("pa-prescreen-sessions/ps_A")?.data.terminal === null && docs.get("pa-prescreen-sessions/ps_A")?.data.currentQId === "q_ship_taste")
}

console.log("\n══════════════════════════════════════════════════════════════════════")
console.log("LEG B — legacy user, 22-day-stale session (forced timeout)")
console.log("══════════════════════════════════════════════════════════════════════")
{
  const { db, docs } = makeFakeDb({
    [`pa-prescreen-sessions/ps_B`]: invokoSession(LEGACY, "ps_B", 22 * 24 * 60 * 60 * 1000), // > 21d
    [`pa-users/${LEGACY}`]: { userId: LEGACY },
  })

  let recsFired = 0
  let piiStarted = 0
  const realTerminalActionWithSpies = (args) =>
    runPrescreenTerminalAction({
      ...args,
      markOutcome: async () => undefined,
      sendSms: async () => undefined,
      startPii: async () => {
        piiStarted++
        return { ok: true, skipped: false }
      },
      generateJobRecs: async () => {
        recsFired++
        return { ok: true, jobCount: 3 }
      },
    })

  console.log("\nB1 — a reply lands on the 22d-stale screen:")
  const b1 = await turn({
    db,
    userId: LEGACY,
    judge: strongJudge,
    reply: "sorry, got busy — here's my answer about the dealership platform",
    onTerminalAction: realTerminalActionWithSpies,
  })
  const sB = docs.get("pa-prescreen-sessions/ps_B")?.data
  expect("session closed as PAUSE", sB?.terminal === "PAUSE")
  expect("terminalReason=expired_inactive_prescreen_session", sB?.terminalReason === "expired_inactive_prescreen_session")
  expect("workSession.boundary=timeout", sB?.workSession?.boundary === "timeout")
  expect("restart copy sent ('reply \"restart screen\"')", /reply "restart screen"/.test(b1.sent[0] ?? ""))
  expect("NO 'under review' claim", !/review/i.test(b1.sent[0] ?? ""))
  expect("REAL terminal action ran with PAUSE and fired ZERO job recs", recsFired === 0)
  expect("no PII chain started off the timeout", piiStarted === 0)

  console.log("\nB2 — follow-up 'ok' right after the timeout:")
  const b2 = await turn({ db, userId: LEGACY, judge: strongJudge, reply: "ok", onTerminalAction: realTerminalActionWithSpies })
  expect("stale follow-up gets the restart path again", /restart screen/.test(b2.sent[0] ?? ""))
  expect("NEVER the matching offer ('I can help find jobs…')", !/help find jobs|meet your expectations|pull roles/i.test(b2.sent[0] ?? ""))
  expect("NEVER an 'under review' claim", !/review/i.test(b2.sent[0] ?? ""))
  expect("job recs still ZERO after the follow-up", recsFired === 0)
}

console.log("\n══════════════════════════════════════════════════════════════════════")
console.log("LEG C — context block the THIN agent gets for the timed-out screen")
console.log("(prod users are handoff-ramped: their post-terminal turns route to the")
console.log(" thin agent, which receives this block via buildCandidateContext)")
console.log("══════════════════════════════════════════════════════════════════════")
{
  const ctx = renderPrescreenContextText(
    [
      {
        sessionId: "ps_B",
        jobId: "hs-10996795-invoko-product-manager",
        jobTitle: "Product Manager",
        company: "Invoko",
        terminal: "PAUSE",
        terminalReason: "expired_inactive_prescreen_session",
        pendingReview: false,
        staleClosed: true,
        retentionStage: null,
        endedAtMs: Date.now(),
      },
    ],
    { profileSignalOnFile: true },
  )
  console.log("\n" + ctx + "\n")
  expect("labels the screen TIMED OUT, not under review", /TIMED OUT/.test(ctx) && /NOT under review/.test(ctx))
  expect("carries the restart directive", /reply 'restart screen'/.test(ctx))
  expect("forbids the matching offer this turn", /Do NOT offer job matching or 'want me to pull roles\?'/.test(ctx))
  expect("forbids the words 'human review'", /Never use the words 'human review'/.test(ctx))
  expect("does NOT render the matching-back-on directive", !/matching is back on the table/.test(ctx))
}

console.log("\n──────────────────────────────────────────────────────────────────────")
if (failures > 0) {
  console.log(`RESULT: ${failures} expectation(s) FAILED`)
  process.exit(1)
}
console.log("RESULT: all expectations passed")
