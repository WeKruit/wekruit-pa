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
    if (u.length <= 30) return `${t} ${u}`
    return `${t} (${u})`
  })
}

const BARE_URL_RE = /(https?:\/\/[^\s\]]+)/gi

function stripBareUrlsInText(input: string, paramNames: ReadonlyArray<string>, dropped: string[]): string {
  return input.replace(BARE_URL_RE, (m) => stripUrlQueryParams(m, paramNames, dropped))
}

function stripEmphasis(input: string): string {
  let s = input
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1")
  s = s.replace(/__([^_]+)__/g, "$1")
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "$1")
  s = s.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, "$1")
  return s
}

function replaceListMarkers(input: string): string {
  return input
    .split("\n")
    .map((line) => line.replace(/^(\s*)([-*])\s+/, "$1· "))
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
  s = replaceMarkdownLinks(s, paramNames, dropped)
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
