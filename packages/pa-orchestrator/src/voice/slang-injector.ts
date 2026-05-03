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
 * - Bounded: emit ≤ 3 terms per turn (matches VOICE-07 "1-2 per turn"
 *   cap with +1 slack so the LLM picks naturally)
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
}

export type SlangInjectDecision = {
  /** System-prompt-injectable string (or null when disabled / no choice). */
  directive: string | null
  /** What we picked, for telemetry. */
  picked: string[]
  /** Lang we routed off. */
  lang: "zh" | "en" | "mixed"
}

const ZH_DIRECTIVE_HEADER = "FRIEND SLANG (sprinkle 0-2, NEVER stack):"
const EN_DIRECTIVE_HEADER = "FRIEND SLANG (sprinkle 0-2, NEVER stack):"

/**
 * Build a per-turn slang directive. Returns `null` when:
 * - PA_SLANG_INJECTOR_DISABLED=true (rollback)
 * - userMessage is empty
 *
 * Otherwise returns a short directive line listing 2-3 appropriate slangs
 * for the detected user lang, deterministically chosen from the curated
 * lexicon. The LLM is instructed to use 0-2 (not all) — natural sprinkling.
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

  let picked: string[] = []
  if (lang === "zh") {
    picked = pickN(ZH_SLANG, 3, rng)
  } else if (lang === "en") {
    picked = pickN(EN_SLANG, 3, rng)
  } else {
    // mixed: 2 zh + 1 en
    picked = [...pickN(ZH_SLANG, 2, rng), ...pickN(EN_SLANG, 1, rng)]
  }

  if (picked.length === 0) {
    return { directive: null, picked: [], lang }
  }

  const header = lang === "zh" ? ZH_DIRECTIVE_HEADER : EN_DIRECTIVE_HEADER
  const directive = `${header} ${picked.join(" / ")}`
  return { directive, picked, lang }
}
