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
 *   - runtime-approved outbox for outbound text
 */
import { createHash } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import {
  KeywordSetJudge,
  PreScreenPipeline,
  WEKRUIT_CANDIDATE_SOURCE,
  buildSharedOnboardingPrompt,
  buildSharedOnboardingPromptContext,
  buildSharedOnboardingStartedState,
  hardFilterClarifyText,
  loadSharedOnboardingParsedResumeForPrompt,
  type KeywordSetLlmCaller,
  type KeywordSetLlmOutput,
  type KeywordSpec,
  type PreScreenClarifyComposer,
  type PreScreenQuestion,
  type PreScreenState,
  type PreScreenStateProvider,
  prescreenSessionToEvaluationAttempt,
} from "@pa/pa-orchestrator"
import { PA_COLLECTIONS } from "@pa/core-types"
import { saveEvaluationAttempt } from "@pa/pa-persistence"
import { SAFETY_CANNED_REPLIES, pickLangForSafety, runSafetyCheck } from "@pa/pa-safety"
import { sendRuntimeApprovedIMessage } from "./runtime-approved-outbox.js"
import { runPrescreenTerminalAction, writePrescreenMemoryUpdate } from "./prescreen-terminal-action.js"
import { isLayoffIntakeActiveForUser } from "./layoff-sms-start.js"

const ACTIVE_PRESCREEN_TIMEOUT_MS = 60 * 60 * 1000
const RECENT_TERMINAL_PRESCREEN_GUARD_MS = 60 * 60 * 1000

type RuntimeSmsSender = (args: {
  to: string
  content: string
  userId?: string
  db?: Firestore
  runtimeSource?: string
  idempotencyKey?: string
}) => Promise<unknown>

function stablePrescreenSendKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 32)
}

async function writePrescreenEvaluationAttempt(args: {
  db: Firestore
  state: PreScreenState
  cfgSnapshot?: { questions?: unknown[]; threshold?: number; confidenceThreshold?: number }
  terminal: "PASS" | "FAIL" | "HARD_STOP" | "PAUSE"
  log: (event: string, payload: Record<string, unknown>) => void
}): Promise<string | null> {
  try {
    const attempt = prescreenSessionToEvaluationAttempt({
      state: args.state,
      cfgSnapshot: args.cfgSnapshot as Parameters<typeof prescreenSessionToEvaluationAttempt>[0]["cfgSnapshot"],
      terminal: args.terminal,
      nowIso: new Date().toISOString(),
      evaluator: { kind: "hybrid", promptVersion: "prescreen-keyword-set-v1" },
    })
    await saveEvaluationAttempt(args.db, attempt)
    await args.db
      .collection("pa-prescreen-sessions")
      .doc(args.state.sessionId)
      .set(
        {
          evaluationAttemptId: attempt.attemptId,
          terminalActionPendingReview: true,
          updatedAt: attempt.updatedAt,
        },
        { merge: true },
      )
    args.log("prescreen.evaluation_attempt.created", {
      sessionId: args.state.sessionId,
      attemptId: attempt.attemptId,
      proposedOutcome: attempt.proposedOutcome.kind,
      terminal: args.terminal,
    })
    return attempt.attemptId
  } catch (err) {
    args.log("prescreen.evaluation_attempt.create_failed", {
      sessionId: args.state.sessionId,
      terminal: args.terminal,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

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

    const sessionEvidence = prescreenSessionEvidenceContext(input.state, input.question.qId)
    const qSpecificGuidance = prescreenClarifyRoundGuidance(input.clarifyRound, input.lang, input.question.qId)

    const system = [
      "You are Claire, a candidate prescreening agent.",
      "Write ONE warm iMessage follow-up that probes like a thoughtful recruiter friend learning the candidate's story.",
      "Do not reject the candidate. Do not conclude fit. Do not repeat the prior generic clarify wording.",
      "Do not start with the same generic acknowledgment every round; avoid repeated 'That's helpful' / 'That helps' openers.",
      "Use the candidate's latest answer and weak evidence to ask the next most useful detail.",
      "Do not ask a checklist. Pick one natural angle: their role, technical depth, systems touched, tradeoff, failure, user/customer impact, or measurable outcome.",
      "Do not ask for business impact, ownership, systems touched, or validation again if the session evidence already covers it. Ask for the missing signal instead.",
      "For technical-depth questions, prefer the weakest required technology or implementation detail; do not drift back to role-fit impact/ownership unless that is the only missing signal.",
      "Keep it under 360 characters. Output strict JSON only: {\"text\":\"...\"}.",
    ].join("\n")

    const userMsg = [
      `Language: ${input.lang}`,
      `Question id: ${input.question.qId}`,
      `Original question: ${input.question.prompt[input.lang]}`,
      `Clarify round for this same question: ${input.clarifyRound}`,
      `Required probe angle for this round: ${qSpecificGuidance}`,
      `Reason: ${input.reason}`,
      `Latest candidate reply: """${input.reply}"""`,
      `Prior answers for this same question: ${JSON.stringify(input.state.questions[input.question.qId]?.evidenceReplies ?? [])}`,
      `Already-covered session evidence from other questions: ${sessionEvidence}`,
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

export function prescreenClarifyRoundGuidance(round: number, lang: "zh" | "en", qId?: string): string {
  const normalizedRound = Math.max(1, Math.floor(round))
  if (qId === "technical_depth") {
    if (lang === "zh") {
      if (normalizedRound === 1) return "追问最弱的必备技术栈或实现细节；不要重复 role-fit 里的 impact/ownership。"
      if (normalizedRound === 2) return "追问具体工程实现：代码、数据、API、调试或架构取舍；避免重新问业务影响。"
      if (normalizedRound === 3) return "确认技术深度缺口：候选人是否真的做过该技术、做到什么程度、哪里没做过。"
      return "最后一次技术确认：最小可证明 shipped technical work 或明确缺口；不要继续绕回项目影响。"
    }
    if (normalizedRound === 1) return "Probe the weakest required technology or implementation detail; do not repeat role-fit impact/ownership."
    if (normalizedRound === 2) return "Probe concrete engineering depth: code, data, APIs, debugging, or architecture tradeoff; avoid re-asking business impact."
    if (normalizedRound === 3) return "Confirm the technical gap: whether they used the required tech, depth of use, and what they did not own."
    return "Final technical check: smallest provable shipped technical work or explicit gap; do not circle back to project impact."
  }
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

export function prescreenSessionEvidenceContext(
  state: { questions?: Record<string, { evidenceReplies?: unknown }> },
  activeQId: string,
): string {
  const rows: string[] = []
  for (const [qId, qState] of Object.entries(state.questions ?? {})) {
    if (qId === activeQId) continue
    const replies = Array.isArray(qState?.evidenceReplies) ? qState.evidenceReplies : []
    const cleanReplies = replies
      .filter((reply): reply is string => typeof reply === "string")
      .map((reply) => reply.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(-3)
    if (!cleanReplies.length) continue
    rows.push(`${qId}: ${cleanReplies.join(" | ")}`.slice(0, 1200))
  }
  return rows.length ? rows.join("\n") : "none"
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
  sendSms?: RuntimeSmsSender
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
  | { kind: "safety_block"; reason: string; signals?: string[] }
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

async function maybeHandlePrescreenSafetyBlock(args: {
  db: Firestore
  userId: string
  toE164: string
  replyText: string
  sessionId: string
  sendSms: RuntimeSmsSender
  log: (event: string, payload: Record<string, unknown>) => void
}): Promise<RunPrescreenTurnResult | null> {
  const verdict = await runSafetyCheck(
    args.db,
    { userId: args.userId, channel: "imessage", text: args.replyText },
    { promptInjection: true },
  )
  if (verdict.verdict !== "block") return null

  const lang = pickLangForSafety(args.replyText)
  let text: string | null
  if (verdict.action === "silent_drop") {
    text = null
  } else if (verdict.action === "escalate") {
    text = SAFETY_CANNED_REPLIES.escalate[lang]
  } else if (verdict.action === "respond_sanitized") {
    text = SAFETY_CANNED_REPLIES.respond_sanitized[lang]
  } else {
    text = "I can’t work with that message. Try rephrasing."
  }

  const nowIso = new Date().toISOString()
  const sessionRef = args.db.collection("pa-prescreen-sessions").doc(args.sessionId)
  await sessionRef.collection("turns").add({
    qId: "safety",
    reply: args.replyText,
    action: {
      kind: "safety_block",
      reason: verdict.layer ?? verdict.reasons[0] ?? "safety_block",
      signals: verdict.signals,
    },
    ts: nowIso,
  })
  await sessionRef.set({ updatedAt: nowIso }, { merge: true })

  if (text !== null) {
    await args.sendSms({
      to: args.toE164,
      content: text,
      userId: args.userId,
      db: args.db,
      runtimeSource: "pa_prescreen_runtime",
      idempotencyKey: `prescreen_safety:${args.sessionId}:${stablePrescreenSendKey(args.replyText, text)}`,
    })
  }

  args.log("prescreen.turn.safety_blocked", {
    userId: args.userId,
    sessionId: args.sessionId,
    action: verdict.action,
    layer: verdict.layer,
    signals: verdict.signals,
    replied: text !== null,
  })
  return { handled: true, sessionId: args.sessionId, textSent: text ?? undefined }
}

function isUserExitPrescreenReply(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  if (!normalized) return false
  if (/^(stop|cancel|pause|quit|exit|end|not now|later|nevermind|never mind|退出|停止|暂停|先不|不用了|算了)[.!。！\s]*$/i.test(normalized)) {
    return true
  }
  const hasExitVerb = /\b(stop|cancel|pause|quit|exit|end)\b/i.test(normalized)
  const hasScreenContext = /\b(this|screen|role|interview|prescreen|pre-screen|job)\b/i.test(normalized)
  const hasDeferralContext = /\b(for now|not now|later|come back|continue later|resume later)\b/i.test(normalized)
  const startsLikeRequest = /^(can|could|may)\s+(we|i)\b/i.test(normalized) || /^let[’']?s\b/i.test(normalized) || /\bplease\b/i.test(normalized)
  if (hasExitVerb && hasScreenContext && (hasDeferralContext || startsLikeRequest)) {
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
  const onboardingState = String(user.onboardingState ?? "")
  const onboardingStatus = String(user.onboardingStatus ?? "")
  return (
    typeof pipeline?.currentQId === "string" ||
    /^q_[a-z0-9_]+_asked$/.test(onboardingState) ||
    ["pending", "invited", "started", "in_progress"].includes(onboardingState) ||
    ["pending", "invited", "started", "in_progress"].includes(onboardingStatus)
  )
}

function detectSimpleYesNo(body: string): "yes" | "no" | "ambiguous" {
  const normalized = body.trim().toLowerCase()
  if (!normalized) return "ambiguous"
  if (
    /^(no|nope|nah|pass|skip|later|not now|don'?t|do not|no thanks|no thank you)\b/i.test(normalized) ||
    /\b(not right now|i'?m good|i am good|good for now|i'?ll pass|i will pass|don'?t want|do not want)\b/i.test(normalized)
  ) {
    return "no"
  }
  if (/^(yes|yeah|yep|yup|sure|ok|okay|alright|all right|sounds good|please|go ahead|let'?s|down)\b/i.test(normalized)) {
    return "yes"
  }
  return "ambiguous"
}

function postPrescreenOnboardingPrompt(lang: "zh" | "en", terminal?: string | null): string {
  if (lang === "zh") {
    return terminal === "PASS"
      ? "感谢回答，这次岗位初筛已经完成。下一步如果匹配合适，我会直接帮你安排和 hiring manager 沟通。同时我也可以继续帮你找更符合期待的岗位，不过需要先更了解你一点。要继续吗？"
      : "这次 screen 先到这里。我可以继续帮你找更符合期待的岗位，不过需要先更了解你一点。要继续吗？"
  }
  return terminal === "PASS"
    ? "Thanks for your answers — the role-fit screen is complete. For the next step, I'll schedule you directly with the hiring manager once there's a match. Meanwhile, I can help find jobs that meet your expectations, but I need to understand you a bit better first. Do you want to proceed?"
    : "Thanks for taking the time. I can help find jobs that meet your expectations, but I need to understand you a bit better first. Do you want to proceed?"
}

async function markUserPrescreenWorkSessionEnded(args: {
  db: Firestore
  userId: string
  sessionId: string
  jobId: string
  terminal: string
  nowIso: string
}): Promise<void> {
  await args.db.collection(PA_COLLECTIONS.users).doc(args.userId).set(
    {
      workSession: {
        kind: "job_prescreen",
        status: "ended",
        boundary: "terminal",
        endedAt: args.nowIso,
        sessionId: args.sessionId,
        jobId: args.jobId,
        terminal: args.terminal,
      },
      updatedAt: args.nowIso,
    },
    { merge: true },
  )
}

async function startSharedOnboardingAfterPrescreen(args: {
  db: Firestore
  userId: string
  toE164: string
  nowIso: string
  sendSms: RuntimeSmsSender
  log: (event: string, payload: Record<string, unknown>) => void
  sessionId: string
}): Promise<string> {
  const userRef = args.db.collection(PA_COLLECTIONS.users).doc(args.userId)
  const userSnap = await userRef.get()
  const user = (userSnap.data() ?? {}) as Record<string, unknown>
  if (user.onboardingState === "complete" || user.onboardingStatus === "complete") {
    const doneText = "Great — I already have your basic profile context, so there’s nothing else you need to answer right now. I’ll reach out when there’s a strong next match."
    await args.sendSms({
      to: args.toE164,
      content: doneText,
      userId: args.userId,
      db: args.db,
      runtimeSource: "pa_prescreen_retention_onboarding",
      idempotencyKey: `prescreen_retention_onboarding_complete:${args.sessionId}`,
    })
    return doneText
  }

  const parsedResume = await loadSharedOnboardingParsedResumeForPrompt(
    args.db,
    args.userId,
    user,
    (event, payload) => args.log(`shared_onboarding.${event}`, payload ?? {}),
  )
  const promptContext = buildSharedOnboardingPromptContext({ user, parsedResume })
  const startedFields = buildSharedOnboardingStartedState(
    args.nowIso,
    WEKRUIT_CANDIDATE_SOURCE,
    promptContext,
  )
  await userRef.set(
    {
      ...startedFields,
      candidateContext: {
        sms: {
          phoneE164: args.toE164,
          smsTriggeredAt: args.nowIso,
        },
      },
      smsState: "shared-onboarding-started-after-prescreen",
      smsThreadId: `iMessage;-;${args.toE164}`,
      updatedAt: args.nowIso,
    },
    { merge: true },
  )
  const q1 = buildSharedOnboardingPrompt("main_goal", promptContext)
  const text = `Great — thanks for completing the role screen. I’ll use what you shared there, and I just need a bit more context for future matches. ${q1}`
  await args.sendSms({
    to: args.toE164,
    content: text,
    userId: args.userId,
    db: args.db,
    runtimeSource: "pa_prescreen_retention_onboarding",
    idempotencyKey: `prescreen_retention_onboarding:${args.sessionId}`,
  })
  return text
}

function isLikelyPrescreenContinuationReply(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  if (!normalized) return false
  if (/\b(?:what(?:'s|\s+is|\s+are)?|whats)\s+(?:the\s+)?next\s+steps?\b/.test(normalized)) return true
  if (/\bwhat\s+happens\s+next\b/.test(normalized)) return true
  if (/\b(prescreen|pre-screen|role screen|job screen|screen|interview)\b/.test(normalized)) return true
  if (/\b(this|that|same)\s+(role|job|screen|interview)\b/.test(normalized)) return true
  if (/\b(reopen|continue|resume|restart|start over|try again)\b(?=.*\b(role|job|screen|interview|prescreen|pre-screen)\b)/.test(normalized)) {
    return true
  }
  return /\b(rain|software engineer|fullstack|full-stack|technical account manager|product manager|product designer)\b/.test(normalized)
}

function isJobSearchRequest(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  if (!normalized) return false
  if (/(?:找|推荐|匹配|看看|发)(?:一些|几个|点)?\s*(?:工作|岗位|机会|职位|内推)/.test(normalized)) {
    return true
  }
  return /\b(?:find|get|show|send|pull|recommend|match|search|look\s+for|help\s+me\s+find)\b[^.!?]{0,80}\b(?:jobs?|roles?|positions?|opportunities|openings|listings|matches|swe|software\s+engineering|software\s+engineer)\b/i.test(normalized)
}

function isJobRecommendationExplanationRequest(reply: string): boolean {
  const body = reply.trim()
  if (!body) return false
  const lower = body.toLowerCase()
  const asksQuestion =
    /[?？]/.test(body) ||
    /\b(?:why|what|which|how|can\s+you|tell\s+me|explain|answer)\b/i.test(body) ||
    /(?:为什么|为啥|哪里|哪点|怎么|解释|推荐理由|匹配原因)/.test(body)
  if (!asksQuestion) return false
  const hasJobContext =
    /\b(?:recommend(?:ed)?|matching?|matched|jobs?|roles?|positions?|opportunities|openings|internships?|co-?ops?|company|rain|constant\s+contact|fullstack)\b/i.test(body) ||
    /(?:推荐|匹配|岗位|职位|工作|机会|实习|公司)/.test(body)
  if (!hasJobContext) return false
  return (
    /\bwhich\s+(?:jobs?|roles?|positions?|opportunities|matches)\b[\s\S]{0,120}\b(?:fit|fits|match|matches|best|make\s+sense)\b/i.test(body) ||
    /\bbest\s+(?:current\s+)?(?:match|fit|role|job|opportunity)\b/i.test(body) ||
    /\bwhether\b[\s\S]{0,140}\b(?:rain|fullstack|role|job)\b[\s\S]{0,140}\b(?:still\s+)?(?:makes?\s+sense|fits?|matches?)\b/i.test(body) ||
    /\blower\s+priority\b[\s\S]{0,120}\b(?:jobs?|roles?|internships?|co-?ops?)\b/i.test(lower) ||
    /\b(?:jobs?|roles?|internships?|co-?ops?)\b[\s\S]{0,120}\blower\s+priority\b/i.test(lower) ||
    /\bwhy\s+(?:did\s+you\s+)?recommend\b/i.test(body) ||
    /\bwhat\s+part\b[\s\S]{0,120}\bmatch(?:ed|es)?\b/i.test(body) ||
    /\bwhy\s+(?:is|was|did|does)?\s*.*\bmatch(?:ed|es|ing)?\b/i.test(body) ||
    /\b(?:deprioritize|prioritize|prefer|rather|instead\s+of)\b[\s\S]{0,120}\b(?:jobs?|roles?|internships?|co-?ops?|startups?|fullstack)\b/i.test(lower) ||
    /(?:推荐理由|匹配原因|为什么推荐|为什么匹配)/.test(body)
  )
}

function isExplicitNewIntentAfterTerminal(reply: string): boolean {
  return isJobRecommendationExplanationRequest(reply) || isJobSearchRequest(reply)
}

function isShortTerminalAck(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  return /^(ok|okay|yes|yeah|yep|sure|alright|all right|go ahead|proceed|got it|thanks|thank you|sounds good|明白|收到|好的|谢谢|行|可以)[.!。！\s]*$/i.test(normalized)
}

function isPostPrescreenProceedReply(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  return /^(yes|yeah|yep|sure|go ahead|proceed|continue|let'?s do it|start|可以|继续|好|好的|行)[.!。！\s]*$/i.test(normalized)
}

function isPostTerminalConstraintUpdate(reply: string): boolean {
  const normalized = reply.trim().toLowerCase()
  if (!normalized) return false
  if (/^(remote|hybrid|onsite|sf|nyc|new york|los angeles|la|bay area|us|usa)\b.{0,80}\b(only|preferred|works|fine|ok|okay)?[.!。！\s]*$/i.test(normalized)) {
    return true
  }
  if (/\b(still|also|actually|for this|about this|constraint|preference|prefer|need|cannot|can't|won't|wouldn'?t)\b(?=.*\b(remote|relocat\w*|location|salary|comp|visa|sponsor|h-?1b|opt|work authorization|authorized|range)\b)/i.test(normalized)) {
    return true
  }
  return false
}

function isRecentTerminalFollowupReply(reply: string): boolean {
  if (isExplicitNewIntentAfterTerminal(reply)) return false
  return (
    isLikelyPrescreenContinuationReply(reply) ||
    isShortTerminalAck(reply) ||
    isPostTerminalConstraintUpdate(reply)
  )
}

async function shouldHandleRecentTerminalSession(args: {
  db: Firestore
  userId: string
  replyText: string
  terminal?: string | null
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
  const onboardingIncomplete = hasIncompleteOnboardingQuestion(user)
  if (args.terminal === "PASS") {
    if (isPostPrescreenProceedReply(args.replyText) && onboardingIncomplete) {
      args.log("prescreen.turn.recent_terminal_guard_yielded_to_onboarding", {
        userId: args.userId,
        onboardingState: user?.onboardingState ?? null,
        currentQId: (user?.pipelineState as Record<string, unknown> | undefined)?.currentQId ?? null,
        reason: "post_prescreen_proceed",
      })
      return false
    }
    if (!isExplicitNewIntentAfterTerminal(args.replyText)) return true
  }
  if (isRecentTerminalFollowupReply(args.replyText)) return true
  if (!onboardingIncomplete) {
    args.log("prescreen.turn.recent_terminal_guard_yielded_to_runtime", {
      userId: args.userId,
      reason: "not_prescreen_followup",
    })
    return false
  }
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
  const sendSms = args.sendSms ?? sendRuntimeApprovedIMessage
  const terminalAction = args.runTerminalAction ?? runPrescreenTerminalAction
  if (await isLayoffIntakeActiveForUser(args.db, args.userId)) {
    log("prescreen.turn.yielded_to_layoff_onboarding", { userId: args.userId })
    return { handled: false }
  }
  let lookup = await findActiveSession(args.db, args.userId, { log })
  if (lookup.kind === "none") {
    lookup = await findRecentTerminalSession(args.db, args.userId, { log })
  }
  if (lookup.kind === "none") return { handled: false }

  const safetyBlock = await maybeHandlePrescreenSafetyBlock({
    db: args.db,
    userId: args.userId,
    toE164: args.toE164,
    replyText: args.replyText,
    sessionId: lookup.sessionId,
    sendSms,
    log,
  })
  if (safetyBlock) return safetyBlock

  if (lookup.kind === "recent_terminal") {
    const shouldGuard = await shouldHandleRecentTerminalSession({
      db: args.db,
      userId: args.userId,
      replyText: args.replyText,
      terminal: lookup.terminal,
      log,
    })
    if (!shouldGuard) return { handled: false }
    const sessionRef = args.db.collection("pa-prescreen-sessions").doc(lookup.sessionId)
    const sessSnap = await sessionRef.get()
    const sessData = (sessSnap.data() ?? {}) as Record<string, unknown>
    const alreadyAcked = typeof sessData.postTerminalFollowupAckAt === "string"
    const nowIso = new Date().toISOString()
    const retention = sessData.postPrescreenRetention && typeof sessData.postPrescreenRetention === "object"
      ? sessData.postPrescreenRetention as Record<string, unknown>
      : null
    const retentionStage = typeof retention?.stage === "string" ? retention.stage : null

    await sessionRef.collection("turns").add({
      qId: "terminal",
      reply: args.replyText,
      action: {
        kind: retentionStage === "await_basic_onboarding" || retentionStage === "await_daily_opt_in" || !alreadyAcked
          ? "post_prescreen_retention"
          : "post_terminal_followup",
        terminal: lookup.terminal,
        reason: "recent_ended_prescreen_session",
      },
      ts: nowIso,
    })

    let text: string | undefined
    if (retentionStage === "await_basic_onboarding" || retentionStage === "await_daily_opt_in" || !alreadyAcked) {
      const yn = detectSimpleYesNo(args.replyText)
      if (yn === "ambiguous") {
        text = postPrescreenOnboardingPrompt(args.lang ?? "en", lookup.terminal)
        try {
          await sendSms({
            to: args.toE164,
            content: text,
            userId: args.userId,
            db: args.db,
            runtimeSource: "pa_prescreen_runtime",
            idempotencyKey: `prescreen_retention_prompt:${lookup.sessionId}`,
          })
          await sessionRef.set(
            {
              postTerminalFollowupAckAt: nowIso,
              updatedAt: nowIso,
              postPrescreenRetention: {
                stage: "await_basic_onboarding",
                terminal: lookup.terminal,
                startedAt: typeof retention?.startedAt === "string" ? retention.startedAt : nowIso,
                updatedAt: nowIso,
              },
            },
            { merge: true },
          )
        } catch (err) {
          log("prescreen.turn.post_prescreen_retention_prompt_failed", {
            sessionId: lookup.sessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } else {
        if (yn === "yes") {
          try {
            text = await startSharedOnboardingAfterPrescreen({
              db: args.db,
              userId: args.userId,
              toE164: args.toE164,
              nowIso,
              sendSms,
              log,
              sessionId: lookup.sessionId,
            })
          } catch (err) {
            text = "Great — thanks for completing the role screen. What kind of next role would actually be worth your time?"
            log("prescreen.turn.post_prescreen_onboarding_start_failed", {
              sessionId: lookup.sessionId,
              error: err instanceof Error ? err.message : String(err),
            })
            await sendSms({
              to: args.toE164,
              content: text,
              userId: args.userId,
              db: args.db,
              runtimeSource: "pa_prescreen_runtime",
              idempotencyKey: `prescreen_retention_yes_fallback:${lookup.sessionId}`,
            })
          }
        } else {
          text = "No problem. We’ll keep this role screen complete. If you want help with broader matches later, just tell me what you’re looking for here."
          try {
            await sendSms({
              to: args.toE164,
              content: text,
              userId: args.userId,
              db: args.db,
              runtimeSource: "pa_prescreen_runtime",
              idempotencyKey: `prescreen_retention_no:${lookup.sessionId}`,
            })
          } catch (err) {
            log("prescreen.turn.post_prescreen_retention_no_send_failed", {
              sessionId: lookup.sessionId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        await sessionRef.set(
          {
            postTerminalFollowupAckAt: nowIso,
            updatedAt: nowIso,
            postPrescreenRetention: {
              stage: yn === "yes" ? "onboarding_started" : "onboarding_declined",
              terminal: lookup.terminal,
              basicOnboardingOptIn: yn === "yes",
              startedAt: typeof retention?.startedAt === "string" ? retention.startedAt : nowIso,
              updatedAt: nowIso,
            },
          },
          { merge: true },
        )
      }
    } else if (!alreadyAcked) {
      text = recentTerminalSessionText(args.lang ?? "en", lookup.terminal)
      try {
        await sendSms({
          to: args.toE164,
          content: text,
          userId: args.userId,
          db: args.db,
          runtimeSource: "pa_prescreen_runtime",
          idempotencyKey: `prescreen_recent_terminal:${lookup.sessionId}`,
        })
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
      await sendSms({
        to: args.toE164,
        content: text,
        userId: args.userId,
        db: args.db,
        runtimeSource: "pa_prescreen_runtime",
        idempotencyKey: `prescreen_expired:${lookup.sessionId}`,
      })
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
      await sendSms({
        to: args.toE164,
        content: text,
        userId: args.userId,
        db: args.db,
        runtimeSource: "pa_prescreen_runtime",
        idempotencyKey: `prescreen_user_exit:${sessionId}`,
      })
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
      await sendSms({
        to: args.toE164,
        content: result.text,
        userId: args.userId,
        db: args.db,
        runtimeSource: "pa_prescreen_runtime",
        idempotencyKey: `prescreen_turn:${sessionId}:${turnQId}:${stablePrescreenSendKey(args.replyText, result.text)}`,
      })
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

  // Screening eval invariant: terminal scoring creates a review artifact only.
  // Employment-impacting downstream actions (Level 1 reveal, PII/recs, employer
  // visibility) are now behind operator commit via paReviewEvaluationAttempt.
  if (
    result.action.kind === "terminal" &&
    (result.action.terminal === "PASS" ||
      result.action.terminal === "FAIL" ||
      result.action.terminal === "HARD_STOP" ||
      result.action.terminal === "PAUSE")
  ) {
    const terminalAt = result.state.updatedAt ?? new Date().toISOString()
    await writePrescreenMemoryUpdate({
      db: args.db,
      sessionId,
      userId: args.userId,
      jobId: result.state.jobId,
      terminal: result.action.terminal,
      occurredAt: terminalAt,
      log,
    })
    await writePrescreenEvaluationAttempt({
      db: args.db,
      state: result.state,
      cfgSnapshot,
      terminal: result.action.terminal,
      log,
    })
    await markUserPrescreenWorkSessionEnded({
      db: args.db,
      userId: args.userId,
      sessionId,
      jobId: result.state.jobId,
      terminal: result.action.terminal,
      nowIso: terminalAt,
    }).catch((err) => {
      log("prescreen.turn.user_work_session_end_failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    if (result.action.terminal !== "PAUSE") {
      await args.db.collection("pa-prescreen-sessions").doc(sessionId).set(
        {
          postPrescreenRetention: {
            stage: "await_basic_onboarding",
            terminal: result.action.terminal,
            startedAt: terminalAt,
            updatedAt: terminalAt,
          },
          updatedAt: terminalAt,
        },
        { merge: true },
      )
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

function recentTerminalSessionText(lang: "zh" | "en", terminal?: string | null): string {
  return postPrescreenOnboardingPrompt(lang, terminal)
}
