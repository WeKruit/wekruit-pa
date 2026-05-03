/**
 * Phase 52 — F1 fix: turn-0 cold-start intent acknowledgement.
 *
 * Why this exists:
 *   The intent-matrix sim (Agent 3, commit 457d85f) discovered that fresh
 *   users' first message is silently dropped from the intent funnel — Claire
 *   ALWAYS replies with the Adam-locked first_mes ("在呢. 今天找你聊点啥? 🍋")
 *   regardless of whether the user typed "帮我找软件工程师工作" (job_search),
 *   "我是 OPT 应届" (visa_check), or anything else. Real production users
 *   arrive WITH intent — eating it on turn-0 is a retention bug.
 *
 * Strategy (Adam brief: "this can be a reusable path"):
 *   Lightweight bilingual regex classifier on the user's first message. If a
 *   high-confidence intent fires, the onboarding `send_first_mes` step
 *   becomes intent-aware: directive instructs the LLM to (1) ack the intent
 *   in one short clause, (2) defer to the role-direction question (Adam's
 *   `ask_q_role` phrase). Low-confidence / abuse / casual → unchanged
 *   Adam-locked greeting. Defense-in-depth: even if safety regex bank misses
 *   a probe, we refuse to ack injection text — fall through to greeting.
 *
 * NO LLM in this path — pure regex. Cost: zero tokens.
 *
 * Bilingual coverage targets the 6 sim-matrix intents:
 *   job_search, visa_check, resume_parse, preference_update, casual_chat,
 *   abuse. The bank is intentionally narrow — false-positive cost
 *   (acking a casual chat as job_search) is higher than miss cost
 *   (gracefully falling back to greeting).
 */

export type FirstTurnIntent =
  | "job_search"
  | "visa_check"
  | "resume_parse"
  | "preference_update"
  | "casual_chat"
  | "abuse"
  | "vent"

export type FirstTurnDetection = {
  intent: FirstTurnIntent | null
  confidence: "high" | "low"
  /** matched pattern ids (safe to log — no raw user text). */
  signals: string[]
}

type IntentPattern = {
  id: string
  intent: FirstTurnIntent
  regex: RegExp
}

/**
 * Bilingual high-confidence patterns. Designed to bias toward false NEGATIVE:
 * if a user types something ambiguous like "你好", we'd rather show the
 * Adam-locked greeting than ack a non-existent intent.
 */
const INTENT_PATTERNS: readonly IntentPattern[] = [
  // ---------- job_search ----------
  // ZH — explicit ask for jobs / role / matching
  {
    id: "job_search_zh_find",
    intent: "job_search",
    // Allow filler between 找/看 and the role/work noun (e.g. "帮我找软件工程师工作").
    regex: /(?:帮我|帮帮|想|要)?\s*(?:找|看|要)\s*(?:一些|个|份)?\s*(?:[一-鿿A-Za-z]{0,8}\s*)?(?:工作|活|职位|岗位|内推|实习|intern|swe|pm|工程师|开发|machine\s*learning|ml|数据|岗)/i,
  },
  {
    id: "job_search_zh_change",
    intent: "job_search",
    regex: /(?:想换|在看|准备换|考虑换|想跳槽|跳槽|换工作)/,
  },
  {
    id: "job_search_zh_role",
    intent: "job_search",
    regex: /(?:找|看|要)(?:个|份|一份)?\s*(?:swe|pm|em|ic|staff|senior|junior|new\s*grad|应届)\s*(?:工作|岗位|岗|内推|的活|位置|实习|intern)/i,
  },
  {
    id: "job_search_zh_internship",
    intent: "job_search",
    regex: /(?:找|要|看)(?:个|份|一些)?\s*(?:实习|internship|intern\s*岗|暑期实习)/i,
  },
  // EN — find/look/want jobs
  {
    id: "job_search_en_find",
    intent: "job_search",
    regex: /\b(?:find|get|help\s+me\s+find|looking\s+for|searching\s+for|need|want)\b[^.!?]{0,40}\b(?:jobs?|roles?|positions?|gigs?|opportun(?:ity|ities)|swe|pm|em|ic|staff|senior|new\s*grad|internships?|intern)\b/i,
  },
  {
    id: "job_search_en_explore",
    intent: "job_search",
    regex: /\b(?:exploring|on\s+the\s+market|on\s+the\s+job\s+market|job\s+hunt(?:ing)?|recruit(?:ing|er)|interview(?:s|ing)?\b[^.!?]{0,30}\b(?:prep|coming))/i,
  },
  {
    id: "job_search_en_changing",
    intent: "job_search",
    regex: /\b(?:thinking|considering|wanna|want\s+to)\s+(?:switch|change|leave|quit)\b[^.!?]{0,30}\b(?:jobs?|companies|roles?|career)\b/i,
  },

  // ---------- visa_check ----------
  // ZH — visa / OPT / H1B / sponsor
  {
    id: "visa_check_zh",
    intent: "visa_check",
    regex: /(?:我是|我有|关于|问下|身份|签证|工作签证|工作授权|身份问题|身份方面)\s*[^。，！？]{0,15}?(?:opt|h-?1\s*b|h1b|绿卡|gc|公民|sponsor|sponsorship|身份|签证)/i,
  },
  {
    id: "visa_check_zh_sponsor",
    intent: "visa_check",
    regex: /(?:需要|要|要找|找)(?:.{0,8}?)?(?:sponsor|sponsorship|赞助签证|h-?1\s*b)/i,
  },
  // EN — work auth / sponsorship / OPT
  {
    id: "visa_check_en",
    intent: "visa_check",
    regex: /\b(?:i'?m|i\s+am|on)\s+(?:on\s+)?(?:opt|stem\s*opt|h-?1\s*b|f-?1|cpt|tn|o-?1)\b/i,
  },
  {
    id: "visa_check_en_need",
    intent: "visa_check",
    regex: /\b(?:need|want|looking\s+for|require)\b[^.!?]{0,30}\b(?:sponsor(?:ship)?|work\s+auth(?:orization)?|h-?1\s*b|visa)\b/i,
  },

  // ---------- resume_parse ----------
  // ZH
  {
    id: "resume_parse_zh",
    intent: "resume_parse",
    regex: /(?:我的|帮我|看看|改改|看下|review)\s*(?:简历|cv|resume)/i,
  },
  // EN
  {
    id: "resume_parse_en",
    intent: "resume_parse",
    regex: /\b(?:my|here'?s|here\s+is|attached(?:\s+is)?|sending|share|share\s+my|i'?ll\s+send)\b[^.!?]{0,15}\b(?:resume|cv|profile)\b/i,
  },
  {
    id: "resume_parse_en_review",
    intent: "resume_parse",
    regex: /\b(?:review|look\s+at|check|critique|fix)\s+(?:my\s+)?(?:resume|cv)\b/i,
  },

  // ---------- preference_update ----------
  // ZH — switching role direction / location / target
  {
    id: "preference_update_zh",
    intent: "preference_update",
    regex: /(?:现在|最近|后来)(?:.{0,8}?)?(?:想转|想做|想去|改做|改方向|换方向)/,
  },
  // EN — pivot / switch direction
  {
    id: "preference_update_en",
    intent: "preference_update",
    regex: /\b(?:pivot(?:ing)?|switch(?:ing)?|moving)\s+(?:to|into)\b[^.!?]{0,30}\b(?:pm|em|director|management|ic|engineering|design|research|founder)\b/i,
  },

  // ---------- vent (Adam iter 21) ----------
  // First-turn distress signal. Without this, "我崩溃了" / "I'm losing it"
  // gets the bare "在呢. 今天找你聊点啥?" boilerplate — discards the
  // user's emotional state on turn-0. iter-20 5-playbook test surfaced
  // this in vent_support_zh scenario.
  // ZH
  {
    id: "vent_zh",
    intent: "vent",
    regex: /(?:崩溃|崩了|烦死|烦透|累死|想哭|我裂开|压力大|破防|emo|心累|绝望|受不了)/,
  },
  // EN
  {
    id: "vent_en",
    intent: "vent",
    regex: /\b(?:so\s+done|can'?t\s+(?:do\s+this|anymore|take\s+(?:it|this))|fed\s+up|burnt?\s+out|breaking\s+down|losing\s+it|exhausted|drained|miserable|going\s+to\s+lose\s+it)\b/i,
  },
]

/**
 * Defense-in-depth: a *light* abuse signal so we don't accidentally craft a
 * cheery "好咧! 帮你..." ack for an injection probe that slipped past the
 * pa-safety gate. The pa-safety v2 bank is the source of truth — this is
 * just a guard. Match → return intent=abuse → upstream falls back to default
 * Adam-locked greeting (NOT to safety canned reply — safety already passed).
 */
const ABUSE_GUARD_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts?)/i,
  /system\s*prompt/i,
  /\bjailbreak\b|\bDAN\b/i,
  /忽略(?:上面|前面|之前|所有)/,
  /系统提示|系统指令|prompt\s*injection/i,
  /你现在是\s*(?:DAN|admin|管理员|开发者|系统|root|越狱)/i,
]

/**
 * Casual chat / greeting / venting — we DO route these to the default
 * Adam-locked greeting (no intent ack). Detection lets us return
 * intent=casual_chat as a positive signal so callers can branch if they want
 * (currently same behavior as null; reserved for future).
 */
const CASUAL_PATTERNS: readonly RegExp[] = [
  /^(?:你好|嗨|hi|hello|hey|嗨呀|哈喽)\s*[!！.。?？~～]?\s*$/i,
  /^(?:在吗|在不在|忙吗)[!！.。?？~～]?\s*$/i,
  /^(?:有人吗|hey\s+there|whats?\s*up|sup)[!！.。?？~～]?\s*$/i,
]

/**
 * Detect intent on the FIRST inbound message of a fresh user. Returns
 * `{ intent: null }` for ambiguous / empty input (caller should fall back
 * to the Adam-locked greeting unchanged).
 *
 * This is intentionally NOT a general-purpose intent classifier — it is
 * scoped to onboarding turn-0 only. Mid-conversation intent routing remains
 * with `matchCachedPlaybooks` + `HEADHUNTER_TRIGGER_RE`.
 */
export function detectFirstTurnIntent(text: string | undefined | null): FirstTurnDetection {
  const body = (text ?? "").trim()
  if (!body) return { intent: null, confidence: "low", signals: [] }

  // Abuse guard FIRST — never ack injection-shaped text.
  for (const re of ABUSE_GUARD_PATTERNS) {
    if (re.test(body)) {
      return { intent: "abuse", confidence: "high", signals: ["abuse_guard"] }
    }
  }

  const signals: string[] = []
  let firstMatchedIntent: FirstTurnIntent | null = null
  for (const p of INTENT_PATTERNS) {
    if (p.regex.test(body)) {
      signals.push(p.id)
      if (firstMatchedIntent === null) firstMatchedIntent = p.intent
    }
  }
  if (firstMatchedIntent) {
    return { intent: firstMatchedIntent, confidence: "high", signals }
  }

  // Casual / greeting → low-confidence positive signal (still uses default greeting).
  for (const re of CASUAL_PATTERNS) {
    if (re.test(body)) {
      return { intent: "casual_chat", confidence: "high", signals: ["casual_pattern"] }
    }
  }

  return { intent: null, confidence: "low", signals: [] }
}

/**
 * Bilingual intent-ack templates for the 4 actionable intents. ZH and EN are
 * directives, NOT exact strings — the LLM composes the natural reply from
 * the directive (Adam-locked tone preserved via shape constraints).
 *
 * casual_chat / abuse / null → caller does NOT use these templates and
 * routes to the unchanged `send_first_mes` greeting path.
 */
export const INTENT_ACK_DIRECTIVES: Record<
  Exclude<FirstTurnIntent, "casual_chat" | "abuse">,
  { zh: string; en: string }
> = {
  job_search: {
    zh: '用户开口就在找工作。用 friend-tone 说"好咧, 帮你看看 [角色/岗位] 的活" (1 短句, 体现你听到了用户具体说的方向, 不要照抄"角色/岗位" 字样), 然后接 ask_q_role 那句问题。',
    en: 'user came in asking about jobs. friend-tone ack like "got you, let\'s get you sorted on [role they mentioned]" (1 short clause, name the actual role/track they said — don\'t echo the brackets), then chain ask_q_role to confirm direction.',
  },
  visa_check: {
    zh: '用户开口就在说身份/签证 (OPT / H1B / 绿卡 / sponsor)。用 friend-tone 说"行, 身份这块我帮你盯着" 类似的一句 ack, 然后 chain ask_q_role 那句问题 (我们先确认方向, 身份在 q_visa 那步问).',
    en: 'user came in mentioning work auth / OPT / sponsorship. friend-tone ack like "got you, we\'ll keep visa in scope" (1 clause), then chain ask_q_role since we ask role direction first (visa is asked later in q_visa).',
  },
  resume_parse: {
    zh: '用户提到简历/CV。用 friend-tone 说"好啊, 简历发我看看" 类似一句 ack, 然后 chain ask_q_role 那句问题 (先确认方向, 这样后面解析简历有上下文).',
    en: 'user mentioned resume/cv. friend-tone ack like "yeah send it over, I\'ll take a look" (1 clause), then chain ask_q_role to lock direction first (so resume parse has context).',
  },
  preference_update: {
    zh: '用户开口就在说想转方向 (PM / EM / 转 IC / 转管理). friend-tone 说"嗯, 那我们顺着这个方向聊" 类似一句 ack, 然后 chain ask_q_role 那句确认问题.',
    en: 'user came in talking about pivoting direction (PM / EM / IC / management). friend-tone ack like "got it, let\'s go with that" (1 clause), then chain ask_q_role to lock the new direction.',
  },
  vent: {
    zh: "用户开口就在情绪发泄 (崩溃 / 烦死 / 心累). 你不是治疗师, 不是 coach, 是那个不打断的室友. ONE-SHORT acknowledgement only — 比如 \"嗯, 听着挺累的.\" 或 \"卧, 那确实.\" 或 \"听起来挺烦的, 你想说说不?\" — 不超过 12 字 / ≤2 短句. NEVER 给建议, NEVER 列原因, NEVER 引导 ask_q_role 这种 onboarding 问题, NEVER 鸡汤. 之后不接任何问题 — 让用户继续吐. friend-tone, Mandarin.",
    en: "user came in venting / distressed. you're not a therapist, not a coach — you're the roommate who doesn't interrupt. ONE-SHORT ack only — like \"yeah, that sounds rough.\" or \"oh fr, that sucks.\" or \"i hear you. wanna say more?\" — under 15 words / ≤2 short sentences. NEVER give advice, NEVER list reasons, NEVER chain into ask_q_role onboarding, NEVER pep talk. don't append any question — let them keep venting. friend-tone, English.",
  },
}
