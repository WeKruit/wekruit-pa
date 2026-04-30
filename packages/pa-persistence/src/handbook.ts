/**
 * Phase 29 — Agent Handbook (Bible-as-data) — per-slug + immutable versions.
 *
 * P10-locked schema (`pa-handbooks/{slug}` pointer doc):
 *   {
 *     slug: string,                      // doc id, e.g. "claire"
 *     version: number,                   // monotonic, ++ on each save
 *     sections: {
 *       identity:        string,
 *       hard_rules:      string[],
 *       default_posture: string,
 *       never_5:         string[],
 *       escape_hatch:    string,
 *       tone_flavors:    { [name: string]: string },
 *       human_tells:     string[],
 *       vocab:           { allowed: string[]; banned: string[] },
 *       playbooks:       { [name: string]: PlaybookSpec },
 *     },
 *     updatedBy: string,
 *     updatedAt: string,
 *     reason: string,
 *   }
 *
 * `pa-handbooks/{slug}/versions/{v}` is an IMMUTABLE full snapshot of the
 * pointer doc at version `v`. Created on every save. Never mutated.
 *
 * Audit: every save also writes `pa-audit-events` (action `handbook.update`
 * or `handbook.create`); reverts write `handbook.revert`. Mirrors Phase 24.5
 * feature-flag pattern.
 *
 * Cache: 30s TTL Map<slug, {handbook, expiresAt}>. Same shape as `getFlag()`
 * cache. Save invalidates the cached entry for `slug`.
 */

import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

// Collection names — exported so dashboard + migration script reuse exact strings.
export const HANDBOOKS_COLLECTION = "pa-handbooks"
export const HANDBOOK_VERSIONS_SUBCOLLECTION = "versions"
export const HANDBOOK_AUDIT_PREFIX = "handbook"

export const HANDBOOK_TTL_MS = 30_000

// Default slug per ADR. Agents without `handbookSlug` field fall back here.
export const DEFAULT_HANDBOOK_SLUG = "claire"

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export type PlaybookSpec = {
  name: string
  trigger: string
  steps: string[]
  exitCondition: string
}

export type HandbookSections = {
  identity: string
  hard_rules: string[]
  default_posture: string
  never_5: string[]
  escape_hatch: string
  tone_flavors: Record<string, string>
  human_tells: string[]
  vocab: { allowed: string[]; banned: string[] }
  playbooks: Record<string, PlaybookSpec>
}

export type HandbookDoc = {
  slug: string
  version: number
  sections: HandbookSections
  updatedBy: string
  updatedAt: string
  reason: string
}

export type SaveHandbookOpts = {
  actor: string
  reason: string
  /**
   * Optimistic concurrency check. If supplied, `saveHandbook` rejects if
   * the live pointer doc version differs (i.e. someone else saved in
   * between read and write — dashboard "stale, refresh"). Pass `null` /
   * omit on initial creation.
   */
  expectedVersion?: number | null
}

// ---------------------------------------------------------------------------
// Empty section scaffold — used for new slugs and as a defense against
// dashboard JSON edits that drop required keys.
// ---------------------------------------------------------------------------

export function emptyHandbookSections(): HandbookSections {
  return {
    identity: "",
    hard_rules: [],
    default_posture: "",
    never_5: [],
    escape_hatch: "",
    tone_flavors: {},
    human_tells: [],
    vocab: { allowed: [], banned: [] },
    playbooks: {},
  }
}

/**
 * Coerce a partial / dashboard-supplied sections object back into a fully
 * populated shape. Preserves unknown keys (logged at orchestrator load
 * time) but guarantees the canonical keys exist with the right shape so
 * `composeSystemPrompt` never NPEs on missing fields.
 */
export function normalizeHandbookSections(raw: unknown): HandbookSections {
  const empty = emptyHandbookSections()
  if (!raw || typeof raw !== "object") return empty
  const r = raw as Record<string, unknown>
  const ensureString = (v: unknown): string =>
    typeof v === "string" ? v : ""
  const ensureStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String(x))) : []
  const ensureStringMap = (v: unknown): Record<string, string> => {
    if (!v || typeof v !== "object") return {}
    const o: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") o[k] = val
    }
    return o
  }
  const ensureVocab = (v: unknown): { allowed: string[]; banned: string[] } => {
    if (!v || typeof v !== "object") return { allowed: [], banned: [] }
    const o = v as Record<string, unknown>
    return {
      allowed: ensureStringArray(o.allowed),
      banned: ensureStringArray(o.banned),
    }
  }
  const ensurePlaybooks = (v: unknown): Record<string, PlaybookSpec> => {
    if (!v || typeof v !== "object") return {}
    const out: Record<string, PlaybookSpec> = {}
    for (const [name, spec] of Object.entries(v as Record<string, unknown>)) {
      if (!spec || typeof spec !== "object") continue
      const s = spec as Record<string, unknown>
      out[name] = {
        name: typeof s.name === "string" ? s.name : name,
        trigger: typeof s.trigger === "string" ? s.trigger : "",
        steps: ensureStringArray(s.steps),
        exitCondition: typeof s.exitCondition === "string" ? s.exitCondition : "",
      }
    }
    return out
  }
  return {
    identity: ensureString(r.identity),
    hard_rules: ensureStringArray(r.hard_rules),
    default_posture: ensureString(r.default_posture),
    never_5: ensureStringArray(r.never_5),
    escape_hatch: ensureString(r.escape_hatch),
    tone_flavors: ensureStringMap(r.tone_flavors),
    human_tells: ensureStringArray(r.human_tells),
    vocab: ensureVocab(r.vocab),
    playbooks: ensurePlaybooks(r.playbooks),
    ...Object.fromEntries(
      Object.entries(r).filter(
        ([k]) =>
          ![
            "identity",
            "hard_rules",
            "default_posture",
            "never_5",
            "escape_hatch",
            "tone_flavors",
            "human_tells",
            "vocab",
            "playbooks",
          ].includes(k)
      )
    ),
  } as HandbookSections
}

// ---------------------------------------------------------------------------
// 30s TTL cache (mirror feature-flags pattern)
// ---------------------------------------------------------------------------

interface CacheEntry {
  doc: HandbookDoc
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
let cacheStats = { hits: 0, misses: 0 }

export function _clearHandbookCache(): void {
  cache.clear()
  cacheStats = { hits: 0, misses: 0 }
}

export function _getHandbookCacheStats(): {
  hits: number
  misses: number
  hitRate: number
} {
  const total = cacheStats.hits + cacheStats.misses
  return {
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    hitRate: total === 0 ? 0 : cacheStats.hits / total,
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function fromSnap(slug: string, raw: Record<string, unknown>): HandbookDoc {
  return {
    slug: typeof raw.slug === "string" ? (raw.slug as string) : slug,
    version: typeof raw.version === "number" ? (raw.version as number) : 0,
    sections: normalizeHandbookSections(raw.sections),
    updatedBy: typeof raw.updatedBy === "string" ? (raw.updatedBy as string) : "",
    updatedAt: typeof raw.updatedAt === "string" ? (raw.updatedAt as string) : "",
    reason: typeof raw.reason === "string" ? (raw.reason as string) : "",
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Fetch handbook by slug. Honors 30s TTL cache. Returns `null` when no
 * pointer doc exists (caller decides whether to fall back).
 */
export async function loadHandbook(
  db: Firestore,
  slug: string,
  ttlMs: number = HANDBOOK_TTL_MS
): Promise<HandbookDoc | null> {
  const now = Date.now()
  const cached = cache.get(slug)
  if (cached && cached.expiresAt > now) {
    cacheStats.hits += 1
    return cached.doc
  }
  cacheStats.misses += 1
  const snap = await db.collection(HANDBOOKS_COLLECTION).doc(slug).get()
  if (!snap.exists) return null
  const doc = fromSnap(slug, snap.data() as Record<string, unknown>)
  cache.set(slug, { doc, expiresAt: now + ttlMs })
  return doc
}

/**
 * List the immutable version snapshots for a slug (newest first by default).
 * Used by dashboard rollback + diff UI.
 */
export async function listVersions(
  db: Firestore,
  slug: string,
  opts: { limit?: number } = {}
): Promise<HandbookDoc[]> {
  const limit = opts.limit ?? 20
  const snap = await db
    .collection(HANDBOOKS_COLLECTION)
    .doc(slug)
    .collection(HANDBOOK_VERSIONS_SUBCOLLECTION)
    .orderBy("version", "desc")
    .limit(limit)
    .get()
  return snap.docs.map((d) =>
    fromSnap(slug, d.data() as Record<string, unknown>)
  )
}

/**
 * Read a specific version snapshot. Returns null if absent.
 */
export async function getVersion(
  db: Firestore,
  slug: string,
  version: number
): Promise<HandbookDoc | null> {
  const snap = await db
    .collection(HANDBOOKS_COLLECTION)
    .doc(slug)
    .collection(HANDBOOK_VERSIONS_SUBCOLLECTION)
    .doc(String(version))
    .get()
  if (!snap.exists) return null
  return fromSnap(slug, snap.data() as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Save a new handbook version. Writes (in a single transaction):
 *   1. `pa-handbooks/{slug}` pointer doc — version bumped to `prev.version + 1`
 *   2. `pa-handbooks/{slug}/versions/{v}` — immutable snapshot at new version
 *   3. `pa-audit-events/{auto}` — action `handbook.update` (or `.create`)
 *
 * Optimistic concurrency: when `opts.expectedVersion` is supplied and does
 * NOT match the live pointer's version, the transaction throws — dashboard
 * surfaces "stale, refresh" instead of clobbering a peer edit.
 *
 * Returns the persisted HandbookDoc (with bumped version + timestamps).
 */
export async function saveHandbook(
  db: Firestore,
  slug: string,
  sections: HandbookSections,
  opts: SaveHandbookOpts
): Promise<HandbookDoc> {
  if (!slug || typeof slug !== "string") {
    throw new Error("saveHandbook: slug is required")
  }
  if (!opts.reason || !opts.reason.trim()) {
    throw new Error("saveHandbook: reason is required (audit log)")
  }
  const normalized = normalizeHandbookSections(sections)
  const handbookRef = db.collection(HANDBOOKS_COLLECTION).doc(slug)
  const auditRef = db.collection(PA_COLLECTIONS.auditEvents).doc()
  const ts = nowIso()

  const persisted = await db.runTransaction(async (tx) => {
    const cur = await tx.get(handbookRef)
    const prev = cur.exists
      ? fromSnap(slug, cur.data() as Record<string, unknown>)
      : null
    if (
      typeof opts.expectedVersion === "number" &&
      prev &&
      prev.version !== opts.expectedVersion
    ) {
      throw new Error(
        `saveHandbook: stale version (expected ${opts.expectedVersion}, ` +
          `live ${prev.version}). Refresh and retry.`
      )
    }
    const nextVersion = (prev?.version ?? 0) + 1
    const snapshot: HandbookDoc = {
      slug,
      version: nextVersion,
      sections: normalized,
      updatedBy: opts.actor,
      updatedAt: ts,
      reason: opts.reason.trim(),
    }
    // Pointer doc — overwrites prior; same shape as snapshot.
    tx.set(handbookRef, snapshot)
    // Immutable snapshot — keyed by version number string.
    const versionRef = handbookRef
      .collection(HANDBOOK_VERSIONS_SUBCOLLECTION)
      .doc(String(nextVersion))
    tx.set(versionRef, snapshot)
    // Audit row.
    tx.set(auditRef, {
      actor: opts.actor,
      action: prev ? `${HANDBOOK_AUDIT_PREFIX}.update` : `${HANDBOOK_AUDIT_PREFIX}.create`,
      key: slug,
      oldValue: prev ? { version: prev.version, sections: prev.sections } : null,
      newValue: { version: nextVersion, sections: normalized },
      reason: snapshot.reason,
      ts,
    })
    return snapshot
  })

  // Cache invalidation — next read re-fetches the bumped pointer.
  cache.delete(slug)
  return persisted
}

/**
 * Revert to a prior version: copy `versions/{targetVersion}` sections back
 * into the pointer doc as a NEW version `prev.version + 1` with reason
 * "revert to v{targetVersion}: ...". Audit row action `handbook.revert`.
 *
 * Returns the new (post-revert) HandbookDoc, or throws if the requested
 * target version doesn't exist.
 */
export async function revertHandbook(
  db: Firestore,
  slug: string,
  targetVersion: number,
  opts: { actor: string; reason?: string }
): Promise<HandbookDoc> {
  const target = await getVersion(db, slug, targetVersion)
  if (!target) {
    throw new Error(
      `revertHandbook: ${slug} has no version ${targetVersion} to revert to.`
    )
  }
  const reason = (opts.reason ?? `revert to v${targetVersion}`).trim()
  const handbookRef = db.collection(HANDBOOKS_COLLECTION).doc(slug)
  const auditRef = db.collection(PA_COLLECTIONS.auditEvents).doc()
  const ts = nowIso()

  const persisted = await db.runTransaction(async (tx) => {
    const cur = await tx.get(handbookRef)
    const prev = cur.exists
      ? fromSnap(slug, cur.data() as Record<string, unknown>)
      : null
    if (!prev) {
      throw new Error(
        `revertHandbook: pointer doc for ${slug} missing — cannot revert`
      )
    }
    const nextVersion = prev.version + 1
    const snapshot: HandbookDoc = {
      slug,
      version: nextVersion,
      sections: target.sections,
      updatedBy: opts.actor,
      updatedAt: ts,
      reason,
    }
    tx.set(handbookRef, snapshot)
    const versionRef = handbookRef
      .collection(HANDBOOK_VERSIONS_SUBCOLLECTION)
      .doc(String(nextVersion))
    tx.set(versionRef, snapshot)
    tx.set(auditRef, {
      actor: opts.actor,
      action: `${HANDBOOK_AUDIT_PREFIX}.revert`,
      key: slug,
      oldValue: { version: prev.version, sections: prev.sections },
      newValue: { version: nextVersion, sections: target.sections },
      reason,
      ts,
      revertedToVersion: targetVersion,
    })
    return snapshot
  })

  cache.delete(slug)
  return persisted
}

// ---------------------------------------------------------------------------
// Compose helper — re-exported through pa-orchestrator/handbook/loader.ts
// (kept here so test fixtures can import without pulling the orchestrator).
// Compose order is fixed in code per ADR (intentional friction; reordering
// requires a code change). Order locked by P10 in PLAN T4 + decision defaults.
// ---------------------------------------------------------------------------

/**
 * Locked render order. Re-litigation goes through P10 + a code change.
 * MUST stay in sync with `composeSystemPrompt` below.
 */
export const HANDBOOK_RENDER_ORDER = [
  "identity",
  "hard_rules",
  "default_posture",
  "never_5",
  "escape_hatch",
  "vocab",
  "human_tells",
  "tone_flavors",
  "playbooks",
] as const

function renderList(items: string[]): string {
  return items
    .map((it) => it.trim())
    .filter((it) => it.length > 0)
    .map((it, i) => `${i + 1}. ${it}`)
    .join("\n")
}

function renderToneFlavors(map: Record<string, string>): string {
  const entries = Object.entries(map).filter(
    ([, v]) => typeof v === "string" && v.trim().length > 0
  )
  if (entries.length === 0) return ""
  return entries.map(([name, body]) => `${name}: ${body.trim()}`).join("\n")
}

function renderVocab(v: { allowed: string[]; banned: string[] }): string {
  const allow = (v.allowed ?? []).filter((x) => x.trim().length > 0)
  const ban = (v.banned ?? []).filter((x) => x.trim().length > 0)
  const parts: string[] = []
  if (allow.length > 0) parts.push(`Allowed: ${allow.join(" / ")}`)
  if (ban.length > 0) parts.push(`Banned: ${ban.join(" / ")}`)
  return parts.join("\n")
}

function renderPlaybooks(map: Record<string, PlaybookSpec>): string {
  const entries = Object.entries(map)
  if (entries.length === 0) return ""
  const blocks: string[] = []
  for (const [key, spec] of entries) {
    const name = (spec.name || key).trim()
    const lines: string[] = [`## ${name}`]
    if (spec.trigger?.trim()) lines.push(`Trigger: ${spec.trigger.trim()}`)
    if (Array.isArray(spec.steps) && spec.steps.length > 0) {
      lines.push("Steps:")
      lines.push(
        spec.steps
          .map((s, i) => `  ${i + 1}. ${String(s).trim()}`)
          .join("\n")
      )
    }
    if (spec.exitCondition?.trim()) lines.push(`Exit: ${spec.exitCondition.trim()}`)
    blocks.push(lines.join("\n"))
  }
  return blocks.join("\n\n")
}

const HEADER_BY_KEY: Record<(typeof HANDBOOK_RENDER_ORDER)[number], string> = {
  identity: "IDENTITY",
  hard_rules: "HARD RULES",
  default_posture: "DEFAULT POSTURE",
  never_5: "NEVERs",
  escape_hatch: "ESCAPE HATCH",
  vocab: "VOCAB",
  human_tells: "HUMAN TELLS",
  tone_flavors: "TONE FLAVORS",
  playbooks: "PLAYBOOKS",
}

/**
 * Compose `HandbookDoc.sections` into the canonical single-string
 * systemPrompt the orchestrator feeds the LLM. Empty sections are
 * skipped entirely (no header). Order is fixed (P10 ADR).
 */
export function composeSystemPrompt(handbook: HandbookDoc): string {
  const s = handbook.sections
  const blocks: string[] = []
  for (const key of HANDBOOK_RENDER_ORDER) {
    let body = ""
    switch (key) {
      case "identity":
        body = (s.identity ?? "").trim()
        break
      case "hard_rules":
        body = renderList(s.hard_rules ?? [])
        break
      case "default_posture":
        body = (s.default_posture ?? "").trim()
        break
      case "never_5":
        body = renderList(s.never_5 ?? [])
        break
      case "escape_hatch":
        body = (s.escape_hatch ?? "").trim()
        break
      case "vocab":
        body = renderVocab(s.vocab ?? { allowed: [], banned: [] })
        break
      case "human_tells":
        body = renderList(s.human_tells ?? [])
        break
      case "tone_flavors":
        body = renderToneFlavors(s.tone_flavors ?? {})
        break
      case "playbooks":
        body = renderPlaybooks(s.playbooks ?? {})
        break
    }
    if (!body) continue
    blocks.push(`# ${HEADER_BY_KEY[key]}\n${body}`)
  }
  return blocks.join("\n\n")
}
