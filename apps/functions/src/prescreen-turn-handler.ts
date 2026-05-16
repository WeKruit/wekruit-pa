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
  hardFilterClarifyText,
  prescreenTurnRecordQId as orchestratorPrescreenTurnRecordQId,
  runPrescreenTurn,
  type KeywordSetLlmCaller,
  type KeywordSetLlmOutput,
  type PreScreenClarifyComposer,
  type PreScreenState,
  type PreScreenStateProvider,
  type PrescreenChannelTextHint,
  type PrescreenConfig,
  type PrescreenRunnerDeps,
  type PrescreenTurnAction,
} from "@pa/pa-orchestrator"
import { sendImessage } from "./sendblue/sendblue-client.js"
import { runPrescreenTerminalAction } from "./prescreen-terminal-action.js"

/* ────────────────────────────────────────────────────────────────────────── */
/* Firestore PreScreenStateProvider (kept inline; merge:true preserves        */
/* sibling fields like cfgSnapshot + e164 + workSession metadata).            */
/* ────────────────────────────────────────────────────────────────────────── */

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
    // Firestore Admin SDK rejects `undefined` field values unless
    // ignoreUndefinedProperties is set. KeywordSetJudge omits optional
    // fields (abortHint, etc.) as undefined; strip recursively first.
    //
    // v2.2 — switched to merge:true so the runner's state writes do not
    // wipe sibling fields the SMS handler used to set inline (cfgSnapshot,
    // e164, postTerminalFollowupAckAt).
    await this.db
      .collection("pa-prescreen-sessions")
      .doc(state.sessionId)
      .set(stripUndefined(state) as PreScreenState, { merge: true })
  }
}

function stripUndefined<T>(v: T): T {
  if (v === null || v === undefined) return v
  if (Array.isArray(v)) return v.map((x) => stripUndefined(x)) as unknown as T
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

/* ────────────────────────────────────────────────────────────────────────── */
/* Production LLM wirings — gpt-5.4-nano                                      */
/* ────────────────────────────────────────────────────────────────────────── */

function makeProductionKeywordSetCaller(): KeywordSetLlmCaller {
  return {
    async score({ reply, lang, keywords, questionPrompt }) {
      const apiKey = process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY
      if (!apiKey) throw new Error("missing OpenAI API key")
      const keywordList = keywords
        .map(
          (k, i) =>
            `${i + 1}. "${k.keyword}" (weight ${(k.weight ?? 1).toFixed(2)})${k.hint ? ` hint: ${k.hint}` : ""}`,
        )
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
  if (normalizedRound === 1)
    return "Find the closest relevant project: context, personal ownership, and user or business outcome."
  if (normalizedRound === 2)
    return "Probe ownership and system boundary: what they personally built, and which systems or data it touched."
  if (normalizedRound === 3)
    return "Probe the hardest failure, tradeoff, or validation: what broke, what they changed, and how they knew it worked."
  return "Final concrete check: smallest provable shipped work, measurable result, or explicit gap; do not keep circling."
}

export function normalizePrescreenClarifyTextForRound(text: string, round: number, lang: "zh" | "en"): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return normalized

  const openerByRound =
    lang === "zh"
      ? ["明白 - ", "这里 ownership 很关键 - ", "这个系统细节有用 - ", "最后我确认一个具体点 - "]
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
