/**
 * Shared helpers for the two-layer conversation-experience eval.
 *
 * Layer 1 (process-intact-runner.mjs)   — deterministic HARD gate (exit code)
 * Layer 2 (llm-runner.mjs / bfcl-runner.mjs) — real-LLM ADVISORY scorecard
 *
 * These helpers are intentionally dependency-free (no dotenv, no test runner)
 * so the eval can run from a bare `node` invocation inside the workspace.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Repo root from a runner module living at apps/eval/conversation-experience/. */
export function repoRootFrom(metaUrl) {
  return resolve(dirname(fileURLToPath(metaUrl)), "..", "..", "..")
}

/**
 * Load the repo-root `.env` into process.env. Worktrees don't carry the
 * gitignored `.env`, so walk up to the first ancestor that has one (the main
 * checkout). Mirrors llm-runner.mjs's loader.
 */
export function loadDotEnv(repoRoot) {
  let dir = repoRoot
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env")
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, "utf-8")
      for (const line of raw.split("\n")) {
        const t = line.trim()
        if (!t || t.startsWith("#")) continue
        const eq = t.indexOf("=")
        if (eq === -1) continue
        const k = t.slice(0, eq).trim()
        let v = t.slice(eq + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        if (!(k in process.env) || !process.env[k]) process.env[k] = v
      }
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Load every *.json fixture in a directory (sorted, stable order). */
export function loadJsonFixtures(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ path: join(dir, file), name: file, fixture: JSON.parse(readFileSync(join(dir, file), "utf-8")) }))
}

/** Expand {key} placeholders throughout a value tree from a flat ctx map. */
export function expandPlaceholders(value, ctx) {
  if (typeof value === "string") {
    let out = value
    for (const [k, v] of Object.entries(ctx)) out = out.split(`{${k}}`).join(String(v))
    return out
  }
  if (Array.isArray(value)) return value.map((v) => expandPlaceholders(v, ctx))
  if (value && typeof value === "object") {
    const o = {}
    for (const [k, v] of Object.entries(value)) o[expandPlaceholders(k, ctx)] = expandPlaceholders(v, ctx)
    return o
  }
  return value
}

export function getByDottedPath(obj, path) {
  let cur = obj
  for (const part of path.split(".")) {
    if (cur == null) return undefined
    cur = cur[part]
  }
  return cur
}

export function jsonEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Dynamic-import a built dist module by repo-relative path (file URL). */
export async function importDist(repoRoot, relPath) {
  const abs = join(repoRoot, relPath)
  if (!existsSync(abs)) {
    throw new Error(`dist missing: ${relPath} — build the workspace first (pnpm -r build)`)
  }
  return import(pathToFileURL(abs).href)
}

// ────────────────────────────────────────────────────────────────────────
// Shared real-seam fixture engine
// ════════════════════════════════════════════════════════════════════════
// Single source of truth for driving the REAL production extraction seam
// (`maybeRunExtractor`) over the `real-seam-fixtures/` set, asserting the
// durable tag store, and grading the result. Consumed by BOTH the manual
// `real-seam-runner.mjs` scorecard AND the blocking `real-seam-gate.mjs`
// predeploy gate, so the manual receipt and the deploy gate exercise the
// EXACT same code path (no drift between "what we run by hand" and "what
// blocks deploys").
// ────────────────────────────────────────────────────────────────────────

/**
 * In-memory Firestore double. `set({merge:true})` is shallow per-key, which
 * is what production `applyPartialUserTags` relies on (it replaces whole tag
 * keys). Identical shape to the stub the production extraction harness uses.
 */
export class FirestoreStub {
  constructor() {
    this.cols = new Map()
  }
  collection(name) {
    if (!this.cols.has(name)) this.cols.set(name, new Map())
    const col = this.cols.get(name)
    return {
      doc: (id) => ({
        get: async () => ({ exists: col.has(id), data: () => col.get(id) ?? undefined }),
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

const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v])
const sortIfArray = (v) => (Array.isArray(v) ? [...v].sort() : v)

function subsetMatch(expected, actual) {
  const fails = []
  for (const [k, v] of Object.entries(expected)) {
    if (JSON.stringify(sortIfArray(v)) !== JSON.stringify(sortIfArray(actual[k]))) {
      fails.push(`tags.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual[k])}`)
    }
  }
  return fails
}

/** Deterministic capture assertion: final_tags subset + includes/excludes. */
export function evalCaptureFixture(expect, finalTags) {
  const fails = []
  if (expect?.final_tags) fails.push(...subsetMatch(expect.final_tags, finalTags))
  for (const [k, vals] of Object.entries(expect?.final_tags_includes ?? {})) {
    const actual = asArr(finalTags[k])
    for (const v of vals) {
      if (!actual.includes(v)) fails.push(`tags.${k}: expected to INCLUDE ${JSON.stringify(v)}, got ${JSON.stringify(finalTags[k])}`)
    }
  }
  for (const [k, vals] of Object.entries(expect?.final_tags_excludes ?? {})) {
    const actual = asArr(finalTags[k])
    for (const v of vals) {
      if (actual.includes(v)) fails.push(`tags.${k}: expected to EXCLUDE ${JSON.stringify(v)}, but present in ${JSON.stringify(finalTags[k])}`)
    }
  }
  return fails
}

const TRANSIENT_RE = /(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timeout|fetch failed|rate.?limit|429|5\d\d)/i

/**
 * Call `maybeRunExtractor` with bounded retries on TRANSIENT network/5xx
 * errors only. A non-transient throw (e.g. a bug) surfaces immediately as
 * `{ran:false, reason:"threw:..."}` — we never retry a deterministic failure.
 *
 * `onAttempt(n, errMsg)` is invoked before each retry so callers can log the
 * blip. Returns the seam outcome (never throws).
 */
async function callSeamWithRetry(maybeRunExtractor, callArgs, { retries = 1, onAttempt } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await maybeRunExtractor(callArgs)
    } catch (err) {
      const msg = err?.message ?? String(err)
      lastErr = msg
      if (attempt < retries && TRANSIENT_RE.test(msg)) {
        if (onAttempt) onAttempt(attempt + 1, msg)
        await new Promise((r) => setTimeout(r, 750 * (attempt + 1)))
        continue
      }
      // Non-transient, or out of retries: report as a soft outcome (matches
      // maybeRunExtractor's own never-throw contract).
      return { ran: false, reason: `threw:${msg}` }
    }
  }
  return { ran: false, reason: `threw:${lastErr}` }
}

/**
 * Drive every fixture in `real-seam-fixtures/` through the REAL
 * `maybeRunExtractor` seam (fixture-controlled `onboarding_state`, the bit
 * `llm-runner.mjs` cannot express because it hard-defaults to "complete"),
 * then assert the durable tag store with `evalCaptureFixture`.
 *
 * @param maybeRunExtractor production seam (imported from dist).
 * @param fixturesDir absolute path to the real-seam-fixtures directory.
 * @param opts.maxModelCalls hard ceiling on total seam invocations across all
 *        fixtures/turns. Throws BEFORE exceeding it — bounds cost on a deploy
 *        gate so a runaway fixture set can never burn unbounded spend.
 * @param opts.retries transient-error retries per seam call (default 1).
 * @param opts.onTransient(name, attempt, msg) optional retry logger.
 * @returns array of per-fixture results: {name, baselineRed, gated, detFails,
 *          onboardingState, ranOutcomes, finalTags}. Plus `_modelCalls` total
 *          attached to the array.
 */
export async function runRealSeamFixtures(maybeRunExtractor, fixturesDir, opts = {}) {
  const { maxModelCalls = Infinity, retries = 1, onTransient } = opts
  const fixtures = loadJsonFixtures(fixturesDir)
  const results = []
  let modelCalls = 0
  for (const { fixture, name } of fixtures) {
    const userId = fixture.user_id ?? "test_user"
    const onboardingState = fixture.onboarding_state ?? "complete"
    const db = new FirestoreStub()
    await db.collection("pa-users").doc(userId).set({ tags: { ...(fixture.initial_tags ?? {}) }, onboardingState })
    const readTags = async () => (await db.collection("pa-users").doc(userId).get()).data()?.tags ?? {}
    const transcript = []
    const ranOutcomes = []

    for (const turn of fixture.turns ?? []) {
      transcript.push({ role: "user", body: turn.inbound })
      if (modelCalls >= maxModelCalls) {
        throw new Error(`real-seam cost ceiling hit: maxModelCalls=${maxModelCalls} reached at fixture '${name}'. Trim the fixture set or raise the ceiling.`)
      }
      const tagsBefore = await readTags()
      modelCalls += 1
      const outcome = await callSeamWithRetry(
        maybeRunExtractor,
        {
          db,
          userId,
          recentMessages: transcript.map((t) => ({ role: t.role, body: t.body, createdAt: new Date().toISOString() })),
          existingTags: tagsBefore,
          onboardingState,
          userMsgsThisBatch: 1,
          forceTrigger: "intent_signal",
          log: () => {},
        },
        { retries, onAttempt: (a, m) => onTransient?.(name, a, m) },
      )
      ranOutcomes.push(outcome)
      if (turn.assistant) transcript.push({ role: "assistant", body: turn.assistant })
    }

    const finalTags = await readTags()
    const detFails = evalCaptureFixture(fixture.expect, finalTags)
    results.push({
      name,
      baselineRed: fixture.expect?.baseline_red === true,
      gated: detFails.length === 0,
      detFails,
      onboardingState,
      ranOutcomes,
      finalTags,
    })
  }
  results._modelCalls = modelCalls
  return results
}
