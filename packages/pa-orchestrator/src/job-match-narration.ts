/**
 * Friend-tone interim copy while V16 find-match runs (multi-second latency).
 * Mirrors composeInterimResumeAck — curated variants, no LLM, sub-ms pick.
 */

export const FIND_MATCH_PRE_CALL_VARIANTS: Record<"en", readonly string[]> = {
  en: [
    "One sec, checking roles against what you shared.",
    "Checking the latest roles now.",
    "I am matching that against open roles now.",
    "Got it. I am looking for a tighter fit.",
    "One sec, I am checking what lines up.",
    "I am pulling a focused batch now.",
    "Got it. I am checking the role pool.",
    "I am looking for roles that fit that context.",
  ],
}

export const MATCH_COLLAB_PRE_CALL_VARIANTS: Record<"en", readonly string[]> = {
  en: [
    "ok lemme check our partner roles for you — one sec",
    "hold on — seeing if any collab interviews fit",
    "one sec, lining up partner openings for you",
    "ok brb — checking interview-track roles",
  ],
}

function hashSeed(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0
  }
  return h
}

function pickFromPool(
  pool: readonly string[],
  seed: string | undefined,
  rng: () => number,
): string {
  const i = seed
    ? hashSeed(seed) % pool.length
    : Math.floor(rng() * pool.length)
  return pool[i] ?? pool[0]!
}

export function composeFindMatchPreCall(
  _lang: "en" | "zh",
  seed?: string,
  rng: () => number = Math.random,
): string {
  return pickFromPool(FIND_MATCH_PRE_CALL_VARIANTS.en, seed, rng)
}

export function composeMatchCollabPreCall(
  _lang: "en" | "zh",
  seed?: string,
  rng: () => number = Math.random,
): string {
  return pickFromPool(MATCH_COLLAB_PRE_CALL_VARIANTS.en, seed, rng)
}
