#!/usr/bin/env node
/**
 * eval-canary-twoturn — the deployed-handler L3 integration test (the canary receipt's
 * required fixture). Drives the REAL production runClaireTurn end-to-end (one zod@4 SDK
 * instance via sdk.ts → proves the SDK loader RUNS, not just builds) against a fake Firestore
 * + dry-run Sendblue transport + fake matcher. No deploy.
 *
 * Asserts the 4 prod failures from .planning/LIVE-SMOKE-2026-05-29-CANARY-RECEIPT.md are fixed:
 *   turn 1 "done with SWE, only product, full-time" → pa-users.tags: SWE removed +
 *           negativeRoleFunction set + full_time (RC1, RC4-no-additive).
 *   turn 2 "recommend me roles" → a reply is delivered, turn COMPLETES, never hangs (RC2).
 *   turn 3 "what preferences do you have saved" → reply reflects canonical tags (RC3).
 *
 * Mechanism (mirrors eval-process.mjs): esbuild-bundles the PRODUCTION claire-agent (agent.ts
 * + transport.ts) with @openai/agents + zod + @pa/* + firebase-admin EXTERNAL, resolved from
 * a controlled node_modules where @openai/zod point at agent-runtime's zod@4 dist — so the SDK
 * loads as plain ESM .js (no tsx intercepting its TypeScript against zod@3).
 *
 * Run: source ~/.zshrc && nvm use 24 && node apps/eval/thin-claire/eval-canary-twoturn.mjs
 */
import { symlinkSync, existsSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "../../..")
const agentRuntimeNm = join(repoRoot, "packages/agent-runtime/node_modules")
const functionsNm = join(repoRoot, "apps/functions/node_modules")

// ── controlled node_modules (rebuilt clean each run to avoid stale partial symlinks):
//    @openai/zod from agent-runtime (zod@4 dist); @pa/* + @wekruit from source (their built
//    dist; ESM import condition). @pa packages keep their own nested zod@3 (correct for them);
//    only the SDK uses zod@4. ──
const nm = join(here, "node_modules")
rmSync(nm, { recursive: true, force: true })
mkdirSync(nm, { recursive: true })
function link(rel, target) {
  const p = join(nm, rel)
  if (existsSync(p)) return
  try {
    symlinkSync(target, p)
  } catch (e) {
    console.error(`symlink ${rel} → ${target} failed: ${e?.message ?? e}`)
  }
}
// SDK: zod@4 build from agent-runtime (overrides the functions zod@3 for claire-agent's createRequire).
link("@openai", join(agentRuntimeNm, "@openai"))
link("zod", join(agentRuntimeNm, "zod"))
link(".bin", join(agentRuntimeNm, ".bin"))
// Everything else: the functions graph (whole @pa + @wekruit scopes cover all transitive workspace deps).
link("@pa", join(functionsNm, "@pa"))
link("@wekruit", join(functionsNm, "@wekruit"))
link("firebase-admin", join(functionsNm, "firebase-admin"))
link("firebase-functions", join(functionsNm, "firebase-functions"))
link("@google-cloud", join(functionsNm, "@google-cloud"))
link("openai", join(functionsNm, "openai"))

// ── load OpenAI key from repo-root .env ──
const envPath = join(repoRoot, ".env")
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^(PA_OPENAI_AGENT_API_KEY|OPENAI_API_KEY)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
if (!process.env.OPENAI_API_KEY && process.env.PA_OPENAI_AGENT_API_KEY) {
  process.env.OPENAI_API_KEY = process.env.PA_OPENAI_AGENT_API_KEY
}
if (!process.env.OPENAI_API_KEY) {
  console.error("no OPENAI_API_KEY / PA_OPENAI_AGENT_API_KEY")
  process.exit(1)
}

// ── esbuild the production agent.ts + transport.ts into one ESM bundle ──
const claireDir = join(repoRoot, "apps/functions/src/claire-agent")
const bundlePath = join(here, ".eval-canary.bundle.mjs")
{
  const esbuild = await import(join(functionsNm, "esbuild/lib/main.js"))
  await esbuild.build({
    stdin: {
      contents: [
        `export { runClaireTurn } from ${JSON.stringify(join(claireDir, "agent.ts"))}`,
        `export { createSendblueTransport } from ${JSON.stringify(join(claireDir, "transport.ts"))}`,
      ].join("\n"),
      resolveDir: here,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: bundlePath,
    logLevel: "silent",
    // require/__filename shim (mirrors build.mjs) so any bundled CJS dep loads in the ESM bundle.
    banner: {
      js: [
        "import { createRequire as __cr } from 'node:module';",
        "import { fileURLToPath as __fp } from 'node:url';",
        "const require = __cr(import.meta.url);",
        "const __filename = __fp(import.meta.url);",
      ].join("\n"),
    },
    external: [
      "@openai/agents", "@openai/agents-core", "zod", "@pa/*", "@wekruit/*",
      "firebase-admin", "firebase-admin/*", "firebase-functions", "firebase-functions/*",
      "@google-cloud/tasks", "@google-cloud/tasks/*", "openai", "node:*",
    ],
  })
}
const { runClaireTurn, createSendblueTransport } = await import(bundlePath)

// ── fake Firestore: pa-users get/set(merge) + pa-messages query stubs (FirestoreSession) ──
function makeFakeDb(seed = {}) {
  const store = new Map(Object.entries(seed))
  function docRef(col, id) {
    const key = `${col}/${id}`
    return {
      async get() {
        return { exists: store.has(key), id, data: () => store.get(key) }
      },
      async set(data, opts) {
        const prev = opts && opts.merge ? store.get(key) || {} : {}
        store.set(key, { ...prev, ...data })
      },
      async update(data) {
        store.set(key, { ...(store.get(key) || {}), ...data })
      },
    }
  }
  function emptyQuery() {
    const q = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      async get() {
        return { docs: [], empty: true, size: 0, forEach() {} }
      },
    }
    return q
  }
  function colRef(col) {
    return {
      doc: (id) => docRef(col, id),
      where: () => emptyQuery(),
      orderBy: () => emptyQuery(),
      limit: () => emptyQuery(),
      async add(data) {
        const id = `auto_${store.size}`
        store.set(`${col}/${id}`, data)
        return { id }
      },
    }
  }
  return { collection: colRef, _store: store }
}

const FAKE_JOBS = [
  { title: "Senior Product Manager", company: "Stripe", rf: "product_management", jt: "full_time", url: "https://stripe.com/jobs/pm" },
  { title: "Backend Software Engineer", company: "Spate", rf: "software_engineering", jt: "full_time", url: "https://spate.com/jobs/swe" },
  { title: "Product Strategy Lead", company: "Ramp", rf: "product_management", jt: "full_time", url: "https://ramp.com/jobs/ps" },
]
function makeFakeFindMatch(db, uid) {
  return async ({ requestedCount }) => {
    const tags = (await db.collection("pa-users").doc(uid).get()).data()?.tags ?? {}
    const want = new Set(tags.targetRoleFunction ?? [])
    const avoid = new Set(tags.negativeRoleFunction ?? [])
    const wt = new Set(tags.targetJobType ?? [])
    const jobs = FAKE_JOBS.filter(
      (j) => want.has(j.rf) && !avoid.has(j.rf) && (wt.size === 0 || wt.has(j.jt)),
    ).slice(0, requestedCount ?? 2)
    return {
      ok: true,
      recCount: jobs.length,
      jobs: jobs.map((j) => `${j.title} @ ${j.company}\n${j.url}`),
      reason: jobs.length ? null : "no fresh roles fit those constraints",
      snapshotTags: { targetRoleFunction: tags.targetRoleFunction, negativeRoleFunction: [...avoid] },
    }
  }
}

const UID = "canary-uid"
const SID = "canary-session"
const fails = []
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`)
  else {
    console.log(`FAIL  ${name}\n        → ${detail ?? ""}`)
    fails.push(name)
  }
}

async function turn(db, transport, text) {
  transport.recordedEvents.length = 0
  await runClaireTurn(
    { userId: UID, sessionId: SID, text, toE164: "+14243201960", lang: "en" },
    { db, transport, findMatch: makeFakeFindMatch(db, UID), log: () => {} },
  )
  return {
    kinds: transport.recordedEvents.map((e) => e.kind),
    events: transport.recordedEvents.slice(),
  }
}

async function main() {
  const db = makeFakeDb({
    "pa-users/canary-uid": { tags: { targetRoleFunction: ["software_engineering"], targetJobType: ["internship"] } },
  })
  const transport = createSendblueTransport({
    db, toE164: "+14243201960", userId: UID, sessionId: SID, dryRun: true, log: () => {},
  })

  const t1 = await turn(db, transport, "done with pure software engineering — only product strategy / PM, full-time, SF or remote")
  const tags1 = (await db.collection("pa-users").doc(UID).get()).data()?.tags ?? {}
  check("RC1: SWE removed from positive set", !(tags1.targetRoleFunction ?? []).includes("software_engineering"), JSON.stringify(tags1.targetRoleFunction))
  check("RC1: product_management present", (tags1.targetRoleFunction ?? []).includes("product_management"), JSON.stringify(tags1.targetRoleFunction))
  check("RC1: negativeRoleFunction has SWE", (tags1.negativeRoleFunction ?? []).includes("software_engineering"), JSON.stringify(tags1.negativeRoleFunction))
  check("RC1: jobType switched to full_time", (tags1.targetJobType ?? []).includes("full_time") && !(tags1.targetJobType ?? []).includes("internship"), JSON.stringify(tags1.targetJobType))
  check("RC4: turn-1 replied, no 'scratch that' artifact", t1.events.some((e) => e.kind === "text" || e.kind === "tapback") && !t1.events.some((e) => String(e.value ?? "").toLowerCase().includes("scratch that")), t1.kinds.join("→"))

  const t2 = await turn(db, transport, "ok now recommend me some roles")
  check("RC2: recommend turn COMPLETES (no hang)", t2.kinds.includes("text") || t2.kinds.includes("status"), t2.kinds.join("→"))
  check("RC2: a text reply was delivered", t2.kinds.includes("text"), t2.kinds.join("→"))

  const t3 = await turn(db, transport, "what preferences do you have saved for me now?")
  const t3text = t3.events.filter((e) => e.kind === "text").map((e) => String(e.value ?? "")).join(" ").toLowerCase()
  check("RC3: saved-pref reply delivered", t3.kinds.includes("text"), t3.kinds.join("→"))
  // RC3: the summary must reflect the CANONICAL pa-users.tags (product + full-time/locations),
  // not a stale store (the prod bug recited "AI/devtools/fintech, avoiding adtech/crypto").
  // Mentioning "avoiding software engineering" is CORRECT (that's the negativeRoleFunction tag).
  check(
    "RC3: saved-pref reflects canonical tags (product + full-time/locations), not a stale store",
    t3text.includes("product") &&
      (t3text.includes("full") || t3text.includes("remote") || t3text.includes("sf")) &&
      !t3text.includes("devtools") &&
      !t3text.includes("adtech"),
    t3text.slice(0, 180),
  )

  console.log(`\n${fails.length === 0 ? "CANARY TWO-TURN: GREEN ✅ — RC1/RC2/RC3/RC4 fixed end-to-end through real runClaireTurn (zod@4 SDK runs)" : `CANARY TWO-TURN: ${fails.length} FAILED`}`)
  process.exit(fails.length === 0 ? 0 : 1)
}

await main()
