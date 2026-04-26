#!/usr/bin/env node
/**
 * Phase 10.5 T8 — Default agent tool-policy migration.
 *
 * Flips `pa_agents` default doc from `toolPolicy: "none"` to
 * `toolPolicy: "allowlist"` with `allowedConnectors: ["current-info",
 * "remember-fact"]` and `toolBudgetPerTurn: 3`. Idempotent — re-running on
 * the migrated state is a no-op (the script detects equality on the three
 * managed fields and skips the write entirely).
 *
 * Modes:
 *   --check                 (default) print the diff without writing.
 *                           `--dry-run` is accepted as an alias.
 *   --apply                 perform the write. Defaults to "forward"
 *                           direction (none → allowlist).
 *   --rollback              switch the target state to `toolPolicy:
 *                           "none", allowedConnectors: []`. Combine with
 *                           `--apply` to actually revert. Without
 *                           `--apply`, prints the rollback diff only.
 *   --help                  this message.
 *
 * Usage from repo root (Phase 10 + Deploy 1 auth pattern):
 *   # uses .env FIREBASE_SERVICE_ACCOUNT_JSON
 *   node scripts/pa-set-default-tool-policy.mjs --check
 *   node scripts/pa-set-default-tool-policy.mjs --apply
 *   node scripts/pa-set-default-tool-policy.mjs --rollback --apply
 *
 * Red lines (this script enforces them):
 *   - NEVER mutates non-default agents (filters by `isDefault == true`).
 *   - NEVER creates the default doc (uses Firestore `update()` which
 *     errors if the doc does not exist).
 *   - NEVER touches fields outside `toolPolicy`, `allowedConnectors`,
 *     `toolBudgetPerTurn`, `updatedAt`.
 *   - NEVER asks for `--apply` confirmation in CI — operator-run only.
 *
 * Production kill switches (in order of preference, see 10.5-PLAN T8):
 *   1. `PA_AGENT_LLM_PROVIDER=siliconflow` env on `onPaInbound` →
 *      engages SF fallback, no `webSearchTool` attached (T4 gate).
 *   2. `PA_AGENT_RUNTIME=chat_completions` → bypass SDK entirely.
 *   3. `node scripts/pa-set-default-tool-policy.mjs --rollback --apply`
 *      → reverts default agent's toolPolicy to "none". Note the regex
 *      pre-router (T5 has not yet landed) still handles current-info /
 *      remember commands, so a rollback here only removes the LLM's
 *      access to tools, not the deterministic short-circuits.
 */
import { existsSync, readFileSync } from "node:fs"
import { initializeApp, getApps, applicationDefault, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

// ---------------- pure logic (testable; exported below) ----------------

/**
 * Forward target: Phase 10.5 production state for the default agent.
 * `toolBudgetPerTurn: 3` matches plan T8.
 */
export const FORWARD_TARGET = Object.freeze({
  toolPolicy: "allowlist",
  allowedConnectors: Object.freeze(["current-info", "remember-fact"]),
  toolBudgetPerTurn: 3,
})

/**
 * Rollback target: pre-Deploy-2 state. `toolBudgetPerTurn` is intentionally
 * preserved at 3 on rollback (it is harmless when toolPolicy is "none" —
 * no tool calls can be made — and removing it would delete data outside
 * the script's contract). If a later phase needs to nuke the budget,
 * that's a separate migration.
 */
export const ROLLBACK_TARGET = Object.freeze({
  toolPolicy: "none",
  allowedConnectors: Object.freeze([]),
})

/**
 * `arrayEqual` — set-aware comparison for `allowedConnectors`. Order
 * is insignificant for the policy gate (`canUseConnector` uses
 * `Array.includes`), so we compare as sets.
 */
function arrayEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  const setA = new Set(a)
  for (const item of b) if (!setA.has(item)) return false
  return true
}

/**
 * `computePlan(currentDoc, mode)` — returns one of:
 *   { action: "noop", currentManaged, target }
 *   { action: "update", currentManaged, target, patch }
 *
 * `currentManaged` is the slice of the current doc that this script
 * manages (toolPolicy, allowedConnectors, toolBudgetPerTurn). `target`
 * is the desired final state. `patch` is what would be passed to
 * `ref.update(...)` — exactly the managed fields plus `updatedAt`.
 *
 * mode: "forward" | "rollback".
 *
 * Idempotency rule: if currentManaged matches target on all keys we
 * write (set-equal on allowedConnectors), action === "noop" and no
 * write is issued. Re-running --apply on the migrated state therefore
 * doesn't even bump `updatedAt`.
 */
export function computePlan(currentDoc, mode) {
  if (mode !== "forward" && mode !== "rollback") {
    throw new Error(`computePlan: invalid mode ${JSON.stringify(mode)}`)
  }
  const target = mode === "forward" ? FORWARD_TARGET : ROLLBACK_TARGET
  const currentManaged = {
    toolPolicy: currentDoc.toolPolicy ?? null,
    allowedConnectors: Array.isArray(currentDoc.allowedConnectors)
      ? currentDoc.allowedConnectors
      : [],
    toolBudgetPerTurn:
      typeof currentDoc.toolBudgetPerTurn === "number"
        ? currentDoc.toolBudgetPerTurn
        : null,
  }

  // Forward target includes toolBudgetPerTurn; rollback target leaves it
  // alone (see ROLLBACK_TARGET docblock).
  let matches =
    currentManaged.toolPolicy === target.toolPolicy &&
    arrayEqual(currentManaged.allowedConnectors, target.allowedConnectors)
  if (mode === "forward") {
    matches = matches && currentManaged.toolBudgetPerTurn === target.toolBudgetPerTurn
  }

  if (matches) {
    return { action: "noop", currentManaged, target }
  }

  const patch = {
    toolPolicy: target.toolPolicy,
    allowedConnectors: [...target.allowedConnectors],
    updatedAt: new Date().toISOString(),
  }
  if (mode === "forward") {
    patch.toolBudgetPerTurn = target.toolBudgetPerTurn
  }
  return { action: "update", currentManaged, target, patch }
}

// ---------------- side-effecting CLI (skipped under --self-test) ----------------

function loadDotEnv(path) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const raw = trimmed.slice(idx + 1).trim()
    if (!process.env[key]) {
      process.env[key] = raw.replace(/^['"]|['"]$/g, "")
    }
  }
}

function parseArgs(argv) {
  const flags = new Set(argv)
  if (flags.has("--help") || flags.has("-h")) return { help: true }
  const apply = flags.has("--apply")
  const rollback = flags.has("--rollback")
  const check = flags.has("--check") || flags.has("--dry-run") || (!apply && !rollback)
  // --rollback without --apply: rollback dry-run. --rollback --apply: write rollback.
  const mode = rollback ? "rollback" : "forward"
  const write = apply
  return { help: false, mode, write, check }
}

function printHelp() {
  process.stdout.write(
    [
      "Phase 10.5 T8 — default-agent tool-policy migration",
      "",
      "Usage:",
      "  node scripts/pa-set-default-tool-policy.mjs [--check|--apply|--rollback] [--help]",
      "",
      "Modes:",
      "  --check / --dry-run   print diff, do not write (default).",
      "  --apply               write forward target (none → allowlist).",
      "  --rollback            switch target to rollback (allowlist → none).",
      "                        Combine with --apply to actually write.",
      "",
      "Auth: FIREBASE_SERVICE_ACCOUNT_JSON env (preferred), else",
      "      FIREBASE_SERVICE_ACCOUNT_PATH, else GOOGLE_APPLICATION_CREDENTIALS,",
      "      else applicationDefault().",
      "",
    ].join("\n") + "\n"
  )
}

function getDb() {
  if (getApps().length) return getFirestore()
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (jsonEnv && jsonEnv.trim().length > 0) {
    const sa = JSON.parse(jsonEnv)
    initializeApp({ credential: cert(sa), projectId: sa.project_id })
  } else if (path) {
    const sa = JSON.parse(readFileSync(path, "utf8"))
    initializeApp({ credential: cert(sa), projectId: sa.project_id })
  } else {
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
    })
  }
  return getFirestore()
}

function formatDiff(plan, docId) {
  const lines = []
  lines.push(`pa_agents/${docId}`)
  lines.push("  managed fields (current → target):")
  lines.push(`    toolPolicy:        ${JSON.stringify(plan.currentManaged.toolPolicy)} → ${JSON.stringify(plan.target.toolPolicy)}`)
  lines.push(`    allowedConnectors: ${JSON.stringify(plan.currentManaged.allowedConnectors)} → ${JSON.stringify(plan.target.allowedConnectors)}`)
  if ("toolBudgetPerTurn" in plan.target) {
    lines.push(`    toolBudgetPerTurn: ${JSON.stringify(plan.currentManaged.toolBudgetPerTurn)} → ${JSON.stringify(plan.target.toolBudgetPerTurn)}`)
  } else {
    lines.push(`    toolBudgetPerTurn: ${JSON.stringify(plan.currentManaged.toolBudgetPerTurn)} (unchanged on rollback)`)
  }
  return lines.join("\n")
}

async function main() {
  loadDotEnv(".env")
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return 0
  }
  const db = getDb()
  const snap = await db.collection("pa_agents").where("isDefault", "==", true).get()
  if (snap.empty) {
    process.stderr.write(
      "[t8-migration] FAIL: no pa_agents doc with isDefault==true. " +
        "This script will NOT create one — seed the registry first " +
        "(see packages/agent-registry/src/seed.json).\n"
    )
    return 2
  }
  if (snap.size > 1) {
    process.stderr.write(
      `[t8-migration] FAIL: ${snap.size} pa_agents docs have isDefault==true. ` +
        "Exactly one default agent expected. Aborting.\n"
    )
    return 2
  }
  const doc = snap.docs[0]
  const plan = computePlan(doc.data(), args.mode)
  process.stdout.write(`[t8-migration] mode=${args.mode} write=${args.write}\n`)
  process.stdout.write(formatDiff(plan, doc.id) + "\n")
  if (plan.action === "noop") {
    process.stdout.write("[t8-migration] no changes needed (idempotent no-op).\n")
    return 0
  }
  if (!args.write) {
    process.stdout.write(
      "[t8-migration] dry-run only. Pass --apply to write the patch above.\n"
    )
    return 0
  }
  // Defense in depth: never run --apply from CI. CI sets `CI=true`.
  if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
    process.stderr.write(
      "[t8-migration] FAIL: CI environment detected; this script is operator-run only.\n"
    )
    return 2
  }
  await doc.ref.update(plan.patch)
  process.stdout.write(`[t8-migration] applied patch to pa_agents/${doc.id}.\n`)
  return 0
}

// Skip CLI invocation under self-test. The test file imports
// `computePlan` and friends without ever flipping this flag.
const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  process.argv[1].endsWith("pa-set-default-tool-policy.mjs")

if (isMain) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`[t8-migration] ERROR: ${err?.stack || err}\n`)
      process.exit(1)
    }
  )
}
