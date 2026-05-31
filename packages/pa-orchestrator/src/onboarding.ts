/**
 * Phase 23 — Onboarding state machine for closed-beta first-contact flow.
 * Phase 44 (v1.5 Stream-B / D5+D13) — extended to 8-state rich JOB-PREF
 * probe (role / yoe / visa / startup-pref / location). One question per turn,
 * bilingual, friend-tone (Adam-locked: a casual friend-tone phrasing not "What is your visa
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
 *   q_resume_asked    → complete              → complete
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
// Phase 54 (USER-TAG-03) — sole-writer for pa-users.tags + onboarding mappers.
// Phase 52 vocab projection of statedPreferences answers; fail-open contract.
import {
  applyPartialUserTags,
  type PartialUserTags,
} from "./tags/user-tags-writer.js"
import {
  mapAnswerToRoleFunction,
  mapAnswerToVisa,
  mapAnswerToLocations,
  bucketYoe,
  type YoeRange,
} from "./tags/onboarding-mappers.js"

export type OnboardingStep =
  | "send_first_mes"
  | "ask_grounding_q" // legacy v1 single-question path (kept for backward compat)
  | "ask_q_lang" // historical only; beta onboarding no longer emits a language question.
  | "send_cv_analysis" // iter33 P3 — Claire reads CV, sends 1-line ack + 2-sentence LLM summary, advances to complete.
  | "ask_q_tos" // iter31 — privacy + terms acceptance gate, before any data probes.
  | "ask_q_role"
  | "ask_q_yoe"
  | "ask_q_visa"
  | "ask_q_startup_pref"
  | "ask_q_country"
  | "ask_q_location"
  | "ask_q_resume" // iter30 closure — proactive resume request after location.
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
}

// Layoff-specific opener composers were deleted 2026-05-19. Candidate-visible
// SMS surfaces must never reveal source provenance (see CLAUDE.md v2.0 lock
// "Candidate flow never returns to the admin domain" + "Hello, WeKruit!"
// generic opener directive). The runtime shared_onboarding path owns the
// first message; layoff vs candidate is a DB-side `source` label only.

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
    // Website registration owns email capture. The legacy deterministic SMS
    // flow must never ask for email or email verification.
    if (state === "first_mes_sent") return opts.enableTosGate ? "ask_q_tos" : "ask_q_role"
    if (state === "q_lang_asked") return opts.enableTosGate ? "ask_q_tos" : "ask_q_role"
    if (state === "q_tos_asked") return "ask_q_role"
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
    state === "q_resume_asked"
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
 * Resolve the output language for onboarding. Product is English-only, so this
 * always returns "en".
 */
function pickLang(_userMessage: string | undefined): "zh" | "en" {
  return "en"
}

/** Friend-tone bilingual prompts — Adam-locked tone, do NOT paraphrase. */
const Q_PROMPTS: Record<
  | "ask_q_tos"
  | "ask_q_role"
  | "ask_q_yoe"
  | "ask_q_visa"
  | "ask_q_startup_pref"
  | "ask_q_country"
  | "ask_q_location"
  | "ask_q_resume",
  { zh: string; en: string }
> = {
  // iter31 — ToS + privacy gate. Friend-tone but explicit; the user must
  // affirmatively reply "yes/agree" for state to advance. Link points at
  // the public hosting page; copy line is short enough to fit the iMessage
  // chunker. Adam-locked: do NOT paraphrase or remove the link.
  ask_q_tos: {
    zh: "before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply \"agree\" if cool with that and we keep going",
    en: "before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply \"agree\" if cool with that and we keep going",
  },
  ask_q_role: {
    zh: "btw — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
    en: "btw — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
  },
  ask_q_yoe: {
    zh: "how many years have you been working? New grad is fine too.",
    en: "how many years have you been working? New grad is fine too.",
  },
  ask_q_visa: {
    zh: "got work auth sorted? citizen / GC / OPT / need sponsorship?",
    en: "got work auth sorted? citizen / GC / OPT / need sponsorship?",
  },
  ask_q_startup_pref: {
    zh: "do you prefer startups, bigger-company stability, or are you flexible?",
    en: "do you prefer startups, bigger-company stability, or are you flexible?",
  },
  ask_q_country: {
    zh: "which country/region you targeting? USA / China / Canada / Europe / anywhere — multi is fine",
    en: "which country/region you targeting? USA / China / Canada / Europe / anywhere — multi is fine",
  },
  ask_q_location: {
    zh: "where you wanna be? SF / NYC / remote ok?",
    en: "where you wanna be? SF / NYC / remote ok?",
  },
  // iter30 closure — proactive resume request. Friend-tone, low-friction;
  // signals "for matching, not gatekeeping". cv-gate-detector regex
  // (`/send.*your\s+resume/i`) catches this phrasing and
  // opens the 24h upload gate automatically.
  ask_q_resume: {
    zh: "btw — can you send me your resume? makes JD review and referrals way more on-point",
    en: "btw — can you send me your resume? makes JD review and referrals way more on-point",
  },
}

export const WEKRUIT_LAYOFF_SOURCE = "WeKruit_Laid_Off"
export const WEKRUIT_CANDIDATE_SOURCE = "candidate"

export type WekruitSignupSource = typeof WEKRUIT_LAYOFF_SOURCE | typeof WEKRUIT_CANDIDATE_SOURCE

export function isWekruitSignupSource(value: unknown): value is WekruitSignupSource {
  return value === WEKRUIT_LAYOFF_SOURCE || value === WEKRUIT_CANDIDATE_SOURCE
}

type OnboardingSessionKind = "normal_onboarding"

type OnboardingUserContext = Pick<User, "id" | "phoneE164" | "onboardingState"> & {
  source?: string | null
  workSession?: Record<string, unknown> | null
}

const LEGACY_ONBOARDING_SESSION_KIND: OnboardingSessionKind = "normal_onboarding"

function onboardingWorkSession(
  user: OnboardingUserContext,
  nextState: OnboardingState,
  now: string
): Record<string, unknown> {
  const kind = LEGACY_ONBOARDING_SESSION_KIND
  const current = user.workSession
  const startedAt =
    current?.kind === kind && typeof current.startedAt === "string" ? current.startedAt : now

  if (nextState === "complete") {
    return {
      kind,
      status: "ended",
      startedAt,
      endedAt: now,
      boundary: "complete",
      currentState: "complete",
    }
  }

  return {
    kind,
    status: "active",
    startedAt,
    boundary: "onboarding",
    currentState: nextState,
  }
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
     * iter30 closure (Adam directive 2026-05-04 "why not start right after
     * hello??"): when true (default), casual_chat / null intents on T0
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
     * against a ROLE answer like "engineering" -> false -> off-by-one chain stall (T1
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
    // 2026-05-04 ("where did this lemon come from? did you not test English???"): the lemon emoji
    // 🍋 was hardcoded zh-only and bled into English replies via LLM
    // translation. Split by language; remove emoji from default greetings.
    const fbLang = pickLang(ctx.userMessage)
    const fallback = "Here. What's on your mind today?"
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
      return `[onboarding_step: send_first_mes_with_intent_ack | intent=${detected.intent}] ${ackDirective} The role-direction question to chain (Adam-locked, do not paraphrase): "${rolePhrase}". Total reply: ≤ 2 sentences. No "OK" preface. No numbering. No A/B framework like "X or Y?" — the role question already enumerates options. Friend-tone, English register matching the user's input.`
    }
    // iter30 closure — Adam directive 2026-05-04 ("why not start right after
    // hello??"): casual_chat / null / unrecognized intent on a fresh user
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
      const opener = "hey, i'm here."
      return `[onboarding_step: send_first_mes_with_casual_chain] User opened with a casual greeting / ambiguous intent. Reply with a friend-tone short opener like "${opener}" (1 short clause), then chain the role-direction question (Adam-locked, do not paraphrase): "${rolePhrase}". Total reply: ≤ 2 sentences. No emoji. No "OK" preface. Friend-tone, English register matching the user's input.`
    }
    return `[onboarding_step: send_first_mes] Reply EXACTLY with Claire's first_mes: "${firstMes}". Nothing else. No greeting. No explanation.`
  }
  if (step === "ask_grounding_q") {
    return `[onboarding_step: ask_grounding_q] Ask ONE casual question to understand what's going on with the user right now. Roommate register: short, genuine, no formal welcome, no formal opener. Example: "what's going on lately, anything you need?" or "what's up today?" — Claude picks naturally from Character Bible v1 voice.`
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
            ? "totally ok — i won't store chat memory if you'd rather not. happy to keep chatting either way. lmk if you change your mind"
            : "totally ok — i won't store chat memory if you'd rather not. happy to keep chatting either way. lmk if you change your mind"
        return `[onboarding_step: ask_q_tos_declined | reason=user_declined_tos] Reply EXACTLY: "${declineMsg}". 1-2 sentences. No emoji. No follow-up question. No legal language. Friend-tone, ${lang === "zh" ? "Mandarin" : "English"} register.`
      }
      if (parsed === "unclear") {
        // Unclear: gentle re-ask, do NOT escalate.
        const reaskMsg =
          lang === "zh"
            ? "just need a quick \"agree\" on the privacy + terms above — or \"no\" and we can chat without me saving anything"
            : "just need a quick \"agree\" on the privacy + terms above — or \"no\" and we can chat without me saving anything"
        return `[onboarding_step: ask_q_tos_reask | reason=ambiguous_reply] Reply EXACTLY: "${reaskMsg}". 1 sentence. No emoji. ${lang === "zh" ? "Mandarin" : "English"} register.`
      }
    }
    return `[onboarding_step: ask_q_tos] Reply EXACTLY this ToS+privacy line (Adam-locked, do not paraphrase, do not chain a follow-up question, do not preface with greeting): "${phrase}". 1-2 short sentences. No emoji. No "OK" preface. English register matching the user's input.`
  }
  if (
    step === "ask_q_role" ||
    step === "ask_q_yoe" ||
    step === "ask_q_visa" ||
    step === "ask_q_startup_pref" ||
    step === "ask_q_location" ||
    step === "ask_q_resume"
  ) {
    // Adam iter 24 — mid-probe suspension. Two triggers, both emit empathetic
    // ack instead of the bare q_X question:
    //   (A) noChainIntent fired (vent / interview_prep / negotiation /
    //       motivation_nudge) — user is in distress / off-topic
    //   (B) user's message does NOT contain a recognizable answer keyword
    //       for the current step (e.g. user says "let me think more" while we asked
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
    // iter35 P7-4 — the legacy regex parser bank was deleted. Suspension is
    // now governed by GuidedOpenJudge's "unclear" verdict in the pipeline
    // path; this compose helper only preserves the venting directive for
    // older dashboard prompt previews.
    if (ventLike) {
      const lang = pickLang(ctx.userMessage)
      if (ventLike && detected) {
        const ackKey = detected.intent as keyof typeof INTENT_ACK_DIRECTIVES
        const ackDirective = INTENT_ACK_DIRECTIVES[ackKey][lang]
        return `[onboarding_step: ${step}_suspended_for_${detected.intent} | intent=${detected.intent}] ${ackDirective}`
      }
      // iter26 — Non-answer path. Adam observed iter24's "ONE clarifier
      // specific to {step}" directive induced LLM to emit AB-framework
      // ("X or Y") on 18/30 turns of long-context test. NEVER PROBE rule
      // (Bible v7.5) violated. Rewrite: NO clarifier question, just
      // empathy + presence. The state already stays at q_X; if user comes
      // back with an actual answer next turn, parser advances. Until then,
      // Claire stays present, no leading questions.
      const langCue = lang === "zh" ? "Mandarin" : "English"
      return `[onboarding_step: ${step}_suspended_no_answer | reason=user_did_not_answer_question] User didn't answer the ${step} question yet. They may be venting, asking meta-questions, or just continuing the thread. Reply with ONE short friend-tone acknowledgement only — no question, no probe, no "A or B" framework. Examples (do NOT echo verbatim, pick register from history): "yeah, i hear you." / "fr, that's a lot." STRICTLY: ≤ 1 short sentence, ≤ 8 words. NEVER append a clarifier question. NEVER list options. Let the user keep talking. ${langCue} register.`
    }
    const lang = pickLang(ctx.userMessage)
    const phrase = Q_PROMPTS[step][lang]
    return `[onboarding_step: ${step}] Ask EXACTLY this ONE friend-tone question (Adam-locked phrasing — do not paraphrase, do not add greeting, do not chain a second question): "${phrase}". 1 sentence. No "OK" preface. No follow-up clauses.`
  }
  // complete / skip don't need synthetic inputs
  return ""
}

/** State transition map: which OnboardingState a step writes. */
const ONBOARDING_NEXT_STATE: Partial<Record<OnboardingStep, OnboardingState>> = {
  send_first_mes: "first_mes_sent",
  ask_grounding_q: "grounding_q1_asked",
  ask_q_lang: "q_lang_asked",
  send_cv_analysis: "complete", // iter33 P3 — terminal CV-analysis step
  ask_q_tos: "q_tos_asked",
  ask_q_role: "q_role_asked",
  ask_q_yoe: "q_yoe_asked",
  ask_q_visa: "q_visa_asked",
  ask_q_startup_pref: "q_startup_pref_asked",
  ask_q_country: "q_country_asked",
  ask_q_location: "q_location_asked",
  ask_q_resume: "q_resume_asked",
  complete: "complete",
}

/**
 * Ordered state vector for idempotent advancement. Both v1 and v2 states are
 * present so a v1 user partway through (`grounding_q1_asked`) cannot regress
 * into a v2 question state, and vice versa.
 */
const STATE_ORDER: Array<OnboardingState | undefined> = [
  undefined,
  "pending",
  "first_mes_sent",
  // v1 leaf
  "grounding_q1_asked",
  // historical beta migration state; active onboarding skips language selection
  "q_lang_asked",
  "q_tos_asked",
  // v2 probe chain
  "q_role_asked",
  "q_yoe_asked",
  "q_visa_asked",
  "q_startup_pref_asked",
  "q_country_asked",
  "q_location_asked",
  "q_resume_asked",
  // iter35 G2 — DiscussionPhase: ack → processing → done → cv_analyzing
  "q_resume_processing",
  "q_resume_done",
  // iter33 P3 — CV analysis brief between q_resume_asked + complete
  "q_cv_analyzing",
  "complete",
]

// ============================================================================
// iter35 P7-4 (2026-05-07) — REMOVED: legacy regex parsers + canon-token maps.
//
// Adam directive: full rewrite, no patching. The functions below were the 4 parallel
// regex paths (the legacy parsers) doing the same job: parse a free-form user reply
// into a canonical statedPreferences value. They are SUPERSEDED by
// `GuidedOpenJudge` in `onboarding/judges/guided-open.ts` (LLM-first +
// optional bloom regex), wired through the V2 question registry in
// `onboarding/questions.ts` and dispatched via `pipeline.runTurn`.
//
// Type aliases (CanonicalRole / CanonicalLocation / CanonicalStartupPref)
// are retained as type-only exports because downstream modules
// (voice/role-to-industry.ts, tags/user-tags-merger.ts) still hold them as
// shape contracts on stored statedPreferences. New writes use the V2 visa /
// location / role canonical strings via `parsedAnswer` opt to
// applyOnboardingStep — no regex re-parse.
//
// ToS and language parsers are retained because those formats are structural
// checks. SMS email capture was removed; website registration owns email.
// ============================================================================

export type CanonicalRole =
  | "swe" | "pm" | "em" | "designer" | "research" | "data" | "ml"
  | "ops" | "marketing" | "sales" | "founder" | "other"

export type CanonicalStartupPref = "startup" | "bigtech" | "either"

export type CanonicalLocation =
  | "sf" | "nyc" | "seattle" | "la" | "boston" | "chicago" | "austin"
  | "shanghai" | "beijing" | "hangzhou" | "shenzhen" | "guangzhou"
  | "remote" | "anywhere" | "china" | "other"

/**
 * iter31 — bilingual ToS accept tokens. Word-boundary checked so casual
 * mentions inside longer text still count ("ok agree" / "yeah, agree"). NOT
 * matched on negation context like "i don't agree" — that's caught by the
 * decline regex which we test FIRST in parseTosAnswer.
 */
export const TOS_ACCEPT_REGEX =
  /(^|[\s,.])(ok\b|okay\b|sure\b|yes\b|yep\b|yeah\b|yup\b|agree(d)?|i\s*agree|accept(ed)?|deal\b|sounds\s*good)(\b|[\s,.!?]|$)/i
/** iter31 — bilingual ToS decline tokens. Tested BEFORE accept. */
export const TOS_DECLINE_REGEX =
  /(^|[\s,.])(no\b|nope\b|nah\b|don'?t\s*agree|do\s*not\s*agree|decline(d)?|disagree(d)?|reject(ed)?|hard\s*pass)(\b|[\s,.!?]|$)/i

/**
 * iter33 Bug 15 fix 2026-05-05 — common-typo detector for email domains.
 * Adam reported typing `indolencorlol@gmal.com` (gmal not gmail) → Mailgun
 * accepted the API call (domain not validated client-side) but SMTP
 * delivery permanently bounced ("No MX for gmal.com"). User got no code
 * but Claire said the code was sent. Now we catch the typo before the send and
 * surface a confirm-prompt back to the user.
 *
 * Map kept conservative — only HIGH-confidence typos that are vanishingly
 * unlikely to be real domains. Things like `gmail.co` (could be a
 * Colombian co-domain) are NOT in here. Edge cases that look like real
 * non-US domains are explicitly NOT flagged.
 */
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
  // iter35 P7-4 — only `ask_q_lang` retains regex-based parsing. The probe
  // Qs (role/yoe/visa/startup_pref/location) now flow
  // through `pipeline.runTurn(QUESTIONS_V2)` + `GuidedOpenJudge` and write
  // canonical values via `parsedAnswer` opt to `applyOnboardingStep`.
  if (step === "ask_q_lang") return parseLangAnswer(reply)
  // ask_q_tos does not write into statedPreferences directly; ToS acceptance
  // is handled separately.
  return {}
}

/**
 * Historical ask_q_lang parser. Beta onboarding no longer asks a language
 * question, and the product is English-only, so any meaningful reply resolves
 * to "en". Empty/whitespace returns {}. Kept for back-compat callers.
 */
export function parseLangAnswer(reply: string): Partial<StatedPreferences> {
  const t = reply.trim().toLowerCase()
  if (!t) return {}
  if (/\bmixed\b|both/.test(t)) {
    return { preferredLang: "mixed" }
  }
  return { preferredLang: "en" }
}

/**
 * Phase 54 (USER-TAG-03) — Project a `Partial<StatedPreferences>` patch into
 * canonical Phase 52 vocab and persist via the `applyPartialUserTags` sole-
 * writer.
 *
 * The patch arrives in either shape:
 *   - regex-derived (the legacy probe parsers) — already
 *     normalized in this module via the legacy canon-token helpers
 *   - LLM Judge canonical — strict StatedPreferences fields
 *
 * Mapping:
 *   - `targetRole` (CanonicalRole tokens like "swe") → `targetRoleFunction[]`
 *     (ROLE_FUNCTION_VOCAB Phase 52)
 *   - `yoeRange` ([min,max]) → `yoeRange` Phase 52 bucket string
 *   - `visaStatus` (CV-side enum incl. opt/h1b/sponsorship_needed) → 4-enum
 *     `visaStatus` Phase 52 (collapses opt/h1b/cpt → sponsor_needed)
 *   - `targetLocations` (CanonicalLocation tokens like "sf") → Phase 52
 *     LOCATION_VOCAB tokens (san_francisco_bay_area, etc)
 *   - `prefersStartup` (boolean|null) → `prefersStartup` boolean (true)
 *     when explicitly preferred startups
 *   - `preferredLang` ('zh'|'en'|'mixed') → 'zh'|'en'|'mixed' Phase 52
 *
 * Fail-open: any unrecognized canonical token maps to "skip this field"
 * rather than poisoning the tags doc with bogus values. The Phase 56 hard-
 * filter treats missing fields as "no restriction".
 */
function projectPrefPatchToPhase52Tags(
  prefPatch: Partial<StatedPreferences>
): PartialUserTags {
  const out: Record<string, unknown> = {}

  // targetRole (CanonicalRole) → targetRoleFunction[] (Phase 52 ROLE_FUNCTION_VOCAB).
  // CanonicalRole tokens map directly to Phase 52 tokens.
  if (Array.isArray(prefPatch.targetRole) && prefPatch.targetRole.length > 0) {
    const mapped: string[] = []
    for (const r of prefPatch.targetRole) {
      const rfs = mapAnswerToRoleFunction(r)
      for (const rf of rfs) if (!mapped.includes(rf)) mapped.push(rf)
    }
    if (mapped.length > 0) out.targetRoleFunction = mapped
  }

  // yoeRange ([min,max]) → bucket string. Use min as the bucketing input
  // (most representative when min !== max).
  if (
    Array.isArray(prefPatch.yoeRange) &&
    prefPatch.yoeRange.length === 2
  ) {
    const [minY] = prefPatch.yoeRange
    const bucket: YoeRange | null = bucketYoe(minY)
    if (bucket) out.yoeRange = bucket
  }

  // visaStatus (CV side: citizen|gc|opt|h1b|sponsorship_needed|unknown)
  //   → 4-enum Phase 52 (citizen|permanent_resident|sponsor_needed|other).
  if (typeof prefPatch.visaStatus === "string") {
    const v = prefPatch.visaStatus
    if (v === "citizen") out.visaStatus = "citizen"
    else if (v === "gc") out.visaStatus = "permanent_resident"
    else if (v === "opt" || v === "h1b" || v === "sponsorship_needed") {
      out.visaStatus = "sponsor_needed"
    } else if (v === "unknown") {
      // map to "other" only when explicitly captured — skip when not seen
      // so we don't overwrite a previously-set tag.
      out.visaStatus = "other"
    } else {
      // free-text path — try the mapper
      const mapped = mapAnswerToVisa(v)
      if (mapped !== "other") out.visaStatus = mapped
    }
  }

  // targetLocations (CanonicalLocation: sf|nyc|...) → LOCATION_VOCAB.
  if (
    Array.isArray(prefPatch.targetLocations) &&
    prefPatch.targetLocations.length > 0
  ) {
    const mapped: string[] = []
    for (const l of prefPatch.targetLocations) {
      const locs = mapAnswerToLocations(l)
      for (const tok of locs) if (!mapped.includes(tok)) mapped.push(tok)
    }
    if (mapped.length > 0) out.targetLocations = mapped
  }

  // targetCountry (q_country canonical output) → tags.targetCountry.
  if (Array.isArray(prefPatch.targetCountry) && prefPatch.targetCountry.length > 0) {
    const seen = new Set<string>()
    const countries: string[] = []
    for (const c of prefPatch.targetCountry) {
      if (typeof c !== "string") continue
      const norm = c.trim().toLowerCase()
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      countries.push(norm)
    }
    if (countries.length > 0) out.targetCountry = countries
  }

  // prefersStartup boolean → prefersStartup boolean. Phase 52 schema lives
  // alongside the StartupPreference enum used elsewhere; we project the raw
  // boolean signal so Phase 56 soft-score can use either side.
  if (prefPatch.prefersStartup === true) out.prefersStartup = true
  else if (prefPatch.prefersStartup === false) out.prefersStartup = false
  // null = no signal / "either" — leave unset.

  // preferredLang.
  if (
    prefPatch.preferredLang === "zh" ||
    prefPatch.preferredLang === "en" ||
    prefPatch.preferredLang === "mixed"
  ) {
    out.preferredLang = prefPatch.preferredLang
  }

  return out
}

/**
 * Phase 54 (USER-TAG-03) — Hook called after applyOnboardingStep persists
 * the Phase 44 `statedPreferences` patch to write the SAME signal
 * (canonically re-projected to Phase 52 vocab) into `pa-users.tags`.
 *
 * Fail-open: errors logged via `log` but never thrown back to the caller.
 * Empty patch (no recognizable Phase 52 signal) → skip silently.
 *
 * Public for unit tests; production callers use `applyOnboardingStep`.
 */
export async function writeOnboardingTags(
  db: Firestore,
  userId: string,
  prefPatch: Partial<StatedPreferences>,
  opts: { nowIso?: string; log?: (e: string, p?: Record<string, unknown>) => void } = {}
): Promise<void> {
  const log = opts.log ?? (() => {})
  if (!userId) {
    log("pa.onboarding_tags.skip", { reason: "no_user_id" })
    return
  }
  if (!prefPatch || typeof prefPatch !== "object") {
    log("pa.onboarding_tags.skip", { reason: "no_patch" })
    return
  }
  let projected: PartialUserTags
  try {
    projected = projectPrefPatchToPhase52Tags(prefPatch)
  } catch (err) {
    log("pa.onboarding_tags.project_error", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  if (Object.keys(projected).length === 0) {
    log("pa.onboarding_tags.skip", { reason: "empty_projection", userId })
    return
  }
  try {
    const res = await applyPartialUserTags(db, userId, projected, {
      source: "chat",
      nowIso: opts.nowIso,
      log,
    })
    if (!res.ok) {
      log("pa.onboarding_tags.write_failed", { userId, error: res.error })
    }
  } catch (err) {
    // applyPartialUserTags already swallows internally — but defense-in-depth.
    log("pa.onboarding_tags.write_throw", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
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
  user: OnboardingUserContext,
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
     * round-trip and lines up the next reply for the role parser.
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
     * iter34 hotfix 2026-05-05 — Adam directive "why still using regex??". When
     * provided, this CANONICAL StatedPreferences patch REPLACES the
     * regex-based `parseUserAnswerForStep(priorAskedStep, priorUserReply)`
     * extraction. Pipeline (Q-as-class) hooks pass Judge canonical output
     * directly (e.g. `{ visaStatus: "h1b" }` from VisaJudge). No re-parse,
     * no regex. Legacy callers don't pass this → regex fallback unchanged.
     *
     * Migration path: as legacy callsites get rewritten to use Judge
     * canonical output, they switch from `priorAskedStep+priorUserReply`
     * to `parsedAnswer`. When all callers migrated, the regex parser dies.
     */
    parsedAnswer?: Partial<StatedPreferences>
  } = {}
): Promise<void> {
  if (step === "skip") return
  if (opts.suspendedForVent) return

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
  // Idempotency: don't regress state. The decision to skip state writes
  // happens after we compute any fresh preference patch, because returning
  // users can already be legacy-complete while still giving new answers.
  const currentIdx = STATE_ORDER.indexOf(currentState)
  const nextIdx = STATE_ORDER.indexOf(nextState)

  const now = opts.now ?? new Date().toISOString()
  const userRef = db.collection(PA_COLLECTIONS.users).doc(user.id)

  // Phase 44 — parse the user's prior answer (if any) into a statedPreferences
  // patch. Empty patch = no-op merge.
  // iter34 hotfix 2026-05-05 — `parsedAnswer` (canonical Judge output)
  // takes precedence over regex parse. Pipeline path uses this; legacy
  // path falls back to regex.
  let prefPatch: Partial<StatedPreferences> = {}
  if (opts.parsedAnswer && Object.keys(opts.parsedAnswer).length > 0) {
    prefPatch = opts.parsedAnswer
  } else if (opts.priorAskedStep && opts.priorUserReply) {
    prefPatch = parseUserAnswerForStep(opts.priorAskedStep, opts.priorUserReply)
  }
  const hasPrefPatch = Object.keys(prefPatch).length > 0
  const statedPreferencesWrite: StatedPreferences | undefined = hasPrefPatch
    ? { ...prefPatch, updatedAt: now }
    : undefined

  const writeProjectedTags = async () => {
    if (!hasPrefPatch) return
    try {
      await writeOnboardingTags(db, user.id, prefPatch, { nowIso: now })
    } catch {
      // writeOnboardingTags already swallows + logs; final defensive catch.
    }
  }

  // Idempotency should prevent state regression, not discard fresh profile
  // evidence from a new session. Returning candidates often already have
  // legacy onboardingState="complete" while the pipeline is collecting a new
  // preference pass in pipelineState; keep those new answers/tags.
  if (currentIdx >= 0 && nextIdx >= 0 && currentIdx >= nextIdx && nextState !== "complete") {
    const payload: Record<string, unknown> = { updatedAt: now }
    if (statedPreferencesWrite) payload.statedPreferences = statedPreferencesWrite
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
    if (Object.keys(payload).length > 1) {
      await userRef.set(payload, { merge: true })
    }
    await writeProjectedTags()
    return
  }

  if (nextState === "complete") {
    const completePayload: Record<string, unknown> = {
      onboardingState: "complete",
      onboardingStatus: "active",
      onboardedAt: now,
      updatedAt: now,
      metadata: { cohort: "beta-v1" },
      workSession: onboardingWorkSession(user, "complete", now),
    }
    if (statedPreferencesWrite) completePayload.statedPreferences = statedPreferencesWrite
    await userRef.set(completePayload, { merge: true })
    await userRef.update({ workSession: completePayload.workSession })
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
      workSession: onboardingWorkSession(user, nextState, now),
    }
    if (statedPreferencesWrite) payload.statedPreferences = statedPreferencesWrite
    // iter30 closure (Adam directive 2026-05-03 "stop using all these fking
    // regexes — they can exist but only as helpers"): when the orchestrator dispatches
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
    await userRef.set(payload, { merge: true })
    await userRef.update({ workSession: payload.workSession })
  }

  // Phase 54 (USER-TAG-03) — Mirror the freshly-persisted statedPreferences
  // patch into `pa-users.tags` (Phase 52 canonical vocab). This is fail-open:
  // tag-store coherence MUST NOT block onboarding state advancement.
  // Skips entirely when there's no patch OR no projectable signal.
  if (hasPrefPatch) {
    await writeProjectedTags()
  }
}
