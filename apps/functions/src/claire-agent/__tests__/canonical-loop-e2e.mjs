/**
 * canonical-loop-e2e.mjs — END-TO-END walk of the canonical candidate flow through the REAL thin seam
 * (selectClaireMode → runClaireTurn → real gpt-5.4-nano → capturing dryRun transport), one continuous
 * session. Seeds the ENRICHED post-LinkedIn-OAuth state (the OAuth tap itself is un-simulatable; its
 * RESULT — tags + experienceHighlights on pa-users — is what we seed, already proven live). Then drives:
 *
 *   T1 (cv-parsed pitch)        → expect: pitch bubble + the 3-way OFFER (find match? / tweak? / optional résumé)
 *   T2 "find me a match"        → expect: location+salary ASK (gate fires; find_match NOT yet)
 *   T3 "SF, around 180k"        → expect: location+salary written to tags; no re-ask
 *   T4 "ok find me matches now" → expect: find_match fires + delivers the seeded role
 *
 * Run (from apps/functions, Node 24, OPENAI key exported):
 *   PA_OPENAI_AGENT_API_KEY=… OPENAI_API_KEY=… node --import tsx src/claire-agent/__tests__/canonical-loop-e2e.mjs
 */
import { PA_COLLECTIONS } from "@pa/core-types"
import { selectClaireMode } from "../mode-selector.js"
import { runClaireTurn } from "../agent.js"
import { createSendblueTransport } from "../transport.js"
import { makeV16FindMatch } from "../tools/matching-tools.js"

const UID = "8fEwIduUrzxZsblHHsNz" // canary dev phone +14243201960
const PHONE = "+14243201960"
const SID = "ses_canon_e2e"

// ── in-memory Firestore (mirrors pitch-loop.mjs stub) ─────────────────────────────────────────────
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
  // thin flag ON for the canary uid
  col("pa-feature-flags").set("paThinClaireEnabled", { key: "paThinClaireEnabled", value: false, type: "bool", scope: "perUser", allowlist: [UID], blocklist: [] })
  // ENRICHED user (as the LinkedIn-OAuth→Coresignal enrich leaves it) — onboarding complete, rich tags,
  // experienceHighlights, but NO targetLocations and NO minSalary (the canonical gate's trigger).
  col(PA_COLLECTIONS.users).set(UID, {
    id: UID, phoneE164: PHONE, displayName: "Adam Yang",
    onboardingState: "complete", onboardingStatus: "active",
    sharedOnboarding: { status: "complete", completed: true },
    tags: {
      careerStage: "senior", yoeRange: [3, 5],
      targetRoleFunction: ["software_engineering"], industrySector: ["automotive"],
      recentRoleTitle: "Senior Software Engineer", recentCompany: "Tesla", visaStatus: "citizen",
      skills: [{ name: "TypeScript" }, { name: "Kubernetes" }, { name: "Azure" }, { name: "CI/CD" }],
      experienceHighlights: [
        { title: "Senior Software Engineer", company: "Tesla", description: "Built the V&C internal portfolio used by 300+ stores; led an Azure backend migration; CI/CD on Kubernetes/Docker.", durationMonths: 12, companyIndustry: "automotive" },
        { title: "Founder", company: "aiStudy", description: "LLM/RAG knowledge-tracing model, +10% AUC.", durationMonths: 5, companyIndustry: "education" },
      ],
    },
  })
  col(PA_COLLECTIONS.sessions).set(SID, { id: SID, userId: UID, channel: "imessage", externalChatId: PHONE, createdAt: "2026-06-03T00:00:00.000Z", lastMessageAt: "2026-06-03T00:00:00.000Z" })
  // a couple of US software-engineering matching-jobs so find_match can deliver
  for (const [i, t] of [["Senior Backend Engineer", "Ramp"], ["Platform Engineer", "Rippling"]].entries()) {
    col("matching-jobs").set(`job_${i}`, {
      jobId: `job_${i}`, status: "active", title: t[0], company: t[1],
      roleFunction: ["software_engineering"], industrySector: ["financial_technology"],
      seniorityLevel: "senior", locationBuckets: ["san_francisco", "remote"], jobType: "full_time",
      sponsorship: true, firstSeenAt: "2026-06-01T00:00:00.000Z", dead: false,
      atsApplyUrl: `https://jobs.${t[1].toLowerCase()}.com/${i}`, requiredSkills: ["typescript", "kubernetes"],
    })
  }
}

async function runTurn(db, { text, cvParsedTrigger }) {
  const decision = await selectClaireMode({ db, userId: UID, inboundText: text, log: () => {}, cvParsedTrigger: !!cvParsedTrigger })
  const eventId = `evt_${Math.abs(hash(text))}`
  const transport = createSendblueTransport({ db, toE164: PHONE, userId: UID, sessionId: SID, inboundEventId: eventId, dryRun: true })
  let findMatchCalled = false
  const findMatch = makeV16FindMatch(db, undefined, undefined)
  const wrappedFindMatch = async (...a) => { findMatchCalled = true; return findMatch(...a) }
  await runClaireTurn(
    { userId: UID, sessionId: SID, text, toE164: PHONE, inboundEventId: eventId, lang: "en" },
    {
      db, transport, findMatch: wrappedFindMatch, log: () => {}, mode: decision.mode,
      ...(decision.pendingStep ? { pendingStep: decision.pendingStep } : {}),
      ...(decision.currentStep ? { currentStep: decision.currentStep } : {}),
      ...(decision.processStore ? { processStore: decision.processStore } : {}),
      ...(decision.onboardingSlot ? { onboardingSlot: decision.onboardingSlot } : {}),
      ...(decision.awaitingAnswer !== undefined ? { awaitingAnswer: decision.awaitingAnswer } : {}),
      ...(decision.postParsePitch ? { postParsePitch: true } : {}),
      ...(decision.enrichmentInFlight ? { enrichmentInFlight: true } : {}),
      ...(decision.gmailNudge ? { gmailNudge: true } : {}),
      ...(decision.locationSalaryAsk ? { locationSalaryAsk: true } : {}),
    },
  )
  const bubbles = transport.recordedEvents.filter((e) => e.kind === "text").map((e) => e.value)
  return { decision, bubbles, findMatchCalled }
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h }
function show(label, r) { console.log(`\n── ${label} ──  [mode=${r.decision.mode}${r.decision.locationSalaryAsk ? " locationSalaryAsk" : ""}${r.findMatchCalled ? " find_match✓" : ""}]`); r.bubbles.forEach((b, i) => console.log(`  bubble${i + 1}: ${b.replace(/\n/g, " ⏎ ").slice(0, 240)}`)) }

const { db, col } = makeFirestore()
seed(col)
const results = {}

results.t1 = await runTurn(db, { text: "[resume just finished parsing]", cvParsedTrigger: true }); show("T1 pitch", results.t1)
results.t2 = await runTurn(db, { text: "find me a match" }); show("T2 'find me a match'", results.t2)
results.t3 = await runTurn(db, { text: "I'm in SF or remote, targeting around 180k" }); show("T3 location+salary answer", results.t3)
const tagsAfterT3 = col(PA_COLLECTIONS.users).get(UID)?.tags ?? {}
results.t4 = await runTurn(db, { text: "ok find me matches now" }); show("T4 'find me matches now'", results.t4)

// ── assertions ────────────────────────────────────────────────────────────────────────────────
const t1txt = results.t1.bubbles.join(" ").toLowerCase()
const t2txt = results.t2.bubbles.join(" ").toLowerCase()
const checks = [
  ["T1 pitch present (cites Tesla)", /tesla/.test(t1txt)],
  ["T1 OFFER to find a match", /(find|pull|grab).*(match|role|job)|match.*(for you|you)/.test(t1txt)],
  ["T1 mentions optional résumé OR tweak", /(résumé|resume|tweak|improve|add)/.test(t1txt)],
  ["T2 gate fired (locationSalaryAsk)", results.t2.decision.locationSalaryAsk === true],
  ["T2 asks location + salary", /(where|location|city|remote|based)/.test(t2txt) && /(salary|comp|pay|\$|target|range|looking)/.test(t2txt)],
  ["T2 did NOT call find_match", results.t2.findMatchCalled === false],
  ["T3 wrote location to tags", Array.isArray(tagsAfterT3.targetLocations) && tagsAfterT3.targetLocations.length > 0],
  ["T3/T4 location+salary captured (loc or salary on file)", (Array.isArray(tagsAfterT3.targetLocations) && tagsAfterT3.targetLocations.length > 0) || (typeof tagsAfterT3.minSalary === "number" && tagsAfterT3.minSalary > 0)],
  ["T4 find_match fired (gate cleared, no re-ask)", results.t4.findMatchCalled === true && results.t4.decision.locationSalaryAsk !== true],
]
console.log("\n================ CANONICAL LOOP E2E ================")
let pass = 0
for (const [name, ok] of checks) { console.log(`  ${ok ? "✅" : "❌"} ${name}`); if (ok) pass++ }
console.log(`\nRESULT: ${pass}/${checks.length} canonical-flow checks passed`)
console.log("tags after T3:", JSON.stringify({ targetLocations: tagsAfterT3.targetLocations, minSalary: tagsAfterT3.minSalary }))
process.exit(pass === checks.length ? 0 : 1)
