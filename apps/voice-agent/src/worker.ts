/**
 * v2.1 S2 — LiveKit Agents worker bootstrap.
 *
 * Why a thin wrapper:
 *   - The voice worker depends on `@livekit/agents` (Node SDK), Deepgram,
 *     Silero, and the OpenAI plugin pointing at the shim. Installing those
 *     for unit tests bloats CI; we keep the SDK import here behind a lazy
 *     dynamic-import so `cli.ts --help` and the unit test suite stay green
 *     without a network install of the LiveKit SDK on the test runner.
 *   - Production (LiveKit Cloud managed agent hosting, L12) provides the
 *     SDK at runtime per `livekit.toml`.
 *
 * Wire diagram (production):
 *   LiveKit room (dispatched by S3 with `bookingId` in metadata)
 *     ↓
 *   defineAgent → entry(ctx)
 *     ↓
 *   parse bookingId from ctx.room.metadata
 *     ↓
 *   loadVoiceContext(bookingId)  ← S1B context loaders
 *     ↓
 *   new AgentSession({
 *     vad: silero.VAD.load(),
 *     turnDetection: new MultilingualModel(),   // adaptive endpointing (Lock L7)
 *     stt: deepgram.STT({ model: "nova-3" }),
 *     llm: new WekruitLLM(),                    // W2 — in-process bridge to
 *                                                //  @pa/agent-runtime.runAgentTurnStream
 *     tts: deepgram.TTS({ model: "aura-2" }),
 *   })
 *     ↓
 *   registerEventHandlers(session, room, sinks)   ← L7
 *     ↓
 *   session.start({ agent, room })
 *     ↓
 *   session.say(buildConsentPrompt(ctx))           ← L8
 */

import { type VoicePipelineLite } from "./turn-loop.js"
import {
  registerEventHandlers,
  type RegisterSinks,
} from "./event-handlers.js"
import { buildConsentPrompt } from "./consent-prompt.js"
import { emitConsentSpokenAudit } from "./consent-audit.js"
import { startRecordingEgress } from "./egress.js"
import type { VoiceCallContext, VoicePrescreenCallContext } from "./voice-context-types.js"
import { WekruitLLM } from "./wekruit-llm.js"

/**
 * W2: production env requirements after the WekruitLLM swap. Note the
 * absence of `WEKRUIT_LLM_SHIM_URL` — the in-process WekruitLLM speaks
 * directly to OpenAI via runAgentTurnStream, so the shim service is no
 * longer required. `OPENAI_API_KEY` IS required (runAgentTurnStream's
 * `assertProviderKey` checks at first call); we leave it implicit here
 * because @pa/agent-runtime owns the assertion and a missing key throws
 * an actionable error from there.
 */
export const REQUIRED_PROD_ENV = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "DEEPGRAM_API_KEY",
] as const

/** Default factory for the LK LLM. Test seam: `opts.buildLLM` overrides. */
export function buildDefaultLLM(): WekruitLLM {
  return new WekruitLLM()
}

export interface StartWorkerOpts {
  /** Test seam — supply an alternative `defineAgent` impl. */
  defineAgent?: (def: { entry: (ctx: AgentRuntimeCtx) => Promise<void> }) => unknown
  /** Test seam — supply pre-loaded context (skips Firestore reads). */
  loadContext?: (bookingId: string) => Promise<VoiceCallContext>
  /** Test seam — pipeline factory. */
  buildPipeline?: (context: VoiceCallContext) => Promise<VoicePipelineLite>
  /** Test seam — LLM factory. Defaults to `buildDefaultLLM` (WekruitLLM). */
  buildLLM?: () => WekruitLLM
  /** Optional logger. */
  log?: (event: string, payload: Record<string, unknown>) => void
}

interface AgentRuntimeCtx {
  room: {
    name?: string
    metadata?: string
    remoteParticipants?: Map<string, RemoteParticipantLike>
    on: (event: string, listener: (...args: unknown[]) => void) => unknown
    off?: (event: string, listener: (...args: unknown[]) => void) => unknown
  }
  /** LK job-info struct — `ctx.job.room.{name,metadata}` is the dispatch-
   * time room reference. Available BEFORE the agent connects to the room
   * (used by LK internals for inference routing). Our `ctx.room.{name,
   * metadata}` are the Room instance which is empty pre-connect. */
  job?: {
    room?: {
      name?: string
      metadata?: string
    }
  }
  /** LK JobContext.connect — attaches the agent process to the dispatched
   * room. MUST be awaited before AgentSession.start, otherwise the
   * session's room operations fail with WS 400 ("Unexpected server
   * response: 400") and no audio reaches the SIP leg. */
  connect?: () => Promise<void>
}

interface RemoteParticipantLike {
  identity?: string
}

/**
 * Production entry. Lazy-imports `@livekit/agents` + plugins so the file
 * itself is safe to load in unit tests (the heavy imports happen inside
 * `start()`).
 *
 * `defineAgent` here is the LiveKit-side primitive that registers our
 * worker with the managed agent host. We expose a thin overridable hook
 * for tests.
 */
export async function startWorker(opts: StartWorkerOpts = {}): Promise<void> {
  const log = opts.log ?? ((event, payload) => {
    console.log(`[voice-agent] ${event}`, payload)
  })

  // ── Validate env (fail fast in prod; tests inject `defineAgent`) ────────
  if (!opts.defineAgent) {
    requireEnv([...REQUIRED_PROD_ENV])
  }

  // S1A flag-flip — voice bridge always streams via the shim when the
  // shim is in `orchestrator` mode. The variable is read at call time by
  // `runAgentTurnStream`, so we set it here at worker start.
  if (!process.env.PA_AGENT_RUNTIME_STREAM_ENABLED) {
    process.env.PA_AGENT_RUNTIME_STREAM_ENABLED = "true"
  }

  // Lazy-import the LiveKit SDK only when we're booting for real.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let livekitMod: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sileroMod: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deepgramMod: any

  if (!opts.defineAgent) {
    livekitMod = await import("@livekit/agents")
    sileroMod = await import("@livekit/agents-plugin-silero")
    deepgramMod = await import("@livekit/agents-plugin-deepgram")
    // W2: openai plugin no longer needed — WekruitLLM bridges directly to
    // runAgentTurnStream. W3 will remove the dep from package.json.
  }

  const defineAgent =
    opts.defineAgent ??
    ((def: { entry: (ctx: AgentRuntimeCtx) => Promise<void> }) =>
      livekitMod.defineAgent(def))

  const loadContext = opts.loadContext ?? defaultLoadContext

  // ── The actual LiveKit Agent definition ─────────────────────────────────
  const agent = defineAgent({
    entry: async (ctx: AgentRuntimeCtx) => {
      // Dispatch-time room info lives on `ctx.job.room` (proto JobInfo);
      // `ctx.room` is the rtc-node Room instance which is empty until
      // `connect()`. Read both, prefer ctx.job.room.
      const dispatchRoomName = ctx.job?.room?.name ?? ctx.room.name
      const dispatchRoomMetadata = ctx.job?.room?.metadata ?? ctx.room.metadata
      const bookingId = readBookingId(dispatchRoomMetadata, dispatchRoomName)
      log("voice.worker.entry", { bookingId })

      // LK v1.4.2: JobContext.connect() attaches the agent process to the
      // dispatched room. MUST be called before AgentSession.start —
      // otherwise the session's room ops fail WS 400 (no audio reaches
      // the SIP candidate leg). LK doc: "run this command as early in the
      // function as possible".
      if (typeof ctx.connect === "function") {
        try {
          await ctx.connect()
          log("voice.worker.room_connected", { bookingId })
        } catch (err) {
          log("voice.worker.room_connect_failed", {
            bookingId,
            error: err instanceof Error ? err.message : String(err),
          })
          throw err
        }
      }

      const callContext = await loadContext(bookingId)
      if (callContext.purpose === "prescreen" && callContext.jobBrief.dead === true) {
        log("voice.worker.dead_job_abort", {
          bookingId,
          jobId: callContext.jobBrief.jobId,
        })
        return
      }

      const pipeline = opts.buildPipeline
        ? await opts.buildPipeline(callContext)
        : await defaultBuildPipeline(callContext)

      // ── Build AgentSession via SDK ───────────────────────────────────────
      // Adaptive turn detection — MultilingualModel from the LiveKit SDK
      // owns endpointing decisions internally. We DO NOT pass a numeric
      // endpointing delay anywhere; the adaptive model is the policy.
      // (Lock L7 anti-hardcode; see __tests__/no-min-endpointing.test.ts.)
      // Deferred terminal closer — set after the session exists so the pipeline
      // adapter's onPipelineTerminal can end the call once the final line plays.
      let closeForTerminal: () => Promise<void> = async () => {}
      const lang = callContext.userProfile.preferredLang ?? "en"
      const pipelineSessionId =
        callContext.purpose === "prescreen" ? callContext.prescreenSessionId : callContext.bookingId

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let session: any
      if (!opts.defineAgent) {
        const { voice, inference } = livekitMod
        const vad = await sileroMod.VAD.load()
        // P1 turn detector (Adam 2026-06-19): prefer the contextual end-of-utterance
        // model over plain VAD endpointing. Defensive — fall back to 'vad' if the
        // installed SDK doesn't expose inference.TurnDetector (no tsc safety here;
        // livekitMod is any). Silero VAD stays loaded for interruption handling.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let turnDetection: any = "vad"
        try {
          if (inference && typeof inference.TurnDetector === "function") {
            turnDetection = new inference.TurnDetector()
            log("voice.worker.turn_detector", { bookingId, mode: "inference" })
          }
        } catch (err) {
          turnDetection = "vad"
          log("voice.worker.turn_detector_fallback_vad", {
            bookingId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        const stt = new deepgramMod.STT({ model: "nova-3" })
        // Deepgram TTS model slug must be a concrete voice (aura-1) — passing
        // the bare family name "aura-2" returns WS handshake 400 from
        // Deepgram, which AgentSession surfaces as `voice.error: 'Unexpected
        // server response: 400'` and immediately tears the session down
        // (no audio reaches the SIP candidate leg).
        const tts = new deepgramMod.TTS({ model: "aura-asteria-en" })
        // P0 single-brain (Adam 2026-06-19): WekruitLLM in PIPELINE-ADAPTER mode is
        // the SOLE in-call brain — every spoken line is the real prescreen/onboarding
        // pipeline output (runPrescreenTurn + KeywordSet judge + clarify composer).
        // No generic free-styling, no `session.say` side-channel (the dueling-brain
        // bug that produced repeated "that helps" filler over the real questions).
        const llm = opts.buildLLM
          ? opts.buildLLM()
          : new WekruitLLM({
              pipelineMode: {
                voicePipeline: pipeline,
                sessionId: pipelineSessionId,
                userId: callContext.userProfile.userId,
                lang,
                redactProfile: callContext.userProfile,
                onPipelineTerminal: async () => {
                  await closeForTerminal()
                },
              },
            })
        void inference
        session = new voice.AgentSession({ vad, turnDetection, stt, llm, tts })
      } else {
        // Test path: callers provide their own session via global hook
        // when overriding defineAgent. The default test-seam doesn't need
        // a real session.
        session = (globalThis as Record<string, unknown>).__voiceAgentTestSession ?? {
          on: () => {},
          off: () => {},
          say: async (_text: string) => {},
          start: async () => {},
        }
      }
      closeForTerminal = async () => {
        try {
          await session.aclose?.()
        } catch (err) {
          log("voice.worker.terminal_close_failed", {
            bookingId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // ── Wire 7 event handlers (L7) ───────────────────────────────────────
      const sinks: RegisterSinks = {
        log,
        onUserSpeechCommitted({ transcript }) {
          // P0: the pipeline adapter (WekruitLLM pipelineMode) now OWNS the reply,
          // PII redaction, and terminal close — the AgentSession runs the pipeline
          // automatically on each user turn. This sink is observability only; calling
          // the pipeline here would double-score the turn.
          log("voice.worker.user_speech_committed", {
            bookingId,
            purpose: callContext.purpose,
            chars: transcript.length,
          })
        },
        onConversationItemAdded(p) {
          log("voice.conversation_item_added", { role: p.role, len: p.textContent.length })
        },
        onAgentFalseInterruption(p) {
          log("voice.agent_false_interruption", { resumed: p.resumed })
        },
        onParticipantDisconnected(p) {
          log("voice.participant_disconnected", { identity: p.identity ?? "" })
        },
        onError(p) {
          log("voice.error", {
            message: p.message ?? p.error?.message ?? "unknown",
          })
        },
        onSessionUsageUpdated(p) {
          log("voice.session_usage_updated", {
            modelUsageCount: p.modelUsage.length,
          })
        },
        onClose(p) {
          log("voice.close", { reason: p.reason ?? "" })
        },
        shutdown: async () => {
          log("voice.shutdown", { bookingId })
          try {
            await session.aclose?.()
          } catch {
            // best effort
          }
        },
      }

      registerEventHandlers(session, ctx.room as never, sinks)

      // ── Start the session ────────────────────────────────────────────────
      // LK v1.4.2: AgentSession.start({ agent, room }) requires a
      // `voice.Agent` with instructions, NOT the worker-level defineAgent
      // return. The worker `agent` registered the entry-point with LK
      // dispatch; the per-call conversational entity is a separate Agent
      // instance constructed here with Claire's persona.
      let conversationalAgent: unknown = agent
      if (!opts.defineAgent) {
        const { voice } = livekitMod
        conversationalAgent = new voice.Agent({
          instructions:
            callContext.purpose === "onboarding"
              ? "You are Claire, WeKruit's voice onboarding agent. Your job is to ask the short onboarding questions needed to understand the candidate. Speak warmly and concisely. Stay on the onboarding flow and do not recommend jobs during this call."
              : "You are Claire, WeKruit's voice prescreen recruiter. Your job is to conduct a short structured prescreen for the candidate. Speak warmly and concisely. Begin by greeting the candidate, then ask the prescreen questions you've been given. Stay strictly on the prescreen plan — do not free-style about unrelated topics.",
          // "WeKruit" → "We-Cruit" (we + cruit as in re-cruit). Without the
          // remap, Deepgram aura pronounces the brand as a single mushed
          // syllable. Map applies before TTS synthesis to every variant.
          ttsPronunciationMap: {
            WeKruit: "We-Cruit",
            Wekruit: "We-Cruit",
            wekruit: "we-cruit",
            WEKRUIT: "We-Cruit",
          },
        })
      }
      const candidateParticipantIdentity = `candidate-${callContext.userProfile.userId}`
      await session.start?.({
        agent: conversationalAgent,
        room: ctx.room,
        inputOptions: { participantIdentity: candidateParticipantIdentity },
      })

      // ── S6 recording archive — kick off LiveKit Egress → GCS ─────────────
      // Fires-and-forgets behind WEKRUIT_VOICE_RECORDINGS_BUCKET env. Any
      // failure (missing bucket, missing GCP creds, transient API error)
      // is caught inside startRecordingEgress; the call continues either
      // way. Per L12 we never self-host — egress is LK Cloud managed.
      // P1 latency (Adam 2026-06-19): fire-and-forget so egress setup never blocks
      // time-to-first-speech. Any failure is caught inside startRecordingEgress and
      // logged here; the call proceeds regardless.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const egressRoomName = (ctx.room as any).name ?? bookingId
      void startRecordingEgress({ roomName: egressRoomName, bookingId }, { log }).catch((err) => {
        log("voice.egress.unexpected", {
          error: err instanceof Error ? err.message : String(err),
        })
      })

      // ── L8 recording consent — first utterance ──────────────────────────
      // P1 latency: greet as soon as ANY remote (SIP) participant connects; don't
      // burn up to 15s matching an exact identity the SIP leg may not set.
      const readyParticipant = await waitForRemoteParticipant(ctx.room, {
        timeoutMs: 5_000,
      })
      if (readyParticipant) {
        log("voice.worker.remote_participant_ready", {
          bookingId,
          identity: readyParticipant.identity ?? "",
        })
      } else {
        log("voice.worker.remote_participant_wait_timeout", {
          bookingId,
          identity: candidateParticipantIdentity,
        })
      }
      const consentLine = buildConsentPrompt(callContext)
      try {
        const speechHandle = session.say?.(consentLine, {
          allowInterruptions: false,
          addToChatCtx: false,
        })
        log("voice.consent_prompt_scheduled", {
          bookingId,
          lang: callContext.userProfile.preferredLang ?? "en",
        })
        await waitForSpeechPlayout(speechHandle, { timeoutMs: 12_000 })
        log("voice.consent_prompt_spoken", { bookingId, lang: callContext.userProfile.preferredLang ?? "en" })
        // S5 — structured TCPA audit log capturing the consent-disclosure
        // moment (paired with the prior-consent verification in
        // voice-tcpa-checks/{bookingId}_<runId>).
        emitConsentSpokenAudit(callContext, consentLine, log)
      } catch (err) {
        log("voice.consent_prompt_failed", {
          bookingId,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // ── Q1 KICKOFF (Adam 2026-06-19) — voice the first question after consent ──
      // Prescreen: the first question is in prescreenConfig (it was suppressed at
      // session creation so the call could greet first). Onboarding: a warm opener;
      // the pipeline asks the first real onboarding question on the candidate's reply.
      // Without this the agent sat silent after the consent line until the candidate
      // spoke first — there was no greeting→Q1.
      try {
        let kickoff: string | undefined
        if (callContext.purpose === "prescreen") {
          const q0 = callContext.prescreenConfig.questions[0]?.prompt
          kickoff = q0?.[lang] ?? q0?.en
        } else {
          kickoff =
            lang === "zh"
              ? "我们开始吧——先跟我说说你在找什么样的机会？"
              : "Let's get started — tell me a bit about the kind of role you're looking for."
        }
        if (kickoff) {
          await session.say?.(kickoff, { allowInterruptions: true })
          log("voice.worker.first_question_spoken", { bookingId, purpose: callContext.purpose })
        }
      } catch (err) {
        log("voice.worker.first_question_failed", {
          bookingId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  })

  // Expose for test introspection.
  ;(globalThis as Record<string, unknown>).__voiceAgent = agent

  log("voice.worker.defined", {})
}

function requireEnv(names: string[]): void {
  const missing = names.filter((n) => !process.env[n])
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`)
  }
}

/**
 * Resolve bookingId from the dispatched room.
 *
 * S3 dispatch (`apps/functions/src/voice/dialOutbound.ts`) calls
 * `sipClient.createSipParticipant({ roomName, ...})` where `roomName` is
 * derived from `bookingId` (default = identity). The SIP path does NOT set
 * room metadata. So the canonical source for bookingId in production is
 * `ctx.room.name`. We still honor `ctx.room.metadata` (JSON `{bookingId}`
 * or raw string) as a fallback for test / synthetic-dispatch paths.
 */
function readBookingId(metadata?: string, roomName?: string): string {
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata) as { bookingId?: string }
      if (typeof parsed.bookingId === "string" && parsed.bookingId.length > 0) {
        return parsed.bookingId
      }
    } catch {
      // not JSON — treat the whole string as the bookingId
    }
    if (metadata.length > 0) return metadata
  }
  if (roomName && roomName.length > 0) return roomName
  throw new Error("voice-agent: cannot resolve bookingId — neither room.metadata nor room.name is set")
}

export async function waitForRemoteParticipant(
  room: {
    remoteParticipants?: Map<string, RemoteParticipantLike>
    on?: (event: string, listener: (...args: unknown[]) => void) => unknown
    off?: (event: string, listener: (...args: unknown[]) => void) => unknown
  },
  opts: { identity?: string; timeoutMs?: number } = {},
): Promise<RemoteParticipantLike | null> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const matches = (participant: RemoteParticipantLike): boolean =>
    !opts.identity || participant.identity === opts.identity

  for (const participant of room.remoteParticipants?.values?.() ?? []) {
    if (matches(participant)) return participant
  }

  const on = room.on
  if (!on) return null

  return await new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      room.off?.("participantConnected", onConnected)
    }
    const settle = (participant: RemoteParticipantLike | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(participant)
    }
    const onConnected = (...args: unknown[]) => {
      const participant = (args[0] ?? {}) as RemoteParticipantLike
      if (matches(participant)) settle(participant)
    }

    on("participantConnected", onConnected)
    timer = setTimeout(() => settle(null), timeoutMs)
  })
}

async function waitForSpeechPlayout(
  speechHandle: unknown,
  opts: { timeoutMs: number },
): Promise<void> {
  const maybeThen = speechHandle as { then?: unknown } | undefined
  if (!maybeThen || typeof maybeThen.then !== "function") return
  await Promise.race([
    Promise.resolve(speechHandle).then(() => undefined),
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("speech_playout_timeout")), opts.timeoutMs)
    }),
  ])
}

/**
 * v2.2 — default context loader fetches from paVoiceCallContext CF.
 * Worker stays free of firebase-admin + @pa/pa-orchestrator bundles so the
 * LK Cloud deploy artifact stays slim. Tests inject `opts.loadContext` to
 * skip the HTTP round-trip.
 */
export async function defaultLoadContext(bookingId: string): Promise<VoiceCallContext> {
  const baseUrl = process.env.WEKRUIT_VOICE_CONTEXT_URL
  if (!baseUrl) {
    throw new Error("voice-agent: WEKRUIT_VOICE_CONTEXT_URL not set")
  }
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.PA_VOICE_CF_SECRET
        ? { "X-Wekruit-Voice-CF-Secret": process.env.PA_VOICE_CF_SECRET }
        : {}),
    },
    body: JSON.stringify({ bookingId }),
  })
  if (!res.ok) {
    throw new Error(`voice-agent: paVoiceCallContext ${res.status}: ${await res.text().catch(() => "?")}`)
  }
  const data = (await res.json()) as {
    bookingId: string
    purpose?: "prescreen" | "onboarding"
    userProfile: VoiceCallContext["userProfile"]
    prescreenSessionId?: string
    jobBrief?: unknown
    prescreenConfig?: unknown
  }
  const purpose = data.purpose === "onboarding" ? "onboarding" : "prescreen"
  if (purpose === "onboarding") {
    return {
      bookingId: data.bookingId,
      purpose,
      userProfile: data.userProfile,
    }
  }
  return {
    bookingId: data.bookingId,
    purpose,
    prescreenSessionId: data.prescreenSessionId ?? data.bookingId,
    userProfile: data.userProfile,
    jobBrief: data.jobBrief as VoicePrescreenCallContext["jobBrief"],
    prescreenConfig: data.prescreenConfig as VoicePrescreenCallContext["prescreenConfig"],
  }
}

/**
 * v2.2 — default pipeline that wraps paVoicePrescreenTurn (the
 * channel-agnostic runner). The voice worker is a thin transport; the
 * orchestrator brain (lifecycle reducer + PreScreenPipeline + KeywordSet
 * judge + clarify composer) runs server-side and returns text + action
 * over HTTPS.
 */
export async function defaultBuildPipeline(context: VoiceCallContext): Promise<VoicePipelineLite> {
  const envName =
    context.purpose === "onboarding"
      ? "WEKRUIT_VOICE_ONBOARDING_TURN_URL"
      : "WEKRUIT_VOICE_PRESCREEN_TURN_URL"
  const callableName =
    context.purpose === "onboarding"
      ? "paVoiceOnboardingTurn"
      : "paVoicePrescreenTurn"
  const baseUrl = process.env[envName]
  if (!baseUrl) {
    throw new Error(`voice-agent: ${envName} not set`)
  }
  return {
    async runTurn(input) {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.PA_VOICE_CF_SECRET
            ? { "X-Wekruit-Voice-CF-Secret": process.env.PA_VOICE_CF_SECRET }
            : {}),
        },
        body: JSON.stringify({
          bookingId: context.bookingId,
          sessionId: input.sessionId,
          userId: input.judgeCtx.userId,
          reply: input.reply,
          lang: input.lang,
          nowIso: input.nowIso,
        }),
      })
      if (!res.ok) {
        throw new Error(
          `voice-agent: ${callableName} ${res.status}: ${await res.text().catch(() => "?")}`,
        )
      }
      const data = (await res.json()) as {
        text: string | null
        action: { kind: string; [k: string]: unknown }
        terminalAction?: { terminal: string; reason: string }
        lifecycleKind: string
      }
      return {
        text: data.text ?? "",
        action: data.action as never,
      }
    },
  }
}
