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
  // Multiple sources joined with "and"/"和"/"," collapse to space-separated URLs.
  s = s.replace(
    /\(\s*((?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\s+\(https?:\/\/[^)\s]+\))(?:\s*(?:and|或|和|与|,|，)\s*(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\s+\(https?:\/\/[^)\s]+\))*\s*\)/gi,
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
  s = s.replace(/＊＊([^＊]+)＊＊/g, "$1")
  s = s.replace(/(?<![＊\w])＊([^＊\n]+)＊(?![＊\w])/g, "$1")
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1")
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
        .replace(/^\s*\d+[\.\)、]\s+/, "· ")
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
 * the orchestrator was leaking patterns like `"今天是赶ddl还是本来就想投着玩先?"`
 * (post-fix run turn 2) at inference. This is a defense-in-depth post-LLM
 * strip — gated by paHumanizeRuntimeEnabled umbrella so non-allowlist users
 * see no behavior change until the flag flips.
 *
 * Behavior contract:
 *  - Detect the LAST sentence containing an A/B probe and strip ONLY that
 *    sentence; preserve all earlier sentences. Never strip the whole reply.
 *  - zh pattern: `(.{2,30}还是.{2,30}\?)` — both arms ≥2 chars; trailing ? or ？
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

const AB_PROBE_ZH_RE = /[^?？\n。！!]{2,30}还是[^?？\n。！!]{2,30}[?？]\s*$/
const AB_PROBE_EN_RE = /[A-Za-z][A-Za-z\s,'’-]{2,40}\bor\b[A-Za-z\s,'’-]{2,40}\?\s*$/i

function splitIntoClauses(text: string): string[] {
  // Split on clause delimiters: zh/en sentence terminators AND commas, since
  // clinical A/B probes often appear after a leading validation clause
  // ("嗯 我在, 你今天是 X 还是 Y?"). We want clause-level granularity so the
  // tail strip can preserve the validation stem and drop only the probe
  // clause. Each chunk retains its trailing delimiter so re-joining is
  // lossless.
  const out: string[] = []
  const re = /[^。！？!?\.\n,，]+[。！？!?\.,，]?\n?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[0].length > 0) out.push(m[0])
  }
  return out.length > 0 ? out : [text]
}

export function stripABProbeFromTail(text: string): StripABResult {
  if (!text || typeof text !== "string") return { stripped: text ?? "", hits: [] }
  const sentences = splitIntoClauses(text)
  if (sentences.length === 0) return { stripped: text, hits: [] }
  // Find the LAST sentence that matches an A/B pattern. We only strip the
  // tail — earlier sentences are preserved verbatim even if they also match.
  let lastABIdx = -1
  let lastLabel = ""
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i]!
    const trimmed = s.trim()
    if (AB_PROBE_ZH_RE.test(trimmed)) {
      lastABIdx = i
      lastLabel = "zh_X_还是_Y_question"
      break
    }
    if (AB_PROBE_EN_RE.test(trimmed)) {
      lastABIdx = i
      lastLabel = "en_X_or_Y_question"
      break
    }
  }
  if (lastABIdx === -1) return { stripped: text, hits: [] }
  // Reconstruct: keep everything except the matched tail sentence.
  const kept = sentences.slice(0, lastABIdx).join("")
  // Trim any dangling whitespace/newline left behind. If kept is empty (the
  // whole reply was a single A/B probe), preserve it as empty rather than
  // returning the original to honor the strip contract.
  const stripped = kept.replace(/\s+$/g, "")
  return { stripped, hits: [lastLabel] }
}

