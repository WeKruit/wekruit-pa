/**
 * v1.8 Phase 77.4 — paPrescreenTurn (subsequent reply handler).
 *
 * v2.2 — thin SMS adapter over @pa/pa-orchestrator's `runPrescreenTurn`.
 * Voice path uses the same runner via apps/voice-agent's worker, so any
 * change to prescreen agent behavior (questions, clarify wording, LLM
 * model, user-exit detection, lifecycle reducer) lands in pa-orchestrator
 * and propagates to both channels automatically.
 *
 * Local responsibilities kept here (SMS-specific only):
 *   - Production LLM wirings (gpt-5.4-nano keyword scorer + clarify composer)
 *   - FirestorePreScreenStore (uses merge:true so cfgSnapshot survives writes)
 *   - sendImessage transport
 *   - runPrescreenTerminalAction dispatch (Adam-locked CF in
 *     prescreen-terminal-action.ts)
 */
import type { Firestore } from "firebase-admin/firestore"
import {
  FirestoreSessionFinder,
  FirestoreTurnRecorder,
  prescreenTurnRecordQId as orchestratorPrescreenTurnRecordQId,
  runPrescreenTurn,
  type KeywordSetLlmCaller,
  type PreScreenClarifyComposer,
  type PrescreenChannelTextHint,
  type PrescreenConfig,
  type PrescreenRunnerDeps,
  type PrescreenTurnAction,
} from "@pa/pa-orchestrator"
import { sendImessage } from "./sendblue/sendblue-client.js"
import { runPrescreenTerminalAction } from "./prescreen-terminal-action.js"
import {
  FirestorePreScreenStore,
  makeProductionKeywordSetCaller,
  makeProductionClarifyComposer,
  normalizePrescreenClarifyTextForRound as sharedNormalizeClarifyText,
  prescreenClarifyRoundGuidance as sharedClarifyRoundGuidance,
} from "./prescreen-deps.js"

/* ────────────────────────────────────────────────────────────────────────── */
/* Firestore PreScreenStateProvider + production LLM wirings live in          */
/* prescreen-deps.ts (shared with paVoicePrescreenTurn).                      */
/* ────────────────────────────────────────────────────────────────────────── */

// Back-compat re-exports — existing tests still import these symbols from
// prescreen-turn-handler. The actual implementations live in prescreen-deps.
export const prescreenClarifyRoundGuidance = sharedClarifyRoundGuidance
export const normalizePrescreenClarifyTextForRound = sharedNormalizeClarifyText

/* ────────────────────────────────────────────────────────────────────────── */
/* Re-export back-compat                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * @deprecated import directly from `@pa/pa-orchestrator`. Retained so the
 * existing prescreen-turn-handler test suite still has a stable import path.
 */
export const prescreenTurnRecordQId = orchestratorPrescreenTurnRecordQId

/* ────────────────────────────────────────────────────────────────────────── */
/* Channel hint — SMS                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/** SMS post-processor is a no-op today; clarify composer already caps text. */
const smsChannelTextHint: PrescreenChannelTextHint = ({ text }) => text

/* ────────────────────────────────────────────────────────────────────────── */
/* Public entry — runPrescreenTurnIfActive                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export interface RunPrescreenTurnArgs {
  db: Firestore
  userId: string
  toE164: string
  replyText: string
  lang?: "zh" | "en"
  sendSms?: typeof sendImessage
  runTerminalAction?: typeof runPrescreenTerminalAction
  keywordSetCaller?: KeywordSetLlmCaller
  clarifyComposer?: PreScreenClarifyComposer
  log?: (event: string, payload: Record<string, unknown>) => void
}

export interface RunPrescreenTurnResult {
  handled: boolean
  sessionId?: string
  terminal?: string | null
  textSent?: string
}

/**
 * Entry called from paMessageCoalescer before Claire dispatch. Returns
 * handled=false when no active prescreen session → coalescer continues
 * to Claire.
 */
export async function runPrescreenTurnIfActive(
  args: RunPrescreenTurnArgs,
): Promise<RunPrescreenTurnResult> {
  const log = args.log ?? (() => {})
  const sendSms = args.sendSms ?? sendImessage
  const terminalAction = args.runTerminalAction ?? runPrescreenTerminalAction

  const store = new FirestorePreScreenStore(args.db)
  const sessionFinder = new FirestoreSessionFinder(args.db)
  const turnRecorder = new FirestoreTurnRecorder(args.db)

  const cfgLoader = async (sessionId: string): Promise<PrescreenConfig | null> => {
    const snap = await args.db.collection("pa-prescreen-sessions").doc(sessionId).get()
    const cfg = snap.data()?.cfgSnapshot as PrescreenConfig | undefined
    return cfg ?? null
  }

  const deps: PrescreenRunnerDeps = {
    store,
    sessionFinder,
    cfgLoader,
    llmCaller: args.keywordSetCaller ?? makeProductionKeywordSetCaller(),
    composeClarify: args.clarifyComposer ?? makeProductionClarifyComposer(),
    turnRecorder,
    channelTextHint: smsChannelTextHint,
  }

  const result = await runPrescreenTurn(
    {
      userId: args.userId,
      reply: args.replyText,
      lang: args.lang ?? "en",
      nowIso: new Date().toISOString(),
      channel: "sms",
      log,
    },
    deps,
  )

  // Map lifecycle → legacy result shape.
  if (result.lifecycle.kind === "no_active_session") {
    return { handled: false }
  }
  if (result.lifecycle.kind === "stale_terminal") {
    log("prescreen.turn.stale_terminal_session_ignored", {
      userId: args.userId,
      sessionId: result.lifecycle.sessionId,
      terminal: result.lifecycle.terminal,
    })
    return { handled: false, sessionId: result.lifecycle.sessionId, terminal: result.lifecycle.terminal }
  }

  const sessionId = lifecycleSessionId(result.lifecycle)
  const jobId = lifecycleJobId(result.lifecycle)

  // Send candidate-facing text first (matches pre-v2.2 ordering for
  // active_turn + recent_terminal). For user_exit + expired the prior
  // code called terminalAction THEN sendSms — but we keep send-first here
  // because terminalAction is best-effort and we never want to suppress
  // the candidate-facing acknowledgment due to a downstream failure.
  if (result.text) {
    try {
      await sendSms({
        to: args.toE164,
        content: result.text,
        userId: args.userId,
        db: args.db,
      })
    } catch (err) {
      log("prescreen.turn.send_failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Terminal-action dispatch (post-PASS / PAUSE side effects — Level 1
  // reveal, auto job recs, etc.). Fail-open; never reverse the runner.
  if (result.terminalAction && sessionId) {
    try {
      await terminalAction({
        db: args.db,
        sessionId,
        terminal: result.terminalAction.terminal,
        userId: args.userId,
        jobId,
        toE164: args.toE164,
        lang: args.lang ?? "en",
        log,
      })
    } catch (err) {
      log("prescreen.terminal_action.threw", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Compute terminal field for the legacy return shape.
  let terminal: string | null | undefined
  if (result.lifecycle.kind === "active_turn") {
    terminal = result.lifecycle.pipelineResult.state.terminal ?? null
  } else if (result.lifecycle.kind === "recent_terminal_guard") {
    terminal = result.lifecycle.terminal
  } else if (result.terminalAction) {
    terminal = result.terminalAction.terminal
  } else {
    terminal = null
  }

  log("prescreen.turn.handled", {
    sessionId,
    lifecycle: result.lifecycle.kind,
    terminal,
  })

  return {
    handled: true,
    ...(sessionId ? { sessionId } : {}),
    terminal: terminal ?? null,
    ...(result.text ? { textSent: result.text } : {}),
  }
}

function lifecycleSessionId(lifecycle: Awaited<ReturnType<typeof runPrescreenTurn>>["lifecycle"]): string {
  switch (lifecycle.kind) {
    case "active_turn":
    case "session_expired":
    case "recent_terminal_guard":
    case "user_exit":
    case "stale_terminal":
      return lifecycle.sessionId
    default:
      return ""
  }
}

function lifecycleJobId(lifecycle: Awaited<ReturnType<typeof runPrescreenTurn>>["lifecycle"]): string {
  switch (lifecycle.kind) {
    case "active_turn":
    case "session_expired":
    case "recent_terminal_guard":
    case "user_exit":
      return lifecycle.jobId
    default:
      return ""
  }
}

/** Action discriminator used by the dashboard observability page. */
export type { PrescreenTurnAction }
