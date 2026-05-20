/**
 * Friend-tone interim copy while V16 find-match runs (multi-second latency).
 * Mirrors composeInterimResumeAck — curated variants, no LLM, sub-ms pick.
 */

export const FIND_MATCH_PRE_CALL_VARIANTS: Record<"en" | "zh", readonly string[]> = {
  en: [
    "ok one sec — pulling roles that might fit you",
    "lemme dig through what's open for you real quick",
    "hold on — gonna see what lines up",
    "ok scanning for stuff in your lane, gimme a sec",
    "let me look — see what's out there for you",
    "one sec, hunting for matches",
    "ok brb — finding things that could work",
    "alright lemme pull a batch for you — hang tight",
  ],
  zh: [
    "好 等我翻一下有什么合适的",
    "嗯嗯 我帮你捞一下岗位 稍等",
    "行 我看下有没有合的",
    "稍等我扫一眼 马上",
    "好勒 我找一下匹配的",
    "等我看看有啥能推的",
    "嗯 我去捞一圈 一会儿",
    "好 我帮你对一下开放岗 稍等哈",
  ],
}

export const MATCH_COLLAB_PRE_CALL_VARIANTS: Record<"en" | "zh", readonly string[]> = {
  en: [
    "ok lemme check our partner roles for you — one sec",
    "hold on — seeing if any collab interviews fit",
    "one sec, lining up partner openings for you",
    "ok brb — checking interview-track roles",
  ],
  zh: [
    "等我看看有没有合作的面试岗适合你",
    "稍等 我对一下合作方的岗位",
    "嗯 我扫一眼合作岗 马上",
    "好 我看下有没有能推的面试机会",
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
  lang: "en" | "zh",
  seed?: string,
  rng: () => number = Math.random,
): string {
  return pickFromPool(FIND_MATCH_PRE_CALL_VARIANTS[lang], seed, rng)
}

export function composeMatchCollabPreCall(
  lang: "en" | "zh",
  seed?: string,
  rng: () => number = Math.random,
): string {
  return pickFromPool(MATCH_COLLAB_PRE_CALL_VARIANTS[lang], seed, rng)
}
