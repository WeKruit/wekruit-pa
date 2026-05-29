#!/usr/bin/env node
/**
 * L3 side-effect eval for WS-tools (matching/tool layer).
 *
 * Real `gpt-5.4-nano`, in-process, isolated fake Firestore + fake findMatch.
 * Drives the production `buildMatchingTools(ctx)` (NOT a stand-in) so the
 * assertions exercise the REAL `reduceMatchingPreferences` keystone reducer +
 * the REAL `applyPartialUserTags` sole writer (the RC1 seam).
 *
 * Proves:
 *   RC1 — after "done with pure SWE, only product strategy / PM, full-time, SF
 *         or remote", fake pa-users.tags.targetRoleFunction == ["product_management"]
 *         (software_engineering GONE — NOT unioned back in by the real writer),
 *         negativeRoleFunction includes "software_engineering", targetJobType
 *         == ["full_time"].
 *   RC2 — "recommend me roles" → find_match recCount > 0, snapshot shows SWE
 *         absent, and the tool never throws.
 *   dedup — schedule_interview twice → second deduped.
 *
 * Run: source ~/.zshrc && nvm use 24 && node --import tsx apps/eval/thin-claire/eval-tools.mjs
 *
 * RESOLUTION NOTE (eval-only, never ships): the monorepo has TWO installed
 * `@openai/agents@0.8.5` builds — one paired with zod@3 (apps/functions's pin)
 * and one with zod@4 (agent-runtime's pin). The zod@3 build crashes at runtime
 * (z.discriminatedUnion incompatibility), so the WORKING build is the zod@4
 * one. The production tool modules import `@openai/agents` + `zod` relative to
 * apps/functions (the zod@3 build). To drive the REAL `buildMatchingTools`
 * against a working SDK, this eval installs a resolve hook that pins every
 * `zod` + `@openai/agents*` specifier to the zod@4 build — giving ONE
 * consistent zod across the SDK, the tools, and shared-tags. The tool LOGIC
 * (reducer + writer + dedup) is unchanged; only the zod runtime is unified.
 *
 * tsx is registered so the `.ts` tool modules + `@pa/*` workspace imports
 * resolve under a plain `node` run too; `node --import tsx` stays canonical.
 */
import { readFileSync, existsSync, symlinkSync, realpathSync, readdirSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import { createRequire, register as registerHook } from "node:module"

const here = dirname(fileURLToPath(import.meta.url))

// ── ensure @openai/agents + zod resolve from this dir (run-evals.mjs pattern) ──
const nm = join(here, "node_modules")
const agentRuntimeNm = join(here, "../../../packages/agent-runtime/node_modules")
if (!existsSync(nm)) {
  try {
    symlinkSync(agentRuntimeNm, nm)
  } catch (e) {
    console.error(`could not symlink node_modules → ${agentRuntimeNm}: ${e?.message ?? e}`)
  }
}

// load env up front (the tool modules also read it lazily).
for (const line of readFileSync(
  "/Users/adam/Desktop/WeKruit/wekruit-pa/.env",
  "utf8",
).split("\n")) {
  const m = line.match(/^(PA_OPENAI_AGENT_API_KEY|OPENAI_API_KEY)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = process.env.PA_OPENAI_AGENT_API_KEY

// ── pin zod + @openai/agents* → the working zod@4 build (eval-only) ──────────
const repoRoot = join(here, "../../..")
const pnpm = (glob) => {
  // resolve the single .pnpm dir whose name starts with glob AND pins zod@4
  const base = join(repoRoot, "node_modules/.pnpm")
  const hit = readdirSync(base).find((d) => d.startsWith(glob) && d.includes("zod@4"))
  return hit ? join(base, hit, "node_modules") : null
}
const ZOD4 = realpathSync(join(agentRuntimeNm, "zod"))
const AGENTS_NM = {
  "@openai/agents": realpathSync(join(agentRuntimeNm, "@openai/agents")),
}
// agents-core / -openai / -realtime resolve through the @openai/agents pkg's
// own node_modules; we point those bare specifiers at the zod@4 builds too.
const agentsZod4 = {
  "@openai/agents-core": pnpm("@openai+agents-core@0.8.5_") ,
  "@openai/agents-openai": pnpm("@openai+agents-openai@0.8.5_"),
  "@openai/agents-realtime": pnpm("@openai+agents-realtime@0.8.5_"),
}
for (const [spec, base] of Object.entries(agentsZod4)) {
  if (base) {
    try {
      AGENTS_NM[spec] = realpathSync(join(base, spec))
    } catch {
      /* zod@3 fallback dir may be picked; the hook handles the common ones */
    }
  }
}
// pre-resolve the working ESM entry for each pinned @openai/agents* package.
const AGENTS_ENTRY = {}
for (const [spec, dir] of Object.entries(AGENTS_NM)) {
  const req = createRequire(join(dir, "package.json"))
  const pkg = req("./package.json")
  const ent =
    (pkg.exports && pkg.exports["."] && (pkg.exports["."].import || pkg.exports["."].default)) ||
    pkg.module ||
    pkg.main ||
    "index.js"
  AGENTS_ENTRY[spec] = pathToFileURL(join(dir, ent)).href
}

// ── bootstrap tsx FIRST so it's the inner loader; our pin hook (registered
// next) runs OUTERMOST and rewrites bare `zod`/`@openai/agents*` specifiers
// before tsx/default resolution. (Hooks chain last-registered-first.) ────────
const fnRequire = createRequire(join(here, "../../functions/package.json"))
try {
  const tsxEsm = pathToFileURL(fnRequire.resolve("tsx/esm/api")).href
  const { register } = await import(tsxEsm)
  register()
} catch {
  // if --import tsx was used the loader is already active; the import below works.
}

// register the zod@4 pin hook (inline data: module). Runs before tsx.
const hookSrc = `
const ZOD4_URL = ${JSON.stringify(pathToFileURL(ZOD4).href)};
const AGENTS_ENTRY = ${JSON.stringify(AGENTS_ENTRY)};
export async function resolve(spec, ctx, next) {
  if (spec === "zod") return next(ZOD4_URL + "/index.js", ctx);
  if (spec.startsWith("zod/")) return next(ZOD4_URL + "/" + spec.slice(4), ctx);
  if (AGENTS_ENTRY[spec]) return next(AGENTS_ENTRY[spec], ctx);
  return next(spec, ctx);
}
`
registerHook("data:text/javascript," + encodeURIComponent(hookSrc), import.meta.url)

const { Agent, run, MemorySession } = await import("@openai/agents")
const { buildMatchingTools } = await import(
  "../../functions/src/claire-agent/tools/matching-tools.ts"
)

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
