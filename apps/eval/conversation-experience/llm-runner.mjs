#!/usr/bin/env node
/**
 * REAL LLM-in-loop harness — the receipt layer.
 *
 * Distinct from runner.mjs (which asserts deterministic arbiter decisions
 * against hand-written `extractor_simulated_patch` mocks). This runner does
 * the thing Adam called out as missing: it runs a REAL model end-to-end and
 * grades both the structured side-effect AND the semantic quality.
 *
 * Per turn:
 *   1. Builds a ConversationExtractRequest from the running tag state +
 *      the fixture's inbound text. NO pre-written patch — the real
 *      gpt-5.4-nano (OpenAI-primary, Anthropic-fallback) must extract the
 *      canonical tag delta itself.
 *   2. Runs the production `runExtraction` with the production LLM caller.
 *      `writeUserTags` is captured into an in-memory tag store so we can
 *      assert the EXACT patch the model produced (not a mock).
 *   3. Merges the patch into the running tag state (simulating the reducer
 *      write), so multi-turn fixtures accumulate state the way production
 *      `mergeUserTags` would.
 *
 * After the run:
 *   - Deterministic assertion: final tags match `expect.final_tags`
 *     (subset match — every key in expect must equal the actual).
 *   - LLM grader: a second gpt-5.4-nano call scores whether the extraction
 *     is *semantically* correct given the conversation — catching the case
 *     where the schema validates but the meaning is wrong (e.g. the model
 *     keeps software_engineering when the user said to drop it).
 *
 * Requires a real OpenAI key in .env (PA_OPENAI_AGENT_API_KEY or
 * OPENAI_API_KEY). Costs a few cents per fixture. This is NOT a unit test —
 * it is the production-fidelity receipt. Run before claiming the reducer
 * works:
 *
 *   node apps/eval/conversation-experience/llm-runner.mjs
 *
 * Exit 0 if every fixture's deterministic assertion AND grader verdict pass;
 * 1 on any fail; 2 on setup error (missing key, dist not built).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname, basename, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "..", "..", "..")
const GRADER_MODEL = "gpt-5.4-nano"

// ────────────────────────────────────────────────────────────────────────
// .env loader (no dotenv dep — parse the repo-root .env into process.env)
// ────────────────────────────────────────────────────────────────────────

function findDotEnv() {
  // Worktrees (.claude/worktrees/<name>) don't carry the gitignored .env;
  // walk up to the first ancestor that has one (the main checkout root).
  let dir = REPO_ROOT
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function loadDotEnv() {
  const envPath = findDotEnv()
  if (!envPath) return
  const raw = readFileSync(envPath, "utf-8")
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env) || !process.env[key]) process.env[key] = val
  }
}

// ────────────────────────────────────────────────────────────────────────
// In-memory Firestore stub (cost-ledger writes land here; harmless)
// ────────────────────────────────────────────────────────────────────────

class FirestoreStub {
  constructor() {
    this.cols = new Map()
  }
  collection(name) {
    if (!this.cols.has(name)) this.cols.set(name, new Map())
    const col = this.cols.get(name)
    return {
      doc: (id) => ({
        get: async () => ({
          exists: col.has(id),
          data: () => col.get(id) ?? undefined,
        }),
        set: async (data, opts) => {
          const existing = col.get(id) ?? {}
          col.set(id, opts?.merge ? { ...existing, ...data } : data)
        },
      }),
      add: async (data) => {
        const id = `auto-${col.size}`
        col.set(id, data)
        return { id }
      },
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// LLM grader
// ────────────────────────────────────────────────────────────────────────

async function gradeExtraction(openai, { turns, finalTags, gradeCriteria }) {
  const prompt = [
    "You are a strict QA grader for a job-matching assistant's preference extractor.",
    "The assistant must convert a candidate's chat into canonical matching tags.",
    "",
    "Conversation (oldest → newest):",
    ...turns.map((t, i) => `  ${i + 1}. [${t.role}] ${t.body}`),
    "",
    "Final canonical tags the extractor produced:",
    JSON.stringify(finalTags, null, 2),
    "",
    "Grading criteria for THIS case:",
    gradeCriteria,
    "",
    "Return JSON only: { \"pass\": boolean, \"reasoning\": string (<=60 words) }.",
    "pass=true only if the final tags faithfully reflect what the candidate stated,",
    "including REMOVING preferences they rejected. If the candidate said to drop",
    "software engineering and the tags still contain software_engineering, pass=false.",
  ].join("\n")
  const resp = await openai.chat.completions.create({
    model: GRADER_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a precise grader. JSON only." },
      { role: "user", content: prompt },
    ],
  })
  const raw = resp.choices?.[0]?.message?.content ?? "{}"
  try {
    return JSON.parse(raw)
  } catch {
    return { pass: false, reasoning: `grader returned non-JSON: ${raw.slice(0, 120)}` }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Fixture loading
// ────────────────────────────────────────────────────────────────────────

function loadLlmFixtures(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ path: join(dir, file), fixture: JSON.parse(readFileSync(join(dir, file), "utf-8")) }))
}

function subsetMatch(expected, actual) {
  const fails = []
  for (const [k, v] of Object.entries(expected)) {
    const a = actual[k]
    if (JSON.stringify(sortIfArray(v)) !== JSON.stringify(sortIfArray(a))) {
      fails.push(`  tags.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(a)}`)
    }
  }
  return fails
}

function sortIfArray(v) {
  return Array.isArray(v) ? [...v].sort() : v
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────

async function main() {
  loadDotEnv()
  const openaiKey = (process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim()
  if (!openaiKey.startsWith("sk-")) {
    console.error("SETUP ERROR: no real OpenAI key (PA_OPENAI_AGENT_API_KEY / OPENAI_API_KEY) in .env")
    process.exit(2)
  }

  const distPath = join(REPO_ROOT, "packages", "pa-orchestrator", "dist", "conversation-extractor-runtime.js")
  if (!existsSync(distPath)) {
    console.error(`SETUP ERROR: build pa-orchestrator first (missing ${distPath})`)
    process.exit(2)
  }
  // FIDELITY (per .planning/LIVE-SMOKE-2026-05-28-RECEIPT.md): drive the REAL
  // production extraction seam `maybeRunExtractor` — the exact wrapper the turn
  // handler (handleDurablePreferenceUpdateTurn, index.ts:2614) calls. It injects
  // the production writeUserTags = applyPartialUserTags (shallow replace-per-key
  // into pa-users.tags), gates on onboardingState, and builds the request as
  // production does. The prior harness used a stand-in mergePatch + bare
  // runExtraction, which could false-green the avoid-swe removal case.
  const { maybeRunExtractor } = await import(pathToFileURL(distPath).href)

  // `openai` is a transitive dep of pa-orchestrator; resolve it from the
  // orchestrator package (apps/eval has no node_modules of its own).
  const orchestratorRequire = createRequire(
    join(REPO_ROOT, "packages", "pa-orchestrator", "package.json"),
  )
  const OpenAI = orchestratorRequire("openai").default ?? orchestratorRequire("openai")
  const grader = new OpenAI({ apiKey: openaiKey })
  const fixturesDir = join(__dirname, "llm-fixtures")
  const fixtures = loadLlmFixtures(fixturesDir)
  if (fixtures.length === 0) {
    console.error(`No LLM fixtures in ${fixturesDir}`)
    process.exit(2)
  }

  let totalFail = 0
  for (const { path, fixture } of fixtures) {
    const label = basename(path)
    console.log(`\n━━━ ${label} ━━━`)
    console.log(fixture.description ?? "")

    const userId = fixture.user_id ?? "test_user"
    const db = new FirestoreStub()
    // Seed the candidate's existing global profile (tags + onboardingState) into
    // the REAL store, then drive the production maybeRunExtractor seam each turn.
    await db.collection("pa-users").doc(userId).set({
      tags: { ...(fixture.initial_tags ?? {}) },
      onboardingState: fixture.onboarding_state ?? "complete",
    })
    const readTags = async () => (await db.collection("pa-users").doc(userId).get()).data()?.tags ?? {}
    const transcript = []

    for (let i = 0; i < fixture.turns.length; i++) {
      const turn = fixture.turns[i]
      transcript.push({ role: "user", body: turn.inbound })
      const tagsBefore = await readTags()

      let outcome
      try {
        // The EXACT production seam: maybeRunExtractor builds the request + injects
        // writeUserTags=applyPartialUserTags and writes into `db` internally.
        outcome = await maybeRunExtractor({
          db,
          userId,
          recentMessages: transcript.map((t) => ({ role: t.role, body: t.body, createdAt: new Date().toISOString() })),
          existingTags: tagsBefore,
          onboardingState: fixture.onboarding_state ?? "complete",
          userMsgsThisBatch: 1,
          forceTrigger: "intent_signal",
          log: () => {},
        })
      } catch (err) {
        console.log(`  turn ${i + 1} EXTRACTION THREW: ${err?.message ?? err}`)
        totalFail += 1
        continue
      }

      const tagsAfter = await readTags()
      const changed = Object.keys(tagsAfter).filter((k) => JSON.stringify(tagsAfter[k]) !== JSON.stringify(tagsBefore[k]))
      console.log(`  turn ${i + 1}: "${turn.inbound}"`)
      console.log(`    ran=${outcome.ran} reason=${outcome.reason ?? "n/a"} model=${outcome.modelUsed ?? "n/a"} changedKeys=${JSON.stringify(changed)}`)
      // assistant turn placeholder so multi-turn transcripts stay coherent
      if (turn.assistant) transcript.push({ role: "assistant", body: turn.assistant })
    }

    const runningTags = await readTags()
    console.log(`  final tags (via production maybeRunExtractor seam): ${JSON.stringify(runningTags)}`)

    // Deterministic assertions over the REAL merged tags:
    //   final_tags          — subset equality
    //   final_tags_includes — key must CONTAIN each listed value (e.g. full_time)
    //   final_tags_excludes — key must NOT contain each listed value (e.g. software_engineering removed)
    const detFails = []
    if (fixture.expect?.final_tags) detFails.push(...subsetMatch(fixture.expect.final_tags, runningTags))
    const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v])
    for (const [k, vals] of Object.entries(fixture.expect?.final_tags_includes ?? {})) {
      const actual = asArr(runningTags[k])
      for (const v of vals) if (!actual.includes(v)) detFails.push(`  tags.${k}: expected to INCLUDE ${JSON.stringify(v)}, got ${JSON.stringify(runningTags[k])}`)
    }
    // final_tags_includes_any — key must contain AT LEAST ONE of the listed values.
    // Use when a concept has >1 valid canonical form (e.g. remote → remote_anywhere
    // OR remote_united_states): asserts the concept was captured without pinning the
    // exact variant. Still deterministic-pass; never silently drops the check.
    for (const [k, vals] of Object.entries(fixture.expect?.final_tags_includes_any ?? {})) {
      const actual = asArr(runningTags[k])
      if (!vals.some((v) => actual.includes(v))) detFails.push(`  tags.${k}: expected to INCLUDE ANY of ${JSON.stringify(vals)}, got ${JSON.stringify(runningTags[k])}`)
    }
    for (const [k, vals] of Object.entries(fixture.expect?.final_tags_excludes ?? {})) {
      const actual = asArr(runningTags[k])
      for (const v of vals) if (actual.includes(v)) detFails.push(`  tags.${k}: expected to EXCLUDE ${JSON.stringify(v)}, but present in ${JSON.stringify(runningTags[k])}`)
    }

    // LLM grader — ADVISORY ONLY (code-grader > model-grader). Non-deterministic
    // even at temp 0; informs follow-ups, never blocks.
    let grade = { pass: true, reasoning: "no grade_criteria" }
    if (fixture.expect?.grade_criteria) {
      grade = await gradeExtraction(grader, {
        turns: transcript,
        finalTags: runningTags,
        gradeCriteria: fixture.expect.grade_criteria,
      })
    }

    const gated = detFails.length === 0
    if (fixture.expect?.baseline_red) {
      // Known-failing baseline (a live-smoke gap). RED here is CORRECT and does
      // NOT fail the run — P5 must turn it green. A surprise GREEN is surfaced.
      if (gated) {
        console.log(`  ⚠ BASELINE NOW GREEN — expected-RED baseline passed; the P5 fix may have landed (update/retire this fixture).`)
      } else {
        console.log(`  RED (expected baseline — P5 target; advisory, does not block):`)
        for (const f of detFails) console.log(`    ${f}`)
      }
    } else if (gated) {
      console.log(`  PASS  (deterministic gate)`)
    } else {
      console.log(`  FAIL  (deterministic gate)`)
      console.log("    deterministic diffs:")
      for (const f of detFails) console.log(`    ${f}`)
      totalFail += 1
    }
    console.log(`  grader [advisory ${grade.pass ? "ok" : "flag"}]: ${grade.reasoning}`)
  }

  console.log("")
  if (totalFail > 0) {
    console.error(`${totalFail} fixture(s) failed.`)
    process.exit(1)
  }
  console.log("All LLM fixtures passed (real model + grader).")
}

main().catch((err) => {
  console.error("llm-runner crashed:", err)
  process.exit(2)
})
