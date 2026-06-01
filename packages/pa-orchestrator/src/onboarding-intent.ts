/**
 * Phase 52 — F1 fix: turn-0 cold-start intent acknowledgement.
 *
 * Why this exists:
 *   The intent-matrix sim (Agent 3, commit 457d85f) discovered that fresh
 *   users' first message is silently dropped from the intent funnel — Claire
 *   ALWAYS replies with the Adam-locked first_mes (the Adam-locked first_mes greeting)
 *   regardless of whether the user typed a job_search ask, a visa_check
 *   ask, or anything else. Real production users
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
  | "interview_prep"
  | "negotiation"
  | "motivation_nudge"

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
 * if a user types something ambiguous like "hi", we'd rather show the
 * Adam-locked greeting than ack a non-existent intent.
 */
const INTENT_PATTERNS: readonly IntentPattern[] = [
  // ---------- job_search ----------
  // ZH — explicit ask for jobs / role / matching
  {
    id: "job_search_zh_find",
    intent: "job_search",
    // Allow filler between the verb and the role/work noun.
    regex: /\b(?:find|want|looking\s+for|need)\b[^.!?]{0,20}\b(?:job|jobs|role|roles|position|positions|referral|internship|intern|swe|pm|machine\s*learning|ml)\b/i,
  },
  {
    id: "job_search_zh_change",
    intent: "job_search",
    regex: /\b(?:switch\s+jobs|change\s+jobs|job\s+hopping)\b/i,
  },
  {
    id: "job_search_zh_role",
    intent: "job_search",
    regex: /\b(?:swe|pm|em|ic|staff|senior|junior|new\s*grad)\s+(?:job|jobs|role|position|referral|internship|intern)\b/i,
  },
  {
    id: "job_search_zh_internship",
    intent: "job_search",
    regex: /\b(?:internship|intern\s+role|summer\s+internship)\b/i,
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
    regex: /\b(?:visa|work\s+auth(?:orization)?|status)\b[^.!?]{0,15}?(?:opt|h-?1\s*b|h1b|green\s+card|gc|citizen|sponsor|sponsorship)\b/i,
  },
  {
    id: "visa_check_zh_sponsor",
    intent: "visa_check",
    regex: /\b(?:need|want|require)\b[^.!?]{0,8}?(?:sponsor|sponsorship|h-?1\s*b)/i,
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
    regex: /\b(?:my|review|check|look\s+at)\s*(?:cv|resume)\b/i,
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
    regex: /\b(?:want\s+to|wanna|thinking\s+of)\s+(?:switch|change|pivot|move)\b/i,
  },
  // EN — pivot / switch direction
  {
    id: "preference_update_en",
    intent: "preference_update",
    regex: /\b(?:pivot(?:ing)?|switch(?:ing)?|moving)\s+(?:to|into)\b[^.!?]{0,30}\b(?:pm|em|director|management|ic|engineering|design|research|founder)\b/i,
  },

  // ---------- interview_prep (Adam iter 23) ----------
  // ZH — interview prep / system design / behavioral
  {
    id: "interview_prep_zh",
    intent: "interview_prep",
    regex: /\b(?:interview|onsite|on-site|technical\s*screen)\s+(?:prep|nervous|how\s+to\s+prepare)|(?:system\s*design|behavioral|coding|leetcode)\s+(?:nervous|how|prep)/i,
  },
  {
    id: "interview_prep_zh_general",
    intent: "interview_prep",
    regex: /\b(?:interview|onsite|on-site)\s+(?:nervous|anxious|scared)\b/i,
  },
  // EN
  {
    id: "interview_prep_en",
    intent: "interview_prep",
    regex: /\b(?:interview|onsite|on-site|technical\s*screen|coding\s*round|behavioral\s*round|system\s*design)\b[^.!?]{0,40}\b(?:tomorrow|next\s+week|coming\s+up|prep|nervous|anxious|scared|don'?t\s+know|how\s+to|help)/i,
  },
  {
    id: "interview_prep_en_nervous",
    intent: "interview_prep",
    regex: /\b(?:nervous|anxious|scared|stressed|freaking\s+out)\s+(?:about|for|over)\s+(?:my\s+)?(?:interview|onsite|coding|behavioral)/i,
  },

  // ---------- negotiation (Adam iter 23) ----------
  // ZH — offer negotiation / counter
  {
    id: "negotiation_zh",
    intent: "negotiation",
    regex: /\b(?:negotiate|discuss)\s*(?:offer|salary|package|tc)|\bcounter\b|\b(?:got|received|have)\s*(?:\d+\s*)?offers?\b/i,
  },
  {
    id: "negotiation_zh_amount",
    intent: "negotiation",
    regex: /\b(?:how\s+much|what\s+number)\s+(?:should\s+i\s+)?(?:ask|request|target)\b[^.!?]{0,12}(?:salary|tc|base|comp)/i,
  },
  // EN
  {
    id: "negotiation_en",
    intent: "negotiation",
    regex: /\b(?:negotiat(?:e|ing|ion)|counter\s*(?:offer|the))\b/i,
  },
  {
    id: "negotiation_en_offers",
    intent: "negotiation",
    regex: /\b(?:got|have|received)\s+(?:\d+\s+|two\s+|multiple\s+|competing\s+)?offers?\b/i,
  },
  {
    id: "negotiation_en_ask",
    intent: "negotiation",
    regex: /\b(?:what\s+(?:number|amount|salary|tc|package)\s+should\s+i\s+(?:ask|request|target))\b/i,
  },

  // ---------- motivation_nudge (Adam iter 23) ----------
  // ZH — procrastination / no motivation
  {
    id: "motivation_zh",
    intent: "motivation_nudge",
    regex: /\b(?:no\s+motivation|unmotivated|procrastinat\w*|lazy|emo)\b/i,
  },
  {
    id: "motivation_zh_paralyzed",
    intent: "motivation_nudge",
    regex: /\b(?:don'?t\s+know\s+where\s+to\s+start|stuck|can'?t\s+get\s+going)\b/i,
  },
  // EN
  {
    id: "motivation_en",
    intent: "motivation_nudge",
    regex: /\b(?:no\s+motivation|unmotivated|procrastinat(?:e|ing)|can'?t\s+start|stuck|paralyzed|don'?t\s+(?:wanna|want\s+to)\s+do)/i,
  },

  // ---------- vent (Adam iter 21) ----------
  // First-turn distress signal. Without this, "I'm losing it"
  // gets the bare first_mes boilerplate — discards the
  // user's emotional state on turn-0. iter-20 5-playbook test surfaced
  // this in vent_support_zh scenario.
  // ZH
  {
    id: "vent_zh",
    intent: "vent",
    regex: /\b(?:breaking\s+down|so\s+stressed|wanna\s+cry|overwhelmed|emo|hopeless)\b/i,
  },
  // iter24 — broader distress vocab
  {
    id: "vent_zh_distress",
    intent: "vent",
    regex: /\b(?:anxious|can'?t\s+sleep|self[-\s]?doubt|panicking|losing\s+it|falling\s+apart)\b/i,
  },
  // iter24 — feeling + negative state
  {
    id: "vent_zh_feel",
    intent: "vent",
    regex: /\b(?:feel|feeling)\b.{0,5}(?:useless|hopeless|empty|loser|failure)/i,
  },
  // EN
  {
    id: "vent_en",
    intent: "vent",
    regex: /\b(?:so\s+done|can'?t\s+(?:do\s+this|anymore|take\s+(?:it|this))|fed\s+up|burnt?\s+out|breaking\s+down|losing\s+it|exhausted|drained|miserable|going\s+to\s+lose\s+it)\b/i,
  },
  // EN iter24 — broader distress vocab
  {
    id: "vent_en_distress",
    intent: "vent",
    regex: /\b(?:anxious|anxiety|can'?t\s+sleep|panicking|overwhelmed|hopeless|spiraling|self[-\s]?doubt|doubting\s+myself|imposter|worthless|tanked\s+(?:my|the)\s+interview|bombed\s+(?:my|the)\s+interview)\b/i,
  },
]

/**
 * Defense-in-depth: a *light* abuse signal so we don't accidentally craft a
 * cheery "sure! let me help..." ack for an injection probe that slipped past the
 * pa-safety gate. The pa-safety v2 bank is the source of truth — this is
 * just a guard. Match → return intent=abuse → upstream falls back to default
 * Adam-locked greeting (NOT to safety canned reply — safety already passed).
 */
const ABUSE_GUARD_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts?)/i,
  /system\s*prompt/i,
  /\bjailbreak\b|\bDAN\b/i,
  /prompt\s*injection/i,
  /you\s+are\s+now\s+(?:DAN|admin|developer|system|root)/i,
]

/**
 * Casual chat / greeting / venting — we DO route these to the default
 * Adam-locked greeting (no intent ack). Detection lets us return
 * intent=casual_chat as a positive signal so callers can branch if they want
 * (currently same behavior as null; reserved for future).
 */
const CASUAL_PATTERNS: readonly RegExp[] = [
  /^(?:hi|hello|hey)\s*[!.?~]?\s*$/i,
  /^(?:you\s+there|around|busy)[!.?~]?\s*$/i,
  /^(?:anyone|hey\s+there|whats?\s*up|sup)[!.?~]?\s*$/i,
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
    zh: 'user came in asking about jobs. friend-tone ack like "got you, let\'s get you sorted on [role they mentioned]" (1 short clause, name the actual role/track they said — don\'t echo the brackets), then chain ask_q_role to confirm direction.',
    en: 'user came in asking about jobs. friend-tone ack like "got you, let\'s get you sorted on [role they mentioned]" (1 short clause, name the actual role/track they said — don\'t echo the brackets), then chain ask_q_role to confirm direction.',
  },
  visa_check: {
    zh: 'user came in mentioning work auth / OPT / sponsorship. friend-tone ack like "got you, we\'ll keep visa in scope" (1 clause), then chain ask_q_role since we ask role direction first (visa is asked later in q_visa).',
    en: 'user came in mentioning work auth / OPT / sponsorship. friend-tone ack like "got you, we\'ll keep visa in scope" (1 clause), then chain ask_q_role since we ask role direction first (visa is asked later in q_visa).',
  },
  resume_parse: {
    zh: 'user mentioned resume/cv. friend-tone ack like "yeah send it over, I\'ll take a look" (1 clause), then chain ask_q_role to lock direction first (so resume parse has context).',
    en: 'user mentioned resume/cv. friend-tone ack like "yeah send it over, I\'ll take a look" (1 clause), then chain ask_q_role to lock direction first (so resume parse has context).',
  },
  preference_update: {
    zh: 'user came in talking about pivoting direction (PM / EM / IC / management). friend-tone ack like "got it, let\'s go with that" (1 clause), then chain ask_q_role to lock the new direction.',
    en: 'user came in talking about pivoting direction (PM / EM / IC / management). friend-tone ack like "got it, let\'s go with that" (1 clause), then chain ask_q_role to lock the new direction.',
  },
  vent: {
    zh: "user came in venting / distressed. you're not a therapist, not a coach — you're the roommate who doesn't interrupt. ONE-SHORT ack only — like \"yeah, that sounds rough.\" or \"oh fr, that sucks.\" or \"i hear you. wanna say more?\" — under 15 words / ≤2 short sentences. NEVER give advice, NEVER list reasons, NEVER chain into ask_q_role onboarding, NEVER pep talk. don't append any question — let them keep venting. friend-tone, English.",
    en: "user came in venting / distressed. you're not a therapist, not a coach — you're the roommate who doesn't interrupt. ONE-SHORT ack only — like \"yeah, that sounds rough.\" or \"oh fr, that sucks.\" or \"i hear you. wanna say more?\" — under 15 words / ≤2 short sentences. NEVER give advice, NEVER list reasons, NEVER chain into ask_q_role onboarding, NEVER pep talk. don't append any question — let them keep venting. friend-tone, English.",
  },
  interview_prep: {
    zh: "user came in nervous about an upcoming interview (system design / behavioral / coding). you're the friend who's been through it, not a coach. ONE-SHORT ack (e.g. \"hey, i got you.\" or \"deep breath.\") + ONE concrete question (e.g. \"what company / role, sys design or behavioral?\" or \"what part are you most stuck on?\"). ≤2 short sentences, ≤25 words. NEVER deliver a STAR-method paragraph or list 5 tips, NEVER chain into ask_q_role onboarding. friend-tone, English.",
    en: "user came in nervous about an upcoming interview (system design / behavioral / coding). you're the friend who's been through it, not a coach. ONE-SHORT ack (e.g. \"hey, i got you.\" or \"deep breath.\") + ONE concrete question (e.g. \"what company / role, sys design or behavioral?\" or \"what part are you most stuck on?\"). ≤2 short sentences, ≤25 words. NEVER deliver a STAR-method paragraph or list 5 tips, NEVER chain into ask_q_role onboarding. friend-tone, English.",
  },
  negotiation: {
    zh: "user came in asking about negotiating offer / salary / counter. you're a friend who's been through it, not a recruiter. ONE-SHORT ack (e.g. \"ok cool, how many offers do you have?\") + ONE anchoring question (\"how many offers, current base / TC, what number do you want?\"). ≤2 short sentences, ≤25 words. NEVER state a specific number (e.g. \"ask for 250k\"), NEVER list a 5-step negotiation framework, NEVER chain into ask_q_role onboarding. friend-tone, English.",
    en: "user came in asking about negotiating offer / salary / counter. you're a friend who's been through it, not a recruiter. ONE-SHORT ack (e.g. \"ok cool, how many offers do you have?\") + ONE anchoring question (\"how many offers, current base / TC, what number do you want?\"). ≤2 short sentences, ≤25 words. NEVER state a specific number (e.g. \"ask for 250k\"), NEVER list a 5-step negotiation framework, NEVER chain into ask_q_role onboarding. friend-tone, English.",
  },
  motivation_nudge: {
    zh: "user came in low-energy / procrastinating / unmotivated. you're the friend who doesn't push. ONE-SHORT ack (e.g. \"yeah, i got you.\" or \"that vibe i know.\") + ONE light nudge — NOT a pep talk; lower the bar (e.g. \"don't force it. just put the smallest one in front of you.\" or \"take a beat, look at it again later.\"). ≤2 short sentences, ≤25 words. NEVER deliver a 5-step framework, NEVER pep talk, NEVER chain into ask_q_role onboarding. friend-tone, English.",
    en: "user came in low-energy / procrastinating / unmotivated. you're the friend who doesn't push. ONE-SHORT ack (e.g. \"yeah, i got you.\" or \"that vibe i know.\") + ONE light nudge — NOT a pep talk; lower the bar (e.g. \"don't force it. just put the smallest one in front of you.\" or \"take a beat, look at it again later.\"). ≤2 short sentences, ≤25 words. NEVER deliver a 5-step framework, NEVER pep talk, NEVER chain into ask_q_role onboarding. friend-tone, English.",
  },
}
