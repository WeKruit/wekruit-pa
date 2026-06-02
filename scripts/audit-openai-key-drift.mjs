#!/usr/bin/env node
/**
 * audit-openai-key-drift.mjs — OpenAI key drift auditor (deliverable #3).
 *
 * Incident: .planning/INCIDENT-2026-06-01-openai-rotation-hardening.md
 *
 * The 2026-06-01 outage's true cause was a PARTIAL rotation: some surfaces got
 * the new key, others kept the dead one. This script reads the OpenAI key from
 * every store it can ACTUALLY read, sha256-hashes each, compares them to the
 * canonical (Firebase Secret Manager `PA_OPENAI_AGENT_API_KEY`), and reports any
 * store whose hash differs. Exits NON-ZERO on drift so it can gate CI.
 *
 * SECURITY — outputs HASHES + REDACTED PREFIXES only. No key value is ever
 * printed, logged, or written. Compare is by sha256 only.
 *
 * Readable stores (this script):
 *   - Firebase Secret Manager: PA_OPENAI_AGENT_API_KEY (canonical), OPENAI_API_KEY,
 *     MATCHING_OPENAI_API_KEY  — via `firebase functions:secrets:access` (authed CLI).
 *   - Local files: wekruit-pa/.env (OPENAI_API_KEY + PA_OPENAI_AGENT_API_KEY),
 *     /Users/adam/wekruit-matching/.env (OPENAI_API_KEY).
 *
 * Unreadable-by-design (write-only / offline) — reported as "unreadable", never
 * drift: GitHub Actions secrets, macmini box, Infisical (need their own login).
 *
 * Usage:
 *   node scripts/audit-openai-key-drift.mjs            # human report
 *   node scripts/audit-openai-key-drift.mjs --json     # machine-readable
 *   node scripts/audit-openai-key-drift.mjs --no-secret-manager   # skip CLI calls (files only)
 * Exit code: 0 = no drift; 1 = drift (or canonical unreadable); 2 = usage error.
 */

import { existsSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import {
  sha256Hex,
  redactKey,
  computeDrift,
  readEnvVarFromContent,
  parseFlags,
} from "./lib/openai-key-drift.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "..")
const PROJECT = "wekruit-5f89b"
const CANONICAL_STORE = "firebase:PA_OPENAI_AGENT_API_KEY"

const { flags } = parseFlags(process.argv.slice(2))
const asJson = flags.has("json")
const skipSecretManager = flags.has("no-secret-manager")

/** Read a Firebase Secret Manager value via firebase-tools. Returns value|null. */
function readFirebaseSecret(name) {
  try {
    const out = execFileSync(
      "npx",
      ["-y", "firebase-tools", "functions:secrets:access", `${name}@latest`, "--project", PROJECT],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000 }
    )
    const v = out.trim()
    return v.length > 0 && v !== "__UNSET__" ? v : null
  } catch {
    return null // CLI not authed / secret absent / access denied → unreadable
  }
}

/** Read a var from a local .env file. Returns value|null. */
function readEnvFile(path, varName) {
  try {
    if (!existsSync(path)) return null
    return readEnvVarFromContent(readFileSync(path, "utf8"), varName)
  } catch {
    return null
  }
}

/** Turn a raw value into a {sha256, prefix} store entry, redacting immediately. */
function hashEntry(store, value) {
  if (value === null || value === undefined) {
    return { store, sha256: null, prefix: "(unreadable)", unreadable: true }
  }
  return { store, sha256: sha256Hex(value), prefix: redactKey(value) }
}

async function main() {
  const hashes = []

  // --- Firebase Secret Manager (3 names, 1 project) ---
  if (!skipSecretManager) {
    hashes.push(hashEntry(CANONICAL_STORE, readFirebaseSecret("PA_OPENAI_AGENT_API_KEY")))
    hashes.push(hashEntry("firebase:OPENAI_API_KEY", readFirebaseSecret("OPENAI_API_KEY")))
    hashes.push(hashEntry("firebase:MATCHING_OPENAI_API_KEY", readFirebaseSecret("MATCHING_OPENAI_API_KEY")))
  } else {
    // Without Secret Manager, the local .env PA_OPENAI_AGENT_API_KEY is the
    // canonical proxy (it's what the rotation script keeps in lockstep).
    hashes.push(
      hashEntry(CANONICAL_STORE, readEnvFile(resolve(REPO_ROOT, ".env"), "PA_OPENAI_AGENT_API_KEY"))
    )
  }

  // --- Local .env files ---
  hashes.push(
    hashEntry("wekruit-pa/.env:OPENAI_API_KEY", readEnvFile(resolve(REPO_ROOT, ".env"), "OPENAI_API_KEY"))
  )
  if (!skipSecretManager) {
    hashes.push(
      hashEntry(
        "wekruit-pa/.env:PA_OPENAI_AGENT_API_KEY",
        readEnvFile(resolve(REPO_ROOT, ".env"), "PA_OPENAI_AGENT_API_KEY")
      )
    )
  }
  hashes.push(
    hashEntry(
      "wekruit-matching/.env:OPENAI_API_KEY",
      readEnvFile("/Users/adam/wekruit-matching/.env", "OPENAI_API_KEY")
    )
  )

  // --- Write-only / offline stores (reported, never drift) ---
  for (const store of [
    "github:wekruit-pa/PA_OPENAI_AGENT_API_KEY (write-only)",
    "github:wekruit-matching/OPENAI_API_KEY (write-only)",
    "macmini (offline)",
    "infisical (login required)",
  ]) {
    hashes.push({ store, sha256: null, prefix: "(unreadable)", unreadable: true })
  }

  const report = computeDrift(CANONICAL_STORE, hashes)

  if (asJson) {
    // sha256 truncated to 12 chars in output — still unique enough to compare,
    // and we NEVER print the value.
    const safe = {
      canonicalStore: report.canonicalStore,
      canonicalSha256: report.canonicalSha256 ? report.canonicalSha256.slice(0, 12) : null,
      driftCount: report.driftCount,
      unreadableCount: report.unreadableCount,
      hasDrift: report.hasDrift,
      rows: report.rows.map((r) => ({
        store: r.store,
        sha256: r.sha256 ? r.sha256.slice(0, 12) : null,
        prefix: r.prefix,
        status: r.status,
      })),
    }
    console.log(JSON.stringify(safe, null, 2))
  } else {
    console.log("OpenAI key drift audit")
    console.log("======================")
    console.log(
      `canonical: ${report.canonicalStore} = ${report.canonicalSha256 ? report.canonicalSha256.slice(0, 12) + "…" : "(UNREADABLE)"}`
    )
    console.log("")
    for (const r of report.rows) {
      const mark = r.status === "match" ? "✓" : r.status === "drift" ? "✗ DRIFT" : "· unreadable"
      const hash = r.sha256 ? r.sha256.slice(0, 12) + "…" : "—"
      console.log(`  ${mark.padEnd(13)} ${r.store.padEnd(48)} ${hash}  ${r.prefix ?? ""}`)
    }
    console.log("")
    console.log(
      `drift: ${report.driftCount}  unreadable: ${report.unreadableCount}  → ${report.hasDrift ? "DRIFT DETECTED" : "in sync"}`
    )
    if (report.hasDrift) {
      console.log("")
      console.log("Partial rotation suspected (the 2026-06-01 outage cause).")
      console.log("Fix: node scripts/sync-openai-key.mjs --key-file <new-key-file> --apply")
    }
  }

  process.exit(report.hasDrift ? 1 : 0)
}

main().catch((err) => {
  // Redact defensively even on crash — never let a value reach stderr.
  console.error("audit-openai-key-drift failed:", redactKey(String(err?.message ?? err)).startsWith("sk-") ? "(redacted)" : String(err?.message ?? err))
  process.exit(2)
})
