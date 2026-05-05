/**
 * iter32 — Deterministic onboarding dispatcher.
 *
 * Adam directive 2026-05-04 ("we should have resume parsed before we start
 * agent runtime"): all pre-runtime onboarding turns dispatch a configured
 * phrase verbatim via sendMemoryReply. NO LLM, NO Voice v1 sandwich, NO
 * AB-probe-strip, NO langlock guard. Same friend-tone surface (the
 * configured zh/en strings ARE friend-tone), zero drift, ~7 LLM calls saved
 * per new user.
 *
 * Sequence (Adam-locked):
 *   1. send_first_mes        — verbatim greeting
 *   2. ask_q_tos             — privacy + terms link, must accept
 *   3. ask_q_role
 *   4. ask_q_yoe
 *   5. ask_q_visa
 *   6. ask_q_startup_pref
 *   7. ask_q_location
 *   8. ask_q_resume          — proactive CV ask
 *   9. CV-gate: WAIT for parsedCandidateResumes row before advancing
 *  10. ask_q_email
 *  11. ask_q_email_verify    — Mailgun fires; user texts back code
 *  12. email-verified-gate: WAIT for contactEmailVerifiedAt
 *  13. complete              → agent runtime (playbook-driven) activates
 *
 * Vent / distress mid-onboarding: state stays, send a short fixed empathy
 * ack ("嗯, 我在. 准备好继续就告诉我") + re-ask same step on next inbound.
 *
 * Crisis (suicide / self-harm) keywords: still routed through pa-safety's
 * deterministic crisis hotline reply (NOT the LLM-rewriter path) because
 * crisis safety supersedes onboarding flow.
 *
 * Config storage: pa-onboarding-config/v1 Firestore doc (operator-editable
 * via dashboard). DEFAULT_ONBOARDING_CONFIG below is the seed default; a
 * Firestore override merges field-by-field on read so operators can edit
 * one prompt without rewriting the whole config.
 */
import type { Firestore } from "firebase-admin/firestore"
import type { InboundEvent, AgentDef, OnboardingState } from "@pa/core-types"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  parseTosAnswer,
  parseEmailVerificationCode,
  parseUserAnswerForStep,
  userAnsweredStep,
  type OnboardingStep,
} from "./onboarding.js"
import {
  ONBOARDING_WORKFLOW,
  walkWorkflow,
  type WorkflowContext,
} from "./onboarding-workflow.js"

// ────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────

export type OnboardingPrompt = { zh: string; en: string }

export type OnboardingStepConfig = {
  /** Phrase to dispatch verbatim via sendMemoryReply. */
  prompt: OnboardingPrompt
  /**
   * Reply when the user's answer doesn't parse (e.g. q_tos_asked +
   * "what does that mean?"). State stays; next inbound retries.
   */
  reaskPrompt?: OnboardingPrompt
  /**
   * Reply when the user actively declines (q_tos_asked + "no").
   */
  declinePrompt?: OnboardingPrompt
  /**
   * Reply emitted while we wait for an out-of-band side-effect to
   * complete — used for ask_q_resume after the user said yes but the
   * Sendblue attachment hasn't arrived yet, and ask_q_email_verify
   * after a wrong code.
   */
  waitingPrompt?: OnboardingPrompt
}

const FIRST_MES_ZH = "在呢. 今天找你聊点啥?"
const FIRST_MES_EN = "Here. What's on your mind today?"

/**
 * Default config — same Adam-locked phrasing that lived in onboarding.ts
 * Q_PROMPTS until iter31. Centralized here as data so a Firestore override
 * can replace single fields without changes to source.
 */
export const DEFAULT_ONBOARDING_CONFIG: Record<OnboardingStep, OnboardingStepConfig | undefined> = {
  send_first_mes: {
    prompt: { zh: FIRST_MES_ZH, en: FIRST_MES_EN },
  },
  ask_grounding_q: undefined, // legacy v1 — not used in deterministic path
  // iter33 P1 (Adam directive 2026-05-04 "问 你 prefer 中文、英文、中英文混合"):
  // explicit lang preference question. Fires after first_mes_sent. Reply
  // parsed by parseLangAnswer → preferredLang (zh / en / mixed). Default to
  // mixed when ambiguous so Claire keeps adapting.
  ask_q_lang: {
    // iter33 spec collapse 2026-05-05 — q_lang is now Claire's FIRST
    // outbound (no separate first_mes greeting). Prompt opens with a
    // short "在呢/Here" acknowledgment so it reads as a greeting + Q,
    // not a cold question.
    prompt: {
      zh: "在呢. 用啥语聊比较顺? 中文 / 英文 / 中英混着说都行",
      en: "Here. What language works for you? Chinese / English / both mixed?",
    },
  },
  ask_q_tos: {
    prompt: {
      zh: "开聊前先说一下: 我会记一些咱聊天的事来给你推工作 / 找内推. 隐私 + 用户协议在这: https://wekruit-pa.web.app/legal — 同意就回个 \"同意\" 我们继续",
      en: "before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa.web.app/legal — reply \"agree\" if cool with that and we keep going",
    },
    declinePrompt: {
      zh: "完全 ok, 你不同意我就不主动记你聊天的事. 想聊别的随时. 改主意了说一声",
      en: "totally ok — i won't store chat memory if you'd rather not. happy to keep chatting either way. lmk if you change your mind",
    },
    reaskPrompt: {
      zh: "刚那个隐私 + 用户协议你看一下哦, 同意就回 \"同意\" — 不同意我们也能继续聊但不会保存",
      en: "just need a quick \"agree\" on the privacy + terms above — or \"no\" and we can chat without me saving anything",
    },
  },
  ask_q_role: {
    prompt: {
      zh: "那你大概想找啥方向的活? 比如做产品、做工程、还是做研究 — 给我个大致就行",
      en: "btw — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
    },
  },
  ask_q_yoe: {
    prompt: {
      zh: "你工作几年了? 还是刚毕业找新人岗?",
      en: "how many years you been working? or fresh outta school?",
    },
  },
  ask_q_visa: {
    prompt: {
      zh: "那你有身份不? 公民/绿卡/OPT/还是要 sponsor?",
      en: "got work auth sorted? citizen / GC / OPT / need sponsorship?",
    },
  },
  ask_q_startup_pref: {
    prompt: {
      zh: "你更想去 startup 那种小而拼的, 还是大厂稳一点?",
      en: "more into startup hustle vibe or stable big-co?",
    },
  },
  ask_q_location: {
    prompt: {
      zh: "想找哪边的工作? 湾区、纽约、还是看远程?",
      en: "where you wanna be? SF / NYC / remote ok?",
    },
  },
  ask_q_resume: {
    prompt: {
      zh: "对了, 简历方便发我一份不? 后面帮你看 JD / 内推都准多了",
      en: "btw — can you send me your resume? makes JD review and referrals way more on-point",
    },
    waitingPrompt: {
      zh: "等你发简历过来哦, iMessage 里直接附件就行",
      en: "just waiting on the resume — send it as an iMessage attachment whenever",
    },
  },
  ask_q_email: {
    prompt: {
      zh: "对了, 平时邮箱用啥? 后面如果你不在线我直接发邮件给你",
      en: "btw — what email should I send stuff to when you're afk? roughly fine",
    },
  },
  ask_q_email_verify: {
    prompt: {
      zh: "已经发了一个 6 位验证码到你邮箱了, 收到回我一下就行 (30 分钟有效)",
      en: "just sent a 6-digit code to your email — text it back to me and we're set (good for 30 mins)",
    },
    waitingPrompt: {
      zh: "等你把邮箱里的 6 位验证码发我",
      en: "still waiting on that 6-digit code from your email",
    },
  },
  // iter33 P3 — send_cv_analysis is not a question step; the runner emits
  // ack + LLM-summary inline. Config slot present for completeness so a
  // Firestore override can replace the ack/fallback strings later.
  send_cv_analysis: {
    prompt: {
      zh: "OK 让我看一下你简历, 等我一下下",
      en: "ok — give me a sec to read your resume",
    },
  },
  complete: undefined,
  skip: undefined,
}

/** Vent ack — short, deterministic, friend-tone. State stays. */
const VENT_ACK: OnboardingPrompt = {
  zh: "嗯, 我在. 准备好继续就告诉我",
  en: "yeah, i'm here. lmk when you're ready to keep going",
}

/**
 * iter33 GAP 4 — env-only kill switch for the iter33 P1+P2 sequence.
 * Set `PA_ONBOARDING_V33_DISABLED=true` on the Cloud Function (or in
 * apps/functions/.env) to skip q_lang_asked + fall back to iter32
 * sequence (first_mes_sent → q_tos_asked → ...). Reading from env
 * each call (cheap) so an operator can flip without redeploying the
 * orchestrator package — only the Cloud Function bundle restart.
 */
export function isV33Disabled(): boolean {
  const v = (process.env.PA_ONBOARDING_V33_DISABLED ?? "").trim().toLowerCase()
  return v === "true" || v === "1" || v === "yes"
}

// ────────────────────────────────────────────────────────────────────
// Lang detect (mirrors onboarding.ts pickLang — kept local so the
// deterministic module has zero external coupling).
// ────────────────────────────────────────────────────────────────────
export function pickLang(
  userMessage: string | undefined,
  fallback: "zh" | "en" = "zh",
): "zh" | "en" {
  // iter32: strip email addresses + URLs before counting so a zh user
  // saying "我邮箱是 adam@wekruit.com" doesn't tip into EN due to the
  // ASCII-heavy email tail. Same for "看 https://example.com" etc.
  const raw = userMessage ?? ""
  const stripped = raw
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "")
    .replace(/https?:\/\/\S+/gi, "")
  const text = stripped.replace(/\s+/g, "")
  if (!text) {
    // iter33 Bug 7 fix (sim-walkthrough C/D/E exposed): user msg was
    // ENTIRELY email/URL ("alex@example.com"). Old behavior returned
    // "zh" hardcoded — meant en-speaking users got zh verify-start
    // template. Now: scan raw msg for CJK glyphs first; if none and
    // raw has ASCII letters, treat as en; else fall back to caller's
    // hint (defaults zh for backward compat).
    const hasCjk = [...raw].some((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0xf900 && code <= 0xfaff)
      )
    })
    if (hasCjk) return "zh"
    if (/[a-z]/i.test(raw)) return "en"
    return fallback
  }
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
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

// ────────────────────────────────────────────────────────────────────
// Firestore override loader. Cache TTL=30s — operator dashboard edits
// take effect within 30s of save.
// ────────────────────────────────────────────────────────────────────
const CONFIG_CACHE_TTL_MS = 30 * 1000
let cachedConfig: typeof DEFAULT_ONBOARDING_CONFIG | null = null
let cachedAt = 0

export async function loadOnboardingConfig(
  db: Firestore | undefined
): Promise<typeof DEFAULT_ONBOARDING_CONFIG> {
  const now = Date.now()
  if (cachedConfig && now - cachedAt < CONFIG_CACHE_TTL_MS) {
    return cachedConfig
  }
  if (!db) {
    cachedConfig = DEFAULT_ONBOARDING_CONFIG
    cachedAt = now
    return cachedConfig
  }
  try {
    const snap = await db.collection("pa-onboarding-config").doc("v1").get()
    if (!snap.exists) {
      cachedConfig = DEFAULT_ONBOARDING_CONFIG
      cachedAt = now
      return cachedConfig
    }
    const override = snap.data() as Partial<typeof DEFAULT_ONBOARDING_CONFIG>
    // Field-by-field merge: operators can edit one prompt without
    // re-writing the rest. Keep the structural skeleton from DEFAULT.
    const merged = { ...DEFAULT_ONBOARDING_CONFIG }
    for (const [step, cfg] of Object.entries(override)) {
      if (!cfg || typeof cfg !== "object") continue
      const def = DEFAULT_ONBOARDING_CONFIG[step as OnboardingStep]
      if (!def) continue
      merged[step as OnboardingStep] = {
        ...def,
        ...(cfg as OnboardingStepConfig),
      }
    }
    cachedConfig = merged
    cachedAt = now
    return cachedConfig
  } catch {
    cachedConfig = DEFAULT_ONBOARDING_CONFIG
    cachedAt = now
    return cachedConfig
  }
}

/** Test helper — clear the cache so tests don't bleed config across cases. */
export function _resetOnboardingConfigCache() {
  cachedConfig = null
  cachedAt = 0
}

// ────────────────────────────────────────────────────────────────────
// Step resolver — same semantics as resolveOnboardingStep but emits
// gate-aware steps so the dispatcher can hold at the resume / email
// verify gates without advancing.
// ────────────────────────────────────────────────────────────────────

export type DeterministicTurnInput = {
  onboardingState: OnboardingState | undefined
  /** From cv-ingest pipeline. True = parsedCandidateResumes row exists. */
  cvParsed: boolean
  /** statedPreferences.contactEmailVerifiedAt is set. */
  emailVerified: boolean
  /** statedPreferences.contactEmail is set. */
  emailCaptured: boolean
}

export type DeterministicAction =
  | { kind: "send_first_mes" }
  | { kind: "ask_q_lang" }
  | { kind: "ask_q_tos" }
  | { kind: "ask_q_tos_decline" }
  | { kind: "ask_q_tos_reask" }
  | { kind: "ask_q_role" | "ask_q_yoe" | "ask_q_visa" | "ask_q_startup_pref" | "ask_q_location" }
  | { kind: "ask_q_resume" }
  | { kind: "wait_for_resume_upload" }
  | { kind: "ask_q_email" }
  | { kind: "ask_q_email_verify_start"; email: string } // need to fire Mailgun
  | { kind: "ask_q_email_verify_retry" } // wrong code branch
  | { kind: "ask_q_email_verify_reissue"; email: string } // expired/exhausted → re-fire Mailgun, stay
  | { kind: "verify_email_code"; candidate: string }
  | { kind: "vent_ack" } // user is venting mid-onboarding
  | { kind: "send_cv_analysis" } // iter33 P3 — Claire reads CV + sends ack + 2-sentence summary, advances to complete
  | { kind: "complete" }
  | { kind: "skip" } // already complete + all gates passed

export function resolveDeterministicAction(
  input: DeterministicTurnInput,
  userMessage: string
): DeterministicAction {
  const state = input.onboardingState

  // iter33 GAP 4 escape hatch — when V33 disabled, restore iter32
  // sequence: pending → send_first_mes → first_mes_sent → ask_q_tos
  // (skips the iter33 collapse + q_lang Q). Handled inline before graph
  // walk because it's an environmental short-circuit.
  if (isV33Disabled()) {
    if (state === undefined || state === "pending") {
      return { kind: "send_first_mes" }
    }
    if (state === "first_mes_sent") {
      return { kind: "ask_q_tos" }
    }
  }

  // iter33 spec collapse 2026-05-05 backward-compat — first_mes_sent state
  // was removed from the workflow graph (pending → q_lang_asked direct).
  // Any user with persisted onboardingState="first_mes_sent" from before
  // this ships hops cleanly to q_lang_asked on next inbound. New users
  // never enter first_mes_sent at all.
  if (state === "first_mes_sent") {
    return { kind: "ask_q_lang" }
  }

  // iter33 GAP 2 — graph executor. Build context from parsers + state,
  // walk ONBOARDING_WORKFLOW edges declaratively, return the action
  // attached to the matching edge (with payloads injected from the
  // parsed context).
  const ctx = buildWorkflowContext(input, userMessage)
  const edge = walkWorkflow(ONBOARDING_WORKFLOW, state, ctx)
  if (!edge) {
    // No edge matched — onboarding terminal (state=complete) or
    // unreachable. Either way, hand off to agent runtime.
    return { kind: "skip" }
  }
  return actionFromEdge(edge.action, ctx)
}

/**
 * iter33 GAP 2 — assemble the WorkflowContext for the graph walker.
 * All parser invocations happen here so the walker stays pure-data.
 */
function buildWorkflowContext(
  input: DeterministicTurnInput,
  userMessage: string
): WorkflowContext {
  const state = input.onboardingState
  const priorAskedStep = priorAskedStepFromState(state)
  const isVent = priorAskedStep ? isVentingMessage(userMessage) : false

  let tosDecision: "accept" | "decline" | "unclear" | undefined
  if (state === "q_tos_asked") {
    tosDecision = parseTosAnswer(userMessage)
  }

  let parsedEmail: string | undefined
  if (state === "q_email_asked") {
    const parsed = parseUserAnswerForStep("ask_q_email", userMessage)
    if (parsed.contactEmail) parsedEmail = parsed.contactEmail
  }

  let parsedCode: string | undefined
  if (state === "q_email_verifying") {
    const code = parseEmailVerificationCode(userMessage)
    if (code) parsedCode = code
  }

  let answered = false
  if (priorAskedStep) {
    // ask_q_role / ask_q_yoe / ask_q_visa / ask_q_startup_pref / ask_q_location
    if (
      priorAskedStep === "ask_q_role" ||
      priorAskedStep === "ask_q_yoe" ||
      priorAskedStep === "ask_q_visa" ||
      priorAskedStep === "ask_q_startup_pref" ||
      priorAskedStep === "ask_q_location"
    ) {
      answered = userAnsweredStep(priorAskedStep, userMessage)
    }
  }

  return {
    userMessage,
    cvParsed: input.cvParsed,
    emailCaptured: input.emailCaptured,
    emailVerified: input.emailVerified,
    v33Disabled: isV33Disabled(),
    isVent,
    tosDecision,
    parsedEmail,
    parsedCode,
    answered,
  }
}

/**
 * iter33 GAP 2 — convert an edge.action string + context into the
 * concrete DeterministicAction object. Edges with data-carrying actions
 * (ask_q_email_verify_start.email, verify_email_code.candidate) inject
 * the parsed payload from ctx.
 */
function actionFromEdge(
  actionKind: string,
  ctx: WorkflowContext
): DeterministicAction {
  switch (actionKind) {
    case "send_first_mes":
      return { kind: "send_first_mes" }
    case "ask_q_lang":
      return { kind: "ask_q_lang" }
    case "ask_q_tos":
      return { kind: "ask_q_tos" }
    case "ask_q_tos_decline":
      return { kind: "ask_q_tos_decline" }
    case "ask_q_tos_reask":
      return { kind: "ask_q_tos_reask" }
    case "ask_q_email":
      return { kind: "ask_q_email" }
    case "ask_q_email_verify_start":
      return { kind: "ask_q_email_verify_start", email: ctx.parsedEmail ?? "" }
    case "ask_q_email_verify_retry":
      return { kind: "ask_q_email_verify_retry" }
    case "verify_email_code":
      return { kind: "verify_email_code", candidate: ctx.parsedCode ?? "" }
    case "ask_q_role":
    case "ask_q_yoe":
    case "ask_q_visa":
    case "ask_q_startup_pref":
    case "ask_q_location":
      return { kind: actionKind }
    case "ask_q_resume":
      return { kind: "ask_q_resume" }
    case "wait_for_resume_upload":
      return { kind: "wait_for_resume_upload" }
    case "send_cv_analysis":
      return { kind: "send_cv_analysis" }
    case "vent_ack":
      return { kind: "vent_ack" }
    case "complete":
      return { kind: "complete" }
    default:
      return { kind: "skip" }
  }
}

// (iter33 GAP 2: legacy switch-based dispatcher REMOVED — see git
// history at PR #3 commit ce67358 for the original imperative version.
// Current dispatcher above walks ONBOARDING_WORKFLOW edges declaratively.)

function priorAskedStepFromState(state: OnboardingState | undefined): OnboardingStep | undefined {
  if (state === "q_lang_asked") return "ask_q_lang"
  if (state === "q_tos_asked") return "ask_q_tos"
  if (state === "q_role_asked") return "ask_q_role"
  if (state === "q_yoe_asked") return "ask_q_yoe"
  if (state === "q_visa_asked") return "ask_q_visa"
  if (state === "q_startup_pref_asked") return "ask_q_startup_pref"
  if (state === "q_location_asked") return "ask_q_location"
  if (state === "q_resume_asked") return "ask_q_resume"
  if (state === "q_email_asked") return "ask_q_email"
  if (state === "q_email_verifying") return "ask_q_email_verify"
  return undefined
}

/**
 * Lightweight vent / distress keyword bank. NOT crisis-level (those route
 * to pa-safety's hotline guard). These are mid-conversation distress
 * signals: "I just got laid off", "fuck this", "i give up", etc. Same
 * spirit as composeOnboardingInput's noChainIntents branch, just
 * regex-only (no LLM intent classifier).
 */
const VENT_KEYWORDS = [
  /\b(fuck|shit|hate|sucks|suck|exhausted|burn(ed|t)?\s*out|done with this)\b/i,
  /\b(i\s+(?:give\s+up|quit|can'?t|wanna\s+die|hate\s+life))/i,
  /\b(laid\s*off|fired|rejected|ghosted)\b/i,
  /(操|草|妈的|我服了|我不行了|累死|崩了|裂开|撑不住|心累|快疯了)/,
]
function isVentingMessage(text: string): boolean {
  if (!text) return false
  for (const re of VENT_KEYWORDS) {
    if (re.test(text)) return true
  }
  return false
}

// ────────────────────────────────────────────────────────────────────
// Reply composer — pure function, no LLM. Picks lang from inbound + the
// configured prompt for the action.
// ────────────────────────────────────────────────────────────────────
export function composeDeterministicReply(
  action: DeterministicAction,
  config: typeof DEFAULT_ONBOARDING_CONFIG,
  userMessage: string
): string {
  const lang = pickLang(userMessage)

  if (action.kind === "vent_ack") return VENT_ACK[lang]
  if (action.kind === "skip") return ""
  if (action.kind === "complete") return ""

  if (action.kind === "send_first_mes") {
    return config.send_first_mes!.prompt[lang]
  }
  if (action.kind === "ask_q_lang") {
    return config.ask_q_lang!.prompt[lang]
  }
  if (action.kind === "ask_q_tos") {
    return config.ask_q_tos!.prompt[lang]
  }
  if (action.kind === "ask_q_tos_decline") {
    return config.ask_q_tos!.declinePrompt![lang]
  }
  if (action.kind === "ask_q_tos_reask") {
    return config.ask_q_tos!.reaskPrompt![lang]
  }
  if (
    action.kind === "ask_q_role" ||
    action.kind === "ask_q_yoe" ||
    action.kind === "ask_q_visa" ||
    action.kind === "ask_q_startup_pref" ||
    action.kind === "ask_q_location"
  ) {
    return config[action.kind]!.prompt[lang]
  }
  if (action.kind === "ask_q_resume") {
    return config.ask_q_resume!.prompt[lang]
  }
  if (action.kind === "wait_for_resume_upload") {
    return config.ask_q_resume!.waitingPrompt![lang]
  }
  if (action.kind === "ask_q_email") {
    return config.ask_q_email!.prompt[lang]
  }
  if (action.kind === "ask_q_email_verify_start") {
    return config.ask_q_email_verify!.prompt[lang]
  }
  if (action.kind === "ask_q_email_verify_retry") {
    return config.ask_q_email_verify!.waitingPrompt![lang]
  }
  if (action.kind === "verify_email_code") {
    // Outcome-specific reply lives in the orchestrator (after hash
    // compare); compose returns empty here so caller composes its own.
    return ""
  }
  return ""
}

/**
 * iter32 — feature flag for deterministic onboarding path. Default OFF
 * so the existing LLM-compose path stays as a rollback for one cycle.
 * Flip ON via `paOnboardingDeterministicEnabled` Firestore flag.
 */
export async function isDeterministicOnboardingEnabled(
  db: Firestore | undefined,
  userId: string | undefined
): Promise<boolean> {
  if (process.env.PA_ONBOARDING_DETERMINISTIC_DISABLED === "true") return false
  if (!db) return false
  try {
    const { getFlag } = await import("@pa/pa-persistence")
    const v = await getFlag(db, "paOnboardingDeterministicEnabled", {
      userId,
      env: process.env,
    })
    return v === true
  } catch {
    return false
  }
}

// ────────────────────────────────────────────────────────────────────
// Runner — dispatches one turn deterministically. Replaces the
// LLM-based composeOnboardingInput → runAgentTurn → langlock → AB-strip
// → crisis-guard chain entirely. ~7 LLM calls saved per new user.
//
// Returns:
//   { handled: true } — turn fully dispatched (reply enqueued, state
//                       advanced, log events fired). Caller must return
//                       from processInboundEvent.
//   { handled: false } — onboarding fully complete + CV parsed + email
//                       verified. Caller proceeds to agent runtime.
// ────────────────────────────────────────────────────────────────────

export type DeterministicRunnerStore = {
  appendMessage(msg: {
    sessionId: string
    userId: string
    role: "user" | "assistant" | "system"
    body: string
    createdAt: string
    idempotencyKey?: string
    rawMeta?: Record<string, unknown>
  }): Promise<void>
  enqueueOutbound(
    userId: string,
    toE164: string,
    body: string,
    input?: { sessionId?: string; role?: string; idempotencyKey?: string }
  ): Promise<void>
  applyOnboarding(
    userId: string,
    phoneE164: string,
    step: OnboardingStep,
    opts?: Record<string, unknown>
  ): Promise<void>
  getTosVersion?(): Promise<string>
  getUserEmailVerification?(userId: string): Promise<{
    codeHash: string
    email: string
    sentAt: string
    expiresAt: string
    attempts: number
  } | null>
  sendVerificationEmail?(email: string): Promise<{
    rawCode: string
    sentAt: string
    expiresAt: string
    providerMessageId?: string
  } | null>
  /**
   * iter33 P3 — produce a 1-2 sentence CV analysis blurb in the user's
   * preferred language. Reads parsedCandidateResumes for the user, calls
   * Qwen-7B (or test stub), and returns the summary. Returns null when
   * LLM is unconfigured / fails — caller falls back to a generic ack so
   * onboarding completes either way.
   */
  generateCvAnalysis?(
    userId: string,
    lang: "zh" | "en"
  ): Promise<{ summary: string } | null>
  /**
   * iter33 P4 — push a 2-job-rec message before complete. Returns null
   * when no recs are available yet (caller falls back to deferred-promise
   * line). recCount lets callers log/track delivered counts.
   */
  generateJobRecs?(
    userId: string,
    lang: "zh" | "en"
  ): Promise<{ message: string; recCount: number } | null>
  log(event: string, payload?: Record<string, unknown>): void
  nowIso(): string
  db?: Firestore
}

export type RunDeterministicTurnInput = {
  event: InboundEvent
  store: DeterministicRunnerStore
  turnId: string
  onboardingUser: {
    id: string
    phoneE164: string
    onboardingState?: OnboardingState
    statedPreferences?: {
      contactEmail?: string
      contactEmailVerifiedAt?: string
      // iter33 Bug 7 — preferredLang as pickLang fallback when current msg
      // strips empty (email-only / URL-only). zh / en / mixed (mixed
      // demoted to zh fallback in runner — most conservative).
      preferredLang?: "zh" | "en" | "mixed"
    }
  }
  cvParsed: boolean
  agent: AgentDef
  /** Whether to suppress outbound enqueue (test-harness flag). */
  suppressOutbound?: boolean
}

export type RunDeterministicTurnResult =
  | { handled: true; action: DeterministicAction }
  | { handled: false }

/**
 * iter32 — main dispatcher. Pure orchestrator: NO LLM hop. Composes a
 * configured phrase verbatim, advances onboarding state via
 * applyOnboarding, sends via sendMemoryReply pattern.
 */
export async function runDeterministicOnboardingTurn(
  input: RunDeterministicTurnInput
): Promise<RunDeterministicTurnResult> {
  const { event, store, turnId, onboardingUser, cvParsed } = input
  const config = await loadOnboardingConfig(store.db)
  // iter33 Bug 7 fix — when user msg is email-only / URL-only / empty,
  // pickLang has no signal and would otherwise default to "zh", flipping
  // en-speaking users into a zh template. Pass the user's stored
  // preferredLang as fallback so the verify-start prompt etc. honors
  // the lang they answered q_lang_asked with. "mixed" → "zh" (legacy
  // default; kept conservative). Helper keeps call sites compact.
  const prefLang = onboardingUser.statedPreferences?.preferredLang
  const langFallback: "zh" | "en" =
    prefLang === "zh" ? "zh" : prefLang === "en" ? "en" : "zh"
  const langFor = (msg: string | undefined): "zh" | "en" =>
    pickLang(msg, langFallback)
  const action = resolveDeterministicAction(
    {
      onboardingState: onboardingUser.onboardingState,
      cvParsed,
      emailVerified: Boolean(onboardingUser.statedPreferences?.contactEmailVerifiedAt),
      emailCaptured: Boolean(onboardingUser.statedPreferences?.contactEmail),
    },
    event.body
  )
  store.log("pa.onboarding.deterministic.action", {
    userId: event.userId,
    turnId,
    eventId: event.id,
    state: onboardingUser.onboardingState,
    actionKind: action.kind,
    cvParsed,
  })

  // skip means agent runtime should activate. Caller handles.
  if (action.kind === "skip") return { handled: false }

  // verify_email_code: hash the candidate, compare to stored hash, route
  // to verified / miss / expired / exhausted.
  // iter32: expired or exhausted → re-issue Mailgun code in place, stay
  // at q_email_verifying (NOT bypass to complete — Adam directive: email
  // verify is mandatory before agent runtime activates, so the dispatcher
  // never lets the user past q_email_verifying without a verified code).
  // Verified → advance to q_role_asked (NOT complete — we still have to
  // run the role/yoe/visa/startup/location/resume probes before complete).
  if (action.kind === "verify_email_code") {
    const challenge = store.getUserEmailVerification
      ? await store.getUserEmailVerification(event.userId)
      : null
    if (!challenge) {
      // shouldn't happen — if we're at q_email_verifying the doc must
      // exist. Recover gracefully by re-asking.
      await sendDirect(input, config.ask_q_email_verify!.waitingPrompt![langFor(event.body)])
      return { handled: true, action }
    }
    const nowMs = Date.now()
    const expired = Date.parse(challenge.expiresAt) < nowMs
    const exhausted = challenge.attempts >= 5
    if (expired || exhausted) {
      // Re-issue: fresh code, fresh challenge, attempts reset to 0. Stay
      // at q_email_verifying. User retries with the new code from the
      // re-sent email. Edge case: if user supplied a typo'd email, the
      // re-issued code goes nowhere — operator can resolve via HITL pause
      // (paRuntimeMode) and manual user.runtimeMode override.
      let reissued: typeof challenge | null = null
      if (store.sendVerificationEmail) {
        try {
          const sent = await store.sendVerificationEmail(challenge.email)
          if (sent) {
            const { createHash } = await import("node:crypto")
            reissued = {
              codeHash: createHash("sha256").update(sent.rawCode).digest("hex"),
              email: challenge.email,
              sentAt: sent.sentAt,
              expiresAt: sent.expiresAt,
              attempts: 0,
            }
          }
        } catch (err) {
          store.log("pa.onboarding.deterministic.email_verify_reissue_error", {
            userId: event.userId,
            turnId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const lang = langFor(event.body)
      if (reissued) {
        // Persist via applyOnboarding with emailVerification opt — same
        // step (q_email_verifying), just refreshed challenge fields.
        await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_email_verify", {
          priorAskedStep: "ask_q_email_verify",
          priorUserReply: event.body,
          emailVerification: {
            codeHash: reissued.codeHash,
            email: reissued.email,
            sentAt: reissued.sentAt,
            expiresAt: reissued.expiresAt,
          },
        })
        const msg = expired
          ? lang === "zh"
            ? "验证码过期了, 我重新发了一个新的, 收到再回我"
            : "code expired — sent you a fresh one, text it back when you get it"
          : lang === "zh"
            ? "试错好几次了, 重新发了个新的, 仔细看一下"
            : "few wrong tries — sent a fresh code, double-check this one"
        await sendDirect(input, msg)
        store.log("pa.onboarding.deterministic.email_verify_reissued", {
          userId: event.userId,
          turnId,
          reason: expired ? "expired" : "exhausted",
        })
      } else {
        // Mailgun unavailable — fall back to a "still trying" reply, no
        // state change. Operator can intervene.
        const msg =
          lang === "zh"
            ? "邮件服务暂时有点问题, 我们等会再试 (或者发个新邮箱给我)"
            : "email service is having a moment — we'll retry (or share a new email if you prefer)"
        await sendDirect(input, msg)
        store.log("pa.onboarding.deterministic.email_verify_reissue_no_transport", {
          userId: event.userId,
          turnId,
        })
      }
      return { handled: true, action }
    }
    // Hash compare
    const { createHash } = await import("node:crypto")
    const candidateHash = createHash("sha256").update(action.candidate).digest("hex")
    const lang = langFor(event.body)
    if (candidateHash === challenge.codeHash) {
      // iter33 P2 — advance to q_tos_asked (NOT complete, NOT q_role).
      // Adam-locked sequence: email-verify clears → ToS gate is the next
      // step. Email is verified; stamp contactEmailVerifiedAt on
      // statedPreferences via emailVerificationVerified opt (Bug #5 fix
      // in applyOnboardingStep makes this stamp fire regardless of
      // nextState). Compose ack + ToS prompt joined.
      await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_tos", {
        priorAskedStep: "ask_q_email_verify",
        priorUserReply: event.body,
        emailVerificationVerified: true,
      })
      const verifiedAck = lang === "zh" ? "✓ 邮箱验过了" : "✓ email verified"
      const tosPhrase = config.ask_q_tos!.prompt[lang]
      await sendDirect(input, `${verifiedAck} — ${tosPhrase}`)
      store.log("pa.onboarding.deterministic.email_verify_verified", {
        userId: event.userId,
        turnId,
        email: challenge.email,
      })
      return { handled: true, action }
    }
    // Miss — bump attempts, stay
    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_email_verify", {
      emailVerificationFailed: true,
    })
    const remaining = Math.max(0, 5 - challenge.attempts - 1)
    const msg =
      lang === "zh"
        ? `验证码不对, 再试一次? 还剩 ${remaining} 次`
        : `code didn't match — try again? ${remaining} ${remaining === 1 ? "try" : "tries"} left`
    await sendDirect(input, msg)
    store.log("pa.onboarding.deterministic.email_verify_miss", {
      userId: event.userId,
      turnId,
      attempts: challenge.attempts + 1,
      remaining,
    })
    return { handled: true, action }
  }

  // ask_q_email_verify_start: fire Mailgun, persist hash, advance state.
  if (action.kind === "ask_q_email_verify_start") {
    if (!store.sendVerificationEmail) {
      // Mailgun not configured — skip verification. Email is captured
      // (we just saw it), state moves to complete WITHOUT verifiedAt.
      // Email-verified gate at outer layer will then re-trigger this if
      // it's required. For now, biz testers without Mailgun get a
      // graceful fallback: just thank them and move on.
      await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "complete", {
        priorAskedStep: "ask_q_email",
        priorUserReply: event.body,
      })
      const lang = langFor(event.body)
      const msg = lang === "zh" ? "收到, 邮箱记下了" : "got it — email saved"
      await sendDirect(input, msg)
      store.log("pa.onboarding.deterministic.email_verify_skipped_no_transport", {
        userId: event.userId,
        turnId,
        email: action.email,
      })
      return { handled: true, action }
    }
    let challenge:
      | {
          codeHash: string
          email: string
          sentAt: string
          expiresAt: string
          providerMessageId?: string
        }
      | undefined
    try {
      const sent = await store.sendVerificationEmail(action.email)
      if (sent) {
        const { createHash } = await import("node:crypto")
        challenge = {
          codeHash: createHash("sha256").update(sent.rawCode).digest("hex"),
          email: action.email,
          sentAt: sent.sentAt,
          expiresAt: sent.expiresAt,
          ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}),
        }
        store.log("pa.onboarding.deterministic.email_verify_sent", {
          userId: event.userId,
          turnId,
          email: action.email,
          providerMessageId: sent.providerMessageId,
        })
      }
    } catch (err) {
      store.log("pa.onboarding.deterministic.email_verify_send_error", {
        userId: event.userId,
        turnId,
        email: action.email,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (!challenge) {
      // Mailgun fired but failed; same fallback as no-transport.
      await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "complete", {
        priorAskedStep: "ask_q_email",
        priorUserReply: event.body,
      })
      const lang = langFor(event.body)
      const msg = lang === "zh" ? "收到, 邮箱记下了" : "got it — email saved"
      await sendDirect(input, msg)
      return { handled: true, action }
    }
    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_email_verify", {
      priorAskedStep: "ask_q_email",
      priorUserReply: event.body,
      emailVerification: challenge,
    })
    const phrase = config.ask_q_email_verify!.prompt[langFor(event.body)]
    await sendDirect(input, phrase)
    return { handled: true, action }
  }

  // iter33 P3 — q_resume_asked + cvParsed=true (or stuck at q_cv_analyzing
  // re-attempt) → send_cv_analysis. Two outbound messages in one turn:
  //   1. ack: "OK 让我看一下你简历"
  //   2. analysis: 1-2 sentence LLM summary of the CV (Qwen-7B). Falls
  //      back to a generic 'thanks for sending it through' line if the
  //      LLM hook is unavailable so onboarding still completes.
  // State advances to "complete" (P4 will interpose a job-rec push here).
  if (action.kind === "send_cv_analysis") {
    const lang = langFor(event.body)
    const ackMsg =
      lang === "zh"
        ? "OK 让我看一下你简历, 等我一下下"
        : "ok — give me a sec to read your resume"
    await sendDirect(input, ackMsg)
    store.log("pa.onboarding.deterministic.cv_analysis_ack_sent", {
      userId: event.userId,
      turnId,
    })

    // LLM analysis. Fail-open to a generic line so onboarding always closes.
    let analysisMsg: string
    try {
      const result = store.generateCvAnalysis
        ? await store.generateCvAnalysis(event.userId, lang)
        : null
      if (result?.summary && result.summary.trim().length > 0) {
        analysisMsg = result.summary.trim()
      } else {
        analysisMsg =
          lang === "zh"
            ? "看下来你背景挺扎实的, 后面给你推岗位会贴着你的方向来"
            : "skimmed it — solid background, i'll lean recommendations toward your trajectory"
      }
    } catch (err) {
      store.log("pa.onboarding.deterministic.cv_analysis_error", {
        userId: event.userId,
        turnId,
        error: err instanceof Error ? err.message : String(err),
      })
      analysisMsg =
        lang === "zh"
          ? "看下来你背景挺扎实的, 后面给你推岗位会贴着你的方向来"
          : "skimmed it — solid background, i'll lean recommendations toward your trajectory"
    }
    await sendDirect(input, analysisMsg)

    // iter33 P4 — third outbound: 2-job-rec push (or deferred-promise
    // when no live matches yet). Adam-locked sequence: "推荐两个岗位.
    // onboard 结束". Fail-OPEN to deferred-promise so onboarding always
    // completes even if matching pipeline is offline.
    let jobRecMsg: string
    let recCount = 0
    try {
      const recs = store.generateJobRecs
        ? await store.generateJobRecs(event.userId, lang)
        : null
      if (recs?.message && recs.message.trim().length > 0) {
        jobRecMsg = recs.message.trim()
        recCount = recs.recCount
      } else {
        jobRecMsg =
          lang === "zh"
            ? "明早 9 点你会收到第一批匹配岗位 (2 个 / 天). 有想法随时告诉我"
            : "you'll get your first 2 matches tomorrow ~9am. ping me anytime with thoughts"
      }
    } catch (err) {
      store.log("pa.onboarding.deterministic.job_recs_error", {
        userId: event.userId,
        turnId,
        error: err instanceof Error ? err.message : String(err),
      })
      jobRecMsg =
        lang === "zh"
          ? "明早 9 点你会收到第一批匹配岗位 (2 个 / 天). 有想法随时告诉我"
          : "you'll get your first 2 matches tomorrow ~9am. ping me anytime with thoughts"
    }
    await sendDirect(input, jobRecMsg)

    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "complete", {
      priorAskedStep: "ask_q_resume",
      priorUserReply: event.body,
    })
    store.log("pa.onboarding.deterministic.complete", {
      userId: event.userId,
      turnId,
      withCvAnalysis: true,
      jobRecCount: recCount,
      jobRecsLive: recCount > 0,
    })
    return { handled: true, action }
  }

  // ToS accept path (iter33 P2 reorder) → advance to q_role_asked +
  // write tosAcceptance audit. iter33 sequence: q_tos_asked accept now
  // gates the role-probe chain (email + verify already cleared upstream).
  if (action.kind === "ask_q_role" && onboardingUser.onboardingState === "q_tos_asked") {
    const tosVersion = store.getTosVersion ? await store.getTosVersion() : "v1.0"
    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_role", {
      priorAskedStep: "ask_q_tos",
      priorUserReply: event.body,
      tosAcceptedVersion: tosVersion,
    })
    await sendDirect(input, config.ask_q_role!.prompt[langFor(event.body)])
    store.log("pa.onboarding.deterministic.tos_accepted", {
      userId: event.userId,
      turnId,
      version: tosVersion,
    })
    return { handled: true, action }
  }

  // ToS decline path → record decline, stay at q_tos_asked.
  if (action.kind === "ask_q_tos_decline") {
    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_tos", {
      priorAskedStep: "ask_q_tos",
      priorUserReply: event.body,
      tosDeclined: true,
      suspendedForVent: true, // re-use suspension semantics: state stays
    })
    const phrase = config.ask_q_tos!.declinePrompt![langFor(event.body)]
    await sendDirect(input, phrase)
    store.log("pa.onboarding.deterministic.tos_declined", {
      userId: event.userId,
      turnId,
    })
    return { handled: true, action }
  }

  // ToS unclear → re-ask, stay.
  if (action.kind === "ask_q_tos_reask") {
    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_tos", {
      priorAskedStep: "ask_q_tos",
      priorUserReply: event.body,
      suspendedForVent: true,
    })
    const phrase = config.ask_q_tos!.reaskPrompt![langFor(event.body)]
    await sendDirect(input, phrase)
    return { handled: true, action }
  }

  // Vent / distress mid-onboarding — short ack + state stays.
  if (action.kind === "vent_ack") {
    await sendDirect(input, VENT_ACK[langFor(event.body)])
    store.log("pa.onboarding.deterministic.vent_suspended", {
      userId: event.userId,
      turnId,
      state: onboardingUser.onboardingState,
    })
    return { handled: true, action }
  }

  // wait_for_resume_upload — CV gate, send waitingPrompt, no advance.
  if (action.kind === "wait_for_resume_upload") {
    await sendDirect(input, config.ask_q_resume!.waitingPrompt![langFor(event.body)])
    store.log("pa.onboarding.deterministic.cv_wait", {
      userId: event.userId,
      turnId,
    })
    return { handled: true, action }
  }

  // ask_q_email_verify_retry — wrong code branch (no code parsed).
  if (action.kind === "ask_q_email_verify_retry") {
    await sendDirect(input, config.ask_q_email_verify!.waitingPrompt![langFor(event.body)])
    return { handled: true, action }
  }

  // Standard advance steps (send_first_mes, ask_q_tos, ask_q_yoe, etc.)
  const stepName = action.kind as OnboardingStep
  await store.applyOnboarding(event.userId, onboardingUser.phoneE164, stepName, {
    priorAskedStep: priorAskedStepFromState(onboardingUser.onboardingState),
    priorUserReply: event.body,
  })
  const reply = composeDeterministicReply(action, config, event.body)
  await sendDirect(input, reply)
  return { handled: true, action }
}

/**
 * Internal helper — appendMessage (assistant) + enqueueOutbound. Mirrors
 * the existing sendMemoryReply pattern from index.ts but lives here so
 * the deterministic module is self-contained for testing.
 */
async function sendDirect(
  input: RunDeterministicTurnInput,
  body: string
): Promise<void> {
  if (!body) return
  const at = input.store.nowIso()
  const { event } = input
  await input.store.appendMessage({
    sessionId: event.sessionId,
    userId: event.userId,
    role: "assistant",
    body,
    createdAt: at,
    idempotencyKey: `out-onboarding-${event.id}`,
    rawMeta: {
      source: "pa_orchestrator",
      turnId: input.turnId,
      eventId: event.id,
      onboarding: "deterministic",
    },
  })
  if (input.suppressOutbound) return
  await input.store.enqueueOutbound(event.userId, event.from, body, {
    sessionId: event.sessionId,
    role: "assistant",
    idempotencyKey: `outbound-onboarding-${event.id}`,
  })
}
