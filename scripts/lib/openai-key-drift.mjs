/**
 * Shared pure helpers for the OpenAI key-resilience scripts (sync / drift /
 * rotate). Self-contained (.mjs) so all three scripts + their tests import ONE
 * implementation — no TS build step, no duplicated hash/redact logic.
 *
 * Incident: .planning/INCIDENT-2026-06-01-openai-rotation-hardening.md
 *
 * SECURITY — every function here either takes a key VALUE only to immediately
 * hash/redact it, or takes a hash/prefix. NOTHING returns or logs a raw value.
 */

import { createHash } from "node:crypto"

/** sha256 hex of a key value. Used for drift compare — never logs the value. */
export function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex")
}

/**
 * Redact a key to a safe display prefix, e.g. `sk-proj-fFdZ4aL7…`.
 * Returns "(empty)" / "(short)" for unusable inputs. NEVER returns the full key.
 */
export function redactKey(value) {
  if (value === undefined || value === null) return "(empty)"
  const s = String(value).trim()
  if (s.length === 0) return "(empty)"
  if (s.length < 12) return "(short)"
  return `${s.slice(0, 12)}…`
}

/** Is this string a plausible OpenAI secret key? (sk-... , >= 20 chars). */
export function looksLikeOpenAiKey(value) {
  if (typeof value !== "string") return false
  const s = value.trim()
  return /^sk-[A-Za-z0-9_-]{10,}$/.test(s) && s.length >= 20
}

/**
 * Compute key drift across stores vs a canonical store.
 *
 * @param {string} canonicalStore - label of the reference store.
 * @param {Array<{store:string, sha256:string|null, prefix?:string, unreadable?:boolean}>} hashes
 * @returns {{canonicalSha256:string|null, canonicalStore:string,
 *   rows:Array<{store:string, sha256:string|null, prefix?:string, status:"match"|"drift"|"unreadable"}>,
 *   driftCount:number, unreadableCount:number, hasDrift:boolean}}
 *
 * Mirrors apps/functions/src/lib/openai-key-health-logic.ts `computeDrift`.
 * Rules: unreadable store = informational (NOT drift); readable hash != canonical
 * = drift; unreadable canonical = hasDrift (can't trust the audit).
 */
export function computeDrift(canonicalStore, hashes) {
  const canonical = hashes.find((h) => h.store === canonicalStore)
  const canonicalSha256 = canonical && !canonical.unreadable ? canonical.sha256 : null

  const rows = []
  let driftCount = 0
  let unreadableCount = 0

  for (const h of hashes) {
    if (h.store === canonicalStore) continue
    if (h.unreadable || h.sha256 === null || h.sha256 === undefined) {
      unreadableCount++
      rows.push({ store: h.store, sha256: null, prefix: h.prefix, status: "unreadable" })
      continue
    }
    if (canonicalSha256 !== null && h.sha256 === canonicalSha256) {
      rows.push({ store: h.store, sha256: h.sha256, prefix: h.prefix, status: "match" })
    } else {
      driftCount++
      rows.push({ store: h.store, sha256: h.sha256, prefix: h.prefix, status: "drift" })
    }
  }

  return {
    canonicalSha256,
    canonicalStore,
    rows,
    driftCount,
    unreadableCount,
    hasDrift: canonicalSha256 === null || driftCount > 0,
  }
}

/**
 * Read an OPENAI key value from a `.env`-style file content for a given var name.
 * Returns the raw value (caller must hash/redact immediately) or null.
 * Pure string parse — does NOT touch the filesystem.
 */
export function readEnvVarFromContent(content, varName) {
  if (typeof content !== "string") return null
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    if (m[1] !== varName) continue
    let v = m[2]
    // strip surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    return v.length > 0 ? v : null
  }
  return null
}

/**
 * Parse simple CLI flags into a {flags:Set, values:Map} bag.
 *
 * Supports both `--key=value` and `--key value` for the flags named in
 * `valueFlags` (so `--project-id proj_abc` works like `--project-id=proj_abc`).
 * Any `--flag` not in `valueFlags` (and not `=`-joined) is a boolean flag.
 */
export function parseFlags(argv, valueFlags = []) {
  const valueSet = new Set([
    "key-file",
    "project-id",
    "sa-name",
    "old-sa-id",
    ...valueFlags,
  ])
  const flags = new Set()
  const values = new Map()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const eq = a.indexOf("=")
    if (eq >= 0) {
      values.set(a.slice(2, eq), a.slice(eq + 1))
      continue
    }
    const name = a.slice(2)
    const next = argv[i + 1]
    if (valueSet.has(name) && next !== undefined && !next.startsWith("--")) {
      values.set(name, next)
      i++ // consume the value token
    } else {
      flags.add(name)
    }
  }
  return { flags, values }
}
