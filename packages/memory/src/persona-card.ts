import type { MemoryFact } from "@pa/core-types"

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
 *  - Cap to ≤ 20 facts (oldest-first eviction).
 *  - Cap to ≤ 1500 JS string-length chars total (oldest-first eviction).
 *    If a single fact alone exceeds the cap, truncate its content to
 *    200 chars + "…".
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

export function buildPersonaCard(facts: MemoryFact[]): string | null {
  if (!facts || facts.length === 0) return null

  // 1) Filter to confirmed only. Discard everything else (deleted, missing
  //    status, etc.) — confirmed is the upstream gate per facts.ts.
  const confirmed = facts.filter((f) => f && f.status === "confirmed")
  if (confirmed.length === 0) return null

  // 2) Stable sort: createdAt asc, then id asc as tiebreak.
  //    Copy first (do NOT mutate input).
  const sorted = [...confirmed].sort((a, b) => {
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
  for (const f of sorted) {
    const key = normalizeFactContent(f.content)
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(f)
  }
  if (deduped.length === 0) return null

  // 4) Cap to MAX_FACTS, oldest-first eviction (drop oldest, keep most
  //    recent MAX_FACTS).
  let kept = deduped.length > MAX_FACTS
    ? deduped.slice(deduped.length - MAX_FACTS)
    : deduped

  // 5) Char cap (≤ MAX_CHARS). Try formatting; if over, drop oldest until
  //    under cap. Single-fact overflow: truncate that fact's content.
  const format = (items: MemoryFact[]): string => {
    const lines = items.map((f) => `- ${f.content}`)
    return [HEADING, ...lines].join("\n")
  }

  let card = format(kept)
  while (card.length > MAX_CHARS && kept.length > 1) {
    // drop oldest (index 0) and re-render
    kept = kept.slice(1)
    card = format(kept)
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
