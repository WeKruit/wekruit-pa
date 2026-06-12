/**
 * stranger-hi-e2e.mjs — Entry-UX S1: a BRAND-NEW stranger texts "hi" through the REAL thin seam
 * (selectClaireMode → runClaireTurn → capturing dryRun transport). Closes the baseline gap noted in
 * .audit/entry-ux-baseline.md "Not drivable today" #1 (no thin stranger-hi harness existed).
 *
 * Production-real gating: PA_ONBOARDING_RAMP_ALL=1 is set below (mirrors prod .env.wekruit-5f89b),
 * so isCanaryUser() is true for the fresh stranger uid exactly as in prod — the cold turn routes to
 * the COLD OFFER-FIRST KICKOFF (mode-selector.ts ~:683 → agent.ts ~:913 deterministic short-circuit).
 * ZERO LLM calls: the golden cold opener is deterministic by design ("must REACH the candidate
 * verbatim"), so this harness needs no API key.
 *
 * GOLDEN-FLOW CONTRACT (task S1): value pitch + least-friction ask; LinkedIn login link prioritized;
 * NO onboarding question wall; ONE atomic bubble (Sendblue ordering guarantee); STOP disclosure;
 * a second "hi" re-offers (offer-first leaves the user COLD — no state poison).
 *
 * Run (from apps/functions, Node 24):
 *   node --import tsx src/claire-agent/__tests__/stranger-hi-e2e.mjs
 */
process.env.PA_ONBOARDING_RAMP_ALL = "1" // prod parity: stranger IS canary in prod

import { PA_COLLECTIONS } from "@pa/core-types"
import { selectClaireMode } from "../mode-selector.js"
import { runClaireTurn } from "../agent.js"
import { createSendblueTransport } from "../transport.js"

const UID = "stranger_s1_uid" // fresh uid — NOT in CANARY_UIDS; ramp env is the prod-real gate
const PHONE = "+19999990042"
const SID = "ses_stranger_s1"

// ── in-memory Firestore (mirrors canonical-loop-e2e.mjs stub) ─────────────────────────────────────
function makeFirestore() {
  const store = new Map()
  const col = (name) => { if (!store.has(name)) store.set(name, new Map()); return store.get(name) }
  let autoId = 0
  const makeQuery = (name, filters) => {
    const run = () => [...col(name).entries()].filter(([, d]) =>
      filters.every(([f, v]) => (f.includes(".") ? f.split(".").reduce((o, k) => o?.[k], d) : d[f]) === v))
    return {
      where(f, _op, v) { return makeQuery(name, [...filters, [f, v]]) },
      orderBy() { return this }, limit() { return this },
      async get() { const r = run(); return { empty: r.length === 0, size: r.length, docs: r.map(([id, d]) => ({ id, exists: true, data: () => d })) } },
    }
  }
  const db = {
    collection(name) {
      return {
        where(f, op, v) { return makeQuery(name, [[f, v]]) },
        orderBy() { return makeQuery(name, []) },
        limit() { return makeQuery(name, []) },
        doc(id) {
          const docId = id ?? `auto_${++autoId}`
          return {
            id: docId,
            async get() { const d = col(name).get(docId); return { id: docId, exists: !!d, data: () => d } },
            async set(data, opts) { const prev = opts?.merge ? (col(name).get(docId) ?? {}) : {}; col(name).set(docId, { ...prev, ...data }); return {} },
            async update(data) { col(name).set(docId, { ...(col(name).get(docId) ?? {}), ...data }); return {} },
            collection(sub) { return db.collection(`${name}/${docId}/${sub}`) },
          }
        },
        async add(data) { const docId = `auto_${++autoId}`; col(name).set(docId, data); return { id: docId } },
        async get() { const docs = [...col(name).entries()].map(([id, d]) => ({ id, exists: true, data: () => d })); return { empty: docs.length === 0, size: docs.length, docs } },
      }
    },
  }
  return { db, col }
}

function seed(col) {
  // STRANGER: bare webhook-provisioned pa-users doc — phone only, NO tags, NO résumé, NO LinkedIn,
  // NO onboarding state. Exactly what resolveInboundUserId leaves for a first-contact sender.
  col(PA_COLLECTIONS.users).set(UID, {
    id: UID, phoneE164: PHONE, createdAt: "2026-06-12T00:00:00.000Z",
  })
  col(PA_COLLECTIONS.sessions).set(SID, {
    id: SID, userId: UID, channel: "imessage", externalChatId: PHONE,
    createdAt: "2026-06-12T00:00:00.000Z", lastMessageAt: "2026-06-12T00:00:00.000Z",
  })
}

async function runTurn(db, text, n) {
  const decision = await selectClaireMode({ db, userId: UID, inboundText: text, log: () => {} })
  const eventId = `evt_s1_${n}`
  const transport = createSendblueTransport({ db, toE164: PHONE, userId: UID, sessionId: SID, inboundEventId: eventId, dryRun: true })
  const result = await runClaireTurn(
    { userId: UID, sessionId: SID, text, toE164: PHONE, inboundEventId: eventId, lang: "en" },
    {
      db, transport, log: () => {}, mode: decision.mode,
      ...(decision.pendingStep ? { pendingStep: decision.pendingStep } : {}),
      ...(decision.currentStep ? { currentStep: decision.currentStep } : {}),
      ...(decision.processStore ? { processStore: decision.processStore } : {}),
      ...(decision.onboardingSlot ? { onboardingSlot: decision.onboardingSlot } : {}),
      ...(decision.awaitingAnswer !== undefined ? { awaitingAnswer: decision.awaitingAnswer } : {}),
      ...(decision.offerFirstKickoff ? { offerFirstKickoff: true } : {}),
      ...(decision.enrichmentInFlight ? { enrichmentInFlight: true } : {}),
    },
  )
  const bubbles = transport.recordedEvents.filter((e) => e.kind === "text").map((e) => e.value)
  return { decision, bubbles, result }
}

const { db, col } = makeFirestore()
seed(col)

const t1 = await runTurn(db, "hi", 1)
const t2 = await runTurn(db, "hi", 2) // re-entry: offer-first must leave the user COLD → re-offer

for (const [label, t] of [["T1 'hi'", t1], ["T2 'hi' again (re-entry)", t2]]) {
  console.log(`\n── ${label} ──  [mode=${t.decision.mode} offerFirstKickoff=${!!t.decision.offerFirstKickoff}]`)
  t.bubbles.forEach((b, i) => console.log(`  bubble${i + 1}: ${b.replace(/\n/g, " ⏎ ")}`))
}

const b1 = t1.bubbles.join("\n").toLowerCase()
const liIdx = b1.indexOf("connect-linkedin?token=")
const cvIdx = b1.indexOf("résumé")
const checks = [
  ["T1 mode-selector picked offer-first kickoff", t1.decision.offerFirstKickoff === true],
  ["T1 exactly ONE atomic bubble (Sendblue ordering guarantee)", t1.bubbles.length === 1],
  ["T1 LinkedIn one-tap login link present (wekruit.com/connect-linkedin?token=…)", /https:\/\/wekruit\.com\/connect-linkedin\?token=/.test(b1)],
  ["T1 LinkedIn offer comes BEFORE the résumé ask (LinkedIn prioritized)", liIdx >= 0 && cvIdx >= 0 && liIdx < cvIdx],
  ["T1 least-friction ask (résumé drop-in-chat offered as alternative)", /drop your résumé right here in the chat/.test(b1)],
  ["T1 value pitch present (matching + pitch to hiring managers)", /matching you/.test(b1) && /hiring managers/.test(b1)],
  ["T1 NO onboarding question wall (no role/location intake question)", !/what kind of role|software engineering, product|where are you based|target_role/.test(b1)],
  ["T1 STOP opt-out disclosure present (first contact)", /reply stop anytime to opt out/.test(b1)],
  ["T1 deterministic delivery (short-circuit, no model turn)", t1.result?.deliveredViaTool === true],
  ["T2 re-entry RE-OFFERS (no state poison — offer fires again, no question wall)", t2.decision.offerFirstKickoff === true && t2.bubbles.length === 1 && /connect-linkedin\?token=/.test(t2.bubbles.join("").toLowerCase())],
]
console.log("\n================ S1 STRANGER-HI (THIN, prod-parity) ================")
let pass = 0
for (const [name, ok] of checks) { console.log(`  ${ok ? "✅" : "❌"} ${name}`); if (ok) pass++ }
console.log(`\nRESULT: ${pass}/${checks.length} S1 golden-flow checks passed`)
process.exit(pass === checks.length ? 0 : 1)
