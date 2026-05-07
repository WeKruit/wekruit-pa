/**
 * iter35 P7-4 — REWRITTEN deterministic onboarding dispatcher.
 *
 * Adam directive 2026-05-07 ("整体重构 不打补丁"): the legacy 1700-line
 * if/else dispatcher is replaced by:
 *   1. `pipeline.runTurn(ONBOARDING_QUESTIONS_V2, ...)` — handles all the
 *      Q&A turns (lang / email / verify / tos / role / yoe / visa /
 *      startup_pref / country / location / resume).
 *   2. `ResumeDiscussionPhase` — handles the long-running CV ingest:
 *      ack -> state=processing -> mid-process hold -> analysis -> done.
 *
 * The 4 parallel regex paths from the legacy code path
 * (the legacy regex parsers /
 * `extractAnswerIntent` LLM fallback) are GONE. Single resolver
 * (`GuidedOpenJudge` LLM-first + bloom regex) lives inside each Q.
 *
 * What's preserved from the legacy file:
 *   - `OnboardingPrompt` / `OnboardingStepConfig` / `DEFAULT_ONBOARDING_CONFIG`
 *     (used by dashboard `/admin/onboarding-questions` for operator edits)
 *   - `loadOnboardingConfig` + `_resetOnboardingConfigCache`
 *   - `composeInterimResumeAck` (used by `runtime-bridge.ts`)
 *   - `pickLang`, `pickPromptText`, `isV33Disabled`,
 *     `isDeterministicOnboardingEnabled`
 *   - `RunDeterministicTurnInput`, `RunDeterministicTurnResult`,
 *     `DeterministicRunnerStore` types — caller (index.ts) shape unchanged
 *
 * What's deleted (per task spec):
 *   - `resolveDeterministicAction` / `composeDeterministicReply`
 *   - 600+ lines of regex dispatch (4-path fallback chain, probe re-ask,
 *     email-LLM branch, vent-ack branch, etc.) — all subsumed by the
 *     pipeline + DiscussionPhase abstractions.
 *
 * Bug A v2 dedup is preserved: ResumeDiscussionPhase's `onArtifactReceived`
 * is idempotent at the dispatcher layer (state guard) + does not re-fire
 * `sendImmediateAck` when state is already `q_resume_processing` (we route
 * to `onMessageWhileProcessing` instead). That replaces the old
 * `cvWaitPromptLastFiredAt` Firestore-tx gate.
 */
import type { Firestore } from "firebase-admin/firestore"
import type {
  InboundEvent,
  AgentDef,
  OnboardingState,
} from "@pa/core-types"
import type { OnboardingStep } from "./onboarding.js"
import { persistUserTagsFromResumeDiscussionData } from "./tags/persist-user-tags-from-cv-discussion.js"
import { runOnboardingPipelineTurn } from "./onboarding/runtime-bridge.js"
import { ResumeDiscussionPhase } from "./onboarding/discussion-resume.js"
import type { PhaseInput, AsyncResult } from "./onboarding/discussion-phase.js"
import type { ResumeAttachment } from "./onboarding/judges/resume.js"

// ---------------------------------------------------------------
// Config — preserved for dashboard operator editing.
// ---------------------------------------------------------------

/** OnboardingPrompt with optional `mixed` zh+en code-switch field. */
export type OnboardingPrompt = { zh: string; en: string; mixed?: string }

/** Pick the prompt text for the resolved prefLang. */
export function pickPromptText(
  p: OnboardingPrompt,
  lang: "zh" | "en" | "mixed"
): string {
  if (lang === "mixed") return p.mixed ?? p.zh
  return p[lang]
}

export type OnboardingStepConfig = {
  prompt: OnboardingPrompt
  reaskPrompt?: OnboardingPrompt
  reaskPromptVariants?: OnboardingPrompt[]
  declinePrompt?: OnboardingPrompt
  waitingPrompt?: OnboardingPrompt
}

/**
 * Default config — kept verbatim for the dashboard prompt-editor UX.
 * The new pipeline-based dispatcher uses V2 questions in `questions.ts`
 * directly; this config exists only for the operator dashboard read-side.
 */
export const DEFAULT_ONBOARDING_CONFIG: Record<OnboardingStep, OnboardingStepConfig | undefined> = {
  send_first_mes: {
    prompt: {
      zh: "在呢. 今天找你聊点啥?",
      en: "Here. What's on your mind today?",
      mixed: "在呢. today 想聊点啥?",
    },
  },
  ask_grounding_q: undefined,
  ask_q_lang: {
    prompt: {
      zh: "在呢. 用啥语聊比较顺? 中文 / 英文 / 中英混着说都行",
      en: "Here. What language works for you? Chinese / English / both mixed?",
      mixed: "在呢. 用啥 lang 顺手聊? 中文 / English / 中英 mixed 都 OK",
    },
  },
  ask_q_tos: {
    prompt: {
      zh: "开聊前先说一下: 我会记一些咱聊天的事来给你推工作 / 找内推. 隐私 + 用户协议在这: https://wekruit-pa-landing.web.app/legal — 同意就回个 \"同意\" 我们继续",
      en: "before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply \"agree\" if cool with that and we keep going",
      mixed: "开聊前 heads up: 我会记一些 chat 内容来给你 push jobs / 找内推. 隐私 + ToS 在这: https://wekruit-pa-landing.web.app/legal — 同意就回 \"同意\" or \"yes\" 我们继续",
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
      zh: "那你工作身份是? 公民 / 绿卡 / 需要 sponsor (含 OPT/CPT/H1B)",
      en: "what's your work auth? citizen / GC / need sponsorship (incl. OPT/CPT/H1B)",
    },
  },
  ask_q_startup_pref: {
    prompt: {
      zh: "你更想去 startup 那种小而拼的, 还是大厂稳一点?",
      en: "more into startup hustle vibe or stable big-co?",
    },
  },
  ask_q_country: {
    prompt: {
      zh: "主要想找哪个国家/地区的机会? 美国 / 中国 / 加拿大 / 欧洲 / 都行",
      en: "what country or region should I target first? US / China / Canada / Europe / anywhere?",
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
    reaskPrompt: {
      zh: "没看到邮箱地址哎, 直接发个 email 给我就行 (像 you@example.com 这种)",
      en: "didn't catch an email there — just paste the address (like you@example.com)",
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
  send_cv_analysis: {
    prompt: {
      zh: "OK 让我看一下你简历, 等我一下下",
      en: "ok — give me a sec to read your resume",
    },
  },
  complete: undefined,
  skip: undefined,
}

export function isV33Disabled(): boolean {
  const v = (process.env.PA_ONBOARDING_V33_DISABLED ?? "").trim().toLowerCase()
  return v === "true" || v === "1" || v === "yes"
}

// ---------------------------------------------------------------
// Lang detect — kept local for module self-containment.
// ---------------------------------------------------------------
export function pickLang(
  userMessage: string | undefined,
  fallback: "zh" | "en" = "zh",
): "zh" | "en" {
  const raw = userMessage ?? ""
  const stripped = raw
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "")
    .replace(/https?:\/\/\S+/gi, "")
  const text = stripped.replace(/\s+/g, "")
  if (!text) return fallback
  let cjk = 0
  let enLetters = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++
    } else if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    ) {
      enLetters++
    }
  }
  if (cjk === 0 && enLetters === 0) return fallback
  const total = [...text].length
  return cjk / total >= 0.3 ? "zh" : "en"
}

// ---------------------------------------------------------------
// Interim resume ack — used by runtime-bridge.ts DiscussionPhase.
// ---------------------------------------------------------------
const INTERIM_RESUME_ACK_VARIANTS: { zh: string[]; en: string[]; mixed: string[] } = {
  zh: [
    "OK 让我看一下你简历, 等我一下下",
    "稍等啊我快速过一下",
    "嗯 我读一下, 一两分钟的事",
    "好的 我先看看, 完了就给你推",
    "收到, 我扫一眼简历",
    "嗯嗯 给我一两分钟看下",
  ],
  en: [
    "ok lemme take a quick look at your resume, brb",
    "give me a sec to skim through",
    "hold on, reading now — a min or two",
    "alright lemme look at this real quick",
    "got it, scanning your resume now",
    "ok one sec, reading through",
  ],
  mixed: [
    "OK 让我 quick look 一下你简历 — 一两分钟",
    "稍等 lemme skim through",
    "好的 reading now, 完了推几个 jobs 给你",
    "嗯 give me a sec — 看完就来",
    "收到 scanning 一下, 一两分钟",
    "ok 让我 skim 一下简历, brb",
  ],
}

export function composeInterimResumeAck(
  lang: "zh" | "en" | "mixed",
  rng: () => number = Math.random,
): string {
  const pool = INTERIM_RESUME_ACK_VARIANTS[lang]
  const i = Math.floor(rng() * pool.length)
  return pool[i] ?? pool[0]!
}

// ---------------------------------------------------------------
// Firestore config override loader.
// ---------------------------------------------------------------
const CONFIG_CACHE_TTL_MS = 30 * 1000
let cachedConfig: typeof DEFAULT_ONBOARDING_CONFIG | null = null
let cachedAt = 0

export async function loadOnboardingConfig(
  db: Firestore | undefined
): Promise<typeof DEFAULT_ONBOARDING_CONFIG> {
  const now = Date.now()
  if (cachedConfig && now - cachedAt < CONFIG_CACHE_TTL_MS) return cachedConfig
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

export function _resetOnboardingConfigCache() {
  cachedConfig = null
  cachedAt = 0
}

// ---------------------------------------------------------------
// Feature flag.
// ---------------------------------------------------------------
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

// ---------------------------------------------------------------
// Runner types — preserved for caller compat (index.ts).
// ---------------------------------------------------------------

export type DeterministicAction =
  | { kind: "pipeline" }
  | { kind: "resume_artifact" }
  | { kind: "resume_hold" }
  | { kind: "resume_complete" }
  | { kind: "skip" }

export type DeterministicTurnInput = {
  onboardingState: OnboardingState | undefined
  cvParsed: boolean
  emailVerified: boolean
  emailCaptured: boolean
}

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
  generateCvAnalysis?(
    userId: string,
    lang: "zh" | "en"
  ): Promise<{ summary: string } | null>
  generateJobRecs?(
    userId: string,
    lang: "zh" | "en"
  ): Promise<{ message: string; recCount: number } | null>
  extractEmailIntent?(
    reply: string,
    lang: "zh" | "en"
  ): Promise<
    | { intent: "provided"; email: string; confidence: number }
    | { intent: "typo"; suggestion: string; original: string }
    | { intent: "declined" }
    | { intent: "unclear"; clarifyingQuestion: string }
    | null
  >
  extractAnswerIntent?(
    step:
      | "ask_q_role"
      | "ask_q_yoe"
      | "ask_q_visa"
      | "ask_q_startup_pref"
      | "ask_q_location",
    reply: string,
    lang: "zh" | "en"
  ): Promise<
    | { intent: "provided"; value: string | number; confidence: number }
    | { intent: "unclear"; clarifyingQuestion: string }
    | null
  >
  log(event: string, payload?: Record<string, unknown>): void
  nowIso(): string
  db?: Firestore
  getOnboardingUser?(userId: string): Promise<{
    id: string
    phoneE164: string
    onboardingState?: OnboardingState
    statedPreferences?: { preferredLang?: "zh" | "en" | "mixed" }
    [k: string]: unknown
  } | null>
}

export type RunDeterministicTurnInput = {
  event: InboundEvent
  store: DeterministicRunnerStore
  langOverride?: "zh" | "en"
  turnId: string
  onboardingUser: {
    id: string
    phoneE164: string
    onboardingState?: OnboardingState
    pipelineState?: { currentQId?: string | null }
    statedPreferences?: {
      contactEmail?: string
      contactEmailVerifiedAt?: string
      preferredLang?: "zh" | "en" | "mixed"
      targetRole?: string[]
      yoeRange?: [number, number] | null
      visaStatus?: string
      prefersStartup?: boolean | null
      targetLocations?: string[]
    }
  }
  cvParsed: boolean
  agent: AgentDef
  suppressOutbound?: boolean
}

export type RunDeterministicTurnResult =
  | { handled: true; action: DeterministicAction }
  | { handled: false }

// ---------------------------------------------------------------
// Resume DiscussionPhase wiring helpers
// ---------------------------------------------------------------

interface CvParsedSyntheticPayload {
  kind: "cv-parsed"
  ok?: boolean
  data?: unknown
  error?: string
}

function detectCvParsedEvent(event: InboundEvent): CvParsedSyntheticPayload | null {
  if (!event.body || !event.body.startsWith("[cv-parsed]")) return null
  const meta = (event.rawMeta ?? {}) as Record<string, unknown>
  const raw = meta.cvParsedResult ?? meta.cvParsed ?? null
  if (raw && typeof raw === "object") {
    const r = raw as { ok?: boolean; data?: unknown; error?: string }
    return { kind: "cv-parsed", ok: r.ok, data: r.data, error: r.error }
  }
  return { kind: "cv-parsed", ok: true, data: meta }
}

function hasAttachment(event: InboundEvent): boolean {
  const meta = (event.rawMeta ?? {}) as Record<string, unknown>
  if (Array.isArray(meta.attachments) && meta.attachments.length > 0) return true
  if (typeof meta.attachmentUrl === "string" && meta.attachmentUrl) return true
  if (Array.isArray(meta.attachmentUrls) && meta.attachmentUrls.length > 0) return true
  if (typeof meta.mediaUrl === "string" && meta.mediaUrl) return true
  return false
}

function resolveLang(input: RunDeterministicTurnInput): "zh" | "en" {
  if (input.langOverride) return input.langOverride
  const pref = input.onboardingUser.statedPreferences?.preferredLang
  if (pref === "zh" || pref === "en") return pref
  if (pref === "mixed") return "zh"
  return pickLang(input.event.body, "zh")
}

function buildResumePhase(input: RunDeterministicTurnInput): ResumeDiscussionPhase {
  const { event, store, turnId, suppressOutbound, onboardingUser } = input

  return new ResumeDiscussionPhase({
    send: async (_phaseInput, text) => {
      if (!text) return
      const at = store.nowIso()
      await store.appendMessage({
        sessionId: event.sessionId,
        userId: event.userId,
        role: "assistant",
        body: text,
        createdAt: at,
        idempotencyKey: `out-resume-discussion-${event.id}`,
        rawMeta: {
          source: "pa_orchestrator",
          turnId,
          eventId: event.id,
          onboarding: "discussion_resume",
        },
      })
      if (suppressOutbound) return
      await store.enqueueOutbound(event.userId, event.from, text, {
        sessionId: event.sessionId,
        role: "assistant",
        idempotencyKey: `outbound-resume-discussion-${event.id}`,
      })
    },

    kickoffCvIngest: async (_phaseInput) => {
      try {
        await store.applyOnboarding(
          event.userId,
          onboardingUser.phoneE164,
          "ask_q_resume",
          {
            priorAskedStep: "ask_q_resume",
            priorUserReply: event.body,
          }
        )
      } catch (err) {
        store.log("pa.onboarding.discussion.kickoff_error", {
          userId: event.userId,
          turnId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },

    writeUserTagsFromCv: async (userId, parsed, _db) => {
      const db = store.db as Firestore | undefined
      if (!db) {
        store.log("pa.onboarding.discussion.tags_skip", { userId, reason: "no_db" })
        return
      }
      await persistUserTagsFromResumeDiscussionData(db, userId, parsed, (e, p) =>
        store.log(e, p as Record<string, unknown> | undefined)
      )
    },

    composeCvAnalysis: async (_phaseInput, _parsed) => {
      const lang = resolveLang(input)
      try {
        if (store.generateCvAnalysis) {
          const result = await store.generateCvAnalysis(event.userId, lang)
          if (result?.summary && result.summary.trim().length > 0) {
            return result.summary.trim()
          }
        }
      } catch (err) {
        store.log("pa.onboarding.discussion.compose_analysis_error", {
          userId: event.userId,
          turnId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return lang === "zh"
        ? "看下来你背景挺扎实的, 后面给你推岗位会贴着你的方向来"
        : "skimmed it — solid background, i'll lean recommendations toward your trajectory"
    },

    setOnboardingState: async (userId, state, _db) => {
      try {
        if (state === "q_resume_processing") {
          if (store.db) {
            await store.db
              .collection("pa-users")
              .doc(userId)
              .set(
                { onboardingState: "q_resume_processing", updatedAt: store.nowIso() },
                { merge: true }
              )
          }
        } else if (state === "q_resume_done") {
          if (store.db) {
            await store.db
              .collection("pa-users")
              .doc(userId)
              .set(
                { onboardingState: "q_resume_done", updatedAt: store.nowIso() },
                { merge: true }
              )
          }
        } else {
          await store.applyOnboarding(
            userId,
            onboardingUser.phoneE164,
            "complete",
            {}
          )
        }
      } catch (err) {
        store.log("pa.onboarding.discussion.set_state_error", {
          userId,
          turnId,
          state,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  })
}

function buildPhaseInput(input: RunDeterministicTurnInput): PhaseInput {
  return {
    userId: input.event.userId,
    turnId: input.turnId,
    rawPayload: input.event.rawMeta,
    userMessage: input.event.body,
    lang: resolveLang(input),
    db: input.store.db,
    log: (event, payload) => input.store.log(event, payload),
  }
}

// ---------------------------------------------------------------
// Main dispatcher — REWRITTEN.
//
// Adam directive 2026-05-07: replace 1700-line if/else with
// `pipeline.runTurn(QUESTIONS_V2, ...)` + DiscussionPhase routes.
// ---------------------------------------------------------------

/**
 * iter35 P7-4 — single-entry dispatcher. Replaces the legacy 1700-line
 * if/else dispatcher with explicit routes:
 *
 *   1. state=q_resume_processing + text msg     -> phase.onMessageWhileProcessing
 *   2. state=q_resume_processing + attachment   -> phase.onArtifactReceived (re-arrival)
 *   3. state=q_resume_asked + attachment present -> phase.onArtifactReceived
 *   4. synthetic [cv-parsed] event              -> phase.onWorkComplete
 *   5. otherwise                                 -> pipeline.runTurn(QUESTIONS_V2)
 *
 * Bug A v2 dedup: re-routing at q_resume_processing means a second
 * attachment / hold msg never re-fires `sendImmediateAck`. The legacy
 * `cvWaitPromptLastFiredAt` Firestore-tx is no longer needed because
 * the state guard supersedes it.
 */
export async function runDeterministicOnboardingTurn(
  input: RunDeterministicTurnInput
): Promise<RunDeterministicTurnResult> {
  const { event, store, turnId, onboardingUser } = input
  const state = onboardingUser.onboardingState

  store.log("pa.onboarding.deterministic.dispatch", {
    userId: event.userId,
    turnId,
    eventId: event.id,
    state,
    hasAttachment: hasAttachment(event),
    isCvParsed: !!detectCvParsedEvent(event),
  })

  // Route 4 — synthetic cv-parsed event from cv-ingest worker / E2E.
  // MUST run before the state===complete early-return: production can mark
  // onboardingState complete slightly ahead of (or race with) pipeline
  // cursor; index.ts also dispatches [cv-parsed] when state is complete so
  // this path still emits the resume-reading ack + analysis + recs.
  const cvParsedEvent = detectCvParsedEvent(event)
  if (cvParsedEvent) {
    const phase = buildResumePhase(input)
    const phaseInput = buildPhaseInput(input)
    const pip = onboardingUser.pipelineState
    const meta = (event.rawMeta ?? {}) as { cvParsedTrigger?: boolean }
    const isCvParsedTrigger = meta.cvParsedTrigger === true
    const atResumeGate = state === "q_resume_asked" || pip?.currentQId === "q_resume"
    // PDF path: onArtifactReceived already sent immediate ack while state moved
    // to q_resume_processing — do not double-ack. Synthetic/E2E: worker sets
    // cvParsedTrigger; user never got PDF ack — always pre-ack unless processing.
    const skipPreAck = state === "q_resume_processing"
    const shouldPreAck =
      !skipPreAck && (isCvParsedTrigger || atResumeGate)
    if (shouldPreAck) {
      await phase.sendAckBeforeSyntheticComplete(phaseInput)
    }
    const result: AsyncResult = cvParsedEvent.ok === false
      ? { ok: false, error: cvParsedEvent.error ?? "cv-ingest failed" }
      : { ok: true, data: cvParsedEvent.data }
    await phase.onWorkComplete(phaseInput, result)

    // 2026-05-07 e2e iter35 fix — after analysis sent + state=complete,
    // fire job-rec generation. Legacy send_cv_analysis chained these;
    // the new DiscussionPhase pattern handles ack/analysis but needs
    // explicit rec hook here so downstream matching pipeline triggers.
    if (cvParsedEvent.ok !== false && store.generateJobRecs) {
      try {
        const recLang = resolveLang(input)
        const recResult = await store.generateJobRecs(event.userId, recLang)
        if (recResult?.message && recResult.message.trim().length > 0) {
          const at = store.nowIso()
          await store.appendMessage({
            sessionId: event.sessionId,
            userId: event.userId,
            role: "assistant",
            body: recResult.message,
            createdAt: at,
            idempotencyKey: `out-resume-recs-${event.id}`,
            rawMeta: {
              source: "pa_orchestrator",
              turnId,
              eventId: event.id,
              onboarding: "discussion_resume_recs",
            },
          })
          if (!input.suppressOutbound) {
            await store.enqueueOutbound(event.userId, event.from, recResult.message, {
              sessionId: event.sessionId,
              role: "assistant",
              idempotencyKey: `outbound-resume-recs-${event.id}`,
            })
          }
          store.log("pa.onboarding.discussion.rec_emit", {
            userId: event.userId,
            turnId,
            recCount: recResult.recCount,
          })
        }
      } catch (err) {
        store.log("pa.onboarding.discussion.rec_emit_error", {
          userId: event.userId,
          turnId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return { handled: true, action: { kind: "resume_complete" } }
  }

  // Once onboarding is fully complete, hand off to agent runtime.
  if (state === "complete") return { handled: false }

  // Route 1 — text msg while processing -> "wait" hold (Bug A regression
  // check: never re-fires sendImmediateAck).
  if (state === "q_resume_processing" && !hasAttachment(event)) {
    const phase = buildResumePhase(input)
    await phase.onMessageWhileProcessing(buildPhaseInput(input))
    return { handled: true, action: { kind: "resume_hold" } }
  }

  // Route 2 — second attachment while processing -> re-kickoff.
  if (state === "q_resume_processing" && hasAttachment(event)) {
    const phase = buildResumePhase(input)
    await phase.onArtifactReceived(buildPhaseInput(input))
    return { handled: true, action: { kind: "resume_artifact" } }
  }

  // Route 3 — first attachment at q_resume_asked.
  if (state === "q_resume_asked" && hasAttachment(event)) {
    const phase = buildResumePhase(input)
    await phase.onArtifactReceived(buildPhaseInput(input))
    return { handled: true, action: { kind: "resume_artifact" } }
  }

  // Route 5 — pipeline handles the rest.
  const pipelineResult = await runOnboardingPipelineTurn({
    event,
    turnId,
    agent: input.agent,
    suppressOutbound: input.suppressOutbound ?? false,
    deps: {
      appendMessage: (args) => store.appendMessage(args),
      enqueueOutbound: (uid, to, body, opts) =>
        store.enqueueOutbound(uid, to, body, opts),
      applyOnboarding: (uid, phone, step, opts) =>
        store.applyOnboarding(uid, phone, step as OnboardingStep, opts),
      ...(store.getOnboardingUser
        ? { getOnboardingUser: (uid: string) => store.getOnboardingUser!(uid) }
        : {}),
      ...(store.extractEmailIntent
        ? { extractEmailIntent: store.extractEmailIntent }
        : {}),
      ...(store.sendVerificationEmail
        ? { sendVerificationEmail: store.sendVerificationEmail }
        : {}),
      nowIso: () => store.nowIso(),
      log: (event2, payload) => store.log(event2, payload),
      db: store.db,
    },
  })

  if (pipelineResult.handled) {
    return { handled: true, action: { kind: "pipeline" } }
  }
  return { handled: false }
}

/**
 * Type re-export for downstream callers that need to inspect resume artifacts.
 */
export type { ResumeAttachment }
