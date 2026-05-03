/**
 * v1.5 / Phase 53.5 — Weighted skill match scoring (Adam 2026-05-02 spec).
 *
 * Why this exists:
 *   In dry-run testing, Adam observed Claire (recruiter mode) saying "你有
 *   Python 是 match" for jobs whose CORE requirement is RAG / tool calling /
 *   workflow orchestration. Python is necessary-but-not-sufficient — a
 *   single generic skill should NOT score the same as a core RAG hit.
 *
 *   Pre-Phase-53.5 the cosine + cross-encoder pipeline treated all required
 *   skill overlaps as roughly-equal (text-embedding-3-small doesn't know
 *   that "RAG" carries 6× the hiring signal of "Python" in the AI agent
 *   2026 market). This module adds a deterministic weighted-skill match
 *   pass that boosts jobs whose CORE requirement keywords are already in
 *   the user's CV skill list, and demotes jobs that match only on generic
 *   skills.
 *
 * Architecture (mirrors Stream I startup-boost in cross-encoder-rerank.ts):
 *   - SkillWeight table per role (core=3.0, supporting=1.5, generic=0.5)
 *   - computeWeightedMatchScore: pure / deterministic / no LLM
 *   - applyWeightedMatchBoost: multiplicative boost on already-ranked jobs,
 *     same shape as applyStartupBoost (jobs, signal, baseScores) → reorder
 *   - Default-OFF flag (paWeightedMatchEnabled). Off-flag = byte-identical
 *     pre-Phase-53.5 ranking.
 *
 * Latency: O(n × |weights|) = O(n × ~30) ≈ < 2ms over 25 jobs.
 *
 * Failure mode: pure / never throws / fallback to mult=1.0 on missing data.
 */

/** A single weight rule. `skill` matched case-insensitively as substring. */
export type SkillWeight = {
  /** Lower-cased substring to match against required-skills + CV-skills. */
  skill: string
  /** 0.5 (generic) – 3.0 (core hot keyword in 2026 market). */
  weight: number
  /** Bucket label — surfaced in coreMissing diagnostics. */
  category: "core" | "supporting" | "generic"
}

/**
 * AI agent / LLM application engineer — 2026 weight table.
 *
 * Hand-curated to align with packages/pa-orchestrator/src/voice/
 * job-market-knowledge.ts AI_AGENT_HOT_SKILLS_2026 bank. Adam constraint
 * (2026-05-02): conservative — only INDISPUTABLE hot keywords get core
 * weights. Niche frameworks (AutoGen / CrewAI / Haystack) deferred.
 */
export const AI_AGENT_SKILL_WEIGHTS: readonly SkillWeight[] = [
  // ---------- core (weight 3.0) — 2026 indisputable hot keywords ----------
  { skill: "rag", weight: 3.0, category: "core" },
  { skill: "retrieval-augmented", weight: 3.0, category: "core" },
  { skill: "function calling", weight: 3.0, category: "core" },
  { skill: "tool calling", weight: 3.0, category: "core" },
  { skill: "tool use", weight: 3.0, category: "core" },
  { skill: "workflow orchestration", weight: 2.5, category: "core" },
  { skill: "agentic", weight: 2.5, category: "core" },
  { skill: "multi-turn state", weight: 2.5, category: "core" },
  { skill: "multi-turn", weight: 2.0, category: "core" },
  { skill: "langchain", weight: 2.0, category: "core" },
  { skill: "llamaindex", weight: 2.0, category: "core" },
  { skill: "vector database", weight: 2.0, category: "core" },
  { skill: "embedding", weight: 1.8, category: "core" },
  // ---------- supporting (weight 1.5) — useful but not differentiating ----------
  { skill: "prompt engineering", weight: 1.5, category: "supporting" },
  { skill: "evaluation", weight: 1.5, category: "supporting" },
  { skill: "eval harness", weight: 1.5, category: "supporting" },
  { skill: "fine-tuning", weight: 1.5, category: "supporting" },
  { skill: "openai", weight: 1.2, category: "supporting" },
  { skill: "anthropic", weight: 1.2, category: "supporting" },
  { skill: "llm", weight: 1.2, category: "supporting" },
  // ---------- generic (weight 0.5) — necessary-but-not-sufficient ----------
  // Adam: "有时候一个 Python 他都觉得我 match" — Python alone is NOT a real match
  // for an AI agent role.
  { skill: "python", weight: 0.5, category: "generic" },
  { skill: "sql", weight: 0.5, category: "generic" },
  { skill: "javascript", weight: 0.5, category: "generic" },
  { skill: "typescript", weight: 0.5, category: "generic" },
  { skill: "git", weight: 0.5, category: "generic" },
  { skill: "docker", weight: 0.5, category: "generic" },
  { skill: "aws", weight: 0.7, category: "generic" },
  { skill: "gcp", weight: 0.7, category: "generic" },
  { skill: "kubernetes", weight: 0.7, category: "generic" },
]

/**
 * Score result. `score` is in [0, 1] — sum(matched weights) / sum(target
 * weights, capped). `matched` lists the matched SkillWeight entries (so the
 * H13 reason explainer can show "你 RAG / tool calling 对得上"). `coreMissing`
 * lists the CORE-category weight skills that the user's CV does NOT contain
 * (so reason can show "core 缺 RAG").
 */
export type WeightedMatchResult = {
  score: number
  matched: SkillWeight[]
  coreMissing: SkillWeight[]
}

function lower(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase().trim() : ""
}

/**
 * Returns true when `userSkills` contains any string that includes (or is
 * included by) `weightSkill` as a case-insensitive substring. This handles
 * "RAG" matching "rag pipeline experience", "LangChain" matching "langchain
 * 0.1.x", etc.
 */
function userHasSkill(userSkills: readonly string[], weightSkill: string): boolean {
  const ws = weightSkill.toLowerCase()
  for (const us of userSkills) {
    const u = lower(us)
    if (!u) continue
    if (u === ws) return true
    if (u.includes(ws)) return true
    if (ws.includes(u) && u.length >= 3) return true
  }
  return false
}

/**
 * Returns true when the job's required-skills list includes the weight skill.
 * Same substring rule as userHasSkill — symmetric.
 */
function jobRequires(jobSkills: readonly string[], weightSkill: string): boolean {
  return userHasSkill(jobSkills, weightSkill)
}

/**
 * Score a (user, job) pair against a weight table. Returns a result with:
 *   - score in [0, 1] = sum(matched weight) / sum(applicable weight)
 *   - matched: weights that fired (user has + job requires)
 *   - coreMissing: CORE weights that the JOB requires but the USER does NOT have
 *
 * "Applicable weight" is the sum of weights for skills the JOB requires —
 * we don't penalize the user for not having a skill that the job didn't ask
 * for. When the job requires no weighted skills (e.g. random job we have no
 * coverage for), score=1.0 (neutral — fall through to cosine ordering).
 *
 * Pure / deterministic / O(|userSkills| × |weights|).
 */
export function computeWeightedMatchScore(
  userSkills: readonly string[],
  jobSkills: readonly string[],
  weights: readonly SkillWeight[]
): WeightedMatchResult {
  const matched: SkillWeight[] = []
  const coreMissing: SkillWeight[] = []
  let matchedSum = 0
  let applicableSum = 0
  for (const w of weights) {
    const required = jobRequires(jobSkills, w.skill)
    if (!required) continue
    applicableSum += w.weight
    if (userHasSkill(userSkills, w.skill)) {
      matched.push(w)
      matchedSum += w.weight
    } else if (w.category === "core") {
      coreMissing.push(w)
    }
  }
  const score = applicableSum > 0 ? matchedSum / applicableSum : 1.0
  return { score, matched, coreMissing }
}

/**
 * Tunable boost weights. Same shape as BOOST_WEIGHTS in cross-encoder-rerank.
 *
 * Mapping from WeightedMatchResult.score to multiplicative boost:
 *   score >= 0.66  → ×1.20  (strong match — most core keywords hit)
 *   score >= 0.33  → ×1.05  (lean match — ≥ 1 core or several supporting)
 *   score <  0.33  → ×0.85  (sink — only generics matched, core missing)
 *   score >= 1.0 (no applicable weights) → ×1.00 (neutral — out of scope)
 *
 * Note: 0.85 < 1.0 means jobs with weak skill match are demoted relative to
 * those with neutral baseScore. This is the "single Python ≠ match" guard.
 */
export const WEIGHTED_MATCH_BOOSTS = {
  STRONG: 1.2,
  LEAN: 1.05,
  WEAK: 0.85,
  NEUTRAL: 1.0,
} as const

/** Per-job boost explanation for H13 reason explainer + observability. */
export type WeightedMatchExplanation = {
  jobId: string
  score: number
  boostMult: number
  matched: SkillWeight[]
  coreMissing: SkillWeight[]
}

/**
 * Apply weighted match scoring to a ranked candidate set. Pure / deterministic.
 * Mirrors the shape of applyStartupBoost (cross-encoder-rerank.ts):
 *
 *   - When applicableSum === 0 across all jobs (e.g. role doesn't match any
 *     weight table), returns input order + empty explanations (zero-cost path).
 *   - Otherwise, computes pseudo-score = (baseScore || 1.0) × boostMult, sorts
 *     descending, and returns new order + explanations for non-1.0 entries.
 *
 * `userSkills` — flat array from candidateProfile.skills.
 * `weights` — pass AI_AGENT_SKILL_WEIGHTS for AI agent jobs; future role tables
 *             can be passed by the caller (caller decides which table applies
 *             based on role detection).
 *
 * Latency: O(n × |weights|) — empirically < 2ms over 25 jobs × 30 weights.
 */
export function applyWeightedMatchBoost<
  J extends { id: string; requiredSkills?: readonly string[] | null },
>(
  jobs: readonly J[],
  userSkills: readonly string[],
  weights: readonly SkillWeight[],
  baseScores?: ReadonlyMap<string, number | null>
): { jobs: J[]; explanations: WeightedMatchExplanation[] } {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { jobs: [], explanations: [] }
  }
  const explanations: WeightedMatchExplanation[] = []
  let anyNonNeutral = false
  const scored = jobs.map((j, idx) => {
    const required = Array.isArray(j.requiredSkills) ? j.requiredSkills : []
    const result = computeWeightedMatchScore(userSkills, required, weights)
    let mult: number = WEIGHTED_MATCH_BOOSTS.NEUTRAL
    // Only apply non-neutral mult when the JOB had ≥ 1 applicable weight
    // (i.e. computeWeightedMatchScore actually had data to score against).
    // The "neutral" score=1.0 case (applicableSum=0) is out-of-scope.
    if (result.matched.length > 0 || result.coreMissing.length > 0) {
      if (result.score >= 0.66) mult = WEIGHTED_MATCH_BOOSTS.STRONG
      else if (result.score >= 0.33) mult = WEIGHTED_MATCH_BOOSTS.LEAN
      else mult = WEIGHTED_MATCH_BOOSTS.WEAK
      if (mult !== WEIGHTED_MATCH_BOOSTS.NEUTRAL) anyNonNeutral = true
      explanations.push({
        jobId: j.id,
        score: result.score,
        boostMult: mult,
        matched: result.matched,
        coreMissing: result.coreMissing,
      })
    }
    const base = (() => {
      const s = baseScores?.get(j.id)
      if (typeof s === "number" && Number.isFinite(s) && s > 0) return s
      return 1.0
    })()
    return { j, score: base * mult, idx }
  })
  if (!anyNonNeutral) {
    return { jobs: jobs.slice(), explanations: [] }
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.idx - b.idx // stable on ties
  })
  return { jobs: scored.map((s) => s.j), explanations }
}

/** Feature flag key. Default OFF; ramp 1% → 100%. */
export const WEIGHTED_MATCH_FLAG_KEY = "paWeightedMatchEnabled"
