/**
 * v1.8 Phase 77.4 — paPrescreenTurn (subsequent reply handler).
 *
 * Inbound coalescer calls `runPrescreenTurnIfActive(db, userId, reply, lang)`
 * BEFORE claimer → Claire orchestrator. If there's an active (terminal=null)
 * prescreen session for the user, we route the reply through
 * PreScreenPipeline.runTurn and short-circuit. Otherwise return ok:false
 * so the coalescer falls through to Claire as normal.
 *
 * Wires:
 *   - FirestorePreScreenStore (reads + writes pa-prescreen-sessions)
 *   - PreScreenQuestion bindings from session.cfgSnapshot
 *   - KeywordSetLlmCaller (production gpt-5.4-nano + Sonnet fallback)
 *   - sendImessage for outbound text
 */
import type { Firestore } from "firebase-admin/firestore"
import {
  KeywordSetJudge,
  PreScreenPipeline,
  hardFilterClarifyText,
  type KeywordSetLlmCaller,
  type KeywordSetLlmOutput,
  type KeywordSpec,
  type PreScreenClarifyComposer,
  type PreScreenQuestion,
  type PreScreenState,
  type PreScreenStateProvider,
} from "@pa/pa-orchestrator"
import { sendImessage } from "./sendblue/sendblue-client.js"
import { runPrescreenTerminalAction } from "./prescreen-terminal-action.js"

const ACTIVE_PRESCREEN_TIMEOUT_MS = 60 * 60 * 1000
const RECENT_TERMINAL_PRESCREEN_GUARD_MS = 60 * 60 * 1000

/** Firestore-backed PreScreenStateProvider. */
class FirestorePreScreenStore implements PreScreenStateProvider {
  constructor(private readonly db: Firestore) {}
  async load(sessionId: string): Promise<PreScreenState | null> {
    const snap = await this.db.collection("pa-prescreen-sessions").doc(sessionId).get()
    if (!snap.exists) return null
    const data = snap.data()
    if (!data) return null
    return data as PreScreenState
  }
  async save(state: PreScreenState): Promise<void> {
    // v1.9 hotfix — Firestore Admin SDK rejects `undefined` field values
    // unless ignoreUndefinedProperties is set. KeywordSetJudge omits
    // optional fields (abortHint, etc.) as undefined, which then propagate
    // into state.questions[qId].scored.abortHint. Strip undefined recursively
    // before write so save never throws "Cannot use \"undefined\"".
    await this.db
      .collection("pa-prescreen-sessions")
      .doc(state.sessionId)
      .set(stripUndefined(state) as PreScreenState, { merge: false })
  }
}

/** Recursively drop keys whose value is `undefined`. Preserves null. */
function stripUndefined<T>(v: T): T {
  if (v === null || v === undefined) return v
  if (Array.isArray(v)) {
    return v.map((x) => stripUndefined(x)) as unknown as T
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue
      out[k] = stripUndefined(val)
    }
    return out as T
  }
  return v
}

/** Production LLM caller — gpt-5.4-nano JSON-mode. */
function makeProductionKeywordSetCaller(): KeywordSetLlmCaller {
  return {
    async score({ reply, lang, keywords, questionPrompt }) {
      const apiKey = process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY
      if (!apiKey) throw new Error("missing OpenAI API key")
      const keywordList = keywords
        .map((k, i) => `${i + 1}. "${k.keyword}" (weight ${(k.weight ?? 1).toFixed(2)})${k.hint ? ` hint: ${k.hint}` : ""}`)
        .join("\n")
      const system = [
        "You are a recruiting screener evaluating candidate replies against a JD keyword set.",
        "For EACH configured keyword, emit one cell:",
        "  - keyword (verbatim)",
        "  - match 0..1 (how well the reply demonstrates this keyword)",
        "  - confidence 0..1 (how sure you are)",
        "  - evidence ≤60 char excerpt from reply",
        "  - reasoning ≤80 char explanation",
        "Also emit: summary ≤120 char, answered bool, abortHint?{kind:low_confidence|off_topic|decline|ambiguous, reason}",
        "When the reply contains multiple prior answers, score the strongest concrete relevant evidence across the whole merged reply.",
        "Do not let an early 'not exact' admission dominate if later details show relevant shipped work, systems, tools, or impact.",
        "Output STRICT JSON. No prose. Do NOT invent keywords. Temperature 0.",
      ].join("\n")
      const userMsg = [
        questionPrompt ? `Question (${lang}): ${questionPrompt}` : "",
        `Candidate reply (${lang}): """${reply}"""`,
        `Keyword set:\n${keywordList}`,
        'Schema: { "perKeyword": [...], "summary": "...", "answered": bool, "abortHint"?: {...} }',
      ]
        .filter(Boolean)
        .join("\n\n")
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-5.4-nano",
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMsg },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        }),
      })
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text().catch(() => "?")}`)
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = json.choices?.[0]?.message?.content
      if (!content) throw new Error("OpenAI empty response")
      return JSON.parse(content) as KeywordSetLlmOutput
    },
  }
}

function makeProductionClarifyComposer(): PreScreenClarifyComposer {
  return async (input) => {
    const hardFilterText = hardFilterClarifyText(input.question.qId, input.lang)
    if (hardFilterText) return hardFilterText

    const apiKey = process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("missing OpenAI API key")

    const weakCells = [...input.merged.perKeyword]
      .filter((cell) => Number.isFinite(cell.match) && cell.match < 0.75)
      .sort((a, b) => a.match - b.match)
      .slice(0, 4)
      .map((cell) => ({
        keyword: cell.keyword,
        match: Number(cell.match.toFixed(2)),
        confidence: Number(cell.confidence.toFixed(2)),
        evidence: cell.evidence,
        reasoning: cell.reasoning,
      }))

    const system = [
      "You are Claire, a candidate prescreening agent.",
      "Write ONE warm iMessage follow-up that probes like a thoughtful recruiter friend learning the candidate's story.",
      "Do not reject the candidate. Do not conclude fit. Do not repeat the prior generic clarify wording.",
      "Do not start with the same generic acknowledgment every round; avoid repeated 'That's helpful' / 'That helps' openers.",
      "Use the candidate's latest answer and weak evidence to ask the next most useful detail.",
      "Do not ask a checklist. Pick one natural angle: their role, technical depth, systems touched, tradeoff, failure, user/customer impact, or measurable outcome.",
      "Keep it under 360 characters. Output strict JSON only: {\"text\":\"...\"}.",
    ].join("\n")

    const userMsg = [
      `Language: ${input.lang}`,
      `Question id: ${input.question.qId}`,
      `Original question: ${input.question.prompt[input.lang]}`,
      `Clarify round for this same question: ${input.clarifyRound}`,
      `Required probe angle for this round: ${prescreenClarifyRoundGuidance(input.clarifyRound, input.lang)}`,
      `Reason: ${input.reason}`,
      `Latest candidate reply: """${input.reply}"""`,
      `Prior answers for this same question: ${JSON.stringify(input.state.questions[input.question.qId]?.evidenceReplies ?? [])}`,
      `Merged score: s=${input.merged.aggregate.s.toFixed(2)} c=${input.merged.aggregate.c.toFixed(2)} summary=${input.merged.aggregate.summary}`,
      `Weak or missing areas JSON: ${JSON.stringify(weakCells)}`,
      `If unsure, use this fallback intent without copying it verbatim: ${input.fallbackText}`,
    ].join("\n")

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    })
    if (!res.ok) throw new Error(`OpenAI clarify ${res.status}: ${await res.text().catch(() => "?")}`)
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = json.choices?.[0]?.message?.content
    if (!content) throw new Error("OpenAI clarify empty response")
    const parsed = JSON.parse(content) as { text?: unknown }
    if (typeof parsed.text !== "string" || !parsed.text.trim()) throw new Error("OpenAI clarify missing text")
    return normalizePrescreenClarifyTextForRound(parsed.text, input.clarifyRound, input.lang)
  }
}

export function prescreenClarifyRoundGuidance(round: number, lang: "zh" | "en"): string {
  const normalizedRound = Math.max(1, Math.floor(round))
  if (lang === "zh") {
    if (normalizedRound === 1) return "找最近的相关项目：背景、候选人亲自负责什么、用户或业务结果。"
    if (normalizedRound === 2) return "追问 ownership 和系统边界：候选人自己做了哪一块、碰到哪些系统或数据。"
    if (normalizedRound === 3) return "追问最难的失败/取舍/验证：问题怎么发现、怎么验证修复。"
    return "最后一次具体确认：最小可证明的 shipped work、指标或明确缺口；不要继续泛泛追问。"
  }
  if (normalizedRound === 1) return "Find the closest relevant project: context, personal ownership, and user or business outcome."
  if (normalizedRound === 2) return "Probe ownership and system boundary: what they personally built, and which systems or data it touched."
  if (normalizedRound === 3) return "Probe the hardest failure, tradeoff, or validation: what broke, what they changed, and how they knew it worked."
  return "Final concrete check: smallest provable shipped work, measurable result, or explicit gap; do not keep circling."
}

export function normalizePrescreenClarifyTextForRound(text: string, round: number, lang: "zh" | "en"): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return normalized

  const openerByRound =
    lang === "zh"
      ? [
          "明白 - ",
          "这里 ownership 很关键 - ",
          "这个系统细节有用 - ",
          "最后我确认一个具体点 - ",
        ]
      : [
          "Got it - ",
          "The ownership piece matters here - ",
          "The systems detail is the useful signal - ",
          "One last concrete check before I score it - ",
        ]
  const idx = Math.min(Math.max(1, Math.floor(round)), openerByRound.length) - 1

  const genericAckPattern =
    lang === "zh"
      ? /^(这段有帮助|谢谢|收到|明白|好的|了解)[\s,，。:：;；!！—-]*/i
      : /^(that'?s helpful|that is helpful|that helps|thanks|thank you|got it|interesting|nice)[\s,.:;!—-]*/i

  if (!genericAckPattern.test(normalized)) return normalized

  const withoutAck = normalized.replace(genericAckPattern, "").trim()
  if (!withoutAck) return normalized
  const replacement = `${openerByRound[idx]}${withoutAck.charAt(0).toLowerCase()}${withoutAck.slice(1)}`
  return replacement
}

/**
 * Find active prescreen session for a user (terminal=null). Returns
 * sessionId or null if none.
 */
type ActivePrescreenLookup =
  | { kind: "none" }
  | { kind: "active"; sessionId: string }
  | { kind: "expired"; sessionId: string; jobId: string }
  | { kind: "recent_terminal"; sessionId: string; jobId: string; terminal: string }

async function findActiveSession(
  db: Firestore,
  userId: string,
  opts: {
    nowMs?: number
    log?: (event: string, payload: Record<string, unknown>) => void
  } = {},
): Promise<ActivePrescreenLookup> {
  const snap = await db
    .collection("pa-prescreen-sessions")
    .where("userId", "==", userId)
    .where("terminal", "==", null)
    .get()
  if (snap.empty) return { kind: "none" }
  const candidates = [...snap.docs].sort((a, b) => {
    const aData = a.data() as Record<string, unknown>
    const bData = b.data() as Record<string, unknown>
    const aMs = timestampMs(aData.updatedAt) ?? timestampMs(aData.createdAt) ?? 0
    const bMs = timestampMs(bData.updatedAt) ?? timestampMs(bData.createdAt) ?? 0
    return bMs - aMs
  })
  const doc = candidates[0]!
  const data = doc.data() as Record<string, unknown>
  const lastActiveMs = timestampMs(data.updatedAt) ?? timestampMs(data.createdAt)
  const nowMs = opts.nowMs ?? Date.now()
  if (lastActiveMs !== null && nowMs - lastActiveMs > ACTIVE_PRESCREEN_TIMEOUT_MS) {
    const nowIso = new Date(nowMs).toISOString()
    await doc.ref.set(
      {
        terminal: "PAUSE",
        terminalReason: "expired_inactive_prescreen_session",
        currentQId: null,
        updatedAt: nowIso,
        workSession: {
          kind: "job_prescreen",
          status: "ended",
          endedAt: nowIso,
          boundary: "timeout",
        },
      },
      { merge: true },
    )
    opts.log?.("prescreen.turn.expired_inactive_session", {
      userId,
      sessionId: doc.id,
      lastActiveAt: new Date(lastActiveMs).toISOString(),
      timeoutMinutes: ACTIVE_PRESCREEN_TIMEOUT_MS / 60_000,
    })
    return {
      kind: "expired",
      sessionId: doc.id,
      jobId: typeof data.jobId === "string" ? data.jobId : "",
    }
  }
  return { kind: "active", sessionId: doc.id }
}

async function findRecentTerminalSession(
  db: Firestore,
  userId: string,
  opts: {
    nowMs?: number
    log?: (event: string, payload: Record<string, unknown>) => void
  } = {},
): Promise<ActivePrescreenLookup> {
  const nowMs = opts.nowMs ?? Date.now()
  const snap = await db
    .collection("pa-prescreen-sessions")
    .where("userId", "==", userId)
    .get()

  let latest:
    | {
        id: string
        jobId: string
        terminal: string
        atMs: number
      }
    | null = null

  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>
    const terminal = typeof data.terminal === "string" ? data.terminal : null
    if (!terminal) continue
    const workSession = data.workSession as Record<string, unknown> | undefined
    if (workSession && workSession.kind !== "job_prescreen") continue

    const endedAtMs =
      timestampMs(workSession?.endedAt) ??
      timestampMs(data.updatedAt) ??
      timestampMs(data.completedAt) ??
      timestampMs(data.createdAt)
    if (endedAtMs === null) continue
    if (nowMs - endedAtMs > RECENT_TERMINAL_PRESCREEN_GUARD_MS) continue
    if (latest && endedAtMs <= latest.atMs) continue

    latest = {
      id: doc.id,
      jobId: typeof data.jobId === "string" ? data.jobId : "",
      terminal,
      atMs: endedAtMs,
    }
  }

  if (!latest) return { kind: "none" }
  opts.log?.("prescreen.turn.recent_terminal_guard_found", {
    userId,
    sessionId: latest.id,
    jobId: latest.jobId,
    terminal: latest.terminal,
    endedAt: new Date(latest.atMs).toISOString(),
  })
  return {
    kind: "recent_terminal",
    sessionId: latest.id,
    jobId: latest.jobId,
    terminal: latest.terminal,
  }
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value && typeof value === "object") {
    const maybe = value as { toMillis?: () => number; toDate?: () => Date }
    if (typeof maybe.toMillis === "function") {
      const ms = maybe.toMillis()
      return Number.isFinite(ms) ? ms : null
    }
    if (typeof maybe.toDate === "function") {
      const ms = maybe.toDate().getTime()
      return Number.isFinite(ms) ? ms : null
    }
  }
  return null
}

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
  /** True when an active session was found and the reply was handled. */
  handled: boolean
  sessionId?: string
  terminal?: string | null
  textSent?: string
}

type PrescreenTurnRecordAction =
  | { kind: "clarify"; qId: string; kAfter: number }
  | { kind: "advance"; fromQId: string; toQId: string }
  | { kind: "terminal"; terminal: "PASS" | "FAIL" | "HARD_STOP" | "PAUSE"; reason: string }
  | { kind: "error"; reason: string }

export function prescreenTurnRecordQId(
  action: PrescreenTurnRecordAction,
  activeQId: string | null | undefined
): string {
  if (action.kind === "clarify") return action.qId
  if (action.kind === "advance") return action.fromQId
  return activeQId ?? "terminal"
}

function prescreenTurnRecordScored(state: PreScreenState, qId: string) {
  const scored = state.questions[qId]?.scored
  if (!scored) return undefined
  return {
    perKeyword: scored.perKeyword,
    aggregate: scored.aggregate,
    ...(scored.abortHint ? { abortHint: scored.abortHint } : {}),
  }
}

function isUserExitPrescreenReply(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  if (!normalized) return false
  if (/^(stop|cancel|pause|quit|exit|end|not now|later|nevermind|never mind|退出|停止|暂停|先不|不用了|算了)[.!。！\s]*$/i.test(normalized)) {
    return true
  }
  return /^(please\s+)?(stop|cancel|pause|quit|exit|end)\b(?=.*\b(this|screen|role|interview|prescreen|pre-screen|for now|now|please)\b)[a-z0-9\s'’.-]*[.!?。！？\s]*$/i.test(normalized)
}

function hasIncompleteOnboardingQuestion(user: Record<string, unknown> | undefined): boolean {
  if (!user) return false
  if (user.onboardingState === "complete" || user.onboardingStatus === "complete") return false
  const pipeline = user.pipelineState && typeof user.pipelineState === "object"
    ? user.pipelineState as Record<string, unknown>
    : null
  if (pipeline?.completed === true) return false
  return typeof pipeline?.currentQId === "string" || /^q_[a-z0-9_]+_asked$/.test(String(user.onboardingState ?? ""))
}

function isLikelyPrescreenContinuationReply(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  if (!normalized) return false
  if (/\b(prescreen|pre-screen|role screen|job screen|screen|interview)\b/.test(normalized)) return true
  if (/\b(this|that|same)\s+(role|job|screen|interview)\b/.test(normalized)) return true
  if (/\b(reopen|continue|resume|restart|start over|try again)\b(?=.*\b(role|job|screen|interview|prescreen|pre-screen)\b)/.test(normalized)) {
    return true
  }
  return /\b(rain|software engineer|fullstack|full-stack|technical account manager|product manager|product designer)\b/.test(normalized)
}

async function shouldHandleRecentTerminalSession(args: {
  db: Firestore
  userId: string
  replyText: string
  log: (event: string, payload: Record<string, unknown>) => void
}): Promise<boolean> {
  let user: Record<string, unknown> | undefined
  try {
    const snap = await args.db.collection("pa-users").doc(args.userId).get()
    user = snap.data() as Record<string, unknown> | undefined
  } catch (err) {
    args.log("prescreen.turn.recent_terminal_user_lookup_failed", {
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  if (!hasIncompleteOnboardingQuestion(user)) return true
  if (isLikelyPrescreenContinuationReply(args.replyText)) return true
  args.log("prescreen.turn.recent_terminal_guard_yielded_to_onboarding", {
    userId: args.userId,
    onboardingState: user?.onboardingState ?? null,
    currentQId: (user?.pipelineState as Record<string, unknown> | undefined)?.currentQId ?? null,
  })
  return false
}

/**
 * Entry called from paMessageCoalescer before Claire dispatch. Returns
 * handled=false when no active prescreen session → coalescer continues
 * to Claire.
 */
export async function runPrescreenTurnIfActive(
  args: RunPrescreenTurnArgs
): Promise<RunPrescreenTurnResult> {
  const log = args.log ?? (() => {})
  const sendSms = args.sendSms ?? sendImessage
  const terminalAction = args.runTerminalAction ?? runPrescreenTerminalAction
  let lookup = await findActiveSession(args.db, args.userId, { log })
  if (lookup.kind === "none") {
    lookup = await findRecentTerminalSession(args.db, args.userId, { log })
  }
  if (lookup.kind === "none") return { handled: false }
  if (lookup.kind === "recent_terminal") {
    const shouldGuard = await shouldHandleRecentTerminalSession({
      db: args.db,
      userId: args.userId,
      replyText: args.replyText,
      log,
    })
    if (!shouldGuard) return { handled: false }
    const sessionRef = args.db.collection("pa-prescreen-sessions").doc(lookup.sessionId)
    const sessSnap = await sessionRef.get()
    const sessData = (sessSnap.data() ?? {}) as Record<string, unknown>
    const alreadyAcked = typeof sessData.postTerminalFollowupAckAt === "string"
    const nowIso = new Date().toISOString()

    await sessionRef.collection("turns").add({
      qId: "terminal",
      reply: args.replyText,
      action: {
        kind: "post_terminal_followup",
        terminal: lookup.terminal,
        reason: "recent_ended_prescreen_session",
      },
      ts: nowIso,
    })

    let text: string | undefined
    if (!alreadyAcked) {
      text = recentTerminalSessionText(args.lang ?? "en")
      try {
        await sendSms({ to: args.toE164, content: text, userId: args.userId, db: args.db })
        await sessionRef.set({ postTerminalFollowupAckAt: nowIso, updatedAt: nowIso }, { merge: true })
      } catch (err) {
        log("prescreen.turn.recent_terminal_ack_send_failed", {
          sessionId: lookup.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    log("prescreen.turn.recent_terminal_guard_handled", {
      sessionId: lookup.sessionId,
      userId: args.userId,
      terminal: lookup.terminal,
      acked: Boolean(text),
    })
    return {
      handled: true,
      sessionId: lookup.sessionId,
      terminal: lookup.terminal,
      textSent: text,
    }
  }
  if (lookup.kind === "expired") {
    try {
      await terminalAction({
        db: args.db,
        sessionId: lookup.sessionId,
        terminal: "PAUSE",
        userId: args.userId,
        jobId: lookup.jobId,
        toE164: args.toE164,
        lang: args.lang ?? "en",
        log,
      })
    } catch (err) {
      log("prescreen.turn.expired_terminal_action_failed", {
        sessionId: lookup.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const text = expiredSessionText(args.lang ?? "en")
    try {
      await sendSms({ to: args.toE164, content: text, userId: args.userId, db: args.db })
    } catch (err) {
      log("prescreen.turn.expired_notice_send_failed", {
        sessionId: lookup.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return { handled: true, sessionId: lookup.sessionId, terminal: "PAUSE", textSent: text }
  }

  const sessionId = lookup.sessionId

  const store = new FirestorePreScreenStore(args.db)
  const state = await store.load(sessionId)
  if (!state) return { handled: false }

  // Pull cfgSnapshot persisted at session start
  const sessRaw = await args.db.collection("pa-prescreen-sessions").doc(sessionId).get()
  const activeQIdRaw = sessRaw.data()?.currentQId
  const activeQId = typeof activeQIdRaw === "string" ? activeQIdRaw : null
  const loadedTerminal = state.terminal ?? null
  if (loadedTerminal !== null || !activeQId) {
    log("prescreen.turn.stale_terminal_session_ignored", {
      userId: args.userId,
      sessionId,
      terminal: loadedTerminal,
      currentQId: activeQId,
    })
    return { handled: false, sessionId, terminal: loadedTerminal }
  }
  const cfgSnapshot = sessRaw.data()?.cfgSnapshot as
    | { questions: Array<{ qId: string; prompt: { zh: string; en: string }; clarifyPrompt: { zh: string; en: string }; keywords: KeywordSpec[] }> }
    | undefined
  if (!cfgSnapshot?.questions) {
    log("prescreen.turn.no_config", { sessionId })
    return { handled: false }
  }

  if (isUserExitPrescreenReply(args.replyText)) {
    const nowIso = new Date().toISOString()
    await args.db
      .collection("pa-prescreen-sessions")
      .doc(sessionId)
      .set(
        {
          terminal: "PAUSE",
          terminalReason: "user_exit",
          currentQId: null,
          updatedAt: nowIso,
          workSession: {
            ...(state.workSession ?? { kind: "job_prescreen" }),
            kind: "job_prescreen",
            status: "ended",
            endedAt: nowIso,
            boundary: "user_exit",
          },
        },
        { merge: true },
      )
    await args.db
      .collection("pa-prescreen-sessions")
      .doc(sessionId)
      .collection("turns")
      .add({
        qId: activeQId ?? "terminal",
        reply: args.replyText,
        action: { kind: "terminal", terminal: "PAUSE", reason: "user_exit" },
        ts: nowIso,
      })
    try {
      await terminalAction({
        db: args.db,
        sessionId,
        terminal: "PAUSE",
        userId: args.userId,
        jobId: state.jobId,
        toE164: args.toE164,
        lang: args.lang ?? "en",
        log,
      })
    } catch (err) {
      log("prescreen.user_exit_terminal_action_failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const text = userExitSessionText(args.lang ?? "en")
    try {
      await sendSms({ to: args.toE164, content: text, userId: args.userId, db: args.db })
    } catch (err) {
      log("prescreen.user_exit_notice_send_failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    log("prescreen.turn.user_exit", { sessionId, userId: args.userId })
    return { handled: true, sessionId, terminal: "PAUSE", textSent: text }
  }

  // Build PreScreenQuestion bindings with production LLM caller
  const caller = args.keywordSetCaller ?? makeProductionKeywordSetCaller()
  const questions: Record<string, PreScreenQuestion> = {}
  for (const q of cfgSnapshot.questions) {
    questions[q.qId] = {
      qId: q.qId,
      prompt: q.prompt,
      clarifyPrompt: q.clarifyPrompt,
      judge: new KeywordSetJudge({
        questionId: q.qId,
        keywords: q.keywords,
        questionPrompt: q.prompt.en,
        llmCaller: caller,
      }),
    }
  }
  const pipeline = new PreScreenPipeline({
    questions,
    store,
    log,
    composeClarify: args.clarifyComposer ?? makeProductionClarifyComposer(),
  })
  const result = await pipeline.runTurn({
    sessionId,
    reply: args.replyText,
    lang: args.lang ?? "en",
    nowIso: new Date().toISOString(),
    judgeCtx: { userId: args.userId, turnId: `t_${Date.now()}` },
  })

  // Persist a turn record for dashboard observability
  const turnQId = prescreenTurnRecordQId(result.action, activeQId)
  const scored = prescreenTurnRecordScored(result.state, turnQId)
  await args.db
    .collection("pa-prescreen-sessions")
    .doc(sessionId)
    .collection("turns")
    .add({
      qId: turnQId,
      reply: args.replyText,
      ...(scored ? { scored } : {}),
      action: result.action,
      ts: new Date().toISOString(),
    })

  if (result.text) {
    try {
      await sendSms({ to: args.toE164, content: result.text, userId: args.userId, db: args.db })
    } catch (err) {
      log("prescreen.turn.send_failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log("prescreen.turn.handled", {
    sessionId,
    action: result.action.kind,
    terminal: result.state.terminal,
  })

  // v1.9 Phase 84 — post-terminal action (Level 1 reveal + auto job recs).
  // Fail-open: never roll back the terminal text on action failure.
  if (
    result.action.kind === "terminal" &&
    (result.action.terminal === "PASS" ||
      result.action.terminal === "FAIL" ||
      result.action.terminal === "HARD_STOP" ||
      result.action.terminal === "PAUSE")
  ) {
    try {
      await terminalAction({
        db: args.db,
        sessionId,
        terminal: result.action.terminal,
        userId: args.userId,
        jobId: result.state.jobId,
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

  return {
    handled: true,
    sessionId,
    terminal: result.state.terminal,
    textSent: result.text,
  }
}

function expiredSessionText(lang: "zh" | "en"): string {
  return lang === "zh"
    ? "这次岗位初筛我先暂停了，避免把旧对话和新的经历混在一起。想继续这个岗位的话，从岗位页面重新开始，我会开一个新的 screen。"
    : "I paused this role screen so I do not mix an old conversation with a new one. If you want to continue this role, reopen it from the job page and I will start a fresh screen."
}

function userExitSessionText(lang: "zh" | "en"): string {
  return lang === "zh"
    ? "好的，我先暂停这个岗位 screen。你之后想继续的话，从岗位页面重新开始就行；你已经分享过的经历我会保留在你的全局 profile 里。"
    : "Got it — I paused this role screen. If you want to continue later, reopen it from the job page; I will keep what you have already shared on your profile."
}

function recentTerminalSessionText(lang: "zh" | "en"): string {
  return lang === "zh"
    ? "收到。这个岗位 screen 已经暂停了；我会把这个约束记到你的 profile 里，后面只看更匹配的机会。"
    : "Got it. This role screen is already paused; I will keep that constraint on your profile and use it for better-matched roles."
}
