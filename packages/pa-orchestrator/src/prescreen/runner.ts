/**
 * v2.2 — runPrescreenTurn (channel-agnostic prescreen runner).
 *
 * One brain for SMS + voice. Both channels call this; the channel adapter
 * (SMS = runtime-approved outbox; voice = session.say after PII redact) consumes the
 * `PrescreenRunResult` and decides transport + terminal-action dispatch.
 *
 * Lifecycle reducer over Firestore facts. The 6 outcomes:
 *
 *   no_active_session    — no terminal=null doc, no recent terminal doc
 *   active_turn          — PreScreenPipeline.runTurn produced clarify/advance/terminal
 *   session_expired      — terminal=null but stale > ACTIVE_PRESCREEN_TIMEOUT_MS
 *   recent_terminal      — recent ended session within RECENT_TERMINAL_PRESCREEN_GUARD_MS
 *   user_exit            — candidate said "stop" / "暂停" / etc.
 *   stale_terminal       — sessionId known but already terminal (race or replay)
 *
 * Each outcome is deterministic over inputs. LLM only inside the active_turn
 * pipeline call (KeywordSetJudge.score + composeClarify); never the lifecycle
 * decision itself.
 */

import type { Lang, ScoredJudgeResult } from "../onboarding/question.js"
import { KeywordSetJudge, type KeywordSetLlmCaller } from "../onboarding/judges/keyword-set.js"
import {
  PreScreenPipeline,
  type PreScreenClarifyComposer,
  type PreScreenQuestion,
  type RunTurnResult,
} from "./pipeline.js"
import type { PreScreenState, PreScreenStateProvider } from "./state.js"
import type { PrescreenConfig } from "./config.js"
import type {
  PrescreenSessionFinder,
  SessionFinderResult,
} from "./session-finder.js"
import type {
  PrescreenTurnAction,
  PrescreenTurnRecord,
  PrescreenTurnRecorder,
  PrescreenTurnScoredSnapshot,
} from "./turn-recorder.js"

/* ────────────────────────────────────────────────────────────────────────── */
/* Types                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

export type PrescreenChannel = "sms" | "voice"

export interface PrescreenRunContext {
  /** Voice path: bookingId is the sessionId. SMS path: omit; runner resolves via findForUser. */
  sessionId?: string
  userId: string
  reply: string
  lang: Lang
  nowIso: string
  channel: PrescreenChannel
  log?: (event: string, payload: Record<string, unknown>) => void
  now?: () => number
}

export type PrescreenLifecycle =
  | { kind: "no_active_session" }
  | { kind: "session_expired"; sessionId: string; jobId: string }
  | {
      kind: "recent_terminal_guard"
      sessionId: string
      jobId: string
      terminal: string
      alreadyAcked: boolean
    }
  | { kind: "user_exit"; sessionId: string; jobId: string }
  | { kind: "stale_terminal"; sessionId: string; terminal: string | null }
  | {
      kind: "active_turn"
      sessionId: string
      jobId: string
      pipelineResult: RunTurnResult
    }

export interface PrescreenRunResult {
  lifecycle: PrescreenLifecycle
  /** Candidate-facing text. null when nothing should be emitted (e.g. ack already done). */
  text: string | null
  /** True when state or a turn record was persisted by the runner. */
  persisted: boolean
  /** Signal for the channel adapter to fire post-decision side effects. */
  terminalAction?: {
    terminal: "PASS" | "FAIL" | "HARD_STOP" | "PAUSE"
    reason: string
  }
}

export type PrescreenCfgLoader = (sessionId: string) => Promise<PrescreenConfig | null>

export type PrescreenChannelTextHint = (input: {
  text: string
  channel: PrescreenChannel
  action: RunTurnResult["action"] | { kind: "expired" } | { kind: "user_exit" } | { kind: "recent_terminal" }
}) => string

export interface PrescreenRunnerDeps {
  store: PreScreenStateProvider
  sessionFinder: PrescreenSessionFinder
  cfgLoader: PrescreenCfgLoader
  llmCaller: KeywordSetLlmCaller
  composeClarify: PreScreenClarifyComposer
  turnRecorder: PrescreenTurnRecorder
  /** Optional post-processor for channel-specific formatting. */
  channelTextHint?: PrescreenChannelTextHint
}

/* ────────────────────────────────────────────────────────────────────────── */
/* User-exit detection                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

export function isUserExitPrescreenReply(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  if (!normalized) return false
  return /^(stop|cancel|pause|quit|exit|end|not now|later|nevermind|never mind|退出|停止|暂停|先不|不用了|算了)[.!。！\s]*$/i.test(
    normalized,
  )
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Channel-agnostic copy                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

export function expiredSessionText(lang: Lang): string {
  return lang === "zh"
    ? "这次岗位初筛我先暂停了，避免把旧对话和新的经历混在一起。想继续这个岗位的话，从岗位页面重新开始，我会开一个新的 screen。"
    : "I paused this role screen so I do not mix an old conversation with a new one. If you want to continue this role, reopen it from the job page and I will start a fresh screen."
}

export function userExitSessionText(lang: Lang): string {
  return lang === "zh"
    ? "好的，我先暂停这个岗位 screen。你之后想继续的话，从岗位页面重新开始就行；你已经分享过的经历我会保留在你的全局 profile 里。"
    : "Got it — I paused this role screen. If you want to continue later, reopen it from the job page; I will keep what you have already shared on your profile."
}

export function recentTerminalSessionText(lang: Lang): string {
  return lang === "zh"
    ? "收到。这次 screen 已经到这里。我也可以继续帮你找更符合期待的岗位，不过需要先更了解你一点。要继续吗？"
    : "Got it. This role screen is done for now. I can help find jobs that meet your expectations, but I need to understand you a bit better first. Do you want to proceed?"
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers — turn record qId + scored snapshot                                */
/* ────────────────────────────────────────────────────────────────────────── */

export function prescreenTurnRecordQId(
  action: PrescreenTurnAction | RunTurnResult["action"],
  activeQId: string | null | undefined,
): string {
  if (action.kind === "clarify") return action.qId
  if (action.kind === "advance") return action.fromQId
  return activeQId ?? "terminal"
}

function snapshotScored(state: PreScreenState, qId: string): PrescreenTurnScoredSnapshot | undefined {
  const scored = state.questions[qId]?.scored as ScoredJudgeResult | undefined
  if (!scored) return undefined
  return {
    perKeyword: scored.perKeyword,
    aggregate: scored.aggregate,
    ...(scored.abortHint !== undefined ? { abortHint: scored.abortHint } : {}),
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* runPrescreenTurn                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

export async function runPrescreenTurn(
  ctx: PrescreenRunContext,
  deps: PrescreenRunnerDeps,
): Promise<PrescreenRunResult> {
  const log = ctx.log ?? (() => {})
  const now = ctx.now ?? Date.now
  const nowMs = now()

  /* Step 1 — lifecycle lookup (voice short-circuits via ctx.sessionId) */
  let lookup: SessionFinderResult
  if (ctx.sessionId) {
    const rec = await deps.sessionFinder.loadById(ctx.sessionId)
    if (!rec) lookup = { kind: "none" }
    else if (rec.terminal !== null) {
      lookup = {
        kind: "recent_terminal",
        sessionId: rec.sessionId,
        jobId: rec.jobId,
        terminal: rec.terminal,
        alreadyAcked: typeof rec.postTerminalFollowupAckAt === "string",
      }
    } else {
      lookup = {
        kind: "active",
        sessionId: rec.sessionId,
        jobId: rec.jobId,
        activeQId: rec.activeQId,
      }
    }
  } else {
    lookup = await deps.sessionFinder.findForUser(ctx.userId, { nowMs, log })
  }

  if (lookup.kind === "none") {
    log("prescreen.runner.no_active_session", { userId: ctx.userId })
    return { lifecycle: { kind: "no_active_session" }, text: null, persisted: false }
  }

  /* Step 2 — recent terminal guard */
  if (lookup.kind === "recent_terminal") {
    await deps.turnRecorder.record(lookup.sessionId, {
      qId: "terminal",
      reply: ctx.reply,
      action: {
        kind: "post_terminal_followup",
        terminal: lookup.terminal,
        reason: "recent_ended_prescreen_session",
      },
      ts: ctx.nowIso,
    })
    let text: string | null = null
    if (!lookup.alreadyAcked) {
      const raw = recentTerminalSessionText(ctx.lang)
      text = applyChannelHint(deps, raw, ctx.channel, { kind: "recent_terminal" })
      await deps.turnRecorder.markPostTerminalAck(lookup.sessionId, ctx.nowIso)
    }
    log("prescreen.runner.recent_terminal_guard", {
      sessionId: lookup.sessionId,
      terminal: lookup.terminal,
      acked: !lookup.alreadyAcked,
    })
    return {
      lifecycle: {
        kind: "recent_terminal_guard",
        sessionId: lookup.sessionId,
        jobId: lookup.jobId,
        terminal: lookup.terminal,
        alreadyAcked: lookup.alreadyAcked,
      },
      text,
      persisted: true,
    }
  }

  /* Step 3 — expired */
  if (lookup.kind === "expired") {
    const raw = expiredSessionText(ctx.lang)
    const text = applyChannelHint(deps, raw, ctx.channel, { kind: "expired" })
    log("prescreen.runner.expired", { sessionId: lookup.sessionId })
    return {
      lifecycle: { kind: "session_expired", sessionId: lookup.sessionId, jobId: lookup.jobId },
      text,
      persisted: true,
      terminalAction: { terminal: "PAUSE", reason: "expired_inactive_prescreen_session" },
    }
  }

  /* Step 4 — active path: load cfg + state */
  const sessionId = lookup.sessionId

  const cfg = await deps.cfgLoader(sessionId)
  if (!cfg || !cfg.questions || cfg.questions.length === 0) {
    log("prescreen.runner.no_config", { sessionId })
    return { lifecycle: { kind: "no_active_session" }, text: null, persisted: false }
  }

  const state = await deps.store.load(sessionId)
  if (!state || state.terminal !== null || !state.currentQId) {
    log("prescreen.runner.stale_terminal_or_missing", {
      sessionId,
      terminal: state?.terminal ?? null,
      currentQId: state?.currentQId ?? null,
    })
    return {
      lifecycle: {
        kind: "stale_terminal",
        sessionId,
        terminal: state?.terminal ?? null,
      },
      text: null,
      persisted: false,
    }
  }

  /* Step 5 — user exit */
  if (isUserExitPrescreenReply(ctx.reply)) {
    const next: PreScreenState = {
      ...state,
      terminal: "PAUSE",
      terminalReason: "user_exit",
      currentQId: null,
      updatedAt: ctx.nowIso,
      ...(state.workSession
        ? {
            workSession: {
              ...state.workSession,
              kind: "job_prescreen" as const,
              status: "ended" as const,
              endedAt: ctx.nowIso,
              boundary: "user_exit" as const,
            },
          }
        : {
            workSession: {
              kind: "job_prescreen" as const,
              status: "ended" as const,
              endedAt: ctx.nowIso,
              boundary: "user_exit" as const,
            },
          }),
    }
    await deps.store.save(next)

    await deps.turnRecorder.record(sessionId, {
      qId: state.currentQId ?? "terminal",
      reply: ctx.reply,
      action: { kind: "terminal", terminal: "PAUSE", reason: "user_exit" },
      ts: ctx.nowIso,
    })

    const raw = userExitSessionText(ctx.lang)
    const text = applyChannelHint(deps, raw, ctx.channel, { kind: "user_exit" })

    log("prescreen.runner.user_exit", { sessionId, userId: ctx.userId })

    return {
      lifecycle: { kind: "user_exit", sessionId, jobId: lookup.jobId },
      text,
      persisted: true,
      terminalAction: { terminal: "PAUSE", reason: "user_exit" },
    }
  }

  /* Step 6 — active turn → build pipeline + runTurn */
  const questions: Record<string, PreScreenQuestion> = {}
  for (const q of cfg.questions) {
    questions[q.qId] = {
      qId: q.qId,
      prompt: q.prompt,
      clarifyPrompt: q.clarifyPrompt,
      judge: new KeywordSetJudge({
        questionId: q.qId,
        keywords: q.keywords,
        questionPrompt: q.prompt.en,
        llmCaller: deps.llmCaller,
      }),
    }
  }
  const pipeline = new PreScreenPipeline({
    questions,
    store: deps.store,
    log,
    composeClarify: deps.composeClarify,
  })

  const result = await pipeline.runTurn({
    sessionId,
    reply: ctx.reply,
    lang: ctx.lang,
    nowIso: ctx.nowIso,
    judgeCtx: { userId: ctx.userId, turnId: `t_${nowMs}`, log },
  })

  const turnQId = prescreenTurnRecordQId(result.action, state.currentQId)
  const scored = snapshotScored(result.state, turnQId)
  const turnRec: PrescreenTurnRecord = {
    qId: turnQId,
    reply: ctx.reply,
    ...(scored ? { scored } : {}),
    action: result.action as PrescreenTurnAction,
    ts: new Date(nowMs).toISOString(),
  }
  await deps.turnRecorder.record(sessionId, turnRec)

  const finalText = result.text
    ? applyChannelHint(deps, result.text, ctx.channel, result.action)
    : null

  let terminalAction: PrescreenRunResult["terminalAction"]
  if (
    result.action.kind === "terminal" &&
    (result.action.terminal === "PASS" ||
      result.action.terminal === "FAIL" ||
      result.action.terminal === "HARD_STOP" ||
      result.action.terminal === "PAUSE")
  ) {
    terminalAction = { terminal: result.action.terminal, reason: result.action.reason }
  }

  log("prescreen.runner.active_turn", {
    sessionId,
    action: result.action.kind,
    terminal: result.state.terminal,
  })

  return {
    lifecycle: {
      kind: "active_turn",
      sessionId,
      jobId: lookup.jobId,
      pipelineResult: result,
    },
    text: finalText,
    persisted: true,
    ...(terminalAction ? { terminalAction } : {}),
  }
}

function applyChannelHint(
  deps: PrescreenRunnerDeps,
  text: string,
  channel: PrescreenChannel,
  action: Parameters<NonNullable<PrescreenRunnerDeps["channelTextHint"]>>[0]["action"],
): string {
  if (!deps.channelTextHint) return text
  return deps.channelTextHint({ text, channel, action })
}
