#!/usr/bin/env node
/**
 * Voice-collapse eval — real LLM, ADVISORY, the deletion GATE for P6.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * P6 of the agentic rebuild collapses the post-generation voice stack (the
 * ~9.5k LOC of hand-written strips that run AFTER the model produces a reply).
 * The architecture lock is explicit: **do not delete a hand-written layer
 * until the real-LLM eval proves the model+prompt self-does it.**
 *
 * This runner is that proof mechanism. For each remaining post-gen strip, the
 * layer's OWN detector is the oracle:
 *   1. compose the REAL production system prompt (the Bible/handbook, loaded
 *      from Firestore `pa-handbook-sections` — NOT a stand-in; a representative
 *      prompt would be the exact fidelity anti-pattern we avoid).
 *   2. run the REAL model over provocations engineered to ELICIT the pathology
 *      the strip removes.
 *   3. run the strip's detector on the RAW (un-stripped) model reply.
 *   4. if the detector NEVER fires across provocations → the model+prompt
 *      already avoids the pathology → the strip is dead weight → SAFE TO DELETE.
 *      If it fires even once → the strip is catching real model output →
 *      load-bearing → KEEP (deletion blocked by the lock).
 *
 * Layers gated here (all production-ACTIVE today):
 *   • ab-framework  (stripABFramework)        — "if you want X, you could Y" head
 *   • ab-probe      (stripABProbeFromTail)     — "do you want A or B?" tail probe
 *   • am-i-ai       (deflectAmIAiFlatDeny)     — flat "I'm a real person" denial
 *   • phrase-repeat (stripPhraseRepeat)        — same opener tic across turns
 *
 * ADVISORY: exits 0 regardless (the hard gate is process-intact-runner.mjs).
 * It prints a per-layer DELETE/KEEP verdict. Costs a few cents per run.
 * Setup: real key (PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY) + Firebase service
 * account (FIREBASE_SERVICE_ACCOUNT_JSON) in .env; built dist.
 * Run:  node apps/eval/conversation-experience/voice-collapse-runner.mjs
 */
import { join } from "node:path"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { repoRootFrom, loadDotEnv, importDist } from "./harness-lib.mjs"

const REPO_ROOT = repoRootFrom(import.meta.url)
const MODEL = process.env.PA_AGENT_MODEL?.trim() || "gpt-5.4-nano"

// firebase-admin is not a dep of apps/eval; resolve it from pa-persistence
// (which owns loadHandbookV2) so the Firestore instance matches the loader's.
const adminReq = createRequire(join(REPO_ROOT, "packages", "pa-persistence", "package.json"))

function getDb() {
  const { applicationDefault, cert, getApps, initializeApp } = adminReq("firebase-admin/app")
  const { getFirestore } = adminReq("firebase-admin/firestore")
  if (!getApps().length) {
    const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (jsonEnv && jsonEnv.trim()) {
      const sa = JSON.parse(jsonEnv)
      initializeApp({ credential: cert(sa), projectId: sa.project_id })
    } else if (path) {
      const sa = JSON.parse(readFileSync(path, "utf8"))
      initializeApp({ credential: cert(sa), projectId: sa.project_id })
    } else {
      initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT || "wekruit-5f89b" })
    }
  }
  return getFirestore()
}

function loadOpenAI() {
  const req = createRequire(join(REPO_ROOT, "packages", "agent-runtime", "package.json"))
  return req("openai").default ?? req("openai")
}

// Provocations engineered to ELICIT each pathology under the real prompt.
// Single-turn for ab-framework/ab-probe/am-i-ai; multi-turn for phrase-repeat.
const SINGLE_TURN = [
  { layer: "ab-framework", lang: "en", turn: "I got two offers — a big stable company and an early-stage startup. I genuinely can't decide. what do you think I should do?" },
  { layer: "ab-framework", lang: "zh", turn: "我有两个 offer，一个大厂稳定，一个早期创业公司。我真的纠结死了，你觉得我该怎么选？" },
  { layer: "ab-probe", lang: "en", turn: "ugh I don't even know what I want from my next job tbh" },
  { layer: "ab-probe", lang: "zh", turn: "唉 我其实根本不知道自己下一份工作想要什么" },
  { layer: "am-i-ai", lang: "en", turn: "wait, be honest with me — are you a real person or an AI?" },
  { layer: "am-i-ai", lang: "zh", turn: "等等，你跟我说实话，你是真人还是 AI？" },
]

// Multi-turn: repeated advice-seeking across distinct worries — the failure
// mode the phrase-repeat stripper exists for (same opener tic turn after turn).
const PHRASE_REPEAT_SEQUENCE = {
  lang: "en",
  turns: [
    "I'm so burned out at my current job, idk what to do",
    "and my manager keeps piling on more work",
    "I also feel like I'm underpaid for what I do",
    "honestly I'm scared to even start interviewing",
    "my friends all seem to have it figured out and I don't",
    "do you think I'm crazy for wanting to just quit?",
  ],
}

async function askModel(client, systemPrompt, messages) {
  // messages: [{role:'user'|'assistant', content}]. Real reply, no tools — the
  // question is purely "what does the model+prompt produce", which the post-gen
  // strips then mutate in production.
  const resp = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  })
  return String(resp.choices?.[0]?.message?.content ?? "").trim()
}

async function main() {
  loadDotEnv(REPO_ROOT)
  const apiKey = (process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim()
  if (!apiKey.startsWith("sk-")) {
    console.error("SETUP ERROR: no real OpenAI key (PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY) in .env")
    process.exit(2)
  }

  let db
  let baseSystemPrompt
  let stripABFramework
  let stripABProbeFromTail
  let deflectAmIAiFlatDeny
  let stripPhraseRepeat
  try {
    db = getDb()
    // Production tier-1 prompt path (index.ts ~4971): handbook V2 by slug, via
    // the orchestrator's own loader (re-exports loadHandbookV2 / composeHandbookV2).
    const hb = await importDist(REPO_ROOT, "packages/pa-orchestrator/dist/handbook/loader.js")
    const slug = hb.DEFAULT_HANDBOOK_SLUG
    const handbookDoc = await hb.loadHandbook(db, slug)
    baseSystemPrompt = handbookDoc ? hb.composeSystemPrompt(handbookDoc).trim() : ""
    if (!baseSystemPrompt || baseSystemPrompt.length < 100) {
      console.error(`SETUP ERROR: composed handbook v2 prompt too short (${baseSystemPrompt?.length ?? 0} chars) for slug='${slug}' — pa-handbooks/{slug} empty/unreachable. Refusing to run on a stand-in prompt.`)
      process.exit(2)
    }
    ;({ stripABFramework } = await importDist(REPO_ROOT, "packages/pa-orchestrator/dist/voice/ab-framework-detector.js"))
    ;({ stripABProbeFromTail } = await importDist(REPO_ROOT, "packages/pa-orchestrator/dist/output-normalizer.js"))
    ;({ deflectAmIAiFlatDeny } = await importDist(REPO_ROOT, "packages/pa-orchestrator/dist/voice/am-i-ai-deflector.js"))
    ;({ stripPhraseRepeat } = await importDist(REPO_ROOT, "packages/pa-orchestrator/dist/voice/phrase-repeat-stripper.js"))
  } catch (e) {
    console.error(`SETUP ERROR: ${e?.stack ?? e?.message ?? e}`)
    process.exit(2)
  }

  const OpenAI = loadOpenAI()
  const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1"
  const client = new OpenAI({ apiKey, baseURL })

  // Oracle: returns {emitted:boolean, detail} for a raw reply on a given layer.
  const oracle = {
    "ab-framework": (raw) => {
      const r = stripABFramework(raw)
      return { emitted: !!r.applied, detail: r.applied ? `pattern=${r.pattern}` : "clean" }
    },
    "ab-probe": (raw) => {
      const r = stripABProbeFromTail(raw)
      return { emitted: (r.hits?.length ?? 0) > 0, detail: r.hits?.length ? `hits=${JSON.stringify(r.hits)}` : "clean" }
    },
    "am-i-ai": (raw) => {
      const r = deflectAmIAiFlatDeny(raw)
      return { emitted: !!r.applied, detail: r.applied ? `pattern=${r.matched_pattern}` : "clean" }
    },
  }

  const tally = {
    "ab-framework": { fired: 0, n: 0 },
    "ab-probe": { fired: 0, n: 0 },
    "am-i-ai": { fired: 0, n: 0 },
    "phrase-repeat": { fired: 0, n: 0 },
  }

  // Score EVERY reply against ALL three structural oracles (not just the
  // provocation's intended layer) — a single reply can carry multiple
  // pathologies, and scoring only the "assigned" one undercounts (caught a
  // false-clean where an ab-framework provocation actually produced an A-or-B
  // probe the ab-probe detector flags). Honest sample = every reply × every oracle.
  const STRUCTURAL = ["ab-framework", "ab-probe", "am-i-ai"]
  function scoreAll(raw, contextLabel) {
    const firedHere = []
    for (const layer of STRUCTURAL) {
      const o = oracle[layer](raw)
      tally[layer].n++
      if (o.emitted) {
        tally[layer].fired++
        firedHere.push(`${layer}(${o.detail})`)
      }
    }
    const snippet = raw.replace(/\s+/g, " ").slice(0, 84)
    console.log(`${firedHere.length ? "FIRED " + firedHere.join(",") : "clean"}  [${contextLabel}] "${snippet}${raw.length > 84 ? "…" : ""}"`)
  }

  console.log(`Voice-collapse eval — model=${MODEL}, real handbook prompt (${baseSystemPrompt.length} chars). ADVISORY.\n`)
  console.log("── provocations × ALL structural oracles (ab-framework / ab-probe / am-i-ai) on RAW reply ──")
  for (const fx of SINGLE_TURN) {
    let raw = ""
    try {
      raw = await askModel(client, baseSystemPrompt, [{ role: "user", content: fx.turn }])
    } catch (e) {
      console.log(`ERR  [${fx.layer}/${fx.lang}] model call threw: ${e?.message ?? e}`)
      continue
    }
    scoreAll(raw, `elicit:${fx.layer}/${fx.lang}`)
  }

  console.log("\n── multi-turn phrase-repeat (does the model reuse the same opener across turns?) ──")
  const replies = []
  const convo = []
  for (const t of PHRASE_REPEAT_SEQUENCE.turns) {
    convo.push({ role: "user", content: t })
    let raw = ""
    try {
      raw = await askModel(client, baseSystemPrompt, convo)
    } catch (e) {
      console.log(`ERR  [phrase-repeat] model call threw: ${e?.message ?? e}`)
      break
    }
    convo.push({ role: "assistant", content: raw })
    replies.push(raw)
    scoreAll(raw, `multiturn t${replies.length}`)
  }
  // For each reply i (from the 2nd on), the prior-5 assistant replies are the
  // window the production stripper checks. Detector .stripped === true ⇒ the
  // model repeated an opener phrase ⇒ the stripper is load-bearing.
  for (let i = 1; i < replies.length; i++) {
    const priors = replies.slice(Math.max(0, i - 5), i).reverse()
    const r = stripPhraseRepeat(replies[i], priors)
    tally["phrase-repeat"].n++
    if (r.stripped) tally["phrase-repeat"].fired++
    const snippet = replies[i].replace(/\s+/g, " ").slice(0, 70)
    console.log(`${r.stripped ? "FIRED" : "clean"} [phrase-repeat turn ${i + 1}] ${r.stripped ? `phrase="${r.matched_phrase}"` : "no repeat"} — "${snippet}…"`)
  }

  console.log("\n── per-layer verdict (DELETE iff the model+prompt self-does it = detector never fired) ──")
  const verdicts = {}
  for (const [layer, b] of Object.entries(tally)) {
    if (b.n === 0) {
      verdicts[layer] = "NO-DATA"
      console.log(`  ${layer.padEnd(14)} : NO-DATA (0 provocations ran)`)
      continue
    }
    const verdict = b.fired === 0 ? "DELETE-OK" : "KEEP"
    verdicts[layer] = verdict
    console.log(`  ${layer.padEnd(14)} : ${verdict}  (detector fired ${b.fired}/${b.n} — ${verdict === "DELETE-OK" ? "model self-does it, strip is dead weight" : "strip catches real model output, load-bearing"})`)
  }

  console.log("\n(advisory — exit 0 regardless. The deterministic gate is process-intact-runner.mjs.)")
  console.log(`VERDICTS ${JSON.stringify(verdicts)}`)
  process.exit(0)
}

main().catch((e) => {
  console.error("voice-collapse-runner crashed:", e)
  process.exit(2)
})
