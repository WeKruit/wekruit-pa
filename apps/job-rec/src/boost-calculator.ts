/**
 * v1.5 / iter30 WS8 — BoostCalculator: Firestore-backed weight tables.
 *
 * Replaces the hardcoded TS const `AI_AGENT_SKILL_WEIGHTS` (match-weights.ts:49)
 * with a Firestore-loaded weight table editable from the `/match-weights`
 * dashboard. Operators edit weight rows and changes go live within 30s with
 * no redeploy (mirrors `playbook-cache.ts` 30-second TTL pattern).
 *
 * Forward-compat with WS2 `pa-canonical-tags`: each row carries a nullable
 * `skillCanonical` FK that WS2's backfill can populate later. Until then,
 * matching falls back to the same case-insensitive substring rule used by
 * the legacy const path — byte-identical scoring contract preserved.
 *
 * Pure / deterministic. O(n × |weights|) ≈ < 2ms over 25 jobs × 30 weights.
 *
 * Caller contract:
 *   - `loadTable(tableKey)` ⇒ `{ table, rows }`. Throws on Firestore error;
 *     callers catch and fall through to the TS const path during the
 *     dual-read window (`paWeightsFromFirestore` flag, default OFF).
 *   - `applyBoost(...)` ⇒ identical reorder semantics as
 *     `applyWeightedMatchBoost` in match-weights.ts:210, plus
 *     `BoostExplainerInput[]` for the redesigned explainer prompt.
 *
 * @module boost-calculator
 */
import type { Firestore, Timestamp } from "firebase-admin/firestore"
import {
  WEIGHTED_MATCH_BOOSTS,
  type SkillWeight,
  type WeightedMatchExplanation,
  type WeightedMatchResult,
} from "./match-weights.js"

// ---------------------------------------------------------------------------
// Types — match Firestore docs 1:1
// ---------------------------------------------------------------------------

export type WeightCategory = "core" | "supporting" | "generic"

/** A single weight row — mirrors `pa-match-weight-tables/{key}/items/{skillKey}`. */
export type WeightRow = {
  /** Stable doc id within the table (e.g. "rag" or "tool-calling"). */
  skillKey: string
  /** Lowercase substring-match probe (legacy compat with match-weights.ts:32). */
  skill: string
  /**
   * Forward-compat FK → pa-canonical-tags (WS2). Null during migration window;
   * WS2 backfill populates once canonical-tags land.
   */
  skillCanonical: string | null
  /** 0.5 (generic) – 3.0 (core hot keyword in 2026 market). */
  weight: number
  category: WeightCategory
  /** Convention: matches owning `tableKey`. */
  market: string
  updatedAt?: Timestamp | string | null
  updatedBy?: string
  reason?: string
}

/** Table metadata — mirrors `pa-match-weight-tables/{tableKey}`. */
export type WeightTable = {
  tableKey: string
  name: string
  description: string
  active: boolean
  defaultForRoles: string[]
  rowCount: number
  /** Bumped on any item write — used in explainer cache key (§7). */
  version: number
  updatedAt?: Timestamp | string | null
  updatedBy?: string
}

/** Per-job boost explanation — input to the explainer (§6 of WS-8 detail-plan). */
export type BoostExplainerInput = {
  jobId: string
  hits: Array<{
    skill: string
    skillCanonical: string | null
    category: WeightCategory
    weight: number
    /** Where the hit landed; `cv-skill` is the only one populated MVP. */
    matchedAgainst: "cv-skill" | "cv-bullet" | "title"
  }>
  coreMissing: Array<{ skill: string; weight: number }>
  /** 1.0 = neutral, 1.2 = strong, 0.85 = weak. */
  totalBoostMult: number
  tableKey: string
  /** Cache invalidation key — explainer keys cache by this. */
  tableVersion: number
}

// ---------------------------------------------------------------------------
// Collections + flag
// ---------------------------------------------------------------------------

export const WEIGHT_TABLES_COLLECTION = "pa-match-weight-tables"
export const WEIGHT_ITEMS_SUBCOLLECTION = "items"

/** Default OFF; ramps 0% → 1% → 100% per detail-plan §10. */
export const WEIGHTS_FROM_FIRESTORE_FLAG_KEY = "paWeightsFromFirestore"

// ---------------------------------------------------------------------------
// Cache (30s TTL, mirror playbook-cache.ts)
// ---------------------------------------------------------------------------

export const WEIGHT_CACHE_TTL_MS = 30_000

interface CacheEntry {
  table: WeightTable
  rows: WeightRow[]
  expiresAt: number
}

/** Per-tableKey cache (one entry per table, since multiple markets coexist). */
const cache: Map<string, CacheEntry> = new Map()

/** Test-only — clear cache between tests. */
export function _clearWeightCache(): void {
  cache.clear()
}

// ---------------------------------------------------------------------------
// Pure helpers — verbatim port of match-weights.ts:99-127 with WeightRow
// ---------------------------------------------------------------------------

function lower(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase().trim() : ""
}

function userHasSkill(userSkills: readonly string[], weightSkill: string): boolean {
  const ws = weightSkill.toLowerCase()
  for (const us of userSkills) {
    const u = lower(us)
    if (!u) continue
    if (u === ws) return true
    if (u.includes(ws)) return true
    if (ws.includes(u) && u.length >= 3) return true
  }
  return false
}

function jobRequires(jobSkills: readonly string[], weightSkill: string): boolean {
  return userHasSkill(jobSkills, weightSkill)
}

/**
 * Score (user, job) against weight rows. Identical math to
 * `computeWeightedMatchScore` in match-weights.ts:142 — verbatim port so
 * the parity test passes byte-for-byte against the const path.
 */
export function computeWeightedMatchScoreFromRows(
  userSkills: readonly string[],
  jobSkills: readonly string[],
  rows: readonly WeightRow[]
): WeightedMatchResult {
  const matched: SkillWeight[] = []
  const coreMissing: SkillWeight[] = []
  let matchedSum = 0
  let applicableSum = 0
  for (const r of rows) {
    const required = jobRequires(jobSkills, r.skill)
    if (!required) continue
    applicableSum += r.weight
    const sw: SkillWeight = { skill: r.skill, weight: r.weight, category: r.category }
    if (userHasSkill(userSkills, r.skill)) {
      matched.push(sw)
      matchedSum += r.weight
    } else if (r.category === "core") {
      coreMissing.push(sw)
    }
  }
  const score = applicableSum > 0 ? matchedSum / applicableSum : 1.0
  return { score, matched, coreMissing }
}

/**
 * Convert the legacy TS-const shape → WeightRow (used by the dual-read
 * fallback path in daily-batch). Synthesizes a stable skillKey, fills the
 * `skillCanonical` FK with null (WS2 will backfill), and stamps the
 * `market` to the owning table key.
 */
export function rowFromConst(w: SkillWeight, market = "ai-agent-2026"): WeightRow {
  return {
    skillKey: w.skill.toLowerCase().trim().replace(/\s+/g, "-"),
    skill: w.skill,
    skillCanonical: null,
    weight: w.weight,
    category: w.category,
    market,
    updatedAt: null,
    updatedBy: "match-weights.ts:AI_AGENT_SKILL_WEIGHTS",
    reason: "synthesized from TS const (legacy fallback)",
  }
}

// ---------------------------------------------------------------------------
// BoostCalculator class
// ---------------------------------------------------------------------------

export type BoostCalculatorDeps = {
  db: Firestore
  /** Test-only: pin time for TTL tests. Default `Date.now`. */
  now?: () => number
  /** Test-only: 0 to bypass cache. Default `WEIGHT_CACHE_TTL_MS`. */
  ttlMs?: number
  log?: (event: string, payload?: Record<string, unknown>) => void
}

export class BoostCalculator {
  private readonly db: Firestore
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly log: (event: string, payload?: Record<string, unknown>) => void

  constructor(deps: BoostCalculatorDeps) {
    this.db = deps.db
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? WEIGHT_CACHE_TTL_MS
    this.log = deps.log ?? (() => {})
  }

  /**
   * Load a weight table (metadata + items) via cache. Refreshes when expired.
   * Throws on Firestore failure — caller catches and falls through to the TS
   * const path (zero-cost neutral mult=1.0, mirrors
   * applyWeightedMatchBoost's contract in match-weights.ts:218).
   */
  async loadTable(tableKey: string): Promise<{ table: WeightTable; rows: WeightRow[] }> {
    const now = this.now()
    const entry = cache.get(tableKey)
    if (entry && entry.expiresAt > now) {
      return { table: entry.table, rows: entry.rows }
    }
    const tableRef = this.db.collection(WEIGHT_TABLES_COLLECTION).doc(tableKey)
    const tableSnap = await tableRef.get()
    if (!tableSnap.exists) {
      throw new Error(`BoostCalculator: weight table not found: ${tableKey}`)
    }
    const tableRaw = (tableSnap.data() ?? {}) as Record<string, unknown>
    const table: WeightTable = {
      tableKey: (tableRaw.tableKey as string) ?? tableKey,
      name: (tableRaw.name as string) ?? tableKey,
      description: (tableRaw.description as string) ?? "",
      active: tableRaw.active === undefined ? true : Boolean(tableRaw.active),
      defaultForRoles: Array.isArray(tableRaw.defaultForRoles)
        ? (tableRaw.defaultForRoles as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      rowCount:
        typeof tableRaw.rowCount === "number" ? tableRaw.rowCount : 0,
      version:
        typeof tableRaw.version === "number" ? tableRaw.version : 1,
      updatedAt: (tableRaw.updatedAt as Timestamp | null | undefined) ?? null,
      updatedBy: (tableRaw.updatedBy as string) ?? "",
    }

    const itemsSnap = await tableRef.collection(WEIGHT_ITEMS_SUBCOLLECTION).get()
    const rows: WeightRow[] = itemsSnap.docs.map((d) => {
      const raw = (d.data() ?? {}) as Record<string, unknown>
      const cat = raw.category
      const category: WeightCategory =
        cat === "core" || cat === "supporting" || cat === "generic" ? cat : "supporting"
      return {
        skillKey: d.id,
        skill: (raw.skill as string) ?? d.id,
        skillCanonical: typeof raw.skillCanonical === "string" ? raw.skillCanonical : null,
        weight: typeof raw.weight === "number" ? raw.weight : 1.0,
        category,
        market: (raw.market as string) ?? tableKey,
        updatedAt: (raw.updatedAt as Timestamp | null | undefined) ?? null,
        updatedBy: (raw.updatedBy as string) ?? "",
        reason: (raw.reason as string) ?? "",
      }
    })

    const fresh: CacheEntry = { table, rows, expiresAt: now + this.ttlMs }
    cache.set(tableKey, fresh)
    this.log("boost_calc.cache_refresh", { tableKey, rowCount: rows.length, version: table.version })
    return { table, rows }
  }

  /**
   * Score a single (user, job) pair. Pure / deterministic. Re-exported as a
   * static helper for tests; instance method exists for fluent use.
   */
  computeWeightedMatchScore(
    userSkills: readonly string[],
    jobSkills: readonly string[],
    rows: readonly WeightRow[]
  ): WeightedMatchResult {
    return computeWeightedMatchScoreFromRows(userSkills, jobSkills, rows)
  }

  /**
   * Apply boost to a ranked candidate set. Returns reordered jobs +
   * `BoostExplainerInput[]` for the new explainer prompt (§6).
   *
   * Identical reorder semantics to `applyWeightedMatchBoost` in
   * match-weights.ts:210 (parity-tested in
   * `__tests__/boost-calculator-parity.test.ts`).
   */
  applyBoost<J extends { id: string; requiredSkills?: readonly string[] | null }>(
    jobs: readonly J[],
    userSkills: readonly string[],
    table: WeightTable,
    rows: readonly WeightRow[],
    baseScores?: ReadonlyMap<string, number | null>
  ): {
    jobs: J[]
    explanations: WeightedMatchExplanation[]
    explainerInputs: BoostExplainerInput[]
  } {
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return { jobs: [], explanations: [], explainerInputs: [] }
    }
    const explanations: WeightedMatchExplanation[] = []
    const explainerInputs: BoostExplainerInput[] = []
    let anyNonNeutral = false

    const scored = jobs.map((j, idx) => {
      const required = Array.isArray(j.requiredSkills) ? j.requiredSkills : []
      const result = computeWeightedMatchScoreFromRows(userSkills, required, rows)
      let mult: number = WEIGHTED_MATCH_BOOSTS.NEUTRAL

      if (result.matched.length > 0 || result.coreMissing.length > 0) {
        if (result.score >= 0.66) mult = WEIGHTED_MATCH_BOOSTS.STRONG
        else if (result.score >= 0.33) mult = WEIGHTED_MATCH_BOOSTS.LEAN
        else mult = WEIGHTED_MATCH_BOOSTS.WEAK
        if (mult !== WEIGHTED_MATCH_BOOSTS.NEUTRAL) anyNonNeutral = true

        explanations.push({
          jobId: j.id,
          score: result.score,
          boostMult: mult,
          matched: result.matched,
          coreMissing: result.coreMissing,
        })

        // Build BoostExplainerInput hits with the canonical-FK + matchedAgainst
        // fields. matchedAgainst defaults to cv-skill — we don't yet probe
        // bullets/title; future work (T18+).
        const hits = result.matched.map((m) => {
          const row = rows.find((r) => r.skill === m.skill)
          return {
            skill: m.skill,
            skillCanonical: row?.skillCanonical ?? null,
            category: m.category,
            weight: m.weight,
            matchedAgainst: "cv-skill" as const,
          }
        })
        explainerInputs.push({
          jobId: j.id,
          hits,
          coreMissing: result.coreMissing.map((c) => ({ skill: c.skill, weight: c.weight })),
          totalBoostMult: mult,
          tableKey: table.tableKey,
          tableVersion: table.version,
        })
      }

      const base = (() => {
        const s = baseScores?.get(j.id)
        if (typeof s === "number" && Number.isFinite(s) && s > 0) return s
        return 1.0
      })()
      return { j, score: base * mult, idx }
    })

    if (!anyNonNeutral) {
      return { jobs: jobs.slice(), explanations: [], explainerInputs: [] }
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.idx - b.idx // stable on ties
    })
    return { jobs: scored.map((s) => s.j), explanations, explainerInputs }
  }
}
