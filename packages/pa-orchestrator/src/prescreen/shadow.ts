/**
 * v1.8 Phase 81 — Onboarding migration shadow framework.
 *
 * Per PS10 + Adam directive 2026-05-11 ("不一刀切; 双写期 + feature flag, 先
 * shadow 跑 7 天比对老 deterministic dispatcher 输出 diff, diff 率 < 1% 再切流"),
 * the migration from `onboarding-deterministic.ts` (legacy) to the new
 * PreScreenPipeline-derived engine runs in three phases per user:
 *
 *   1. engineVersion="v1"       → only legacy runs (default for existing users)
 *   2. engineVersion="v2_shadow" → both engines run; only v1 reply emits;
 *                                  v2 output written to pa-onboarding-shadow-diff
 *   3. engineVersion="v2"       → only new engine runs
 *
 * This file is the SHADOW-PHASE framework: feature-flag resolution, diff
 * recording, jaccard-similarity comparator, and gate evaluation (< 1% mean
 * diff over 7 days). The actual rollout flip is operational (Adam writes
 * `pa-feature-flags/onboarding-engine.users.[uid] = "v2"`) — this file
 * just produces the diff signal that informs the decision.
 */

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type EngineVersion = "v1" | "v2_shadow" | "v2"

/** Per-user feature-flag entry stored at pa-feature-flags/onboarding-engine.users. */
export interface OnboardingEngineFlag {
  /** Map of userId → engineVersion. */
  users?: Record<string, EngineVersion>
  /** Default for users not explicitly listed. */
  default: EngineVersion
  /** Optional cohort percentage roll-out (0..100). Caller hashes userId. */
  cohortPct?: number
}

/** Recorded diff for one shadow turn. */
export interface OnboardingShadowDiff {
  userId: string
  turnId: string
  ts: string
  prompt: string
  /** Reply emitted by the live (v1) engine — what the user actually saw. */
  v1Reply: string
  /** Reply that v2 would have produced. */
  v2Reply: string
  /** Jaccard similarity over normalized tokens, ∈ [0, 1]. */
  jaccard: number
  /** True when v1Reply and v2Reply diverge enough to count as a real diff. */
  isDiff: boolean
  /** Stage advance / halt agreement. */
  stateAgreed: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Feature-flag resolution
// ────────────────────────────────────────────────────────────────────────────

/**
 * Hash a string to a stable [0, 100) bucket. Used for cohort roll-out so
 * we don't need to enumerate every user in the flag doc.
 */
export function userIdToCohortBucket(userId: string): number {
  let h = 0
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) | 0
  }
  return Math.abs(h) % 100
}

/**
 * Resolve which engine version applies to a given user. Lookup order:
 *   1. Explicit users[uid] entry
 *   2. Cohort bucket vs cohortPct (if set, < cohortPct → "v2_shadow")
 *   3. Default
 */
export function resolveEngineVersion(
  flag: OnboardingEngineFlag,
  userId: string
): EngineVersion {
  const explicit = flag.users?.[userId]
  if (explicit) return explicit
  if (typeof flag.cohortPct === "number" && flag.cohortPct > 0) {
    if (userIdToCohortBucket(userId) < flag.cohortPct) return "v2_shadow"
  }
  return flag.default
}

// ────────────────────────────────────────────────────────────────────────────
// Diff comparator
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a reply for comparison. Lowercase + strip punctuation +
 * collapse whitespace. Mirrors the gentle-touch approach used in
 * voice/style-analyzer.ts to avoid spurious-diff noise.
 */
export function normalizeReplyForDiff(reply: string): string {
  return reply
    .toLowerCase()
    .replace(/[，。！？.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Tokenize a normalized reply into a Set of tokens for Jaccard. Treats
 * CJK characters individually (per-char Set) and non-CJK as
 * whitespace-split words. Matches the heuristic used by mirror-snippet.ts.
 */
export function tokenizeForJaccard(normalized: string): Set<string> {
  const tokens = new Set<string>()
  for (const ch of normalized) {
    // CJK / Hangul / Kana ranges → per-character token
    if (/[一-鿿぀-ヿ가-힯]/.test(ch)) {
      tokens.add(ch)
    }
  }
  // Whitespace-split non-CJK tokens
  for (const w of normalized.split(/\s+/)) {
    if (w.length > 0 && !/[一-鿿぀-ヿ가-힯]/.test(w[0])) {
      tokens.add(w)
    }
  }
  return tokens
}

/**
 * Compute Jaccard similarity ∈ [0, 1] over two normalized replies.
 * Identical replies → 1; disjoint vocab → 0.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = tokenizeForJaccard(normalizeReplyForDiff(a))
  const sb = tokenizeForJaccard(normalizeReplyForDiff(b))
  if (sa.size === 0 && sb.size === 0) return 1
  let intersection = 0
  for (const t of sa) {
    if (sb.has(t)) intersection++
  }
  const union = sa.size + sb.size - intersection
  if (union === 0) return 1
  return intersection / union
}

/** Threshold below which a shadow turn counts as a real diff (PS10 < 1%). */
export const DIFF_JACCARD_THRESHOLD = 0.85

/**
 * Build the diff record for one shadow turn. Caller persists this to
 * `pa-onboarding-shadow-diff` for daily aggregation.
 */
export function buildShadowDiff(args: {
  userId: string
  turnId: string
  ts: string
  prompt: string
  v1Reply: string
  v2Reply: string
  v1StateAdvanced: boolean
  v2StateAdvanced: boolean
}): OnboardingShadowDiff {
  const j = jaccardSimilarity(args.v1Reply, args.v2Reply)
  return {
    userId: args.userId,
    turnId: args.turnId,
    ts: args.ts,
    prompt: args.prompt,
    v1Reply: args.v1Reply,
    v2Reply: args.v2Reply,
    jaccard: j,
    isDiff: j < DIFF_JACCARD_THRESHOLD,
    stateAgreed: args.v1StateAdvanced === args.v2StateAdvanced,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Gate evaluation
// ────────────────────────────────────────────────────────────────────────────

export interface ShadowGateReport {
  /** Total turns recorded over the window. */
  totalTurns: number
  /** Mean Jaccard across all turns. */
  meanJaccard: number
  /** Fraction of turns with isDiff=true. */
  diffRate: number
  /** Fraction of turns with stateAgreed=false. */
  stateDisagreeRate: number
  /** Pass ⇒ Adam can flip default to "v2". */
  gatePassed: boolean
  /** Reason when gate did not pass. */
  reason?: string
}

/**
 * Evaluate the 7-day shadow gate. Per PS10 the cutover criterion is
 * "diff rate < 1% over 7 days". This pure function takes the aggregated
 * diff records and produces a pass/fail report.
 *
 * Caller drives the date filter (`since`/`until`) at the Firestore-query
 * layer; this function operates on whatever batch is handed in.
 */
export function evaluateShadowGate(
  diffs: OnboardingShadowDiff[],
  opts: { minTurns?: number; diffRateThreshold?: number } = {}
): ShadowGateReport {
  const minTurns = opts.minTurns ?? 100
  const diffRateThreshold = opts.diffRateThreshold ?? 0.01 // 1%

  if (diffs.length < minTurns) {
    return {
      totalTurns: diffs.length,
      meanJaccard: 0,
      diffRate: 0,
      stateDisagreeRate: 0,
      gatePassed: false,
      reason: `not enough turns (${diffs.length} < ${minTurns} required)`,
    }
  }
  const sumJ = diffs.reduce((s, d) => s + d.jaccard, 0)
  const numDiff = diffs.filter((d) => d.isDiff).length
  const numStateDisagree = diffs.filter((d) => !d.stateAgreed).length
  const diffRate = numDiff / diffs.length
  const stateDisagreeRate = numStateDisagree / diffs.length

  const report: ShadowGateReport = {
    totalTurns: diffs.length,
    meanJaccard: sumJ / diffs.length,
    diffRate,
    stateDisagreeRate,
    gatePassed: false,
  }
  if (diffRate >= diffRateThreshold) {
    report.reason = `diff rate ${(diffRate * 100).toFixed(2)}% ≥ ${(diffRateThreshold * 100).toFixed(2)}% threshold`
    return report
  }
  if (stateDisagreeRate >= 0.005) {
    report.reason = `state-disagreement ${(stateDisagreeRate * 100).toFixed(2)}% ≥ 0.5% — engines advance differently, cannot cut over`
    return report
  }
  report.gatePassed = true
  return report
}
