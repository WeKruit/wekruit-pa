/**
 * iter35 P7-4 — REWRITTEN deterministic onboarding dispatcher.
 *
 * Adam directive 2026-05-07 ("full rewrite, no patching"): the legacy 1700-line
 * if/else dispatcher is replaced by:
 *   1. `pipeline.runTurn(ONBOARDING_QUESTIONS_V2, ...)` — handles all the
 *      Q&A turns (tos / role / yoe / visa /
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
 *   - `pickLang`, `pickPromptText`, `isV33Disabled`
 *   - `RunDeterministicTurnInput`, `RunDeterministicTurnResult`,
 *     `DeterministicRunnerStore` types — caller (index.ts) shape unchanged
 *
 * What's deleted (per task spec):
 *   - `resolveDeterministicAction` / `composeDeterministicReply`
 *   - 600+ lines of regex dispatch (4-path fallback chain, probe re-ask,
 *     vent-ack branch, etc.) — all subsumed by the
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
import { runCrisisHotlineGuard } from "./safety/crisis-guard-runner.js"
import { normalizeForIMessage } from "./output-normalizer.js"

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
      zh: "Here. What's on your mind today?",
      en: "Here. What's on your mind today?",
      mixed: "Here. What's on your mind today?",
    },
  },
  ask_grounding_q: undefined,
  ask_q_lang: undefined,
  ask_q_tos: {
    prompt: {
      zh: "before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply \"agree\" if cool with that and we keep going",
      en: "before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply \"agree\" if cool with that and we keep going",
      mixed: "totally ok — i won't store chat memory if you'd rather not. happy to keep chatting either way. lmk if you change your mind",
    },
    declinePrompt: {
      zh: "totally ok — i won't store chat memory if you'd rather not. happy to keep chatting either way. lmk if you change your mind",
      en: "totally ok — i won't store chat memory if you'd rather not. happy to keep chatting either way. lmk if you change your mind",
    },
    reaskPrompt: {
      zh: "just need a quick \"agree\" on the privacy + terms above — or \"no\" and we can chat without me saving anything",
      en: "just need a quick \"agree\" on the privacy + terms above — or \"no\" and we can chat without me saving anything",
    },
  },
  ask_q_role: {
    prompt: {
      zh: "btw — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
      en: "btw — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
    },
  },
  ask_q_yoe: {
    prompt: {
      zh: "how many years have you been working? New grad is fine too.",
      en: "how many years have you been working? New grad is fine too.",
    },
  },
  ask_q_visa: {
    prompt: {
      zh: "what's your work auth? citizen / GC / need sponsorship (incl. OPT/CPT/H1B)",
      en: "what's your work auth? citizen / GC / need sponsorship (incl. OPT/CPT/H1B)",
    },
  },
  ask_q_startup_pref: {
    prompt: {
      zh: "do you prefer startups, bigger-company stability, or are you flexible?",
      en: "do you prefer startups, bigger-company stability, or are you flexible?",
    },
  },
  ask_q_country: {
    prompt: {
      zh: "what country or region should I target first? US / China / Canada / Europe / anywhere?",
      en: "what country or region should I target first? US / China / Canada / Europe / anywhere?",
    },
  },
  ask_q_location: {
    prompt: {
      zh: "where you wanna be? SF / NYC / remote ok?",
      en: "where you wanna be? SF / NYC / remote ok?",
    },
  },
  ask_q_resume: {
    prompt: {
      zh: "btw — can you send me your resume? makes JD review and referrals way more on-point",
      en: "btw — can you send me your resume? makes JD review and referrals way more on-point",
    },
    waitingPrompt: {
      zh: "just waiting on the resume — send it as an iMessage attachment whenever",
      en: "just waiting on the resume — send it as an iMessage attachment whenever",
    },
  },
  send_cv_analysis: {
    prompt: {
      zh: "ok — give me a sec to read your resume",
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
  _userMessage: string | undefined,
  _fallback: "zh" | "en" = "en",
): "zh" | "en" {
  // Product is English-only — onboarding output language is always English.
  return "en"
}

// ---------------------------------------------------------------
// Interim resume ack — used by runtime-bridge.ts DiscussionPhase.
// ---------------------------------------------------------------
const INTERIM_RESUME_ACK_VARIANTS: { zh: string[]; en: string[]; mixed: string[] } = {
  zh: [
    "ok lemme take a quick look at your resume, brb",
    "give me a sec to skim through",
    "hold on, reading now — a min or two",
    "alright lemme look at this real quick",
    "got it, scanning your resume now",
    "ok one sec, reading through",
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
    "ok lemme take a quick look at your resume, brb",
    "give me a sec to skim through",
    "hold on, reading now — a min or two",
    "alright lemme look at this real quick",
    "got it, scanning your resume now",
    "ok one sec, reading through",
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
  generateCvAnalysis?(
    userId: string,
    lang: "zh" | "en"
  ): Promise<{ summary: string } | null>
  generateJobRecs?(
    userId: string,
    lang: "zh" | "en"
  ): Promise<{ message: string; recCount: number } | null>
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

function resolveLang(_input: RunDeterministicTurnInput): "zh" | "en" {
  // Product is English-only — onboarding output language is always English.
  return "en"
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
      return "skimmed it — solid background, i'll lean recommendations toward your trajectory"
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

async function sendRuntimeOnboardingReply(
  input: RunDeterministicTurnInput,
  body: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const { event, store, turnId } = input
  const { text } = normalizeForIMessage(body, { maxLength: 600 })
  await store.appendMessage({
    sessionId: event.sessionId,
    userId: event.userId,
    role: "assistant",
    body: text,
    createdAt: store.nowIso(),
    idempotencyKey: `out-onboarding-runtime-${event.id}-${String(meta.kind ?? "reply")}`,
    rawMeta: {
      source: "pa_orchestrator",
      turnId,
      eventId: event.id,
      onboarding: "runtime",
      ...meta,
    },
  })
  if (input.suppressOutbound) return
  await store.enqueueOutbound(event.userId, event.from, text, {
    sessionId: event.sessionId,
    role: "assistant",
    idempotencyKey: `outbound-onboarding-runtime-${event.id}-${String(meta.kind ?? "reply")}`,
  })
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

  const crisisBaseReply = "I hear you. Before anything job-related, let's make sure you're safe right now."
  const crisisGuard = await runCrisisHotlineGuard({
    store,
    event,
    turnId,
    userInput: event.body,
    reply: crisisBaseReply,
    callSite: "onboarding",
  })
  if (crisisGuard.detected) {
    await sendRuntimeOnboardingReply(input, crisisGuard.reply, {
      kind: "crisis_guard",
      detected: crisisGuard.detected,
      injected: crisisGuard.injected,
    })
    return { handled: true, action: { kind: "pipeline" } }
  }

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
