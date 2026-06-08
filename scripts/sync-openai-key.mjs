#!/usr/bin/env node
/**
 * sync-openai-key.mjs — single-source OpenAI key fan-out (deliverable #2).
 *
 * Incident: .planning/INCIDENT-2026-06-01-openai-rotation-hardening.md §2 + §5.
 *
 * Given ONE new key (via --key-file or stdin, NEVER argv), this script pushes it
 * to every store the agent can write, then prints the manual paste steps for the
 * stores it cannot reach. Idempotent — re-running with the same key is a no-op in
 * effect (Firebase/gh just create an identical new version).
 *
 * Writes (with --apply):
 *   - Firebase Secret Manager (project wekruit-5f89b): 3 names —
 *       PA_OPENAI_AGENT_API_KEY, OPENAI_API_KEY, MATCHING_OPENAI_API_KEY
 *     via `firebase functions:secrets:set --data-file -` (value piped on stdin).
 *   - GitHub Actions: `gh secret set` for both repos —
 *       wekruit-pa/PA_OPENAI_AGENT_API_KEY, wekruit-matching/OPENAI_API_KEY.
 *   - Local wekruit-pa/.env: rewrites OPENAI_API_KEY + PA_OPENAI_AGENT_API_KEY
 *     in place (timestamped backup). (rotate-openai-key.mjs relies on this.)
 *
 * Prints (always): manual macmini + Infisical paste steps (offline / login-gated).
 *
 * SECURITY — the key value is read once into memory, piped to child processes via
 * stdin, and never printed/logged/echoed. All console output is the redacted
 * prefix + sha256 only. Refuses to run if the input is not a plausible sk- key.
 *
 * Usage:
 *   node scripts/sync-openai-key.mjs --key-file /path/to/newkey.txt          # DRY-RUN (default)
 *   printf '%s' "$NEWKEY" | node scripts/sync-openai-key.mjs --stdin         # DRY-RUN
 *   node scripts/sync-openai-key.mjs --key-file /path/to/newkey.txt --apply  # really write
 *   ... --no-firebase / --no-github / --no-env   # skip a target
 * The script ALWAYS defaults to --dry-run. Pass --apply to mutate anything.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import { sha256Hex, redactKey, looksLikeOpenAiKey, parseFlags } from "./lib/openai-key-drift.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "..")
const PROJECT = "wekruit-5f89b"
const PA_REPO = "admin-wekruit/wekruit-pa"
const MATCHING_REPO = "admin-wekruit/wekruit-matching"
const ENV_PATH = resolve(REPO_ROOT, ".env")

const { flags, values } = parseFlags(process.argv.slice(2))
const apply = flags.has("apply")
const dryRun = !apply
const doFirebase = !flags.has("no-firebase")
const doGithub = !flags.has("no-github")
const doEnv = !flags.has("no-env")

function log(...a) {
  console.log(...a)
}

/** Read the new key from --key-file or stdin. Returns trimmed string. */
function readNewKey() {
  const file = values.get("key-file")
  if (file) {
    if (!existsSync(file)) {
      fail(`--key-file not found: ${file}`)
    }
    return readFileSync(file, "utf8").trim()
  }
  // stdin
  try {
    return readFileSync(0, "utf8").trim()
  } catch {
    return ""
  }
}

function fail(msg) {
  console.error(`sync-openai-key: ${msg}`)
  process.exit(2)
}

/** Set a Firebase secret by piping the value on stdin (never argv). */
function setFirebaseSecret(name, value) {
  if (dryRun) {
    log(`  [dry-run] firebase functions:secrets:set ${name} --project ${PROJECT} --data-file -`)
    return { ok: true, dryRun: true }
  }
  const res = spawnSync(
    "npx",
    ["-y", "firebase-tools", "functions:secrets:set", name, "--project", PROJECT, "--data-file", "-"],
    { input: value, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000 }
  )
  if (res.status !== 0) {
    return { ok: false, error: redactStderr(res.stderr || res.stdout || "unknown") }
  }
  return { ok: true }
}

/** Set a GitHub Actions secret via gh, piping the value on stdin (--body -). */
function setGithubSecret(repo, name, value) {
  if (dryRun) {
    log(`  [dry-run] gh secret set ${name} --repo ${repo} --body -`)
    return { ok: true, dryRun: true }
  }
  const res = spawnSync("gh", ["secret", "set", name, "--repo", repo, "--body", "-"], {
    input: value,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  })
  if (res.status !== 0) {
    return { ok: false, error: redactStderr(res.stderr || res.stdout || "unknown") }
  }
  return { ok: true }
}

/** Rewrite OPENAI_API_KEY + PA_OPENAI_AGENT_API_KEY in wekruit-pa/.env. */
function rewriteEnvFile(value) {
  const present = existsSync(ENV_PATH)
  if (dryRun) {
    log(
      `  [dry-run] would rewrite ${ENV_PATH} (OPENAI_API_KEY + PA_OPENAI_AGENT_API_KEY), ` +
        `backup .env.bak.<ts>` +
        (present ? "" : "  [note: .env not present here — created on --apply]")
    )
    return { ok: true, dryRun: true }
  }
  if (!present) {
    return { ok: false, error: `.env not found at ${ENV_PATH}` }
  }
  const before = readFileSync(ENV_PATH, "utf8")
  const lines = before.split(/\r?\n/)
  const targets = new Set(["OPENAI_API_KEY", "PA_OPENAI_AGENT_API_KEY"])
  const seen = new Set()
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/)
    if (m && targets.has(m[1])) {
      seen.add(m[1])
      return `${m[1]}=${value}`
    }
    return line
  })
  // Append any target not present.
  for (const t of targets) {
    if (!seen.has(t)) next.push(`${t}=${value}`)
  }
  const after = next.join("\n")
  const backup = `${ENV_PATH}.bak.${Math.floor(Date.now() / 1000)}`
  copyFileSync(ENV_PATH, backup)
  writeFileSync(ENV_PATH, after, { mode: 0o600 })
  return { ok: true, backup }
}

/** Strip any sk- token out of a child stderr before we ever print it. */
function redactStderr(text) {
  return String(text).replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-…REDACTED").slice(0, 400)
}

function ghAvailable() {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore", timeout: 10000 })
    return true
  } catch {
    return false
  }
}

// --------------------------------------------------------------------------

const NEWKEY = readNewKey()
if (!NEWKEY) {
  fail("no key provided — pass --key-file <path> or pipe the key on stdin (--stdin).")
}
if (!looksLikeOpenAiKey(NEWKEY)) {
  fail("refusing: input does not look like an OpenAI key (expected 'sk-...').")
}

const prefix = redactKey(NEWKEY)
const hash12 = sha256Hex(NEWKEY).slice(0, 12)

log("sync-openai-key")
log("===============")
log(`mode:    ${apply ? "APPLY (writing)" : "DRY-RUN (default — pass --apply to write)"}`)
log(`new key: ${prefix}  sha256=${hash12}…`)
log("")

const results = []

if (doFirebase) {
  log("Firebase Secret Manager (project wekruit-5f89b):")
  for (const name of ["PA_OPENAI_AGENT_API_KEY", "OPENAI_API_KEY", "MATCHING_OPENAI_API_KEY"]) {
    const r = setFirebaseSecret(name, NEWKEY)
    results.push({ target: `firebase:${name}`, ...r })
    if (!dryRun) log(`  ${r.ok ? "✓ set" : "✗ FAILED"} ${name}${r.error ? " — " + r.error : ""}`)
  }
  log("")
}

if (doGithub) {
  log("GitHub Actions secrets:")
  if (!dryRun && !ghAvailable()) {
    log("  ✗ gh CLI not found / not authed — skipping (install + `gh auth login`).")
    results.push({ target: "github", ok: false, error: "gh unavailable" })
  } else {
    let r = setGithubSecret(PA_REPO, "PA_OPENAI_AGENT_API_KEY", NEWKEY)
    results.push({ target: `github:${PA_REPO}`, ...r })
    if (!dryRun) log(`  ${r.ok ? "✓ set" : "✗ FAILED"} ${PA_REPO}/PA_OPENAI_AGENT_API_KEY${r.error ? " — " + r.error : ""}`)
    r = setGithubSecret(MATCHING_REPO, "OPENAI_API_KEY", NEWKEY)
    results.push({ target: `github:${MATCHING_REPO}`, ...r })
    if (!dryRun) log(`  ${r.ok ? "✓ set" : "✗ FAILED"} ${MATCHING_REPO}/OPENAI_API_KEY${r.error ? " — " + r.error : ""}`)
  }
  log("")
}

if (doEnv) {
  log("Local wekruit-pa/.env:")
  const r = rewriteEnvFile(NEWKEY)
  results.push({ target: "wekruit-pa/.env", ...r })
  if (!dryRun) log(`  ${r.ok ? "✓ rewrote (backup " + r.backup + ")" : "✗ FAILED — " + r.error}`)
  log("")
}

// --- Manual steps (always printed) ---
log("MANUAL paste steps (stores the agent cannot reach):")
log("  [macmini]   ssh wekruitclaw1@<macmini>; edit wekruit-matching .env OPENAI_API_KEY → new key;")
log("              restart the launchd pipeline. Confirm next scrape authenticates.")
log("  [Infisical] infisical login; update OPENAI_API_KEY in prod (/jobless/*) to the new key.")
log("              (matching .infisical.json defaultEnvironment is empty, so this does NOT")
log("               auto-propagate — the local .env rewrite above is still authoritative today.)")
log("")
log(`new key sha256=${hash12}… — verify each manual store hashes to this via:`)
log("  node scripts/audit-openai-key-drift.mjs")

const anyFail = results.some((r) => r.ok === false)
if (dryRun) {
  log("")
  log("DRY-RUN complete — nothing was written. Re-run with --apply to push the key.")
}
process.exit(anyFail ? 1 : 0)
