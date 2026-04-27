import type { MemoryFact } from "@pa/core-types"
import { rankFactsByImportance } from "./persona-card-ranker.js"

/**
 * Phase 11.1.1 — deterministic, Unicode-safe persona-card builder.
 *
 * Pure function. Zero I/O (no Firestore / Mem0 reads). Operates on the
 * `MemoryFact[]` snapshot the orchestrator already loaded via
 * `store.listMemoryFacts(event.userId)`.
 *
 * Contract (frozen by .planning/phases/11.../11.1-PLAN.md §3.11.1.1):
 *  - Filter to `status === "confirmed"`.
 *  - Sort ascending by `createdAt` (ISO lexicographic), tiebreak by `id`.
 *  - Dedup by trim+collapse-whitespace normalized `content`.
 *  - Cap to ≤ 20 facts. Memory-opt P0-2: eviction is now
 *    importance-weighted (see `persona-card-ranker.ts`); the lowest-
 *    score facts are dropped first. When all facts have equal score
 *    (legacy data with no salience/access signals), the ranker
 *    collapses to recency-desc ordering, matching the prior
 *    oldest-first FIFO semantics.
 *  - Cap to ≤ 1500 JS string-length chars total. Char-cap eviction is
 *    also importance-weighted (drop the lowest-scoring kept fact, then
 *    re-render). If a single fact alone exceeds the cap, truncate its
 *    content to 200 chars + "…".
 *  - Format:
 *      Persona facts (confirmed):
 *      - <fact 1 content>
 *      - <fact 2 content>
 *  - Empty input or zero confirmed → return `null` (no bare heading).
 *  - No mutation of the input array.
 *  - No lowercasing / no NFC-normalization beyond Firestore round-trip.
 */
const HEADING = "Persona facts (confirmed):"
const MAX_FACTS = 20
const MAX_CHARS = 1500
const SINGLE_FACT_OVERFLOW_CAP = 200

function normalizeFactContent(content: string): string {
  return content.trim().replace(/\s+/g, " ")
}

function truncateOversizedFact(content: string): string {
  // Only invoked when a single fact alone exceeds MAX_CHARS once formatted
  // with heading + "- " prefix; we trim raw content to SINGLE_FACT_OVERFLOW_CAP
  // and append the ellipsis sentinel so the cap is honored deterministically.
  if (content.length <= SINGLE_FACT_OVERFLOW_CAP) return content
  return content.slice(0, SINGLE_FACT_OVERFLOW_CAP) + "…"
}

export function buildPersonaCard(
  facts: MemoryFact[],
  opts?: { now?: () => number }
): string | null {
  if (!facts || facts.length === 0) return null

  // 1) Filter to confirmed only. Discard everything else (deleted, missing
  //    status, etc.) — confirmed is the upstream gate per facts.ts.
  const confirmed = facts.filter((f) => f && f.status === "confirmed")
  if (confirmed.length === 0) return null

  // 2) Stable sort: createdAt asc, then id asc as tiebreak. This is the
  //    EMISSION order; importance-weighted eviction (step 4) operates on
  //    a separately-ranked copy.
  //    Copy first (do NOT mutate input).
  const sortedAsc = [...confirmed].sort((a, b) => {
    const ca = a.createdAt ?? ""
    const cb = b.createdAt ?? ""
    if (ca !== cb) return ca < cb ? -1 : 1
    const ia = a.id ?? ""
    const ib = b.id ?? ""
    if (ia !== ib) return ia < ib ? -1 : 1
    return 0
  })

  // 3) Dedup by normalized content. Earlier (older) entry wins so order
  //    of the surviving items remains createdAt-ascending.
  const seen = new Set<string>()
  const deduped: MemoryFact[] = []
  for (const f of sortedAsc) {
    const key = normalizeFactContent(f.content)
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(f)
  }
  if (deduped.length === 0) return null

  // 4) Memory-opt P0-2: importance-weighted eviction. Rank dedup'd facts
  //    by score, take top MAX_FACTS, then re-emit in createdAt-asc order.
  const nowMs = opts?.now ? opts.now() : Date.now()
  const ranked = rankFactsByImportance(deduped, nowMs)
  // Build a quick id-set of survivors. Falls back to all when count is
  // already <= cap (avoid pointless filtering allocation).
  let keptIds: Set<string>
  if (ranked.length > MAX_FACTS) {
    keptIds = new Set(ranked.slice(0, MAX_FACTS).map((r) => r.fact.id))
  } else {
    keptIds = new Set(ranked.map((r) => r.fact.id))
  }
  let kept = deduped.filter((f) => keptIds.has(f.id))

  // 5) Char cap (≤ MAX_CHARS). Drop the lowest-scoring kept fact until
  //    under cap. Single-fact overflow: truncate that fact's content.
  const format = (items: MemoryFact[]): string => {
    const lines = items.map((f) => `- ${f.content}`)
    return [HEADING, ...lines].join("\n")
  }

  let card = format(kept)
  if (card.length > MAX_CHARS && kept.length > 1) {
    // Build a per-id score map so we can drop lowest-scoring first.
    const scoreById = new Map<string, number>(ranked.map((r) => [r.fact.id, r.score]))
    while (card.length > MAX_CHARS && kept.length > 1) {
      // Find the lowest-score kept fact; tiebreak: oldest createdAt first
      // (drops least valuable AND least recent).
      let dropIdx = 0
      let dropScore = scoreById.get(kept[0]!.id) ?? 0
      let dropCreated = kept[0]!.createdAt ?? ""
      for (let i = 1; i < kept.length; i++) {
        const s = scoreById.get(kept[i]!.id) ?? 0
        const c = kept[i]!.createdAt ?? ""
        if (s < dropScore || (s === dropScore && c < dropCreated)) {
          dropIdx = i
          dropScore = s
          dropCreated = c
        }
      }
      kept = kept.filter((_, i) => i !== dropIdx)
      card = format(kept)
    }
  }
  if (card.length > MAX_CHARS && kept.length === 1) {
    // Single fact alone overshoots the cap. Truncate its content per
    // contract: 200 chars + "…".
    const only = kept[0]!
    const truncated: MemoryFact = { ...only, content: truncateOversizedFact(only.content) }
    kept = [truncated]
    card = format(kept)
  }

  return card
}
