/**
 * Copy of `apps/macos-imessage-worker/src/chunker.ts` (Phase 20) — used by
 * `output-normalizer` for >600 char splits. Coexists with worker copy until
 * Phase 21 Sendblue migration.
 *
 * Phase 15 — Chunked-message simulation.
 *
 * Pure function: take an assistant reply text, return an ordered list of
 * chunks plus inter-chunk delays. Used by the outbound dispatch path when
 * the typing-indicator feature is enabled (env flag
 * PA_TYPING_INDICATOR_DISABLED=false / unset). The reply *content* is
 * preserved exactly: `chunks.join("\n\n" or " ")` reconstructs the
 * original text after trim normalization.
 *
 * Hard invariants (Phase 15 PLAN §3c, red lines):
 *  - Never split inside a fenced code block (``` ... ```).
 *  - Never split inside a markdown link (`[label](url)`).
 *  - If text length ≤ MIN_CHUNKABLE_LEN (60), return a single chunk.
 *  - If no clean split point exists, return a single chunk.
 *  - Chunk count capped at MAX_CHUNKS (3).
 *  - delaysMs.length === chunks.length - 1.
 *  - Each delay ∈ [MIN_DELAY_MS, MAX_DELAY_MS] = [800, 1500].
 */

export type ChunkPlan = {
  chunks: string[]
  delaysMs: number[]
}

export type PlanChunksOptions = {
  /** Cap on total chunks. Default 3. */
  maxChunks?: number
  /** Minimum length below which we always send as a single chunk. Default 60. */
  minChunkableLen?: number
  /** Inter-chunk delay range, milliseconds. Default [800, 1500]. */
  minDelayMs?: number
  maxDelayMs?: number
  /**
   * Override the random source for tests. Returns a value in [0, 1).
   * Default Math.random.
   */
  random?: () => number
}

const DEFAULT_MAX_CHUNKS = 3
const DEFAULT_MIN_CHUNKABLE_LEN = 60
const DEFAULT_MIN_DELAY_MS = 800
const DEFAULT_MAX_DELAY_MS = 1500

/**
 * Compute the set of indices that fall *inside* a fenced code block
 * (i.e. between an opening ``` and the matching closing ```).
 * Splitting at any of these indices would break the fence.
 *
 * The fence regex matches the canonical markdown fence on its own line
 * boundary. We scan greedily and toggle inside/outside.
 */
function computeProtectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []

  // 1. Fenced code blocks: ``` … ```
  const fenceRe = /```/g
  let m: RegExpExecArray | null
  let openStart: number | null = null
  while ((m = fenceRe.exec(text)) !== null) {
    if (openStart === null) {
      openStart = m.index
    } else {
      // Range covers from start of opening fence through end of closing fence.
      ranges.push([openStart, m.index + m[0].length])
      openStart = null
    }
  }
  if (openStart !== null) {
    // Unmatched fence — treat the rest of the text as protected.
    ranges.push([openStart, text.length])
  }

  // 2. Markdown links: [label](url). Catches the bracketed pair plus
  //    the immediately-following parenthesized URL. We don't try to be
  //    strict about nested brackets — splitting inside the [..] or (..)
  //    is what we want to prevent.
  const linkRe = /\[[^\]\n]*\]\([^)\n]*\)/g
  while ((m = linkRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length])
  }

  return ranges
}

function isInsideProtected(idx: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) {
    if (idx >= s && idx < e) return true
  }
  return false
}

/**
 * Find candidate split positions in priority order.
 *  - Priority 1: paragraph boundaries (`\n\n` or more).
 *  - Priority 2: sentence boundaries (`. `, `! `, `? `, plus `。 ` `！ ` `？ `
 *    and the same with newline trailing).
 *
 * Each candidate is the index AFTER the boundary punctuation/whitespace,
 * so `text.slice(0, idx)` is the chunk and `text.slice(idx)` is the rest.
 */
function findParagraphBoundaries(text: string, protectedRanges: Array<[number, number]>): number[] {
  const out: number[] = []
  // Match one-or-more blank lines; tolerate \r\n.
  const re = /(\r?\n[ \t]*){2,}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length
    if (!isInsideProtected(m.index, protectedRanges)) {
      out.push(end)
    }
  }
  return out
}

function findSentenceBoundaries(text: string, protectedRanges: Array<[number, number]>): number[] {
  const out: number[] = []
  // English: . ! ? followed by whitespace.
  // CJK: 。 ！ ？ followed by optional space (often no space in CJK).
  const re = /([.!?])\s+|([。！？])\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length
    if (!isInsideProtected(m.index, protectedRanges)) {
      out.push(end)
    }
  }
  return out
}

/**
 * Greedy split: walk through candidate boundaries and pick the ones that
 * keep each chunk roughly balanced (at least minChunkableLen long where
 * possible). Cap at maxChunks total chunks.
 */
function chooseSplits(
  text: string,
  candidates: number[],
  maxChunks: number,
  perChunkMinLen: number
): number[] {
  if (candidates.length === 0) return []
  const targetChunks = Math.min(maxChunks, candidates.length + 1)
  // Aim for roughly equal-length chunks: total / targetChunks.
  const targetLen = Math.ceil(text.length / targetChunks)
  const splits: number[] = []
  let cursor = 0
  while (splits.length < targetChunks - 1) {
    const desired = cursor + targetLen
    // Pick the candidate closest to `desired` that is also at least
    // `perChunkMinLen` after `cursor` and at least `perChunkMinLen`
    // before `text.length` (so the trailing chunk also passes the floor).
    let best = -1
    let bestDist = Infinity
    for (const c of candidates) {
      if (c <= cursor) continue
      if (c - cursor < perChunkMinLen) continue
      if (text.length - c < perChunkMinLen) continue
      // Don't reuse a split.
      if (splits.includes(c)) continue
      const d = Math.abs(c - desired)
      if (d < bestDist) {
        bestDist = d
        best = c
      }
    }
    if (best < 0) break
    splits.push(best)
    cursor = best
  }
  return splits.sort((a, b) => a - b)
}

function pickDelay(
  random: () => number,
  minDelayMs: number,
  maxDelayMs: number
): number {
  const span = maxDelayMs - minDelayMs
  return Math.round(minDelayMs + random() * span)
}

export function planChunks(text: string, opts: PlanChunksOptions = {}): ChunkPlan {
  const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS
  const minChunkableLen = opts.minChunkableLen ?? DEFAULT_MIN_CHUNKABLE_LEN
  const minDelayMs = opts.minDelayMs ?? DEFAULT_MIN_DELAY_MS
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const random = opts.random ?? Math.random

  const trimmed = text // Caller is responsible for trimming; we want byte-exact reconstruction.

  // Floor: short replies always go single.
  if (trimmed.length <= minChunkableLen) {
    return { chunks: [trimmed], delaysMs: [] }
  }

  const protectedRanges = computeProtectedRanges(trimmed)

  // Per-chunk floor: smaller than the whole-reply floor so CJK text with
  // short paragraphs (each ~30 chars) can still split. Empirically a
  // single CJK paragraph of one sentence runs 20-40 characters; English
  // sentence boundaries similarly land in the 30-60 char range.
  const perChunkMinLen = Math.max(20, Math.floor(minChunkableLen / 3))

  // Try paragraph boundaries first.
  let candidates = findParagraphBoundaries(trimmed, protectedRanges)
  let splits = chooseSplits(trimmed, candidates, maxChunks, perChunkMinLen)

  // Fall back to sentence boundaries if paragraphs gave us nothing.
  if (splits.length === 0) {
    candidates = findSentenceBoundaries(trimmed, protectedRanges)
    splits = chooseSplits(trimmed, candidates, maxChunks, perChunkMinLen)
  }

  // No clean split point — single chunk.
  if (splits.length === 0) {
    return { chunks: [trimmed], delaysMs: [] }
  }

  const chunks: string[] = []
  let last = 0
  for (const s of splits) {
    chunks.push(trimmed.slice(last, s).trimEnd())
    last = s
  }
  chunks.push(trimmed.slice(last).trimEnd())

  // Filter out any empty chunks defensively.
  const nonEmpty = chunks.filter((c) => c.length > 0)
  if (nonEmpty.length <= 1) {
    return { chunks: [trimmed], delaysMs: [] }
  }

  const delaysMs: number[] = []
  for (let i = 0; i < nonEmpty.length - 1; i += 1) {
    delaysMs.push(pickDelay(random, minDelayMs, maxDelayMs))
  }

  return { chunks: nonEmpty, delaysMs }
}

/**
 * Execute the chunk plan: deliver chunks via `send`, sleeping between
 * each. The first chunk ships immediately. Errors in one chunk halt
 * the loop — the caller decides how to surface a partial-send failure.
 *
 * Returns the index of the last chunk that successfully sent, or
 * `chunks.length - 1` if all chunks shipped.
 */
export async function deliverChunks(
  plan: ChunkPlan,
  send: (text: string) => Promise<void>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<{ sent: number; error?: { index: number; cause: unknown } }> {
  for (let i = 0; i < plan.chunks.length; i += 1) {
    try {
      await send(plan.chunks[i])
    } catch (cause) {
      return { sent: i, error: { index: i, cause } }
    }
    if (i < plan.chunks.length - 1) {
      await sleep(plan.delaysMs[i])
    }
  }
  return { sent: plan.chunks.length }
}

/**
 * True iff Phase 15 chunked-delivery should be applied to a given text.
 * Pulls from env so callers don't have to repeat the gate.
 */
export function isTypingIndicatorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Default state: DISABLED (i.e. flag === "true" → single-message behavior).
  // P10 will flip this default after telemetry.
  const v = env.PA_TYPING_INDICATOR_DISABLED
  if (v == null) return false // unset → kill switch armed (single-send), per Phase 15 default
  return v.trim().toLowerCase() !== "true"
}
