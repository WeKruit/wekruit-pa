/**
 * post-pitch-flow.mjs — verifies the POST-PITCH flow fixes (Adam 2026-06-04) through the REAL agent
 * (selectClaireMode → runClaireTurn → gpt-5.4-nano → capturing dryRun transport). Seeds an ENRICHED,
 * ONBOARDED candidate (onboardingStatus:complete) WITHOUT location/salary, then drives:
 *
 *   A "i think either works, founding eng / senior; i also led a huge voice infra at tesla"
 *        → profile REFINEMENT: expect NO find_match, NO location/salary question, NO 'connect LinkedIn'.
 *   B "yeah find me some roles"   → explicit ASK: expect the location+salary question (both missing), NO match yet.
 *   C "remote within the US, ~200k" → expect find_match fires.
 *
 * Run (apps/functions, Node 24, OPENAI key exported):
 *   PA_OPENAI_AGENT_API_KEY=… node --import tsx src/claire-agent/__tests__/post-pitch-flow.mjs
 */
import { PA_COLLECTIONS } from "@pa/core-types"
import { selectClaireMode } from "../mode-selector.js"
import { runClaireTurn } from "../agent.js"
import { createSendblueTransport } from "../transport.js"
import { makeV16FindMatch } from "../tools/matching-tools.js"

const UID = "8fEwIduUrzxZsblHHsNz"
const PHONE = "+14243201960"
const SID = "ses_postpitch"

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
        orderBy() { return makeQuery(name, []) }, limit() { return makeQuery(name, []) },
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
  col("pa-feature-flags").set("paThinClaireEnabled", { key: "paThinClaireEnabled", value: false, type: "bool", scope: "perUser", allowlist: [UID], blocklist: [] })
  col(PA_COLLECTIONS.users).set(UID, {
    id: UID, phoneE164: PHONE, displayName: "Adam Yang",
    onboardingState: "complete", onboardingStatus: "complete",
    sharedOnboarding: { status: "complete", completed: true },
    tags: {
      careerStage: "senior", targetRoleFunction: ["software_engineering"],
      recentRoleTitle: "Senior Software Engineer", recentCompany: "Tesla", visaStatus: "citizen",
      skills: [{ name: "TypeScript" }, { name: "Kubernetes" }, { name: "Azure" }],
    },
    experienceHighlights: [{ title: "Senior Software Engineer", company: "Tesla", description: "Backend + infra." }],
  })
  col(PA_COLLECTIONS.sessions).set(SID, { id: SID, userId: UID, channel: "imessage", externalChatId: PHONE, createdAt: "2026-06-04T00:00:00.000Z", lastMessageAt: "2026-06-04T00:00:00.000Z" })
  for (const [i, t] of [["Senior Backend Engineer", "Ramp"], ["Platform Engineer", "Rippling"]].entries()) {
    col("matching-jobs").set(`job_${i}`, {
      jobId: `job_${i}`, status: "active", title: t[0], company: t[1], roleFunction: ["software_engineering"],
      seniorityLevel: "senior", locationBuckets: ["remote_united_states"], jobType: "full_time",
      sponsorship: true, firstSeenAt: "2026-06-03T00:00:00.000Z", dead: false,
      atsApplyUrl: `https://jobs.${t[1].toLowerCase()}.com/${i}`, requiredSkills: ["typescript"],
    })
  }
}

async function runTurn(db, text) {
  const decision = await selectClaireMode({ db, userId: UID, inboundText: text, log: () => {} })
  const eventId = `evt_${Math.abs(hash(text))}`
  const transport = createSendblueTransport({ db, toE164: PHONE, userId: UID, sessionId: SID, inboundEventId: eventId, dryRun: true })
  let findMatchCalled = false
  const findMatch = makeV16FindMatch(db, undefined, undefined)
  const wrapped = async (...a) => { findMatchCalled = true; return findMatch(...a) }
  await runClaireTurn(
    { userId: UID, sessionId: SID, text, toE164: PHONE, inboundEventId: eventId, lang: "en" },
    { db, transport, findMatch: wrapped, log: () => {}, mode: decision.mode,
      ...(decision.pendingStep ? { pendingStep: decision.pendingStep } : {}),
      ...(decision.processStore ? { processStore: decision.processStore } : {}) },
  )
  const bubbles = transport.recordedEvents.filter((e) => e.kind === "text").map((e) => e.value)
  return { bubbles, findMatchCalled, text: bubbles.join(" ⏎ ").toLowerCase() }
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h }
function show(label, r) { console.log(`\n── ${label} ──  [find_match=${r.findMatchCalled}]`); r.bubbles.forEach((b, i) => console.log(`  ${i + 1}: ${b.replace(/\n/g, " ⏎ ").slice(0, 260)}`)) }

const { db, col } = makeFirestore()
seed(col)
const a = await runTurn(db, "i think either works, founding eng / senior and tech lead; i also built a huge voice infra at tesla that takes thousands of calls per day"); show("A refinement", a)
const b = await runTurn(db, "yeah find me some roles"); show("B explicit ask", b)
const c = await runTurn(db, "remote within the US, around 200k"); show("C loc+salary given", c)

const asksLocSalary = (t) => /(where|location|city|metro|remote|based)/.test(t) && /(salary|comp|pay|\$|target|range|\dk)/.test(t)
const asksConnect = (t) => /(connect.*linkedin|paste.*linkedin|upload.*résumé|upload.*resume|weren.t invited|not invited)/.test(t)
const checks = [
  ["A: did NOT find_match on a refinement turn", a.findMatchCalled === false],
  ["A: did NOT ask location/salary on a refinement turn", !asksLocSalary(a.text)],
  ["A: did NOT re-offer connect-LinkedIn / 'not invited'", !asksConnect(a.text)],
  ["A: acknowledged the new info (voice/infra)", /(voice|infra|love|got it|nice|that's|strong)/.test(a.text)],
  ["B: asked location + salary before matching", asksLocSalary(b.text) || c.findMatchCalled],
  ["B/C: never re-offered connect-LinkedIn", !asksConnect(b.text) && !asksConnect(c.text)],
  ["C: find_match fired after loc+salary given", c.findMatchCalled === true || b.findMatchCalled === true],
]
console.log("\n================ POST-PITCH FLOW ================")
let pass = 0
for (const [n, ok] of checks) { console.log(`  ${ok ? "✅" : "❌"} ${n}`); if (ok) pass++ }
console.log(`\nRESULT: ${pass}/${checks.length}`)
process.exit(pass === checks.length ? 0 : 1)
