/**
 * Phase 23 — Onboarding state machine for closed-beta first-contact flow.
 * Phase 44 (v1.5 Stream-B / D5+D13) — extended to 8-state rich JOB-PREF
 * probe (role / yoe / visa / startup-pref / location). One question per turn,
 * bilingual, friend-tone (Adam-locked: "那你有身份不" not "What is your visa
 * status"). Synthetic system inputs only — ZERO new LLM calls per probe step.
 *
 * D-03: Onboarding state lives on pa_users (onboardingState field).
 * D-04: Uses Voice v1 prompt unchanged — synthetic system inputs inject the
 *       onboarding step hint; Claude composes actual replies naturally.
 * D-08: status=invited triggers onboarding flow; auto-promotes to active at complete.
 *
 * State machine (v2):
 *   pending/undefined → send_first_mes        → first_mes_sent
 *   first_mes_sent    → ask_q_role            → q_role_asked
 *   q_role_asked      → ask_q_yoe             → q_yoe_asked
 *   q_yoe_asked       → ask_q_visa            → q_visa_asked
 *   q_visa_asked      → ask_q_startup_pref    → q_startup_pref_asked
 *   q_startup_pref_asked → ask_q_location     → q_location_asked
 *   q_location_asked  → ask_q_resume          → q_resume_asked
 *   q_resume_asked    → ask_q_email           → q_email_asked        (iter30 V6)
 *   q_email_asked     → complete              → complete
 *   complete          → skip                  → (no-op)
 *
 * Legacy state (v1 compat): when `enableV2 = false`, `first_mes_sent` resolves
 * to legacy `ask_grounding_q` (single-question path) and `grounding_q1_asked`
 * resolves to `complete`. Existing prod users with `grounding_q1_asked` keep
 * working unchanged.
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import type {
  User,
  AgentDef,
  OnboardingState,
  StatedPreferences,
  VisaStatus,
} from "@pa/core-types"
// Phase 52 — F1 fix: bilingual turn-0 intent detection / ack directives.
import type { FirstTurnDetection, FirstTurnIntent } from "./onboarding-intent.js"
import { INTENT_ACK_DIRECTIVES } from "./onboarding-intent.js"

export type OnboardingStep =
  | "send_first_mes"
  | "ask_grounding_q" // legacy v1 single-question path (kept for backward compat)
  | "ask_q_lang" // iter33 — explicit zh/en/mixed preference question, fires after first_mes.
  | "ask_q_tos" // iter31 — privacy + terms acceptance gate, before any data probes.
  | "ask_q_role"
  | "ask_q_yoe"
  | "ask_q_visa"
  | "ask_q_startup_pref"
  | "ask_q_location"
  | "ask_q_resume" // iter30 closure — proactive resume request after location.
  | "ask_q_email" // iter30 V6 — optional contact email after resume.
  | "ask_q_email_verify" // iter31 — emit code + ask user to text it back.
  | "complete"
  | "skip"

export type ResolveOpts = {
  /** v2 8-state probe; default false = legacy 4-state. */
  enableV2?: boolean
  /**
   * iter31 — when true, route first_mes_sent → ask_q_tos (privacy + terms
   * acceptance gate) instead of going straight into ask_q_role. Default
   * false so existing in-flight users keep advancing as today; flip on via
   * `paOnboardingTosGateEnabled` Firestore flag for new biz testers.
   */
  enableTosGate?: boolean
  /**
   * iter31 — when true, route q_email_asked → ask_q_email_verify (Mailgun
   * code + SMS reply) instead of straight to complete. Requires
   * `opts.emailCaptured=true` to actually fire — if user skipped email at
   * q_email_asked, this flag has no effect. Flip on via
   * `paOnboardingEmailVerifyEnabled`.
   */
  enableEmailVerification?: boolean
  /**
   * iter31 — orchestrator-provided signal: did parseEmailAnswer succeed
   * for the q_email_asked reply? (i.e. did the user supply a parseable
   * email address?) When false, q_email_asked → complete unconditionally.
   */
  emailCaptured?: boolean
}

/**
 * Pure function: derive the next onboarding action from user state.
 * Called before every inbound turn; returns "skip" for active/complete users.
 *
 * When `enableV2=false` (default), legacy first_mes_sent → ask_grounding_q
 * path is preserved exactly. When `enableV2=true`, first_mes_sent advances
 * into the 5-question chain (q_role → q_yoe → q_visa → q_startup → q_location).
 */
export function resolveOnboardingStep(
  user: Pick<User, "onboardingState">,
  opts: ResolveOpts = {}
): OnboardingStep {
  const state = user.onboardingState
  if (!state || state === "pending") return "send_first_mes"
  if (opts.enableV2) {
    // iter32 reorder (Adam directive 2026-05-04 "Email & verify should be
    // part of pre cv in tos.."): email + verify happen BEFORE the role
    // probe. Sequence: first_mes_sent → q_tos_asked → q_email_asked →
    // q_email_verifying → q_role_asked → q_yoe_asked → … → q_resume_asked
    // → complete. The ToS gate is enableable separately via
    // `opts.enableTosGate` so we can ship the schema first and flip the
    // gate ON for biz testers without disturbing existing in-flight users.
    if (state === "first_mes_sent") return opts.enableTosGate ? "ask_q_tos" : "ask_q_email"
    if (state === "q_tos_asked") return "ask_q_email"
    if (state === "q_email_asked") {
      return opts.emailCaptured && opts.enableEmailVerification
        ? "ask_q_email_verify"
        : "ask_q_role"
    }
    if (state === "q_email_verifying") return "ask_q_email_verify"
    if (state === "q_role_asked") return "ask_q_yoe"
    if (state === "q_yoe_asked") return "ask_q_visa"
    if (state === "q_visa_asked") return "ask_q_startup_pref"
    if (state === "q_startup_pref_asked") return "ask_q_location"
    if (state === "q_location_asked") return "ask_q_resume"
    if (state === "q_resume_asked") return "complete"
    // Legacy v1 state encountered with v2 on — treat grounding_q1_asked as
    // already-grounded; advance to complete (don't re-probe the user).
    if (state === "grounding_q1_asked") return "complete"
    return "skip"
  }
  // Legacy v1 path (enableV2=false)
  if (state === "first_mes_sent") return "ask_grounding_q"
  if (state === "grounding_q1_asked") return "complete"
  // v2 question states encountered with v2 off (e.g. flag flipped back) →
  // converge to complete to avoid stranding the user mid-probe.
  if (
    state === "q_tos_asked" ||
    state === "q_role_asked" ||
    state === "q_yoe_asked" ||
    state === "q_visa_asked" ||
    state === "q_startup_pref_asked" ||
    state === "q_location_asked" ||
    state === "q_resume_asked" ||
    state === "q_email_asked" ||
    state === "q_email_verifying"
  ) {
    return "complete"
  }
  return "skip"
}

/**
 * Phase 44 — Should the onboarding probe run at all for this user?
 *
 * D3: any user message that triggers `intent=job_search` (or any inbound when
 * onboarding hasn't completed) should reuse the same probe instead of asking
 * a fresh question. Returns the next step, or "skip" when complete.
 *
 * v1.5 simplification: 30-day staleness check is deferred to v1.6. Today we
 * only probe when onboardingState is incomplete — fully-completed users are
 * never re-probed (they have whatever statedPreferences they answered).
 */
export function shouldRunOnboardingProbe(
  user: Pick<User, "onboardingState" | "statedPreferences">,
  opts: { enableV2?: boolean; intent?: string } = {}
): OnboardingStep {
  const step = resolveOnboardingStep(user, { enableV2: opts.enableV2 })
  if (step === "skip") return "skip"
  // First-contact flow always runs regardless of intent (legacy behavior preserved).
  // For mid-conversation intents like `job_search`, only probe when v2 is on
  // AND we're past the opener — otherwise the user gets bumped back to greeting.
  if (opts.intent === "job_search" && step === "send_first_mes" && !opts.enableV2) {
    return "skip"
  }
  return step
}

/**
 * Detect zh vs en from user input. Returns "zh" when ≥30% of non-whitespace
 * characters are CJK; otherwise "en". Empty input defaults to "zh" (Claire's
 * first_mes is Chinese — keep the opener consistent).
 */
function pickLang(userMessage: string | undefined): "zh" | "en" {
  const text = (userMessage ?? "").replace(/\s+/g, "")
  if (!text) return "zh"
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // CJK Unified Ideographs + extensions (rough but sufficient for routing)
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++
    }
  }
  const total = [...text].length
  return cjk / total >= 0.3 ? "zh" : "en"
}

/** Friend-tone bilingual prompts — Adam-locked tone, do NOT paraphrase. */
const Q_PROMPTS: Record<
  | "ask_q_tos"
  | "ask_q_role"
  | "ask_q_yoe"
  | "ask_q_visa"
  | "ask_q_startup_pref"
  | "ask_q_location"
  | "ask_q_resume"
  | "ask_q_email"
  | "ask_q_email_verify",
  { zh: string; en: string }
> = {
  // iter31 — ToS + privacy gate. Friend-tone but explicit; the user must
  // affirmatively reply "yes/同意/agree" for state to advance. Link points at
  // the public hosting page; copy line is short enough to fit the iMessage
  // chunker. Adam-locked: do NOT paraphrase or remove the link.
  ask_q_tos: {
    zh: "开聊前先说一下: 我会记一些咱聊天的事来给你推工作 / 找内推. 隐私 + 用户协议在这: https://wekruit-pa.web.app/legal — 同意就回个 \"同意\" 我们继续",
    en: "before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa.web.app/legal — reply \"agree\" if cool with that and we keep going",
  },
  ask_q_role: {
    zh: "那你大概想找啥方向的活? 比如做产品、做工程、还是做研究 — 给我个大致就行",
    en: "btw — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
  },
  ask_q_yoe: {
    zh: "你工作几年了? 还是刚毕业找新人岗?",
    en: "how many years you been working? or fresh outta school?",
  },
  ask_q_visa: {
    zh: "那你有身份不? 公民/绿卡/OPT/还是要 sponsor?",
    en: "got work auth sorted? citizen / GC / OPT / need sponsorship?",
  },
  ask_q_startup_pref: {
    zh: "你更想去 startup 那种小而拼的, 还是大厂稳一点?",
    en: "more into startup hustle vibe or stable big-co?",
  },
  ask_q_location: {
    zh: "想找哪边的工作? 湾区、纽约、还是看远程?",
    en: "where you wanna be? SF / NYC / remote ok?",
  },
  // iter30 closure — proactive resume request. Friend-tone, low-friction;
  // signals "for matching, not gatekeeping". cv-gate-detector regex
  // (`/发简历给我/`, `/send.*your\s+resume/i`) catches this phrasing and
  // opens the 24h upload gate automatically.
  ask_q_resume: {
    zh: "对了, 简历方便发我一份不? 后面帮你看 JD / 内推都准多了",
    en: "btw — can you send me your resume? makes JD review and referrals way more on-point",
  },
  // iter30 V6 — optional contact email. Friend-tone, low-friction; user can
  // skip with "no" / "later" / "skip" and onboarding still advances to
  // complete (email is an optional channel, not a gate).
  ask_q_email: {
    zh: "对了, 平时邮箱用啥? 后面如果你不在线我直接发邮件给你",
    en: "btw — what email should I send stuff to when you're afk? roughly fine",
  },
  // iter31 — email verification. Code is freshly generated by the
  // orchestrator's `startEmailVerification` callback; the prompt directive
  // injects the masked email into the reply ("xxx@yyy") and instructs Claire
  // to ask the user to text back the 6-digit code. Adam-locked phrasing.
  ask_q_email_verify: {
    zh: "已经发了一个 6 位验证码到你邮箱了, 收到回我一下就行 (30 分钟有效)",
    en: "just sent a 6-digit code to your email — text it back to me and we're set (good for 30 mins)",
  },
}

/**
 * Compose the synthetic system input hint for the current onboarding step.
 *
 * D-04: These are system inputs injected into the existing Voice v1 prompt
 * context — NOT a separate prompt. The LLM composes the actual reply
 * naturally from the Character Bible v1 personality.
 *
 * Phase 44: For v2 question steps, the prompt instructs the LLM to ask the
 * given Adam-locked phrase verbatim (or near-verbatim — picking either zh or
 * en register based on the user's most recent input). This is a directive,
 * not a paraphrase license.
 */
export function composeOnboardingInput(
  step: OnboardingStep,
  agent: AgentDef,
  ctx: {
    userMessage?: string
    detectedIntent?: FirstTurnDetection
    /**
     * iter30 closure (Adam directive 2026-05-04 "我说完 hello 之后, 为什么
     * 不开始??"): when true (default), casual_chat / null intents on T0
     * chain ask_q_role so the 6Q probe visibly starts on T0 instead of T1.
     * Set false to honor the `PA_ONBOARDING_INTENT_ACK_DISABLED=true`
     * emergency kill switch — restores the old bare-greeting behavior.
     */
    chainCasualOnFresh?: boolean
    /**
     * V4 QA Agent-I 2026-05-04 P0 fix: the q_X step suspend-vs-advance
     * decision must check whether the user answered the LAST question we
     * asked (priorAskedStep), NOT the question we're about to ask
     * (`step`). For state=q_role_asked → step=ask_q_yoe, priorAskedStep is
     * "ask_q_role". Pre-fix used `step` directly, which checked YOE regex
     * against a ROLE answer "工程" → false → off-by-one chain stall (T1
     * ack-only, T2 advance-and-ask).
     *
     * Pass undefined to fall back to legacy behavior (used by tests that
     * assert the suspended branch directly with a synthetic step).
     */
    priorAskedStep?: OnboardingStep
  } = {}
): string {
  if (step === "send_first_mes") {
    const match = agent.systemPrompt.match(/[Ff]irst\s+message:\s*(.+?)(?:\n|$)/)
    // iter30 closure — bilingual fallback per user lang. Adam directive
    // 2026-05-04 ("这个柠檬哪里来的? 你没测试英文吗???"): the lemon emoji
    // 🍋 was hardcoded zh-only and bled into English replies via LLM
    // translation. Split by language; remove emoji from default greetings.
    const fbLang = pickLang(ctx.userMessage)
    const fallback = fbLang === "zh" ? "在呢. 今天找你聊点啥?" : "Here. What's on your mind today?"
    const firstMes = match?.[1]?.trim() ?? fallback
    // Phase 52 — F1 fix: intent-aware first message. When the user's opening
    // message expressed a high-confidence actionable intent (job_search /
    // visa_check / resume_parse / preference_update), we weave a 1-clause
    // ack into the synthetic input AND chain ask_q_role's Adam-locked
    // phrasing — instead of regurgitating the bare greeting and discarding
    // the user's intent. casual_chat / abuse / null intents fall through to
    // the unchanged Adam-locked greeting (defense-in-depth: never ack
    // injection-shaped text even if pa-safety let it through).
    const detected = ctx.detectedIntent
    const ackable: ReadonlyArray<FirstTurnIntent> = [
      "job_search",
      "visa_check",
      "resume_parse",
      "preference_update",
    ]
    // Adam iter 21 — vent intent gets a SEPARATE branch. Unlike the role-
    // probe-ackable intents, vent must NOT chain ask_q_role (questioning a
    // distressed user about their target role IS the bug we're fixing).
    //
    // Adam iter 23 — interview_prep / negotiation / motivation_nudge get the
    // same NO-CHAIN treatment: a stressed-pre-interview / negotiation /
    // procrastinating user does not want to be asked "are you SWE or PM?"
    // first. Their playbook directive itself contains the question (specific
    // to their context), so we route through the no-chain branch.
    const noChainIntents: ReadonlyArray<FirstTurnIntent> = [
      "vent",
      "interview_prep",
      "negotiation",
      "motivation_nudge",
    ]
    if (
      detected &&
      detected.intent !== null &&
      noChainIntents.includes(detected.intent) &&
      detected.confidence === "high"
    ) {
      const lang = pickLang(ctx.userMessage)
      const ackKey = detected.intent as keyof typeof INTENT_ACK_DIRECTIVES
      const ackDirective = INTENT_ACK_DIRECTIVES[ackKey][lang]
      return `[onboarding_step: send_first_mes_with_${detected.intent}_ack | intent=${detected.intent}] ${ackDirective}`
    }
    if (
      detected &&
      detected.intent !== null &&
      detected.intent !== "casual_chat" &&
      detected.intent !== "abuse" &&
      !noChainIntents.includes(detected.intent) &&
      detected.confidence === "high" &&
      ackable.includes(detected.intent)
    ) {
      const ackKey = detected.intent as keyof typeof INTENT_ACK_DIRECTIVES
      const lang = pickLang(ctx.userMessage)
      const ackDirective = INTENT_ACK_DIRECTIVES[ackKey][lang]
      const rolePhrase = Q_PROMPTS.ask_q_role[lang]
      return `[onboarding_step: send_first_mes_with_intent_ack | intent=${detected.intent}] ${ackDirective} The role-direction question to chain (Adam-locked, do not paraphrase): "${rolePhrase}". Total reply: ≤ 2 sentences. No "好的" / "OK" preface. No numbering. No A/B framework like "X 还是 Y?" — the role question already enumerates options. Friend-tone, ${lang === "zh" ? "Mandarin" : "English"} register matching the user's input.`
    }
    // iter30 closure — Adam directive 2026-05-04 ("我说完 hello 之后, 为什么
    // 不开始??"): casual_chat / null / unrecognized intent on a fresh user
    // should ALSO chain ask_q_role. Previously these fell through to a bare
    // greeting, which felt passive — Claire said hi, then user had to send
    // ANOTHER message before the probe started. Now: friendly opener +
    // chain role-Q in the same reply, so the 6Q chain visibly begins on T0.
    // abuse intent still falls through to bare greeting (defense-in-depth).
    // Honors `chainCasualOnFresh: false` for the
    // `PA_ONBOARDING_INTENT_ACK_DISABLED=true` emergency rollback path.
    const chainCasual = ctx.chainCasualOnFresh !== false
    if (
      chainCasual &&
      (!detected || detected.intent === null || detected.intent === "casual_chat")
    ) {
      const lang = pickLang(ctx.userMessage)
      const rolePhrase = Q_PROMPTS.ask_q_role[lang]
      const opener = lang === "zh" ? "嗨, 我在." : "hey, i'm here."
      return `[onboarding_step: send_first_mes_with_casual_chain] User opened with a casual greeting / ambiguous intent. Reply with a friend-tone short opener like "${opener}" (1 short clause), then chain the role-direction question (Adam-locked, do not paraphrase): "${rolePhrase}". Total reply: ≤ 2 sentences. No emoji. No "好的" / "OK" preface. Friend-tone, ${lang === "zh" ? "Mandarin" : "English"} register matching the user's input.`
    }
    return `[onboarding_step: send_first_mes] Reply EXACTLY with Claire's first_mes: "${firstMes}". Nothing else. No greeting. No explanation.`
  }
  if (step === "ask_grounding_q") {
    return `[onboarding_step: ask_grounding_q] Ask ONE casual question to understand what's going on with the user right now. Roommate register: short, genuine, no "欢迎", no formal opener. Example: "你最近怎么了, 找我有什么事吗" or "今天有什么事?" — Claude picks naturally from Character Bible v1 voice.`
  }
  // iter31 — ToS gate. Distinct from the q_X probe steps: no "suspended"
  // empathy branch (the user EITHER accepts, declines, or stays mute), and
  // no LLM voice-shaping (the prompt is a legal-flavored line that needs to
  // ship verbatim). Composed deterministically.
  if (step === "ask_q_tos") {
    const lang = pickLang(ctx.userMessage)
    const phrase = Q_PROMPTS.ask_q_tos[lang]
    // If we're re-asking (user replied something other than accept/decline),
    // soften the tone. Caller signals via priorAskedStep === "ask_q_tos".
    if (ctx.priorAskedStep === "ask_q_tos" && ctx.userMessage) {
      const parsed = parseTosAnswer(ctx.userMessage)
      if (parsed === "decline") {
        // Decline path: respectful, do NOT pressure. State stays at
        // q_tos_asked (caller decides not to advance) — Claire just
        // acknowledges and offers to be there if the user changes mind.
        const declineMsg =
          lang === "zh"
            ? "完全 ok, 你不同意我就不主动记你聊天的事. 想聊别的随时. 改主意了说一声"
            : "totally ok — i won't store chat memory if you'd rather not. happy to keep chatting either way. lmk if you change your mind"
        return `[onboarding_step: ask_q_tos_declined | reason=user_declined_tos] Reply EXACTLY: "${declineMsg}". 1-2 sentences. No emoji. No follow-up question. No legal language. Friend-tone, ${lang === "zh" ? "Mandarin" : "English"} register.`
      }
      if (parsed === "unclear") {
        // Unclear: gentle re-ask, do NOT escalate.
        const reaskMsg =
          lang === "zh"
            ? "刚那个隐私 + 用户协议你看一下哦, 同意就回 \"同意\" — 不同意我们也能继续聊但不会保存"
            : "just need a quick \"agree\" on the privacy + terms above — or \"no\" and we can chat without me saving anything"
        return `[onboarding_step: ask_q_tos_reask | reason=ambiguous_reply] Reply EXACTLY: "${reaskMsg}". 1 sentence. No emoji. ${lang === "zh" ? "Mandarin" : "English"} register.`
      }
    }
    return `[onboarding_step: ask_q_tos] Reply EXACTLY this ToS+privacy line (Adam-locked, do not paraphrase, do not chain a follow-up question, do not preface with greeting): "${phrase}". 1-2 short sentences. No emoji. No "好的" / "OK" preface. ${lang === "zh" ? "Mandarin" : "English"} register matching the user's input.`
  }
  // iter31 — email verification step. The orchestrator side already wrote
  // user.emailVerification (codeHash + email) and dispatched the Mailgun
  // send before we got here. Compose a deterministic reply directive.
  if (step === "ask_q_email_verify") {
    const lang = pickLang(ctx.userMessage)
    const phrase = Q_PROMPTS.ask_q_email_verify[lang]
    return `[onboarding_step: ask_q_email_verify] Reply EXACTLY this verification line (Adam-locked, do not paraphrase, do not include the actual code, do not chain a follow-up question): "${phrase}". 1 sentence. No emoji. ${lang === "zh" ? "Mandarin" : "English"} register.`
  }
  if (
    step === "ask_q_role" ||
    step === "ask_q_yoe" ||
    step === "ask_q_visa" ||
    step === "ask_q_startup_pref" ||
    step === "ask_q_location" ||
    step === "ask_q_resume" ||
    step === "ask_q_email"
  ) {
    // Adam iter 24 — mid-probe suspension. Two triggers, both emit empathetic
    // ack instead of the bare q_X question:
    //   (A) noChainIntent fired (vent / interview_prep / negotiation /
    //       motivation_nudge) — user is in distress / off-topic
    //   (B) user's message does NOT contain a recognizable answer keyword
    //       for the current step (e.g. user says "再帮我想想" while we asked
    //       q_visa) — they're not answering
    // The orchestrator ALSO sees the suspension via the same checks and skips
    // applyOnboardingStep so the state stays where it was.
    const detected = ctx.detectedIntent
    const noChainIntents: ReadonlyArray<FirstTurnIntent> = [
      "vent",
      "interview_prep",
      "negotiation",
      "motivation_nudge",
    ]
    const ventLike = Boolean(
      detected &&
        detected.intent !== null &&
        noChainIntents.includes(detected.intent) &&
        detected.confidence === "high"
    )
    // V4 QA Agent-I 2026-05-04 P0 fix: prefer priorAskedStep when caller
    // provides it. Falls back to `step` for legacy callers (tests that
    // synthesize the suspended branch with a forward step name).
    const userAnswered = userAnsweredStep(ctx.priorAskedStep ?? step, ctx.userMessage)
    if (ventLike || !userAnswered) {
      const lang = pickLang(ctx.userMessage)
      if (ventLike && detected) {
        const ackKey = detected.intent as keyof typeof INTENT_ACK_DIRECTIVES
        const ackDirective = INTENT_ACK_DIRECTIVES[ackKey][lang]
        return `[onboarding_step: ${step}_suspended_for_${detected.intent} | intent=${detected.intent}] ${ackDirective}`
      }
      // iter26 — Non-answer path. Adam observed iter24's "ONE clarifier
      // specific to {step}" directive induced LLM to emit AB-framework
      // ("X 还是 Y") on 18/30 turns of long-context test. NEVER PROBE rule
      // (Bible v7.5) violated. Rewrite: NO clarifier question, just
      // empathy + presence. The state already stays at q_X; if user comes
      // back with an actual answer next turn, parser advances. Until then,
      // Claire stays present, no leading questions.
      const langCue = lang === "zh" ? "Mandarin" : "English"
      return `[onboarding_step: ${step}_suspended_no_answer | reason=user_did_not_answer_question] User didn't answer the ${step} question yet. They may be venting, asking meta-questions, or just continuing the thread. Reply with ONE short friend-tone acknowledgement only — no question, no probe, no "A 还是 B / A or B" framework. Examples (do NOT echo verbatim, pick register from history): "嗯, 我在." / "听着挺累的." / "卧槽, 那确实." / "yeah, i hear you." / "fr, that's a lot." STRICTLY: ≤ 1 short sentence, ≤ 12 字 / ≤ 8 words. NEVER append a clarifier question. NEVER list options. Let the user keep talking. ${langCue} register.`
    }
    const lang = pickLang(ctx.userMessage)
    const phrase = Q_PROMPTS[step][lang]
    // iter31 — T6 tone-lock for ask_q_email. Adam directive 2026-05-04 ("T6
    // ask_q_email LLM tone drift — state advances correctly but reply
    // doesn't always include literal '邮箱'"). Strengthen the constraint by
    // naming the load-bearing keyword explicitly so the LLM can't drift
    // into "what's your contact" / "drop me an email" style paraphrase.
    if (step === "ask_q_email") {
      const keyword = lang === "zh" ? "邮箱" : "email"
      return `[onboarding_step: ${step}] Ask EXACTLY this ONE friend-tone question (Adam-locked phrasing — do not paraphrase, do not add greeting, do not chain a second question): "${phrase}". MUST contain the literal word "${keyword}". 1 sentence. No "好的" / "OK" preface. No "btw" if zh. No follow-up clauses.`
    }
    return `[onboarding_step: ${step}] Ask EXACTLY this ONE friend-tone question (Adam-locked phrasing — do not paraphrase, do not add greeting, do not chain a second question): "${phrase}". 1 sentence. No "好的" / "OK" preface. No "btw" if zh. No follow-up clauses.`
  }
  // complete / skip don't need synthetic inputs
  return ""
}

/** State transition map: which OnboardingState a step writes. */
const ONBOARDING_NEXT_STATE: Partial<Record<OnboardingStep, OnboardingState>> = {
  send_first_mes: "first_mes_sent",
  ask_grounding_q: "grounding_q1_asked",
  ask_q_lang: "q_lang_asked",
  ask_q_tos: "q_tos_asked",
  ask_q_role: "q_role_asked",
  ask_q_yoe: "q_yoe_asked",
  ask_q_visa: "q_visa_asked",
  ask_q_startup_pref: "q_startup_pref_asked",
  ask_q_location: "q_location_asked",
  ask_q_resume: "q_resume_asked",
  ask_q_email: "q_email_asked",
  ask_q_email_verify: "q_email_verifying",
  complete: "complete",
}

/**
 * Ordered state vector for idempotent advancement. Both v1 and v2 states are
 * present so a v1 user partway through (`grounding_q1_asked`) cannot regress
 * into a v2 question state, and vice versa.
 */
// iter32 reorder (Adam directive 2026-05-04 "Email & verify should be part
// of pre cv in tos.."): email + verify form a pre-CV trust handshake
// immediately after ToS, BEFORE the role/yoe probe sequence. STATE_ORDER
// is FORWARD-ONLY for idempotency in applyOnboardingStep — when adding
// new states or reordering, ensure all in-flight users are at states
// that still advance monotonically.
const STATE_ORDER: Array<OnboardingState | undefined> = [
  undefined,
  "pending",
  "first_mes_sent",
  // v1 leaf
  "grounding_q1_asked",
  // iter33 — explicit zh/en/mixed preference (P1)
  "q_lang_asked",
  // iter31 — ToS gate
  "q_tos_asked",
  // iter32 — email + verify (pre-CV trust handshake)
  "q_email_asked",
  "q_email_verifying",
  // v2 probe chain
  "q_role_asked",
  "q_yoe_asked",
  "q_visa_asked",
  "q_startup_pref_asked",
  "q_location_asked",
  "q_resume_asked",
  "complete",
]

// ============================================================================
// Phase 44 — Lightweight regex/keyword parsers for statedPreferences writes.
// NO LLM in this path (Adam-locked). Each parser returns the patch to merge
// into statedPreferences, or {} when the user reply doesn't match — null
// fields are stored explicitly to record "we asked, no clean signal yet".
// ============================================================================

function parseRoleAnswer(reply: string): Partial<StatedPreferences> {
  const trimmed = reply.trim().slice(0, 80)
  if (!trimmed) return {}
  return { targetRole: [trimmed] }
}

function parseYoeAnswer(reply: string): Partial<StatedPreferences> {
  const lower = reply.toLowerCase()
  // New-grad signals (zh + en)
  if (
    /(刚毕业|应届|新人|new\s*grad|fresh(\s*out)?|just\s*graduated|no\s*experience)/i.test(reply)
  ) {
    return { yoeRange: [0, 1] }
  }
  // Numeric "N years/yrs/y" or "N 年"
  const num = lower.match(/(\d{1,2})\s*(\+)?\s*(years?|yrs?|y\b|年)/i)
  if (num && num[1]) {
    const n = parseInt(num[1], 10)
    if (Number.isFinite(n) && n >= 0 && n <= 50) {
      return { yoeRange: [n, n] }
    }
  }
  return { yoeRange: null }
}

function parseVisaAnswer(reply: string): Partial<StatedPreferences> {
  const lower = reply.toLowerCase()
  // Order matters: most-specific first to avoid GC matching "card" via citizen.
  if (/(sponsor|sponsorship|h-?1\s*b\s*later|need.*visa)/i.test(reply)) {
    return { visaStatus: "sponsorship_needed" satisfies VisaStatus }
  }
  if (/(h-?1\s*b|h1)/i.test(reply)) {
    return { visaStatus: "h1b" }
  }
  if (/(opt\b|stem.*opt)/i.test(lower) || /\bOPT\b/.test(reply)) {
    return { visaStatus: "opt" }
  }
  if (/(green\s*card|绿卡|gc\b|permanent\s*resident)/i.test(reply)) {
    return { visaStatus: "gc" }
  }
  if (/(citizen|公民|美国人|us\s*citizen)/i.test(reply)) {
    return { visaStatus: "citizen" }
  }
  return { visaStatus: "unknown" }
}

function parseStartupPrefAnswer(reply: string): Partial<StatedPreferences> {
  const lower = reply.toLowerCase()
  const startupHit = /(startup|小公司|小厂|创业|early\s*stage|hustle)/i.test(reply)
  const bigcoHit = /(大厂|大公司|big[-\s]*co|big\s*tech|stable|faang|enterprise)/i.test(reply)
  if (startupHit && !bigcoHit) return { prefersStartup: true }
  if (bigcoHit && !startupHit) return { prefersStartup: false }
  return { prefersStartup: null }
}

function parseLocationAnswer(reply: string): Partial<StatedPreferences> {
  const trimmed = reply.trim().slice(0, 120)
  if (!trimmed) return { targetLocations: [] }
  // Detect "remote" mentions but still keep the raw reply as a hint.
  const tokens: string[] = []
  if (/(remote|在家|远程|wfh)/i.test(reply)) tokens.push("remote")
  if (/(湾区|bay\s*area|sf|san\s*francisco)/i.test(reply)) tokens.push("SF Bay Area")
  if (/(ny|纽约|new\s*york|nyc)/i.test(reply)) tokens.push("NYC")
  if (/(seattle|西雅图)/i.test(reply)) tokens.push("Seattle")
  if (/(la\b|los\s*angeles|洛杉矶)/i.test(reply)) tokens.push("LA")
  if (tokens.length === 0) tokens.push(trimmed)
  return { targetLocations: Array.from(new Set(tokens)) }
}

/**
 * Adam iter 24 — did the user actually ANSWER the question we asked?
 *
 * Different from `parseUserAnswerForStep` which loosely parses anything as a
 * potential answer (e.g. parseRoleAnswer returns any non-empty string as
 * `targetRole: [reply]`). This is the strict signal: did the user's reply
 * contain a recognizable answer keyword for the step?
 *
 * Used by `applyOnboardingStep` to gate state advancement: if user did NOT
 * answer and is just venting / asking for help / changing topic, KEEP the
 * state at the same q_X so the next turn re-asks (or stays suspended via
 * the noChainIntent path).
 */
export function userAnsweredStep(
  step: OnboardingStep,
  reply: string | undefined | null
): boolean {
  const r = (reply ?? "").trim()
  if (!r) return false
  // iter31 — ToS gate. ANY explicit accept token counts as answered. Decline
  // tokens also count as answered (they progress us out of the suspended /
  // re-ask state into a "user has chosen" branch handled by parseTosAnswer).
  // Anything else stays in the suspended path so we don't accidentally
  // treat random chatter as consent.
  if (step === "ask_q_tos") {
    return TOS_ACCEPT_REGEX.test(r) || TOS_DECLINE_REGEX.test(r)
  }
  if (step === "ask_q_email_verify") {
    // 6-digit codes (digits only, ignoring punctuation/spaces around).
    const compact = r.replace(/[\s\-—–]/g, "")
    return /^\d{6}$/.test(compact)
  }
  if (step === "ask_q_role") {
    return /(swe|pm\b|em\b|ic\b|staff|senior|junior|new\s*grad|应届|工程|产品|设计|研究|design|research|engineer|developer|前端|后端|算法|数据|machine\s*learning|ml\b)/i.test(r)
  }
  if (step === "ask_q_yoe") {
    return /(\d{1,2}\s*(?:\+)?\s*(?:years?|yrs?|y\b|年))|(刚毕业|应届|新人|new\s*grad|fresh(?:\s*out)?|just\s*graduated|no\s*experience)/i.test(r)
  }
  if (step === "ask_q_visa") {
    return /(citizen|公民|美国人|us\s*citizen|green\s*card|绿卡|gc\b|permanent\s*resident|opt\b|stem.*opt|\bOPT\b|h-?1\s*b|h1\b|sponsor|sponsorship|need.*visa)/i.test(r)
  }
  if (step === "ask_q_startup_pref") {
    return /(startup|小公司|小厂|创业|early\s*stage|hustle|大厂|大公司|big[-\s]*co|big\s*tech|stable|faang|enterprise)/i.test(r)
  }
  if (step === "ask_q_location") {
    return /(remote|在家|远程|wfh|湾区|bay\s*area|sf\b|san\s*francisco|ny\b|纽约|new\s*york|nyc|seattle|西雅图|la\b|los\s*angeles|洛杉矶|波士顿|boston|chicago|austin|texas|tx\b)/i.test(r)
  }
  if (step === "ask_q_resume") {
    // Resume answer is acceptance/decline/defer — any short reply counts as
    // an "answered" so we advance past the ask. Actual resume upload happens
    // out-of-band via Sendblue attachment + cv-ingest pipeline; the gate
    // opens automatically because the ask_q_resume phrase matches
    // cv-gate-detector regex (`/发简历给我/`, `/send.*your\s+resume/i`).
    return r.length >= 1
  }
  if (step === "ask_q_email") {
    // iter30 V6 — accept either an email-shaped string OR a skip keyword
    // (no/later/skip/不用/算了/以后/没有). Either way we advance past the
    // ask; parseEmailAnswer decides whether to record contactEmail.
    if (EMAIL_REGEX.test(r)) return true
    if (EMAIL_SKIP_REGEX.test(r)) return true
    return false
  }
  return false
}

/** iter30 V6 — RFC-5322-lite email shape (good enough for friend-tone parsing). */
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
/** iter30 V6 — bilingual skip keywords for declining to share email. */
const EMAIL_SKIP_REGEX =
  /(^|[\s,，.。])(no|nope|nah|skip|later|pass|不用|算了|以后再说|没有|不想|不要|跳过)(\b|[\s,，.。!！?？]|$)/i

/**
 * iter31 — bilingual ToS accept tokens. Word-boundary checked so casual
 * mentions inside longer text still count ("ok 同意" / "yeah, agree"). NOT
 * matched on negation context like "i don't agree" — that's caught by the
 * decline regex which we test FIRST in parseTosAnswer.
 */
export const TOS_ACCEPT_REGEX =
  /(^|[\s,，.。])(同意|接受|可以|没问题|好的|好|行|ok\b|okay\b|sure\b|yes\b|yep\b|yeah\b|yup\b|agree(d)?|i\s*agree|accept(ed)?|deal\b|sounds\s*good)(\b|[\s,，.。!！?？]|$)/i
/** iter31 — bilingual ToS decline tokens. Tested BEFORE accept. */
export const TOS_DECLINE_REGEX =
  /(^|[\s,，.。])(不同意|拒绝|不行|不要|不可以|算了|no\b|nope\b|nah\b|don'?t\s*agree|do\s*not\s*agree|decline(d)?|disagree(d)?|reject(ed)?|不接受|hard\s*pass)(\b|[\s,，.。!！?？]|$)/i

/**
 * iter30 V6 — extract an email address from a free-form reply, or detect a
 * skip-shaped answer. Returns `{ contactEmail }` if a valid email was found,
 * or `{}` if the user declined / didn't include one. Empty patch means the
 * orchestrator advances state without writing contactEmail.
 */
function parseEmailAnswer(reply: string): Partial<StatedPreferences> {
  if (!reply) return {}
  const match = reply.match(EMAIL_REGEX)
  if (match) {
    return { contactEmail: match[0].toLowerCase() }
  }
  return {}
}

/**
 * iter31 — Did the user accept the ToS? Returns `"accept"` | `"decline"` |
 * `"unclear"`. Decline is tested FIRST so "i don't agree" doesn't
 * accidentally trip the accept token "agree". `"unclear"` keeps state at
 * q_tos_asked so the next inbound retries.
 */
export function parseTosAnswer(reply: string): "accept" | "decline" | "unclear" {
  if (!reply) return "unclear"
  if (TOS_DECLINE_REGEX.test(reply)) return "decline"
  if (TOS_ACCEPT_REGEX.test(reply)) return "accept"
  return "unclear"
}

/**
 * iter31 — Extract a 6-digit code from a free-form reply. Tolerates
 * punctuation / spacing ("123 456", "123-456", "code: 123456"). Returns
 * the canonicalized 6 digits or null when no match.
 */
export function parseEmailVerificationCode(reply: string): string | null {
  if (!reply) return null
  const compact = reply.replace(/[\s\-—–.,，。:]/g, "")
  const match = compact.match(/(\d{6})/)
  return match ? match[1]! : null
}

/**
 * Parse a user's free-form reply for the question state we just asked.
 * Idempotent: parsing is pure, callers decide whether to write.
 *
 * The `step` param is the step we ASKED — i.e. we're now parsing the reply
 * that arrived AFTER that step ran. Map: ask_q_role → parses reply for role.
 */
export function parseUserAnswerForStep(
  step: OnboardingStep,
  reply: string
): Partial<StatedPreferences> {
  if (!reply) return {}
  if (step === "ask_q_lang") return parseLangAnswer(reply)
  if (step === "ask_q_role") return parseRoleAnswer(reply)
  if (step === "ask_q_yoe") return parseYoeAnswer(reply)
  if (step === "ask_q_visa") return parseVisaAnswer(reply)
  if (step === "ask_q_startup_pref") return parseStartupPrefAnswer(reply)
  if (step === "ask_q_location") return parseLocationAnswer(reply)
  if (step === "ask_q_email") return parseEmailAnswer(reply)
  // ask_q_tos / ask_q_email_verify don't write into statedPreferences directly
  // — they affect User-level fields (tosAcceptance / contactEmailVerifiedAt)
  // which applyOnboardingStep handles separately.
  return {}
}

/**
 * iter33 — parse zh/en/mixed reply to ask_q_lang. Bilingual + permissive:
 * "中文" / "zh" / "chinese" → zh; "english" / "en" / "英文" → en; explicit
 * "mixed" / "混" / "中英" / "both" / "都行" / "either" → mixed. Default to
 * mixed when reply ambiguous (most permissive — Claire keeps adapting per
 * turn). NEVER throws.
 */
export function parseLangAnswer(reply: string): Partial<StatedPreferences> {
  const t = reply.trim().toLowerCase()
  if (!t) return {}
  // Explicit mixed first — phrases like "中英文" contain "中" and "英" and
  // would otherwise be miscategorized.
  if (/混|中英|both|either|都行|都可以|whatever|mix/.test(t)) {
    return { preferredLang: "mixed" }
  }
  // English signals next — "英文" contains 文 (CJK) but is an EN selection.
  // Check before the pure-CJK fallback so "英文" → en (not zh).
  if (/english|英文|engl|\ben\b/.test(t)) {
    return { preferredLang: "en" }
  }
  // Chinese signals
  if (/中文|chinese|\bzh\b|汉语|普通话|国语/.test(t) || /^[一-鿿]+$/.test(reply.trim())) {
    return { preferredLang: "zh" }
  }
  // Ambiguous — default to mixed (Claire stays adaptive)
  return { preferredLang: "mixed" }
}

/**
 * Advance the user's onboarding state in Firestore. Idempotent: if the user
 * already has a state >= the target, the write is a no-op.
 *
 * Phase 44: when `opts.priorUserReply` is supplied AND the *previous* step
 * was a question step, parse the reply and merge into statedPreferences in
 * the same Firestore set() call. This means the answer to q_role gets
 * written when we transition q_role_asked → q_yoe_asked (i.e. when the next
 * step "ask_q_yoe" is applied). The `opts.priorAskedStep` declares which
 * step's answer we are parsing.
 *
 * On "complete": also promotes the matching pa_beta_participants row to active
 * and sets onboardedAt + metadata.cohort=beta-v1 (D-07, D-08).
 */
export async function applyOnboardingStep(
  db: Firestore,
  user: Pick<User, "id" | "phoneE164" | "onboardingState">,
  step: OnboardingStep,
  opts: {
    now?: string
    /** Phase 44 — previous step asked (parses reply into statedPreferences). */
    priorAskedStep?: OnboardingStep
    /** Phase 44 — user's reply to the prior step's question. */
    priorUserReply?: string
    /**
     * Phase 52 — F1 fix: when true AND step is `send_first_mes`, we already
     * chained `ask_q_role` inline (intent-aware first_mes), so jump state
     * directly to `q_role_asked` instead of `first_mes_sent`. Saves one
     * round-trip and lines up the next reply for `parseRoleAnswer`.
     */
    intentAcked?: boolean
    /**
     * iter31 — when intent-ack chained ask_q_tos (not ask_q_role) because the
     * ToS gate is enabled, set this to "q_tos_asked" so state advances there
     * instead of q_role_asked. Default behavior (undefined) keeps the F1 path.
     */
    intentAckTarget?: "q_role_asked" | "q_tos_asked"
    /**
     * Adam iter 24 — mid-probe vent suspension. When set, do NOT advance the
     * onboarding state. The current question stays "asked" so the user's
     * next non-vent reply gets parsed by the same step's parser.
     */
    suspendedForVent?: boolean
    /**
     * iter31 — when true, the user explicitly DECLINED ToS. We DO advance
     * state to q_tos_asked (so we don't loop) but we record the decline in
     * tosAcceptance with version=null and a `declinedAt` field so downstream
     * memory ingest stays opt-out. The orchestrator emits the decline ack
     * via composeOnboardingInput's ask_q_tos_declined branch.
     */
    tosDeclined?: boolean
    /**
     * iter31 — when truthy AND step === ask_q_tos: the user accepted; record
     * tosAcceptance with this version + the raw reply for audit.
     */
    tosAcceptedVersion?: string
    /**
     * iter31 — when set AND step === ask_q_email_verify: the orchestrator
     * generated and sent a code; persist the hash + email + sentAt so
     * `verifyEmailCode` can match the user's next reply against it.
     */
    emailVerification?: {
      codeHash: string
      email: string
      sentAt: string
      expiresAt: string
      providerMessageId?: string
    }
    /**
     * iter31 — when true, the verification code matched. Clears
     * emailVerification, sets statedPreferences.contactEmailVerifiedAt,
     * advances to complete.
     */
    emailVerificationVerified?: boolean
    /**
     * iter31 — when true, the verification code MISSED. Increment
     * emailVerification.attempts but DO NOT advance state.
     */
    emailVerificationFailed?: boolean
  } = {}
): Promise<void> {
  if (step === "skip") return
  if (opts.suspendedForVent) return

  // iter31 — verification miss: stay at q_email_verifying, bump attempts.
  if (opts.emailVerificationFailed) {
    const now = opts.now ?? new Date().toISOString()
    const userRef = db.collection(PA_COLLECTIONS.users).doc(user.id)
    const snap = await userRef.get()
    const cur = snap.data() as { emailVerification?: { attempts?: number } } | undefined
    const attempts = (cur?.emailVerification?.attempts ?? 0) + 1
    await userRef.set(
      {
        updatedAt: now,
        "emailVerification.attempts": attempts,
      },
      { merge: true }
    )
    return
  }

  // iter31 — ToS unclear / re-ask: do NOT advance, suspended-for-vent style.
  // Caller handles this branch by setting suspendedForVent=true (above) when
  // ask_q_tos was the prior step and parseTosAnswer returned "unclear".

  let nextState = ONBOARDING_NEXT_STATE[step]
  if (!nextState) return
  // Phase 52 — F1 fix: intent-acked first_mes already asked the role question
  // inline; advance state past first_mes_sent to q_role_asked so the user's
  // NEXT reply is parsed by ask_q_role's parser.
  // iter31 — when ToS gate is on, intent-ack chains ask_q_tos (not
  // ask_q_role). Caller passes the gate-aware target via `intentAckTarget`.
  if (opts.intentAcked && step === "send_first_mes") {
    nextState = opts.intentAckTarget === "q_tos_asked" ? "q_tos_asked" : "q_role_asked"
  }

  const currentState = user.onboardingState
  // Idempotency: don't regress state
  const currentIdx = STATE_ORDER.indexOf(currentState)
  const nextIdx = STATE_ORDER.indexOf(nextState)
  if (currentIdx >= 0 && nextIdx >= 0 && currentIdx >= nextIdx) return

  const now = opts.now ?? new Date().toISOString()
  const userRef = db.collection(PA_COLLECTIONS.users).doc(user.id)

  // Phase 44 — parse the user's prior answer (if any) into a statedPreferences
  // patch. Empty patch = no-op merge.
  let prefPatch: Partial<StatedPreferences> = {}
  if (opts.priorAskedStep && opts.priorUserReply) {
    prefPatch = parseUserAnswerForStep(opts.priorAskedStep, opts.priorUserReply)
  }
  const hasPrefPatch = Object.keys(prefPatch).length > 0
  const statedPreferencesWrite: StatedPreferences | undefined = hasPrefPatch
    ? { ...prefPatch, updatedAt: now }
    : undefined

  if (nextState === "complete") {
    const completePayload: Record<string, unknown> = {
      onboardingState: "complete",
      onboardedAt: now,
      updatedAt: now,
      metadata: { cohort: "beta-v1" },
    }
    if (statedPreferencesWrite) completePayload.statedPreferences = statedPreferencesWrite
    // iter31 — verified email transition: clear the verification challenge
    // and stamp contactEmailVerifiedAt onto statedPreferences.
    if (opts.emailVerificationVerified) {
      completePayload.emailVerification = null
      const merged: Partial<StatedPreferences> = {
        ...(completePayload.statedPreferences as Partial<StatedPreferences> | undefined),
        contactEmailVerifiedAt: now,
        updatedAt: now,
      }
      completePayload.statedPreferences = merged
    }
    await userRef.set(completePayload, { merge: true })
    // Auto-promote beta participant: find by userId = user.id and status in (invited, active)
    const snap = await db
      .collection(PA_COLLECTIONS.betaParticipants)
      .where("userId", "==", user.id)
      .limit(10)
      .get()
    for (const doc of snap.docs) {
      const data = doc.data() as { status: string }
      if (data.status === "invited") {
        await doc.ref.set({ status: "active", activatedAt: now, updatedAt: now }, { merge: true })
      }
    }
    // Fallback: also check by normalized phone handle
    if (snap.empty && user.phoneE164) {
      const snapPhone = await db
        .collection(PA_COLLECTIONS.betaParticipants)
        .where("contactHandle", "==", user.phoneE164)
        .limit(5)
        .get()
      for (const doc of snapPhone.docs) {
        const data = doc.data() as { status: string }
        if (data.status === "invited") {
          await doc.ref.set(
            { status: "active", activatedAt: now, updatedAt: now, userId: user.id },
            { merge: true }
          )
        }
      }
    }
  } else {
    const payload: Record<string, unknown> = {
      onboardingState: nextState,
      updatedAt: now,
    }
    if (statedPreferencesWrite) payload.statedPreferences = statedPreferencesWrite
    // iter30 closure (Adam directive 2026-05-03 "不要一直用这些 fking regex,
    // 可以有但是只能是 helper"): when the orchestrator dispatches
    // ask_q_resume, we KNOW Claire is proactively asking for the CV — open
    // the 24h upload gate deterministically here instead of pattern-matching
    // her reply post-turn. cv-gate-detector regex remains as a fallback for
    // OTHER skills (cv_followup, headhunter mid-conversation) where the
    // orchestrator doesn't already have first-class signal. 24h TTL matches
    // GATE_TTL_MS in cv-gate-detector.ts.
    if (step === "ask_q_resume") {
      const expiresAt = new Date(new Date(now).getTime() + 24 * 60 * 60 * 1000).toISOString()
      payload.resumeAccepted = {
        at: now,
        expiresAt,
        triggerHash: "onboarding_ask_q_resume",
      }
      payload.lastAssistantTurnAt = now
      payload.lastAssistantTurnAskedResume = true
    }
    // iter31 — ToS gate writes. Step-agnostic: orchestrator passes
    // tosAcceptedVersion / tosDeclined when transitioning OUT of
    // q_tos_asked (typically with step=ask_q_role on accept, or step=
    // ask_q_tos on a re-ask that surfaced a clear answer this time).
    // Accept → version + acceptedAt; decline → declinedAt + version="declined"
    // so downstream consumers can opt the user out of memory ingest.
    if (opts.tosAcceptedVersion) {
      payload.tosAcceptance = {
        version: opts.tosAcceptedVersion,
        acceptedAt: now,
        channel: "imessage_sms",
        ...(opts.priorUserReply ? { rawReply: opts.priorUserReply.slice(0, 200) } : {}),
      }
    } else if (opts.tosDeclined) {
      payload.tosAcceptance = {
        version: "declined",
        acceptedAt: now,
        channel: "imessage_sms",
        declinedAt: now,
        ...(opts.priorUserReply ? { rawReply: opts.priorUserReply.slice(0, 200) } : {}),
      }
    }
    // iter31 — Email verification setup: persist hash + email + sent/expires
    // so verifyEmailCode can match the user's reply on the next inbound.
    if (step === "ask_q_email_verify" && opts.emailVerification) {
      payload.emailVerification = {
        codeHash: opts.emailVerification.codeHash,
        email: opts.emailVerification.email.toLowerCase(),
        sentAt: opts.emailVerification.sentAt,
        expiresAt: opts.emailVerification.expiresAt,
        attempts: 0,
        ...(opts.emailVerification.providerMessageId
          ? { providerMessageId: opts.emailVerification.providerMessageId }
          : {}),
      }
    }
    await userRef.set(payload, { merge: true })
  }
}
