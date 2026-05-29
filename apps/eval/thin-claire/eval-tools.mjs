#!/usr/bin/env node
/**
 * L3 side-effect eval for WS-tools (matching/tool layer).
 *
 * Drives the PRODUCTION `buildMatchingTools(ctx)` (the real `reduceMatchingPreferences`
 * keystone reducer + the real `applyPartialUserTags` sole writer) against a fake Firestore +
 * fake findMatch. Real `gpt-5.4-nano`, in-process, no deploy.
 *
 * Proves: RC1 (after "done with pure SWE, only product, full-time" → pa-users.tags
 * targetRoleFunction == ["product_management"], negativeRoleFunction has SWE, full_time),
 * RC2 (find_match returns, snapshot SWE-absent, never throws), and schedule dedup.
 *
 * Loaded via the shared esbuild-bundle harness (_claire-bundle.mjs) so the SDK loads as
 * compiled .js on the zod@4 graph — no tsx intercepting @openai/agents-core against zod@3
 * (which sdk.ts's createRequire would hit under a tsx resolve-hook).
 *
 * Run: source ~/.zshrc && nvm use 24 && node apps/eval/thin-claire/eval-tools.mjs
 */
import { loadClaireBundle, loadEnv } from "./_claire-bundle.mjs"

loadEnv()
const { Agent, run, MemorySession, buildMatchingTools } = await loadClaireBundle()

// ════════════ minimal in-memory fake Firestore ════════════
// collection(name).doc(id) → { get(): {exists, data()}, set(data,{merge}) }
// with TOP-LEVEL merge, plus runTransaction(fn) over the same store (schedule).
function makeFakeFirestore() {
  const store = new Map() // `${collection}/${id}` → docData
  const key = (c, id) => `${c}/${id}`
  const docHandle = (c, id) => ({
    get: async () => {
      const data = store.get(key(c, id))
      return { exists: data !== undefined, data: () => data }
    },
    set: async (data, opts) => {
      if (opts?.merge) {
        const prev = store.get(key(c, id)) ?? {}
        store.set(key(c, id), { ...prev, ...data })
      } else {
        store.set(key(c, id), { ...data })
      }
    },
  })
  return {
    _store: store,
    collection: (c) => ({ doc: (id) => docHandle(c, id) }),
    // tx.get/tx.set over the in-memory map. doc.set mutates synchronously
    // (no awaits inside), so the second schedule_interview call observes the
    // first booking and dedups.
    runTransaction: async (fn) => {
      const tx = {
        get: async (ref) => ref.get(),
        set: (ref, data, opts) => {
          void ref.set(data, opts)
        },
      }
      return fn(tx)
    },
  }
}

// ════════════ fake findMatch (RC2) — catalog filtered by post-reducer tags ════
function makeFakeFindMatch(db) {
  const CATALOG = [
    { title: "Senior Product Manager", company: "Stripe", rf: "product_management", jt: "full_time", url: "https://stripe.com/apply/pm" },
    { title: "Backend Software Engineer", company: "Spate", rf: "software_engineering", jt: "full_time", url: "https://spate.com/apply/swe" },
    { title: "Product Strategy Lead", company: "Ramp", rf: "product_management", jt: "full_time", url: "https://ramp.com/apply/ps" },
  ]
  return async ({ userId, requestedCount }) => {
    const snap = await db.collection("pa-users").doc(userId).get()
    const tags = (snap.exists && snap.data()?.tags) || {}
    const want = new Set(tags.targetRoleFunction ?? [])
    const avoid = new Set(tags.negativeRoleFunction ?? [])
    const wantType = new Set(tags.targetJobType ?? [])
    const matched = CATALOG.filter(
      (j) => want.has(j.rf) && !avoid.has(j.rf) && (wantType.size === 0 || wantType.has(j.jt)),
    ).slice(0, requestedCount ?? 3)
    return {
      ok: true,
      recCount: matched.length,
      jobs: matched.map((j) => `${j.title} @ ${j.company}\n${j.url}`),
      reason: matched.length === 0 ? "no fresh roles fit those constraints" : null,
      snapshotTags: {
        targetRoleFunction: tags.targetRoleFunction ?? [],
        negativeRoleFunction: [...avoid],
        targetJobType: tags.targetJobType ?? [],
      },
    }
  }
}

// ════════════ no-op recording transport stub ════════════
function makeTransport() {
  const events = []
  return {
    events,
    async markRead() { events.push("mark_read") },
    async typing() { events.push("typing") },
    async sendStatus(t) { events.push(`status:${t}`) },
    async sendText(t) { events.push(`text:${t}`) },
    async tapback(r) { events.push(`tapback:${r}`) },
    async noReply(r) { events.push(`no_reply:${r}`) },
  }
}

const INSTRUCTIONS = [
  "You are Claire, a warm concise recruiter friend texting a candidate on iMessage.",
  "Persist durable preferences with set_matching_preferences BEFORE matching.",
  "If they say they want ONLY / want to SWITCH TO a kind of role, pass it as onlyRoleFunctions (a REPLACE).",
  "If they say they are DONE WITH / want to AVOID / are NOT interested in a kind of role, pass that role as avoidRoleFunctions.",
  "Map 'product strategy'/'PM'/'product' → product_management; 'software engineering'/'SWE' → software_engineering.",
  "When they ask for roles / recommendations, call find_match and tell them the concrete results (or the reason none fit).",
  "When they want to book/schedule an interview, call schedule_interview.",
  "Keep replies short and human. Don't claim you saved something you didn't.",
].join(" ")

function makeCtx(db) {
  return {
    db,
    userId: "eval-uid",
    sessionId: "eval-session",
    lang: "en",
    transport: makeTransport(),
    judgeModel: "gpt-5.4-nano",
    jobId: "eval-job-123",
    log: () => {},
    nowIso: () => "2026-05-29T00:00:00Z",
    findMatch: makeFakeFindMatch(db),
  }
}

function makeAgent(ctx) {
  return new Agent({
    name: "Claire",
    model: "gpt-5.4-nano",
    instructions: INSTRUCTIONS,
    tools: buildMatchingTools(ctx),
  })
}

function seedUser(db) {
  db.collection("pa-users").doc("eval-uid").set(
    { tags: { targetRoleFunction: ["software_engineering"], targetJobType: ["internship"] } },
    { merge: true },
  )
}

function readTags(db) {
  return db._store.get("pa-users/eval-uid")?.tags ?? {}
}

// best-of-3 for LLM-driven turns; a true design regression fails all 3.
async function bestOf3(label, fn) {
  let lastErr = "no attempt"
  for (let i = 1; i <= 3; i++) {
    try {
      const err = await fn()
      if (!err) {
        console.log(`PASS  ${label}${i > 1 ? ` (attempt ${i})` : ""}`)
        return true
      }
      lastErr = err
    } catch (e) {
      lastErr = `THREW: ${e?.message ?? e}`
    }
    if (i < 3) console.log(`  …retry ${label} (attempt ${i} → ${lastErr})`)
  }
  console.log(`FAIL  ${label}\n        → ${lastErr}`)
  return false
}

async function main() {
  let ok = true

  // ── RC1 — set_matching_preferences drops SWE via the REAL writer ──────────
  ok =
    (await bestOf3(
      "RC1: avoid-SWE→only-PM,full-time → real applyPartialUserTags removes SWE",
      async () => {
        const db = makeFakeFirestore()
        seedUser(db)
        const ctx = makeCtx(db)
        const session = new MemorySession("rc1")
        await run(
          makeAgent(ctx),
          "done with pure software engineering — only product strategy / PM, full-time, SF or remote",
          { session },
        )
        const tags = readTags(db)
        const roles = tags.targetRoleFunction ?? []
        if (roles.includes("software_engineering")) return `SWE not removed: ${JSON.stringify(roles)}`
        if (JSON.stringify(roles) !== JSON.stringify(["product_management"]))
          return `targetRoleFunction != ["product_management"]: ${JSON.stringify(roles)}`
        if (!(tags.negativeRoleFunction ?? []).includes("software_engineering"))
          return `negativeRoleFunction missing SWE: ${JSON.stringify(tags.negativeRoleFunction)}`
        if (JSON.stringify(tags.targetJobType ?? []) !== JSON.stringify(["full_time"]))
          return `targetJobType != ["full_time"]: ${JSON.stringify(tags.targetJobType)}`
        return null
      },
    )) && ok

  // ── RC2 — find_match returns, SWE absent in snapshot, no throw ────────────
  ok =
    (await bestOf3(
      "RC2: recommend roles → find_match recCount>0, SWE absent in snapshot, no throw",
      async () => {
        const db = makeFakeFirestore()
        seedUser(db)
        const ctx = makeCtx(db)
        const session = new MemorySession("rc2")
        await run(
          makeAgent(ctx),
          "done with pure software engineering — only product strategy / PM, full-time, SF or remote",
          { session },
        )
        const tags = readTags(db)
        if ((tags.targetRoleFunction ?? []).includes("software_engineering"))
          return "precondition: SWE still present before find_match"
        let threw = false
        let res
        try {
          res = await run(makeAgent(ctx), "ok now recommend me some roles", { session })
        } catch (e) {
          threw = true
          res = e
        }
        if (threw) return `find_match turn threw: ${res?.message ?? res}`
        const fm = await ctx.findMatch({ userId: "eval-uid", requestedCount: 3 })
        if (!fm.ok) return `findMatch not ok: ${fm.reason}`
        if (fm.recCount <= 0) return `recCount not > 0: ${fm.recCount}`
        if ((fm.snapshotTags?.targetRoleFunction ?? []).includes("software_engineering"))
          return `snapshot still shows SWE: ${JSON.stringify(fm.snapshotTags)}`
        if (fm.jobs.some((j) => /software engineer/i.test(j)))
          return `a SWE job leaked into matches: ${JSON.stringify(fm.jobs)}`
        return null
      },
    )) && ok

  // ── dedup — schedule_interview twice → second deduped (deterministic) ─────
  {
    const db = makeFakeFirestore()
    seedUser(db)
    const ctx = makeCtx(db)
    const tools = buildMatchingTools(ctx)
    const schedule = tools.find((t) => t.name === "schedule_interview")
    let dedupErr = null
    try {
      // tool.invoke(runContext, inputJsonString) → JSON-string of execute()'s
      // return. Our execute ignores runContext, so {} is a safe stand-in.
      const first = await schedule.invoke({}, JSON.stringify({ slotIso: "2026-06-01T17:00:00Z" }))
      const second = await schedule.invoke({}, JSON.stringify({ slotIso: "2026-06-01T17:00:00Z" }))
      const f = typeof first === "string" ? JSON.parse(first) : first
      const s = typeof second === "string" ? JSON.parse(second) : second
      if (f.action !== "committed") dedupErr = `first not committed: ${JSON.stringify(f)}`
      else if (s.action !== "deduped") dedupErr = `second not deduped: ${JSON.stringify(s)}`
    } catch (e) {
      dedupErr = `THREW: ${e?.message ?? e}`
    }
    if (dedupErr) {
      console.log(`FAIL  dedup: schedule_interview twice → second deduped\n        → ${dedupErr}`)
      ok = false
    } else {
      console.log("PASS  dedup: schedule_interview twice → second deduped")
    }
  }

  console.log(`\n${ok ? "WS-TOOLS L3 EVAL: GREEN ✅" : "WS-TOOLS L3 EVAL: RED ❌"}`)
  process.exit(ok ? 0 : 1)
}

await main()
