/**
 * Phase B3 — Downstream trigger tag-write side effects.
 *
 * When a `pa-downstream-triggers` doc matches in the orchestrator's
 * `runDownstreamConnector` pipeline, this module performs the matching
 * tag-write side effect on `pa-users/{userId}.tags`. The dispatcher in
 * `downstream.ts` uses `TAG_SIDE_EFFECTS[triggerId]` (a `triggerId → handler`
 * lookup table) so generic downstream code stays free of per-trigger logic.
 *
 * Side effects today:
 *   1. `mentioned_layoff`            → `tags.urgentlySeeking = true`
 *   2. `mentioned_negative_company`  → append `tags.companyNegativeList`
 *   3. `mentioned_positive_company`  → append `tags.companyPositiveList`
 *                                      AND append `tags.targetCompanyTags`
 *                                      via the simple name→tag heuristic
 *
 * Spec invariants:
 *   - Idempotent — never duplicates entries; uses set-union semantics.
 *   - Capped at 30 entries per list (see `UserTagsSchema.max(30)`).
 *   - Company names normalized via `@pa/core-types.normalizeCompanyName`.
 *   - Never throws into the chat path — caller (`runDownstreamConnector`)
 *     swallows + logs errors.
 *
 * Sole-writer compliance (Phase 54): ALL writes route through
 * `applyPartialUserTags` from `./tags/user-tags-writer.js`. This module does
 * NOT write the user-tags blob directly — that would trip the
 * `sole-writer.test.ts` audit which greps for direct Firestore writes.
 * Reads are direct (read-only is not gated).
 */

import type { Firestore } from "firebase-admin/firestore"
import { normalizeCompanyName } from "@pa/core-types"
import { applyPartialUserTags } from "./tags/user-tags-writer.js"

const USERS_COLLECTION = "pa-users"

/** Max entries per list — mirrors UserTagsSchema.max(30) in shared-tags. */
export const TAG_LIST_CAP = 30

/**
 * Context passed to a tag side-effect handler when a downstream trigger
 * matched. `snippet` is the matched user-turn span (≤200 chars) coming from
 * `evaluateTriggers` — typed back via the trigger result.
 */
export interface TagSideEffectContext {
  db: Firestore
  userId: string
  snippet: string
}

/**
 * Side-effect handler signature. MUST be idempotent — handlers may be
 * invoked for repeat matches against the same snippet inside a cooldown
 * window when the dispatcher is later configured to fire multiple times.
 */
export type TagSideEffectHandler = (ctx: TagSideEffectContext) => Promise<void>

/**
 * Read raw `tags` object off `pa-users/{userId}` (best-effort; returns `{}`
 * when the doc / field is missing). Used by the list-append helpers to
 * compute the dedupe-union before delegating the write to
 * `applyPartialUserTags`.
 */
async function readExistingTags(
  db: Firestore,
  userId: string
): Promise<Record<string, unknown>> {
  try {
    const snap = await db.collection(USERS_COLLECTION).doc(userId).get()
    if (!snap.exists) return {}
    const data = snap.data() as Record<string, unknown> | undefined
    const t = data?.tags
    if (t && typeof t === "object" && !Array.isArray(t)) {
      return t as Record<string, unknown>
    }
  } catch {
    // fail-open — proceed as if the field were empty
  }
  return {}
}

/**
 * Write `urgentlySeeking=true` to `pa-users/{userId}.tags` via the sole
 * writer. Uses merge so other tag fields are preserved.
 */
export async function setUrgentlySeeking(
  db: Firestore,
  userId: string,
  value: boolean
): Promise<void> {
  await applyPartialUserTags(db, userId, { urgentlySeeking: value }, { source: "chat" })
}

type CompanyListField = "companyNegativeList" | "companyPositiveList"

/**
 * Append normalized company names to a user-tag list field, deduped + capped
 * at 30 entries (preserves existing entries; drops new candidates that
 * would push the list over the cap).
 *
 * Idempotent — calling twice with the same names is a no-op after the first
 * call. Reads current tags then writes via `applyPartialUserTags`.
 */
export async function appendCompanyList(
  db: Firestore,
  userId: string,
  field: CompanyListField,
  names: string[]
): Promise<void> {
  const normalized = names
    .map((n) => normalizeCompanyName(n))
    .filter((n) => n.length > 0)
  if (normalized.length === 0) return

  const tags = await readExistingTags(db, userId)
  const existingRaw = tags[field]
  const existing: string[] = Array.isArray(existingRaw)
    ? existingRaw.filter((v): v is string => typeof v === "string")
    : []

  // Union: preserve existing order, append new names in order.
  const seen = new Set(existing)
  const merged: string[] = [...existing]
  for (const name of normalized) {
    if (seen.has(name)) continue
    if (merged.length >= TAG_LIST_CAP) break // preserves oldest entries
    seen.add(name)
    merged.push(name)
  }

  // Skip the write when nothing changed.
  if (merged.length === existing.length && merged.every((v, i) => v === existing[i])) {
    return
  }

  await applyPartialUserTags(
    db,
    userId,
    { [field]: merged } as Partial<Record<CompanyListField, string[]>>,
    { source: "chat" }
  )
}

/**
 * Append to `tags.targetCompanyTags` (open-vocab CompanyTag list), deduped
 * + capped at 30. Tokens must already match `COMPANY_TAG_PATTERN`
 * (`[a-z][a-z0-9_]{1,63}`) — the caller (the positive-company handler)
 * derives tokens from the name→tag heuristic.
 */
export async function appendTargetCompanyTags(
  db: Firestore,
  userId: string,
  tagsToAdd: string[]
): Promise<void> {
  const sanitized = tagsToAdd
    .map((t) => (typeof t === "string" ? t.toLowerCase().trim() : ""))
    .filter((t) => /^[a-z][a-z0-9_]{1,63}$/.test(t))
  if (sanitized.length === 0) return

  const tags = await readExistingTags(db, userId)
  const existingRaw = tags.targetCompanyTags
  const existing: string[] = Array.isArray(existingRaw)
    ? existingRaw.filter((v): v is string => typeof v === "string")
    : []

  const seen = new Set(existing)
  const merged: string[] = [...existing]
  for (const t of sanitized) {
    if (seen.has(t)) continue
    if (merged.length >= TAG_LIST_CAP) break
    seen.add(t)
    merged.push(t)
  }

  if (merged.length === existing.length && merged.every((v, i) => v === existing[i])) {
    return
  }

  await applyPartialUserTags(db, userId, { targetCompanyTags: merged }, { source: "chat" })
}

/**
 * Small known-company set: maps a normalized company name (output of
 * `normalizeCompanyName`) to a canonical CompanyTag token. Used by the
 * positive-company handler to also seed `targetCompanyTags`. v1 list —
 * additions are cheap; absence is graceful (positive-list still updates).
 */
const KNOWN_COMPANY_TAG: Record<string, string> = {
  anthropic: "ai_native",
  openai: "ai_native",
  "scale-ai": "ai_native",
  mistral: "ai_native",
  perplexity: "ai_native",
  apple: "big_tech",
  google: "big_tech",
  meta: "big_tech",
  microsoft: "big_tech",
  amazon: "big_tech",
  nvidia: "big_tech",
  tesla: "big_tech",
  stripe: "fintech_unicorn",
  ramp: "fintech_unicorn",
  brex: "fintech_unicorn",
  plaid: "fintech_unicorn",
  coinbase: "crypto_web3",
}

/**
 * Map an industry/category keyword in the snippet (e.g. "fintech",
 * "agencies") to a canonical CompanyTag. Returns null when no rule matches.
 */
const CATEGORY_TAG_RULES: Array<[RegExp, string]> = [
  [/\bfintech\b/i, "fintech_unicorn"],
  [/\bcrypto|web3|blockchain\b/i, "crypto_web3"],
  [/\bagenc(y|ies)|consulting\b/i, "agency_consulting"],
  [/\bbig.?tech\b/i, "big_tech"],
  [/\bmag.?7\b/i, "mag_7"],
  [/\bai.native|ai startups?\b/i, "ai_native"],
  [/\bgov(ernment)?\s+(contract|contractor)s?\b/i, "gov_contract"],
  [/\bretail|ops\b/i, "retail_ops"],
  [/\byc\b|y combinator/i, "yc_active"],
  [/\bunicorn\b/i, "unicorn"],
]

/**
 * Heuristic extractor: pull capitalized multi-letter spans from a snippet
 * and treat them as candidate company names. Filters out a small stop-word
 * set (start-of-sentence capitalization, common pronouns, "I").
 *
 * v1 — keeps things simple. The dispatcher caps each list at 30, so
 * over-extraction is bounded; under-extraction means the user's pref just
 * doesn't get recorded that turn (recoverable on the next mention).
 */
export function extractCompanyNames(snippet: string): string[] {
  if (typeof snippet !== "string" || snippet.length === 0) return []
  // Capitalized words: one capital + ≥2 letters (filters "I", "A").
  // Allows multi-word spans separated by spaces or hyphens.
  const re = /\b([A-Z][a-zA-Z0-9]{1,})(?:[\s\-]+[A-Z][a-zA-Z0-9]+)*\b/g
  const STOP = new Set([
    "I",
    "I'm",
    "I've",
    "I'd",
    "I'll",
    "We",
    "You",
    "They",
    "He",
    "She",
    "It",
    "The",
    "A",
    "An",
    "My",
    "Our",
    "Your",
    "Their",
    "His",
    "Her",
    "Its",
    "OK",
    "No",
    "Yes",
    "But",
    "And",
    "Or",
    "So",
    "If",
    "When",
    "Where",
    "Why",
    "How",
    "What",
    "Who",
    "Hey",
    "Hi",
    "Hello",
  ])
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(snippet)) !== null) {
    const raw = m[0].trim()
    if (!raw || STOP.has(raw)) continue
    if (raw.length < 2) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
}

/**
 * Map company names + category keywords in the snippet to canonical
 * CompanyTag tokens for `targetCompanyTags`. Combines name→tag lookups
 * (e.g. "Anthropic" → "ai_native") with category regex rules
 * (e.g. "fintech" → "fintech_unicorn").
 */
export function inferCompanyTagsFromSnippet(snippet: string, names: string[]): string[] {
  const out = new Set<string>()
  for (const raw of names) {
    const norm = normalizeCompanyName(raw)
    const tag = KNOWN_COMPANY_TAG[norm]
    if (tag) out.add(tag)
  }
  for (const [re, tag] of CATEGORY_TAG_RULES) {
    if (re.test(snippet)) out.add(tag)
  }
  return Array.from(out)
}

/**
 * `triggerId → handler` lookup table. The downstream connector calls the
 * matching entry (if any) AFTER firePostHook + recordFire. Handlers MUST
 * be idempotent and never throw — the connector swallows + logs errors so
 * a failing side effect never breaks the chat path.
 *
 * Unknown trigger IDs are a no-op (no entry, no side effect) — partners
 * can add new triggers without forcing a code change here, and only the
 * triggers we've explicitly wired produce tag writes.
 */
export const TAG_SIDE_EFFECTS: Record<string, TagSideEffectHandler> = {
  mentioned_layoff: async ({ db, userId }) => {
    await setUrgentlySeeking(db, userId, true)
  },
  mentioned_negative_company: async ({ db, userId, snippet }) => {
    const names = extractCompanyNames(snippet)
    if (names.length === 0) return
    await appendCompanyList(db, userId, "companyNegativeList", names)
  },
  mentioned_positive_company: async ({ db, userId, snippet }) => {
    const names = extractCompanyNames(snippet)
    if (names.length > 0) {
      await appendCompanyList(db, userId, "companyPositiveList", names)
    }
    const tags = inferCompanyTagsFromSnippet(snippet, names)
    if (tags.length > 0) {
      await appendTargetCompanyTags(db, userId, tags)
    }
  },
}

/**
 * Dispatcher invoked by `runDownstreamConnector` after a successful match.
 * Looks up the handler in `TAG_SIDE_EFFECTS` and invokes it; logs +
 * swallows any thrown error so the chat path is never blocked.
 */
export async function applyTagSideEffect(
  db: Firestore,
  userId: string,
  triggerId: string,
  snippet: string,
  log?: (msg: string, fields?: Record<string, unknown>) => void
): Promise<void> {
  const handler = TAG_SIDE_EFFECTS[triggerId]
  if (!handler) return
  try {
    await handler({ db, userId, snippet })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    if (log) log("tag side effect failed", { triggerId, userId, error: errMsg })
    else console.log(`[downstream] tag side effect failed`, { triggerId, userId, error: errMsg })
  }
}
