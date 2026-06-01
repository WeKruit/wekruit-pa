import { planChunks, type PlanChunksOptions } from "./chunker.js"

/**
 * UTM/tracking/s — exhaustive list (Phase 20 D-04).
 * Applied case-insensitively to `URL#searchParams`.
 */
export const STRIP_PARAMS: ReadonlyArray<string> = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "gclsrc",
  "dclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "__hssc",
  "__hstc",
  "__hsfp",
  "ref",
  "ref_src",
  "ref_url",
  "source",
] as const

export type NormalizeOpts = {
  maxLength?: number
  stripParams?: ReadonlyArray<string>
  forceSingleMessage?: boolean
  /** @internal */ planChunkOpts?: PlanChunksOptions
}

export type NormalizeResult = {
  text: string
  chunks?: string[]
  droppedTracking: string[]
  wasOverLength: boolean
}

function mergeDropped(acc: string[], names: string[]) {
  for (const n of names) {
    if (!acc.includes(n)) acc.push(n)
  }
  return acc
}

function stripUrlQueryParams(href: string, paramNames: ReadonlyArray<string>, dropped: string[]): string {
  try {
    const u = new URL(href)
    for (const p of paramNames) {
      for (const key of [...u.searchParams.keys()]) {
        if (key.toLowerCase() === p.toLowerCase()) {
          u.searchParams.delete(key)
          mergeDropped(dropped, [p])
        }
      }
    }
    let out = u.toString()
    if (u.protocol === "http:" || u.protocol === "https:") {
      if (out.endsWith("?") || out.endsWith("#")) {
        return out.replace(/\?$/, "").replace(/#$/, "")
      }
    }
    return out
  } catch {
    return href
  }
}

/**
 * Iter 16 Bug 10: Qwen-7B sometimes echoes literal placeholder tokens like
 * `<TOPIC>`, `<topic>`, `<X>` from rewriter prompt examples. Strip them out
 * before downstream renders. We delete the placeholder + any single space
 * adjacent to it so reply doesn't have weird gaps.
 */
function stripPromptPlaceholders(input: string): string {
  // Common leak patterns: <TOPIC>, <topic>, <X>, <Y>, <CATEGORY>, <USER_TOPIC>
  // Strip ONLY the placeholder + adjacent single space — preserve newlines.
  return input.replace(/ ?<[A-Z_]{1,20}> ?/gi, "").replace(/[ \t]+/g, " ")
}

function stripCodeFences(input: string): string {
  return input.replace(/```[\w]*\r?\n([\s\S]*?)```/g, (_m, inner: string) => inner)
}

function stripInlineCode(input: string): string {
  return input.replace(/`([^`]+)`/g, "$1")
}

function replaceMarkdownLinks(input: string, paramNames: ReadonlyArray<string>, dropped: string[]): string {
  return input.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (full, text: string, urlRaw: string) => {
    const href = urlRaw.trim()
    const u = stripUrlQueryParams(href, paramNames, dropped)
    const t = (text as string).trim()
    if (t.length === 0) return u
    if (t === href || t === u) return u
    // iMessage preview only fires when the URL is "standalone" — bare token
    // separated by whitespace, not wrapped in parens. Short URLs inline
    // (text + space + URL); long URLs on their own line so the preview card
    // renders cleanly under the prose.
    if (u.length <= 30) return `${t} ${u}`
    return `${t}\n${u}`
  })
}

const BARE_URL_RE = /(https?:\/\/[^\s\]]+)/gi

function stripBareUrlsInText(input: string, paramNames: ReadonlyArray<string>, dropped: string[]): string {
  return input.replace(BARE_URL_RE, (m) => stripUrlQueryParams(m, paramNames, dropped))
}

/**
 * Phase 40 humanize-runtime — strip "(domain.tld (https://...))" double-paren
 * citation patterns the LLM emits when it has web_search hosted-tool sources.
 * Bible v7.5.1 hard rule says "talk like roommate, drop bare URL at most once
 * at end" but defense-in-depth handles residual emissions: collapse outer
 * paren wrap + redundant bare-domain prefix into a single space-prefixed URL.
 *
 * Idempotent (re-running on cleaned text is no-op since no inner pattern remains).
 */
function flattenCitations(input: string): string {
  let s = input
  // Step 1: outer paren wrapping "domain.tld (url)" → just the URL (loses parens entirely).
  // Multiple sources joined with "and"/"," collapse to space-separated URLs.
  s = s.replace(
    /\(\s*((?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\s+\(https?:\/\/[^)\s]+\))(?:\s*(?:and|,)\s*(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\s+\(https?:\/\/[^)\s]+\))*\s*\)/gi,
    (match) => {
      const urls = match.match(/https?:\/\/[^)\s]+/g) || []
      return urls.length > 0 ? " " + urls.join(" ") : ""
    }
  )
  // Step 2: bare-domain followed by "(url)" without outer paren → just the URL (no parens).
  // e.g. "see fortune.com (https://x)" → "see https://x"
  s = s.replace(
    /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\s+\((https?:\/\/[^)\s]+)\)/gi,
    "$2"
  )
  // Step 3: dangling "(domain.tld)" with no URL inside → drop entirely (residual citation).
  s = s.replace(/\s?\(\s*[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\s*\)/gi, "")
  return s
}

function stripEmphasis(input: string): string {
  let s = input
  s = s.replace(/\uff0a\uff0a([^\uff0a]+)\uff0a\uff0a/g, "$1")
  s = s.replace(/(?<![\uff0a\w])\uff0a([^\uff0a\n]+)\uff0a(?![\uff0a\w])/g, "$1")
  s = s.replace(/\*\*([^*]+)\*\*(?=[A-Za-z0-9])/g, "$1 ")
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1")
  s = s.replace(/__([^_]+)__(?=[A-Za-z0-9])/g, "$1 ")
  s = s.replace(/__([^_]+)__/g, "$1")
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "$1")
  s = s.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, "$1")
  return s
}

function replaceListMarkers(input: string): string {
  return input
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*\d+[\.\)\u3001]\s+/, "· ")
        .replace(/^(\s*)([-*])\s+/, "$1· ")
    )
    .join("\n")
}

function normalizeWhitespace(input: string): string {
  let s = input.replace(/[ \t]+$/gm, "")
  s = s.replace(/(?:\n[ \t]*){3,}/g, "\n\n")
  s = s.trim()
  return s
}

/**
 * iMessage-safe plain text at orchestrator exit. Idempotent for stable inputs
 * (see unit tests). Rule order per Phase 20 PLAN.
 */
export function normalizeForIMessage(input: string, opts?: NormalizeOpts): NormalizeResult {
  const maxLength = opts?.maxLength ?? 600
  const paramNames = opts?.stripParams ?? STRIP_PARAMS
  const dropped: string[] = []
  if (!input || !input.trim()) {
    return { text: "", droppedTracking: [], wasOverLength: false }
  }

  let s = stripCodeFences(input)
  s = stripInlineCode(s)
  s = stripPromptPlaceholders(s)
  s = replaceMarkdownLinks(s, paramNames, dropped)
  s = flattenCitations(s)
  s = stripBareUrlsInText(s, paramNames, dropped)
  s = stripEmphasis(s)
  s = replaceListMarkers(s)
  s = normalizeWhitespace(s)

  const strippedLen = s.length
  const wasOverLength = strippedLen > maxLength
  if (opts?.forceSingleMessage) {
    if (s.length > maxLength) {
      s = s.slice(0, Math.max(0, maxLength - 1)) + "…"
    }
    return { text: s, droppedTracking: dropped, wasOverLength }
  }
  if (s.length <= maxLength) {
    return { text: s, droppedTracking: dropped, wasOverLength: false }
  }
  const plan = planChunks(s, { maxChunks: 3, minChunkableLen: 60, ...opts?.planChunkOpts })
  if (plan.chunks.length === 0) {
    return { text: s.slice(0, maxLength - 1) + "…", droppedTracking: dropped, wasOverLength: true }
  }
  if (plan.chunks.length === 1) {
    return { text: plan.chunks[0]!, droppedTracking: dropped, wasOverLength: true }
  }
  const text = plan.chunks.join("\n\n")
  return { text, chunks: plan.chunks, droppedTracking: dropped, wasOverLength: true }
}


/**
 * Stream H5 — runtime mirror of voice-axes.mjs `checkABFramework()` clinical
 * A/B-probe detector. The Bible v7.5 NEVER PROBE rule is enforced in eval but
 * the orchestrator was leaking clinical "X or Y?" choice probes at the tail of
 * a reply. This is a defense-in-depth post-LLM strip — gated by
 * paHumanizeRuntimeEnabled umbrella so non-allowlist users see no behavior
 * change until the flag flips.
 *
 * The product is English-only, so only the English " or " probe pattern is
 * detected.
 *
 * Behavior contract:
 *  - Detect the LAST sentence containing an A/B probe and strip ONLY that
 *    sentence; preserve all earlier sentences. Never strip the whole reply.
 *  - en pattern: a sentence with " or " sandwiched between two non-trivial
 *    verb-bearing arms ending in ?
 *  - Idempotent: a stripped string contains no further A/B tail probes.
 *
 * Returns { stripped, hits } — hits[] is a small telemetry array (never log
 * the user-text directly; log only the pattern label and hit count).
 */
export type StripABResult = {
  stripped: string
  hits: string[]
}

const AB_PROBE_EN_RE = /[A-Za-z][A-Za-z\s,'’-]{2,40}\bor\b[A-Za-z\s,'’-]{2,40}\?\s*$/i

// iter26 — procedural AB strip. Locate the rightmost AB span, then walk
// backward from X start to find a STEM-PRESERVING boundary (sentence
// terminator OR comma where the X-comma-side is ≥3 chars).

// Sentence terminators. Includes unicode-escaped CJK terminators
// (U+3002 / U+FF01 / U+FF1F) for defense against any residual
// full-width punctuation, without any literal non-ASCII char in source.
const SENTENCE_TERM_RE = /[\u3002\uff01\uff1f!?.\n]/

function findEnABSpanEnd(text: string, fromIdx: number): { yEnd: number } | null {
  // Y after " or " up to "?" within 40 chars.
  for (let i = fromIdx; i < Math.min(text.length, fromIdx + 42); i++) {
    const ch = text[i]!
    if (ch === "?") {
      const yLen = i - fromIdx
      if (yLen >= 2) return { yEnd: i + 1 }
      return null
    }
    if (SENTENCE_TERM_RE.test(ch) && ch !== "?") return null
  }
  return null
}

function stripFromX(text: string, xStart: number, label: "en_X_or_Y_question"): StripABResult {
  let kept = text.slice(0, xStart)
  kept = kept.replace(/[\s,]+$/g, "")
  return { stripped: kept, hits: [label] }
}

export function stripABProbeFromTail(text: string): StripABResult {
  if (!text || typeof text !== "string") return { stripped: text ?? "", hits: [] }

  // Find rightmost EN AB span.
  let bestStart = -1
  let bestLabel: "en_X_or_Y_question" | "" = ""

  // EN " or " scan (case-insensitive)
  const enRe = /\bor\b/gi
  let em: RegExpExecArray | null
  while ((em = enRe.exec(text)) !== null) {
    const orIdx = em.index
    const yResult = findEnABSpanEnd(text, orIdx + em[0].length)
    if (yResult) {
      // Walk backward from orIdx to find X start (sentence/comma boundary).
      let xStart = orIdx
      let commaCandidate = -1
      for (let i = orIdx - 1; i >= Math.max(0, orIdx - 42); i--) {
        const ch = text[i]!
        if (SENTENCE_TERM_RE.test(ch)) {
          xStart = i + 1
          break
        }
        if (ch === "," && commaCandidate === -1) {
          if (orIdx - (i + 1) >= 3) commaCandidate = i + 1
        }
      }
      if (xStart === orIdx && commaCandidate !== -1) xStart = commaCandidate
      if (xStart === orIdx) {
        const winStart = Math.max(0, orIdx - 40)
        if (orIdx - winStart >= 3) xStart = winStart
      }
      while (xStart < orIdx && /\s/.test(text[xStart]!)) xStart++
      const xSlice = text.slice(xStart, orIdx).trim()
      if (
        xSlice.length >= 3 &&
        /[A-Za-z]/.test(xSlice) &&
        !/[?!.\n]/.test(xSlice)
      ) {
        if (xStart > bestStart) {
          bestStart = xStart
          bestLabel = "en_X_or_Y_question"
        }
      }
    }
  }

  if (bestStart === -1 || bestLabel === "") return { stripped: text, hits: [] }
  return stripFromX(text, bestStart, bestLabel)
}
