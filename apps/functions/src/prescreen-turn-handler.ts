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
  type KeywordSetLlmCaller,
  type KeywordSetLlmOutput,
  type KeywordSpec,
  type PreScreenQuestion,
  type PreScreenState,
  type PreScreenStateProvider,
} from "@pa/pa-orchestrator"
import { sendImessage } from "./sendblue/sendblue-client.js"
import { runPrescreenTerminalAction } from "./prescreen-terminal-action.js"

const ACTIVE_PRESCREEN_TIMEOUT_MS = 60 * 60 * 1000

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

/**
 * Find active prescreen session for a user (terminal=null). Returns
 * sessionId or null if none.
 */
type ActivePrescreenLookup =
  | { kind: "none" }
  | { kind: "active"; sessionId: string }
  | { kind: "expired"; sessionId: string; jobId: string }

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
    .orderBy("createdAt", "desc")
    .limit(1)
    .get()
  if (snap.empty) return { kind: "none" }
  const doc = snap.docs[0]
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
  log?: (event: string, payload: Record<string, unknown>) => void
}

export interface RunPrescreenTurnResult {
  /** True when an active session was found and the reply was handled. */
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
  args: RunPrescreenTurnArgs
): Promise<RunPrescreenTurnResult> {
  const log = args.log ?? (() => {})
  const sendSms = args.sendSms ?? sendImessage
  const terminalAction = args.runTerminalAction ?? runPrescreenTerminalAction
  const lookup = await findActiveSession(args.db, args.userId, { log })
  if (lookup.kind === "none") return { handled: false }
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
  const cfgSnapshot = sessRaw.data()?.cfgSnapshot as
    | { questions: Array<{ qId: string; prompt: { zh: string; en: string }; clarifyPrompt: { zh: string; en: string }; keywords: KeywordSpec[] }> }
    | undefined
  if (!cfgSnapshot?.questions) {
    log("prescreen.turn.no_config", { sessionId })
    return { handled: false }
  }

  // Build PreScreenQuestion bindings with production LLM caller
  const caller = makeProductionKeywordSetCaller()
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
  const pipeline = new PreScreenPipeline({ questions, store, log })
  const result = await pipeline.runTurn({
    sessionId,
    reply: args.replyText,
    lang: args.lang ?? "en",
    nowIso: new Date().toISOString(),
    judgeCtx: { userId: args.userId, turnId: `t_${Date.now()}` },
  })

  // Persist a turn record for dashboard observability
  await args.db
    .collection("pa-prescreen-sessions")
    .doc(sessionId)
    .collection("turns")
    .add({
      qId: result.state.currentQId ?? "terminal",
      reply: args.replyText,
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
      await runPrescreenTerminalAction({
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
