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
    await this.db
      .collection("pa-prescreen-sessions")
      .doc(state.sessionId)
      .set(state, { merge: false })
  }
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
async function findActiveSessionId(db: Firestore, userId: string): Promise<string | null> {
  const snap = await db
    .collection("pa-prescreen-sessions")
    .where("userId", "==", userId)
    .where("terminal", "==", null)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get()
  if (snap.empty) return null
  return snap.docs[0].id
}

export interface RunPrescreenTurnArgs {
  db: Firestore
  userId: string
  toE164: string
  replyText: string
  lang?: "zh" | "en"
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
  const sessionId = await findActiveSessionId(args.db, args.userId)
  if (!sessionId) return { handled: false }

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
      await sendImessage({ to: args.toE164, content: result.text })
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

  return {
    handled: true,
    sessionId,
    terminal: result.state.terminal,
    textSent: result.text,
  }
}
