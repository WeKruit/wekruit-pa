/**
 * V16 0-match narration — grounded reply using real matcher counters.
 *
 * Adam directive 2026-05-27 ("If no jobs match, explain the reason naturally
 * and ask a useful next-step question."):
 *
 *   The legacy handleCompletedUserJobSearchRequest emitted the same generic
 *   line "I could not pull fresh roles right now" on every 0-match, throwing
 *   away V16's drop-reason histogram (`out.dropped`, `out.hardFilter`,
 *   `out.missingAxes`, `out.needsOnboarding`). This module reads those
 *   counters and composes a short reply that names the actual cause and
 *   asks a next-step question.
 *
 *   Pure function. No I/O. No LLM. Caller provides the V16 result snapshot
 *   and the output language; the function returns a 1-3 sentence reply.
 *
 * Why not LLM-compose this?
 *   1. Determinism: failure mode of "Claire vaguely apologizing" is exactly
 *      what got us here. A deterministic narrator can be unit-tested and
 *      asserted against in the conversation harness.
 *   2. Latency: the user just waited for V16 to evaluate 500 jobs. Don't
 *      add another LLM call before the reply lands.
 *   3. Cost: 0-match turns happen on every cold-start user.
 *
 *   When more nuance is needed later, callers can post-process this string
 *   through an LLM rewriter — but the structural decision (which counter to
 *   surface) belongs here.
 */

export interface V16CountersForNarration {
  /** True when the user has no `pa-users.tags` doc at all. */
  noUserTags?: boolean
  /**
   * True when V16's needsOnboarding branch fired — at least one matcher axis
   * is empty (typically targetRoleFunction, targetLocations, visaStatus,
   * careerStage, or targetJobType).
   */
  needsOnboarding?: boolean
  /**
   * Axes that are missing or empty when `needsOnboarding === true`. Closed
   * vocab from V16; we map a subset to human-readable phrasings below.
   */
  missingAxes?: readonly string[]
  /** Total candidate jobs V16 evaluated (pre-filter). */
  total?: number
  /**
   * Candidates dropped by V16 hard filter. When `dropped === total && total > 0`,
   * every fresh candidate failed at least one hard gate — Claire should name
   * the dominant gate.
   */
  dropped?: number
  /**
   * Per-gate drop histogram returned by V16. Counters for: `visa`,
   * `location`, `careerStage`, `jobType`, `freshness`, `atsApplyUrl`, `dead`,
   * `roleFunction`. Keys absent when 0.
   */
  hardFilter?: Readonly<Record<string, number>>
  /**
   * True if V16 was called with `collabPrescreenOnly` and no partner jobs
   * match. Caller phrases differently for partner vs. open-market.
   */
  collabPrescreenOnly?: boolean
}

export type NarrationLang = "en" | "zh"

/**
 * Human-readable phrasing for each missingAxes key, per language. Keep
 * concise — one short noun phrase, not a full sentence.
 */
const AXIS_PHRASING_EN: Readonly<Record<string, string>> = {
  targetRoleFunction: "what kind of role you want",
  targetLocations: "where you want to work",
  visaStatus: "your work-authorization status",
  careerStage: "your seniority level",
  targetJobType: "the job type (full-time, internship, contract)",
  industrySector: "the industries you care about",
}

const AXIS_PHRASING_ZH: Readonly<Record<string, string>> = {
  targetRoleFunction: "想做什么类型的岗位",
  targetLocations: "想在哪儿工作",
  visaStatus: "签证 / 工作授权状态",
  careerStage: "资历水平",
  targetJobType: "岗位类型（全职 / 实习 / 合同）",
  industrySector: "感兴趣的行业",
}

/**
 * Human-readable phrasing for each hardFilter gate, per language. Same
 * concision rule as above.
 */
const GATE_PHRASING_EN: Readonly<Record<string, string>> = {
  visa: "all the fresh roles I have need work authorization I don't see on file for you",
  location: "all the fresh roles are in places that don't match your location prefs",
  careerStage: "the fresh roles I have are at a different seniority level than where you are",
  jobType: "all the fresh roles are a job type you didn't say you wanted",
  freshness: "everything in the corpus is older than my 20-day freshness window",
  atsApplyUrl: "the fresh roles I have don't have a working apply link",
  dead: "the matching jobs got pulled or expired",
  roleFunction: "I didn't find roles in your target role family today",
}

const GATE_PHRASING_ZH: Readonly<Record<string, string>> = {
  visa: "现在的新岗位都需要工作授权，你的签证情况对不上",
  location: "新岗位的地点都不在你的偏好范围内",
  careerStage: "新岗位的资历层级跟你不在一个段位",
  jobType: "新岗位的工作类型不是你想要的",
  freshness: "我能看到的岗位都超过 20 天没更新了",
  atsApplyUrl: "新岗位都没有可用的申请链接",
  dead: "原来的匹配岗位已经下架或过期了",
  roleFunction: "今天没找到你目标角色家族的新岗位",
}

/**
 * Concrete next-step question per dominant gate. Caller can append.
 */
const GATE_FOLLOWUP_EN: Readonly<Record<string, string>> = {
  visa: "Want me to broaden to roles that don't require sponsorship I can't confirm?",
  location: "Want me to broaden the location?",
  careerStage: "Want me to look at adjacent seniority levels?",
  jobType: "Want me to include other job types?",
  freshness: "Want me to extend the freshness window or check yesterday's batch again?",
  atsApplyUrl: "Want me to surface roles where I'll need to find the link myself?",
  dead: "Want me to look at fresh roles in the same role family instead?",
  roleFunction: "Want me to look at adjacent role families?",
}

const GATE_FOLLOWUP_ZH: Readonly<Record<string, string>> = {
  visa: "要不要放宽到不要求 sponsor 的岗位？",
  location: "要不要把地点放宽一些？",
  careerStage: "要不要看看相邻资历的岗位？",
  jobType: "要不要包含其他工作类型？",
  freshness: "要不要放宽 freshness 窗口，再看一遍昨天的批次？",
  atsApplyUrl: "要不要看一些需要我自己去找申请链接的岗位？",
  dead: "要不要看看同一角色家族的新岗位？",
  roleFunction: "要不要看看相邻角色家族的岗位？",
}

/**
 * Return the gate with the highest drop count. Ties broken by the order
 * keys were first seen — V16 returns hardFilter in evaluation order, so
 * earlier-in-order = earlier-in-cascade = stronger signal.
 */
function dominantGate(hardFilter: Readonly<Record<string, number>> | undefined): string | null {
  if (!hardFilter) return null
  let bestKey: string | null = null
  let bestCount = 0
  for (const [k, v] of Object.entries(hardFilter)) {
    if (typeof v !== "number" || v <= 0) continue
    if (v > bestCount) {
      bestKey = k
      bestCount = v
    }
  }
  return bestKey
}

function axisLabel(axis: string, lang: NarrationLang): string {
  const map = lang === "zh" ? AXIS_PHRASING_ZH : AXIS_PHRASING_EN
  return map[axis] ?? axis
}

function gateLabel(gate: string, lang: NarrationLang): string {
  const map = lang === "zh" ? GATE_PHRASING_ZH : GATE_PHRASING_EN
  return map[gate] ?? gate
}

function gateFollowup(gate: string, lang: NarrationLang): string {
  const map = lang === "zh" ? GATE_FOLLOWUP_ZH : GATE_FOLLOWUP_EN
  return map[gate] ?? (lang === "zh" ? "要不要换个方向？" : "Want me to broaden the search?")
}

/**
 * Compose a 1-3 sentence reply for a 0-match V16 result. Caller is
 * responsible for sending the reply through the same outbound pipeline
 * non-zero-match replies use.
 *
 * Result is always non-empty — callers can drop the legacy "I could not
 * pull fresh roles right now" fallback entirely.
 */
export function composeNoMatchReply(
  counters: V16CountersForNarration,
  lang: NarrationLang,
): string {
  // 1. No user tags at all — direct ask, no apology.
  if (counters.noUserTags) {
    return lang === "zh"
      ? "我这边还没拿到你的偏好资料 — 想从哪儿开始？目标角色 / 地点 / 工作授权状态 任选一个我们就能跑起来。"
      : "I don't have your preference profile on file yet — where do you want to start? Tell me one of: target role, location, or work-authorization status, and I can run the search."
  }

  // 2. Onboarding gap — name the most-load-bearing missing axis.
  if (counters.needsOnboarding) {
    const axes = (counters.missingAxes ?? []).slice(0, 2)
    if (axes.length > 0) {
      const labels = axes.map((a) => axisLabel(a, lang))
      if (lang === "zh") {
        return `我没法跑匹配，因为 ${labels.join(" 和 ")} 还没填 — 你跟我说一下，下次拉的就准了。`
      }
      return `I can't run a clean match yet because I don't have ${labels.join(" or ")} on file — tell me and the next pull will be sharp.`
    }
    return lang === "zh"
      ? "我的偏好资料还有一两个轴是空的 — 跟我说一下目标角色、地点、签证、资历，下次匹配就能精准了。"
      : "Your preference profile has a couple of axes still empty — give me target role, location, visa, or seniority, and the next pull will be sharp."
  }

  // 3. Partner/collab pool empty — different framing.
  if (counters.collabPrescreenOnly) {
    return lang === "zh"
      ? "今天的合作岗里没看到跟你匹配的 — 我可以扩到整个开放市场再扫一轮吗？"
      : "I didn't find a partner role that fits today — want me to widen to the open market and scan again?"
  }

  // 4. Hard-filter wipeout — name the dominant gate.
  const total = counters.total ?? 0
  const dropped = counters.dropped ?? 0
  const gate = dominantGate(counters.hardFilter)
  if (total > 0 && dropped >= total && gate) {
    if (lang === "zh") {
      return `我扫了 ${total} 个新岗位，全被 hard filter 拦了 — ${gateLabel(gate, lang)}。${gateFollowup(gate, lang)}`
    }
    return `I scanned ${total} fresh roles and the hard filter dropped all of them — ${gateLabel(gate, lang)}. ${gateFollowup(gate, lang)}`
  }

  // 5. Empty corpus — no jobs to evaluate at all.
  if (total === 0) {
    return lang === "zh"
      ? "今天的新岗位池暂时空了。我标记了这次请求，等下批进来我再扫一遍。"
      : "The fresh-role pool is empty for now. I've marked your request and will scan again when the next batch lands."
  }

  // 6. Soft-score wipeout (rare — V16 had survivors but ranker dropped all).
  if (total > 0) {
    if (lang === "zh") {
      return `我扫了 ${total} 个岗位，但没一个的匹配分够高。要不要稍微放宽一下偏好？`
    }
    return `I scanned ${total} roles but none scored high enough to send. Want to loosen one preference and let me try again?`
  }

  // Fallback — should be unreachable; kept as a never-empty terminal.
  return lang === "zh"
    ? "这次没匹到合适的。要不要换个方向我再试试？"
    : "Nothing fit this round. Want me to try a different angle?"
}

/**
 * Caller-friendly tag for trace metadata. Maps the same V16 result to a
 * short string so `pa-turn-traces.noMatchReason` is a stable enum value
 * rather than the prose copy.
 */
export function noMatchReasonTag(counters: V16CountersForNarration): string {
  if (counters.noUserTags) return "no_user_tags"
  if (counters.needsOnboarding) {
    const axes = counters.missingAxes ?? []
    return axes.length > 0 ? `missing_axis:${axes[0]}` : "needs_onboarding"
  }
  if (counters.collabPrescreenOnly) return "no_collab_match"
  const total = counters.total ?? 0
  const dropped = counters.dropped ?? 0
  if (total > 0 && dropped >= total) {
    const gate = dominantGate(counters.hardFilter)
    return gate ? `hard_filter:${gate}` : "hard_filter_wipeout"
  }
  if (total === 0) return "empty_corpus"
  return "soft_score_below_threshold"
}
