/**
 * Adam iter 19 — slang injector.
 *
 * Re-uses the curated VOICE-07 slang lexicon (ZH_SLANG / EN_SLANG) as a
 * runtime system-prompt-injected hint. Previously the lexicon was only
 * consumed by the mirror-snippet path (style-analyzer.ts), which is
 * currently disabled by `isVoiceMirrorDisabledFlag` (Bug 11 deferral)
 * — so the lexicon was orphaned dead code.
 *
 * This module gives it a second consumer that doesn't depend on the
 * disabled mirror: a per-turn directive that suggests Claire sprinkle
 * 1-2 lang-appropriate slangs into her reply, which keeps the
 * friend-roommate persona crisp without requiring the heavy mirror
 * machinery.
 *
 * Wired into orchestrator/index.ts systemInputs alongside playbookAddendum.
 *
 * Design constraints (D-08, Adam iter 19):
 * - 0 net new LLM calls (system prompt is pre-existing)
 * - Sub-1ms execution (pure text)
 * - Lang-aware: zh user → zh slang only, en user → en slang only,
 *   mixed user → mix of both at 2:1 zh:en ratio
 * - Bounded palette: up to 8 terms surfaced per turn (zh/en) or 4+2=6
 *   (mixed). The LLM still picks 0-2 per VOICE-07 — a wider palette
 *   lowers the chance the LLM lands on the same opener two turns in a
 *   row (Adam directive 2026-05-19: "spread the wording a bit").
 * - Cross-turn dedupe: callers may pass `excludeTerms` (recent picks
 *   surfaced on the prior turn) so the palette rotates instead of
 *   regenerating the same 3 candidates each time.
 * - Deterministic seeding by turnId so repeated runs reproduce
 * - Feature-flag gated via PA_SLANG_INJECTOR_DISABLED=true rollback
 */
import { ZH_SLANG, EN_SLANG } from "./slang-lexicon.js"
import { detectUserLang } from "./imperfection-injector/index.js"

/** mulberry32 PRNG (deterministic, fast, tiny). */
function buildRng(seed: string): () => number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let s = h >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickN<T>(arr: readonly T[], n: number, rng: () => number): T[] {
  if (arr.length <= n) return [...arr]
  const out: T[] = []
  const used = new Set<number>()
  while (out.length < n && used.size < arr.length) {
    const i = Math.floor(rng() * arr.length)
    if (used.has(i)) continue
    used.add(i)
    out.push(arr[i] as T)
  }
  return out
}

export type SlangInjectInput = {
  /** Latest user message (used for lang detection). */
  userMessage: string
  /** Stable seed (turnId) so the choice is reproducible. */
  seed: string
  /**
   * Recently surfaced slang picks (cross-turn dedupe). Used to filter
   * the candidate pool before sampling so back-to-back palettes don't
   * lead with the same terms (e.g. "deadass" twice in a row).
   *
   * Caller should pass the last ~6-12 picks from `pa-users.sharedOnboarding.voice.recentSlangPicks`
   * (onboarding) or `pa-users.voice.recentSlangPicks` (main path).
   */
  excludeTerms?: readonly string[]
}

export type SlangInjectDecision = {
  /** System-prompt-injectable string (or null when disabled / no choice). */
  directive: string | null
  /** What we picked, for telemetry. */
  picked: string[]
  /** Lang we routed off. */
  lang: "zh" | "en" | "mixed"
}

const DIRECTIVE_HEADER =
  "FRIEND SLANG PALETTE (pick 0-2 only, NEVER stack, do not repeat the same opener two turns in a row):"

/** Hard cap on the palette size we surface per turn. */
const MAX_PALETTE_PER_LANG = 8
const MAX_PALETTE_MIXED_ZH = 4
const MAX_PALETTE_MIXED_EN = 2

function filterPool(pool: readonly string[], exclude: ReadonlySet<string>): readonly string[] {
  if (exclude.size === 0) return pool
  return pool.filter((t) => !exclude.has(t))
}

/**
 * Build a per-turn slang palette directive. Returns `null` when:
 * - PA_SLANG_INJECTOR_DISABLED=true (rollback)
 * - userMessage is empty
 * - filtered pool is empty (all candidate terms were excluded)
 *
 * Otherwise returns a directive line listing up to 8 (zh/en) or 6 (mixed)
 * candidate slangs from the curated lexicon, minus any `excludeTerms` the
 * caller passed (last few turns' picks). The LLM is still instructed to
 * use only 0-2 per VOICE-07; the wider palette protects against
 * back-to-back identical openers.
 */
export function buildSlangInjection(input: SlangInjectInput): SlangInjectDecision {
  if (process.env.PA_SLANG_INJECTOR_DISABLED === "true") {
    return { directive: null, picked: [], lang: "en" }
  }
  const userMessage = (input.userMessage ?? "").trim()
  if (!userMessage) {
    return { directive: null, picked: [], lang: "en" }
  }
  const lang = detectUserLang(userMessage)
  const rng = buildRng(input.seed || userMessage.slice(0, 16))
  const exclude = new Set(
    (input.excludeTerms ?? []).map((t) => t.trim()).filter((t) => t.length > 0),
  )

  let picked: string[] = []
  if (lang === "zh") {
    const pool = filterPool(ZH_SLANG, exclude)
    picked = pickN(pool, Math.min(MAX_PALETTE_PER_LANG, pool.length), rng)
  } else if (lang === "en") {
    const pool = filterPool(EN_SLANG, exclude)
    picked = pickN(pool, Math.min(MAX_PALETTE_PER_LANG, pool.length), rng)
  } else {
    const zhPool = filterPool(ZH_SLANG, exclude)
    const enPool = filterPool(EN_SLANG, exclude)
    picked = [
      ...pickN(zhPool, Math.min(MAX_PALETTE_MIXED_ZH, zhPool.length), rng),
      ...pickN(enPool, Math.min(MAX_PALETTE_MIXED_EN, enPool.length), rng),
    ]
  }

  if (picked.length === 0) {
    return { directive: null, picked: [], lang }
  }

  const directive = `${DIRECTIVE_HEADER} ${picked.join(" / ")}`
  return { directive, picked, lang }
}
