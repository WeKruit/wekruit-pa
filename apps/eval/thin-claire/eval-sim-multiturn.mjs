#!/usr/bin/env node
/**
 * L5 simulated-user multi-turn eval — a real ≥12-turn conversation driving the PRODUCTION
 * runClaireTurn (real gpt-5.4-nano, full growing context), graded on FINAL environment state
 * (pa-users.tags) + long-context DRIFT (Adam: "context 一长就不够好"):
 *   - reply length stays bounded (no monotonic bloat as context grows)
 *   - no repeated identical opener across turns
 *   - no markdown / no "scratch that," artifact / no AI-disclosure (RC4 voice)
 *   - the durable preference arc resolves correctly after switch → add → remove.
 *
 * Loaded via the shared esbuild-bundle harness (real claire-agent, zod@4, no tsx interception).
 * Run: source ~/.zshrc && nvm use 24 && node apps/eval/thin-claire/eval-sim-multiturn.mjs
 */
import { loadClaireBundle, loadEnv } from "./_claire-bundle.mjs"

loadEnv()
const { runClaireTurn, createSendblueTransport } = await loadClaireBundle()

// faithful fake Firestore: pa-users get/set(merge) + pa-messages query stubs (FirestoreSession)
function makeFakeDb(seed = {}) {
  const store = new Map(Object.entries(seed))
  const docRef = (col, id) => {
    const key = `${col}/${id}`
    return {
      async get() { return { exists: store.has(key), id, data: () => store.get(key) } },
      async set(data, opts) { store.set(key, { ...(opts && opts.merge ? store.get(key) || {} : {}), ...data }) },
      async update(data) { store.set(key, { ...(store.get(key) || {}), ...data }) },
    }
  }
  const emptyQuery = () => { const q = { where: () => q, orderBy: () => q, limit: () => q, async get() { return { docs: [], empty: true, size: 0, forEach() {} } } }; return q }
  const colRef = (col) => ({ doc: (id) => docRef(col, id), where: () => emptyQuery(), orderBy: () => emptyQuery(), limit: () => emptyQuery(), async add(d) { const id = `a${store.size}`; store.set(`${col}/${id}`, d); return { id } } })
  return { collection: colRef, _store: store }
}

const JOBS = [
  { title: "Senior Product Manager", company: "Stripe", rf: "product_management", jt: "full_time", url: "https://stripe.com/pm" },
  { title: "Backend Software Engineer", company: "Spate", rf: "software_engineering", jt: "full_time", url: "https://spate.com/swe" },
  { title: "Product Strategy Lead", company: "Ramp", rf: "product_management", jt: "full_time", url: "https://ramp.com/ps" },
  { title: "Data Analyst", company: "Notion", rf: "data_analysis", jt: "full_time", url: "https://notion.com/da" },
]
const makeFindMatch = (db, uid) => async ({ requestedCount }) => {
  const t = (await db.collection("pa-users").doc(uid).get()).data()?.tags ?? {}
  const want = new Set(t.targetRoleFunction ?? []), avoid = new Set(t.negativeRoleFunction ?? []), wt = new Set(t.targetJobType ?? [])
  const jobs = JOBS.filter((j) => want.has(j.rf) && !avoid.has(j.rf) && (wt.size === 0 || wt.has(j.jt))).slice(0, requestedCount ?? 2)
  return { ok: true, recCount: jobs.length, jobs: jobs.map((j) => `${j.title} @ ${j.company}\n${j.url}`), reason: jobs.length ? null : "no fresh roles fit", snapshotTags: { targetRoleFunction: t.targetRoleFunction, negativeRoleFunction: [...avoid] } }
}

const UID = "sim-uid", SID = "sim-session"
// 12-turn realistic arc: ask → switch (SWE→PM) → recs → saved? → tangent → add data → recs → ack → why? → ok → remove data → final list
const SCRIPT = [
  "hey! can you recommend me some roles?",
  "actually I'm done with pure software engineering — only product strategy / PM now, full-time, in SF or remote",
  "ok now recommend me some roles",
  "what preferences do you have saved for me right now?",
  "wait, what do you actually know about my background?",
  "cool. oh also I'm open to data analysis roles too, add that",
  "recommend me roles again with that",
  "sure",
  "wait why did you pick those ones?",
  "ok cool thanks",
  "hmm actually scrap data analysis, take it back off",
  "ok give me the final list then",
]

const replies = []
async function main() {
  const db = makeFakeDb({ "pa-users/sim-uid": { tags: { targetRoleFunction: ["software_engineering"], targetJobType: ["internship"] } } })
  const transport = createSendblueTransport({ db, toE164: "+14243201960", userId: UID, sessionId: SID, dryRun: true, log: () => {} })
  for (let i = 0; i < SCRIPT.length; i++) {
    transport.recordedEvents.length = 0
    await runClaireTurn({ userId: UID, sessionId: SID, text: SCRIPT[i], toE164: "+14243201960", lang: "en" }, { db, transport, findMatch: makeFindMatch(db, UID), log: () => {} })
    const textOnly = transport.recordedEvents.filter((e) => e.kind === "text").map((e) => String(e.value ?? "")).join(" ").trim()
    const reply = transport.recordedEvents.filter((e) => e.kind === "text" || e.kind === "status").map((e) => String(e.value ?? "")).join(" ").trim()
    const kinds = transport.recordedEvents.map((e) => e.kind)
    const handled = kinds.some((k) => ["text", "status", "tapback", "no_reply"].includes(k))
    const ranFindMatch = kinds.includes("typing") // typing reflex fires only on the slow find_match tool
    replies.push({ turn: i + 1, user: SCRIPT[i], reply, textOnly, kinds, len: textOnly.length, handled, ranFindMatch })
    console.log(`T${i + 1} «${SCRIPT[i].slice(0, 48)}» → [${kinds.join("→")}] ${reply.slice(0, 90).replace(/\n/g, " ")}`)
  }

  const tags = (await db.collection("pa-users").doc(UID).get()).data()?.tags ?? {}
  const fails = []
  const ck = (name, cond, detail) => { if (cond) console.log(`PASS  ${name}`); else { console.log(`FAIL  ${name} → ${detail ?? ""}`); fails.push(name) } }

  console.log(`\nFINAL tags: ${JSON.stringify(tags)}`)
  // FINAL STATE (the arc resolves): SWE removed, PM present, data_analysis added-then-removed, full_time
  ck("final: software_engineering removed", !(tags.targetRoleFunction ?? []).includes("software_engineering"), JSON.stringify(tags.targetRoleFunction))
  ck("final: product_management present", (tags.targetRoleFunction ?? []).includes("product_management"))
  ck("final: data_analysis removed at the end (add→remove arc)", !(tags.targetRoleFunction ?? []).includes("data_analysis"), JSON.stringify(tags.targetRoleFunction))
  ck("final: negativeRoleFunction has software_engineering", (tags.negativeRoleFunction ?? []).includes("software_engineering"))
  ck("final: jobType full_time (internship dropped)", (tags.targetJobType ?? []).includes("full_time") && !(tags.targetJobType ?? []).includes("internship"), JSON.stringify(tags.targetJobType))

  // LONG-CONTEXT DRIFT — measured on TEXT replies only (status bubbles + job-listing URLs excluded).
  const textReplies = replies.filter((r) => r.textOnly.length > 0)
  const convo = textReplies.filter((r) => !r.ranFindMatch) // exclude recs turns (job lists are legitimately long)
  const maxLen = Math.max(...convo.map((r) => r.len))
  ck("drift: conversational reply not bloated (non-recs text <= 320 chars)", maxLen <= 320, `maxLen=${maxLen}`)
  const early = convo.slice(0, 3).reduce((a, r) => a + r.len, 0) / Math.max(1, Math.min(3, convo.length))
  const late = convo.slice(-3).reduce((a, r) => a + r.len, 0) / Math.max(1, Math.min(3, convo.length))
  ck("drift: late replies not >2x early (no context-length bloat)", late <= early * 2 + 40, `early≈${Math.round(early)} late≈${Math.round(late)}`)
  const openers = textReplies.map((r) => r.textOnly.toLowerCase().replace(/[^a-z ]/g, "").trim().split(/\s+/).slice(0, 2).join(" "))
  const maxRepeat = Math.max(...Object.values(openers.reduce((m, o) => ((m[o] = (m[o] || 0) + 1), m), {})))
  ck("drift: no text-reply opener repeated >3x across 12 turns", maxRepeat <= 3, `maxRepeat=${maxRepeat} openers=${JSON.stringify(openers)}`)
  const allText = textReplies.map((r) => r.textOnly.toLowerCase()).join("\n")
  ck("voice: no markdown bullets/bold/links", !/[*_`]|^[\s]*[-•]/m.test(allText), "markdown found")
  ck("voice: no 'scratch that' artifact (RC4)", !allText.includes("scratch that"), "scratch-that found")
  ck("voice: no AI/bot self-disclosure", !/\b(i am an ai|as an ai|language model|i'm a bot)\b/.test(allText), "AI disclosure found")
  // tapback (low-info ack) IS a handled turn — count text/status/tapback/no_reply, not just text.
  const handledCount = replies.filter((r) => r.handled).length
  ck("coverage: every turn handled — text or tapback (no hang over 12 turns)", handledCount === SCRIPT.length, `${handledCount}/${SCRIPT.length} handled`)

  console.log(`\n${fails.length === 0 ? "L5 MULTI-TURN SIM: GREEN ✅ — 12-turn arc, real runClaireTurn, final state correct + no long-context drift" : `L5 MULTI-TURN SIM: ${fails.length} FAILED`}`)
  process.exit(fails.length === 0 ? 0 : 1)
}
await main()
