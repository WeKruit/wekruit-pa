import { planChunks, type ChunkPlan } from "./chunker.js"

export const STRIP_PARAMS = [
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
}

export type NormalizeResult = {
  text: string
  chunks?: string[]
  droppedTracking: string[]
  wasOverLength: boolean
}

const DEFAULT_MAX = 600

function collectStripParams(
  target: Set<string>,
  list: ReadonlyArray<string> = STRIP_PARAMS as unknown as string[]
) {
  for (const p of list) target.add(p.toLowerCase())
}

function stripUrlSearchParams(
  rawUrl: string,
  extraParams: Set<string>
): { href: string; dropped: string[] } {
  const dropped: string[] = []
  try {
    const u = new URL(rawUrl)
    const keys = [...u.searchParams.keys()]
    for (const k of keys) {
      if (extraParams.has(k.toLowerCase())) {
        u.searchParams.delete(k)
        dropped.push(k)
      }
    }
    // Normalize if search became empty
    let href = u.toString()
    if (u.search === "" && href.endsWith("?")) {
      href = href.slice(0, -1)
    }
    return { href, dropped }
  } catch {
    return { href: rawUrl, dropped: [] }
  }
}

/**
 * iMessage / SMS-safe text: no markdown, no tracking query params in URLs.
 */
export function normalizeForIMessage(input: string, opts: NormalizeOpts = {}): NormalizeResult {
  const maxLength = opts.maxLength ?? DEFAULT_MAX
  const paramSet = new Set<string>()
  collectStripParams(paramSet, opts.stripParams)
  for (const p of STRIP_PARAMS) {
    paramSet.add(p.toLowerCase())
  }

  const allDropped: string[] = []
  const recordDropped = (d: string[]) => {
    for (const x of d) {
      if (!allDropped.includes(x)) allDropped.push(x)
    }
  }

  let s = input

  // 1) Fenced code blocks
  s = s.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)\n?```/g, "$1")

  // 2) Inline backticks
  s = s.replace(/`([^`]+)`/g, "$1")

  // 3) Markdown links
  s = s.replace(/\[([^\]\n]*)\]\(([^)\n]+)\)/g, (full, label, url) => {
    const { href, dropped } = stripUrlSearchParams(String(url), paramSet)
    recordDropped(dropped)
    const text = String(label).trim()
    const h = href.trim()
    const sameAsUrl = (a: string, b: string) => {
      if (a === b) return true
      try {
        return new URL(a).href === new URL(b).href
      } catch {
        return false
      }
    }
    if (text === h || text === h.replace(/^https?:\/\//, "") || sameAsUrl(text, h)) {
      return h
    }
    if (h.length <= 30) {
      return text ? `${text} ${h}` : h
    }
    return text ? `${text} (${h})` : h
  })

  // 4) Bare URLs
  s = s.replace(/https?:\/\/[^\s)\]]+/g, (m) => {
    const { href, dropped } = stripUrlSearchParams(m, paramSet)
    recordDropped(dropped)
    return href
  })

  // 5) Emphasis: **…** and __…__ (loop for nested, e.g. ***a***), then *…* / _…_
  let prev = ""
  while (prev !== s) {
    prev = s
    s = s.replace(/\*\*([^*]+?)\*\*/g, "$1")
    s = s.replace(/__([^_]+?)__/g, "$1")
  }
  prev = ""
  while (prev !== s) {
    prev = s
    s = s.replace(/\*([^*]+?)\*/g, "$1")
    s = s.replace(/_([^_]+?)_/g, "$1")
  }

  // 6) List markers: hyphen / asterisk bullets (not numbered)
  s = s.replace(/^[\u002d*][ \t]+/gm, "· ")

  // 7) Whitespace
  s = s.replace(/\n{3,}/g, "\n\n")
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
  s = s.trim()

  if (s.length === 0) {
    return { text: "", droppedTracking: allDropped, wasOverLength: false }
  }

  if (s.length <= maxLength || opts.forceSingleMessage) {
    if (s.length > maxLength && opts.forceSingleMessage) {
      const cut = s.slice(0, Math.max(0, maxLength - 1)) + "…"
      return { text: cut, droppedTracking: allDropped, wasOverLength: true }
    }
    return { text: s, droppedTracking: allDropped, wasOverLength: false }
  }

  // 8) Length: chunk or truncate
  const wasOverLength = s.length > maxLength
  const plan: ChunkPlan = planChunks(s, { maxChunks: 3, minChunkableLen: 60 })
  if (plan.chunks.length >= 2) {
    const allUnder = plan.chunks.every((c) => c.length <= maxLength)
    if (allUnder) {
      return {
        text: plan.chunks.join("\n\n"),
        chunks: plan.chunks,
        droppedTracking: allDropped,
        wasOverLength,
      }
    }
  }
  const cut = s.slice(0, Math.max(0, maxLength - 1)) + "…"
  return { text: cut, droppedTracking: allDropped, wasOverLength: true }
}

/** Regex gate for eval harness: markdown leaking into user-visible text. */
export function isIMessageRenderSafe(text: string): boolean {
  if (/\*\*.+?\*\*/.test(text)) return false
  if (/\[.+?\]\(.+?\)/.test(text)) return false
  if (/^[\-\*][ \t]/m.test(text)) return false
  if (/`{1,3}/.test(text)) return false
  return true
}
