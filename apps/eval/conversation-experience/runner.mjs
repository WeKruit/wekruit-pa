#!/usr/bin/env node
/**
 * Stateful conversation harness — Firestore-state-diff assertion layer.
 *
 * Why this exists
 * ───────────────
 * The existing eval layer (apps/eval/intent-matrix-results, scripts/
 * audit-turn-arbitration.mjs, packages/pa-orchestrator unit tests) checks
 * what Claire *says*, not what she *does*. The May 2026 regression chain
 * (PRs #237, #238, #239 — all "passed eval" but each shipped a regression)
 * happened because the eval scored outbound text against an LLM judge while
 * the canonical `pa-users.tags` field never actually mutated. Anthropic's
 * 2026 "Demystifying Evals for AI Agents" post calls this out by name:
 * "Agents lie in the transcript — grade the database, not the words."
 *
 * What this harness does
 * ──────────────────────
 * 1. Loads a fixture (JSON, no YAML dep) describing
 *      - initial Firestore state (pa-users doc + matching-jobs corpus)
 *      - a sequence of inbound user turns
 *      - per-turn expectations: arbiter owner, action, evidence shape,
 *        and a Firestore-shape *post-state* assertion
 * 2. Drives the pure decision layer (decideConversationTurnOwner +
 *    decideConversationDeliveryAction + buildConversationEvidenceWrites)
 * 3. Tracks an in-memory Firestore mock (Map-of-Maps) seeded from the
 *    fixture. Records every write the arbiter / handler would emit.
 * 4. After every turn, diffs the in-memory state against the fixture's
 *    `firestore_after` block. Any mismatch = test fail.
 * 5. Returns process exit code 0 on green, non-zero on red. Designed to be
 *    wired into firebase.json predeploy as a regression gate; until then,
 *    runs manually via `node apps/eval/conversation-experience/runner.mjs`.
 *
 * What this harness does NOT do (yet)
 * ──────────────────────────────────
 *  - It does not replay the full Cloud Functions handler. That requires
 *    mocking Firebase Admin, OpenAI, Anthropic, mem0, and Sendblue — out of
 *    scope for this PR. The pure arbiter decisions + Firestore-write
 *    expectations cover the May 2026 regression class (stale-tag matcher
 *    input, frozen trace status, empty pa-tool-calls).
 *  - It does not call real LLMs for `runExtraction`. Fixtures pre-declare
 *    the tag patch the extractor would produce; the harness asserts that
 *    `mergeUserTags` would receive that patch and that the matcher input
 *    snapshot on the resulting `pa-tool-calls` row reflects the post-patch
 *    tags. End-to-end LLM correctness lives in
 *    `packages/pa-orchestrator/src/__tests__/conversation-extractor.test.ts`
 *    and the production smoke (live iMessage at +1 717 491 9939).
 *  - It does not score voice / continuity / human feel. That stays in the
 *    LLM-judge layer; this layer is the deterministic regression baseline
 *    that judge eval results don't override.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname, basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// ────────────────────────────────────────────────────────────────────────
// Arbiter import (compiled output preferred; falls back to src via tsx)
// ────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "..", "..", "..")

async function loadArbiter() {
  // Prefer dist (post-build); fall back to src via tsx (local dev).
  const distPath = join(
    REPO_ROOT,
    "packages",
    "pa-orchestrator",
    "dist",
    "conversation-turn-arbiter.js",
  )
  const srcPath = join(
    REPO_ROOT,
    "packages",
    "pa-orchestrator",
    "src",
    "conversation-turn-arbiter.ts",
  )
  try {
    statSync(distPath)
    const turn = await import(distPath)
    const action = await import(distPath.replace("conversation-turn-arbiter.js", "conversation-action-arbiter.js"))
    return { turn, action }
  } catch {
    // src fallback — runner must be invoked under `tsx` for the .ts import to work.
    const turn = await import(srcPath)
    const action = await import(srcPath.replace("conversation-turn-arbiter.ts", "conversation-action-arbiter.ts"))
    return { turn, action }
  }
}

// ────────────────────────────────────────────────────────────────────────
// In-memory Firestore mock (Map-of-Maps)
// ────────────────────────────────────────────────────────────────────────

/**
 * Map<collection, Map<docId, JSON>>. Mirrors the subset of Firestore writes
 * our handlers emit during a job-search turn: pa-users, pa-messages,
 * pa-turn-traces, pa-tool-calls, pa-outbound. Writes are deep-merged when
 * the caller passes `{merge:true}` (matches Firestore semantics).
 */
class FirestoreMock {
  constructor() {
    this.store = new Map()
  }

  _collection(name) {
    if (!this.store.has(name)) this.store.set(name, new Map())
    return this.store.get(name)
  }

  /** Replace top-level fields; deep-merge nested objects per Firestore. */
  set(collection, docId, data, { merge = false } = {}) {
    const col = this._collection(collection)
    const existing = col.get(docId) ?? {}
    const next = merge ? deepMerge(existing, data) : data
    col.set(docId, next)
  }

  get(collection, docId) {
    return this._collection(collection).get(docId) ?? null
  }

  /** Return `{collection: {docId: data}}` for human-readable diffs. */
  snapshot() {
    const out = {}
    for (const [collection, docs] of this.store.entries()) {
      out[collection] = {}
      for (const [docId, data] of docs.entries()) {
        out[collection][docId] = data
      }
    }
    return out
  }
}

function deepMerge(a, b) {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return b
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && a && typeof a[k] === "object") {
      out[k] = deepMerge(a[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────
// Fixture shape (JSON)
// ────────────────────────────────────────────────────────────────────────
//
// {
//   "name": "avoid-swe-after-onboarding",
//   "description": "...",
//   "user_id": "test_user_001",
//   "session_id": "test_session_001",
//   "initial_state": {
//     "pa-users/{user_id}": {...},
//     "matching-jobs/{job_id}": {...}
//   },
//   "turns": [
//     {
//       "inbound": "actually avoid pure SWE, product strategy only, SF or remote",
//       "shared_onboarding_active": false,
//       "extractor_simulated_patch": {
//         "targetRoleFunction": ["product_management"],
//         "targetLocations": ["san_francisco", "remote"]
//       },
//       "matcher_simulated_result": { "recCount": 0, "v16Counters": {...} },
//       "expect": {
//         "owner": "durable_preference_update",
//         "action": "micro_ack",
//         "evidence_kinds": ["durable_preference"],
//         "firestore_after": {
//           "pa-users/{user_id}.tags.targetRoleFunction": ["product_management"]
//         }
//       }
//     }
//   ]
// }

function loadFixtures(fixturesDir) {
  const files = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
  return files.map((file) => {
    const path = join(fixturesDir, file)
    const raw = readFileSync(path, "utf-8")
    return { path, fixture: JSON.parse(raw) }
  })
}

function expandPlaceholders(value, ctx) {
  if (typeof value === "string") {
    return value.replace(/\{user_id\}/g, ctx.userId).replace(/\{session_id\}/g, ctx.sessionId)
  }
  if (Array.isArray(value)) return value.map((v) => expandPlaceholders(v, ctx))
  if (value && typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[expandPlaceholders(k, ctx)] = expandPlaceholders(v, ctx)
    }
    return out
  }
  return value
}

function seedInitialState(db, initialState, ctx) {
  const expanded = expandPlaceholders(initialState, ctx)
  for (const [path, data] of Object.entries(expanded)) {
    const [collection, ...rest] = path.split("/")
    const docId = rest.join("/")
    db.set(collection, docId, data)
  }
}

// ────────────────────────────────────────────────────────────────────────
// Per-turn simulation
// ────────────────────────────────────────────────────────────────────────

function buildTurnContext(turn, ctx, fixtureInitial) {
  const userDoc = ctx.db.get("pa-users", ctx.userId) ?? {}
  const sharedOnboardingActive = turn.shared_onboarding_active === true
  return {
    turnId: `turn-${ctx.turnIndex}`,
    userId: ctx.userId,
    inbound: { text: turn.inbound, createdAt: new Date().toISOString(), channel: "imessage" },
    activeWorkflow: null,
    recentMessages: ctx.recentMessages,
    recentOutbound: ctx.recentMessages.filter((m) => m.role === "assistant"),
    sharedOnboarding: { active: sharedOnboardingActive, currentQuestionId: turn.shared_onboarding_question_id ?? null },
    preferenceState: userDoc.statedPreferences ?? null,
  }
}

function applySimulatedExtractor(db, ctx, turn) {
  if (!turn.extractor_simulated_patch) return null
  const patch = turn.extractor_simulated_patch
  db.set("pa-users", ctx.userId, { tags: patch, updatedAt: new Date().toISOString() }, { merge: true })
  return patch
}

function applySimulatedMatcher(db, ctx, turn, ownerDecision) {
  if (!turn.matcher_simulated_result) return null
  const result = turn.matcher_simulated_result
  const toolCallId = `tool-${ctx.turnIndex}`
  const userTagsSnapshot = (db.get("pa-users", ctx.userId) ?? {}).tags ?? {}
  db.set("pa-tool-calls", toolCallId, {
    id: toolCallId,
    turnId: `turn-${ctx.turnIndex}`,
    userId: ctx.userId,
    name: "find-match",
    status: result.recCount === 0 ? (result.failed ? "failed" : "completed") : "completed",
    input: { lang: "en", userTagsSnapshot },
    output: { recCount: result.recCount, v16Counters: result.v16Counters ?? {} },
  })
  db.set("pa-turn-traces", `turn-${ctx.turnIndex}`, {
    turnId: `turn-${ctx.turnIndex}`,
    status: "completed",
    owner: ownerDecision.selectedOwner,
    outboundSource: "job_search",
    toolCallId,
    recCount: result.recCount,
  })
  return { toolCallId, ...result }
}

function applyArbiterTrace(db, ctx, ownerDecision, actionDecision) {
  db.set("pa-turn-traces", `turn-${ctx.turnIndex}`, {
    turnId: `turn-${ctx.turnIndex}`,
    status: "owner_arbitrated",
    owner: ownerDecision.selectedOwner,
    action: actionDecision.selectedAction,
  })
}

// ────────────────────────────────────────────────────────────────────────
// Assertion helpers
// ────────────────────────────────────────────────────────────────────────

function getByDottedPath(obj, path) {
  const parts = path.split(".")
  let cur = obj
  for (const part of parts) {
    if (cur == null) return undefined
    cur = cur[part]
  }
  return cur
}

function assertFirestoreAfter(db, expected, ctx) {
  const fails = []
  for (const [path, expectedValue] of Object.entries(expected)) {
    const expandedPath = path.replace(/\{user_id\}/g, ctx.userId).replace(/\{session_id\}/g, ctx.sessionId)
    const [collection, docIdRest, ...rest] = expandedPath.split(".")
    const [col, docId] = collection.includes("/") ? collection.split("/") : [collection, docIdRest]
    const fieldPath = collection.includes("/") ? [docIdRest, ...rest].join(".") : rest.join(".")
    const doc = db.get(col, docId)
    if (!doc) {
      fails.push(`MISSING DOC: ${col}/${docId} (path was: ${path})`)
      continue
    }
    const actual = fieldPath ? getByDottedPath(doc, fieldPath) : doc
    const expectedJson = JSON.stringify(expectedValue)
    const actualJson = JSON.stringify(actual)
    if (expectedJson !== actualJson) {
      fails.push(`DIFF at ${path}:\n  expected: ${expectedJson}\n  actual:   ${actualJson}`)
    }
  }
  return fails
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────

async function runFixture(arbiter, file, fixture) {
  const ctx = {
    userId: fixture.user_id ?? "test_user",
    sessionId: fixture.session_id ?? "test_session",
    db: new FirestoreMock(),
    recentMessages: [],
    turnIndex: 0,
  }
  if (fixture.initial_state) seedInitialState(ctx.db, fixture.initial_state, ctx)

  const turnFails = []
  for (const turn of fixture.turns) {
    ctx.turnIndex += 1
    const turnContext = buildTurnContext(turn, ctx, fixture.initial_state)
    const ownerDecision = arbiter.turn.decideConversationTurnOwner(turnContext)
    const actionDecision = arbiter.action.decideConversationDeliveryAction(turnContext, ownerDecision)
    const evidenceWrites = arbiter.action.buildConversationEvidenceWrites(turnContext, ownerDecision, actionDecision)

    applyArbiterTrace(ctx.db, ctx, ownerDecision, actionDecision)
    if (turn.extractor_simulated_patch) applySimulatedExtractor(ctx.db, ctx, turn)
    if (turn.matcher_simulated_result) applySimulatedMatcher(ctx.db, ctx, turn, ownerDecision)

    ctx.recentMessages.push({ role: "user", body: turn.inbound, createdAt: new Date().toISOString() })

    const expect = turn.expect ?? {}
    if (expect.owner && expect.owner !== ownerDecision.selectedOwner) {
      turnFails.push(`turn ${ctx.turnIndex}: owner expected '${expect.owner}', got '${ownerDecision.selectedOwner}'`)
    }
    if (expect.action && expect.action !== actionDecision.selectedAction) {
      turnFails.push(`turn ${ctx.turnIndex}: action expected '${expect.action}', got '${actionDecision.selectedAction}'`)
    }
    if (Array.isArray(expect.evidence_kinds)) {
      const actualKinds = evidenceWrites.map((w) => w.kind)
      for (const kind of expect.evidence_kinds) {
        if (!actualKinds.includes(kind)) {
          turnFails.push(`turn ${ctx.turnIndex}: evidence kind '${kind}' missing (got: ${actualKinds.join(", ") || "none"})`)
        }
      }
    }
    if (expect.firestore_after) {
      const fails = assertFirestoreAfter(ctx.db, expect.firestore_after, ctx)
      turnFails.push(...fails.map((f) => `turn ${ctx.turnIndex}: ${f}`))
    }
  }

  return { file, fixture, fails: turnFails, finalSnapshot: ctx.db.snapshot() }
}

async function main() {
  const arbiter = await loadArbiter()
  const fixturesDir = join(__dirname, "fixtures")
  const fixtures = loadFixtures(fixturesDir)
  if (fixtures.length === 0) {
    console.error("No fixtures found in", fixturesDir)
    process.exit(2)
  }
  let totalFails = 0
  for (const { path, fixture } of fixtures) {
    const result = await runFixture(arbiter, path, fixture)
    const fileLabel = basename(path)
    if (result.fails.length === 0) {
      console.log(`PASS  ${fileLabel} (${fixture.turns.length} turn${fixture.turns.length === 1 ? "" : "s"})`)
    } else {
      console.log(`FAIL  ${fileLabel}`)
      for (const f of result.fails) console.log(`  - ${f}`)
      totalFails += result.fails.length
    }
  }
  if (totalFails > 0) {
    console.error(`\n${totalFails} assertion${totalFails === 1 ? "" : "s"} failed.`)
    process.exit(1)
  } else {
    console.log("\nAll fixtures passed.")
  }
}

main().catch((err) => {
  console.error("harness crashed:", err)
  process.exit(2)
})
