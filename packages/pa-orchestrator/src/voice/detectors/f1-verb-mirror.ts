/**
 * Phase 35 — F1 verb-mirror detector.
 *
 * Detects when Claire's reply echoes the user's last turn via n-gram
 * Jaccard overlap. zh: char 3-gram. en: word bigram. Mixed text: detect
 * majority lang of Claire's reply, then n-gram accordingly.
 *
 * Threshold: `PA_F1_MIRROR_THRESHOLD` (default 0.25, matches Phase 34
 * baseline gate `drift_mirror_max ≤ 0.25` = ~42% reduction from 0.429).
 *
 * Action: `strip` — wire-in caller post-processes by stripping echoed
 * n-grams from Claire's reply (deterministic, no LLM call).
 *
 * Algorithm parity: this TS port matches `computeMirrorRatio` in
 * `tests/scenarios/lib/voice-axes.mjs:328` to 1e-6 tolerance. Verified
 * via `f1-verb-mirror.test.ts` parity test against the .mjs helper
 * (loaded via dynamic import).
 *
 * Latency: pure text, no I/O, no async — < 5ms per call typical.
 */
import type { DetectorContext, DetectorResult } from "./types.js"

const DEFAULT_THRESHOLD = 0.25

function readEnvThreshold(): number {
  const raw = process.env.PA_F1_MIRROR_THRESHOLD?.trim()
  if (!raw) return DEFAULT_THRESHOLD
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_THRESHOLD
  return n
}

function isCjkChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3000 && code <= 0x303f)
  )
}

/**
 * Majority-lang detection. Matches `voice-axes.mjs:detectLang` exactly.
 * Cjk-vs-ASCII char count; tie/empty → "en".
 */
function detectLang(text: string): "zh" | "en" {
  if (typeof text !== "string" || text.length === 0) return "en"
  let cjk = 0
  let ascii = 0
  for (const ch of text) {
    if (isCjkChar(ch)) cjk += 1
    else if ((ch.charCodeAt(0) ?? 0) < 128) ascii += 1
  }
  return cjk > ascii ? "zh" : "en"
}

function charNgrams(text: string, n: number): Set<string> {
  const out = new Set<string>()
  if (typeof text !== "string") return out
  for (let i = 0; i + n <= text.length; i++) {
    out.add(text.slice(i, i + n))
  }
  return out
}

function wordBigrams(text: string): Set<string> {
  const out = new Set<string>()
  if (typeof text !== "string") return out
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean)
  for (let i = 0; i + 2 <= words.length; i++) {
    out.add(`${words[i]} ${words[i + 1]}`)
  }
  return out
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Compute Jaccard mirror ratio between Claire's reply and the user's
 * preceding turn. Public for tests + parity audits.
 *
 * @returns 0..1 (1 = identical n-gram sets)
 */
export function computeMirrorRatio(userText: string, claireText: string): number {
  if (!userText || !claireText) return 0
  const lang = detectLang(claireText)
  if (lang === "zh") {
    return jaccardOverlap(charNgrams(userText, 3), charNgrams(claireText, 3))
  }
  return jaccardOverlap(wordBigrams(userText), wordBigrams(claireText))
}

/**
 * F1 detector entry point. Pure text, sync.
 */
export function detectVerbMirror(ctx: DetectorContext): DetectorResult {
  const start = performance.now()
  const threshold = ctx.env?.f1MirrorThreshold ?? readEnvThreshold()
  const { user, assistant } = ctx.turn

  if (!user || !assistant) {
    return {
      id: "f1_verb_mirror",
      triggered: false,
      score: 0,
      reason: "no_input",
      suggested_action: null,
      latencyMs: performance.now() - start,
    }
  }

  const score = computeMirrorRatio(user, assistant)
  const triggered = score >= threshold

  return {
    id: "f1_verb_mirror",
    triggered,
    score,
    reason: triggered
      ? `mirror_ratio_${score.toFixed(3)}_>=_${threshold.toFixed(3)}`
      : `mirror_ratio_${score.toFixed(3)}_<_${threshold.toFixed(3)}`,
    suggested_action: triggered ? "strip" : null,
    latencyMs: performance.now() - start,
  }
}
