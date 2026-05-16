/**
 * v2.2 — Shared prescreen LLM wirings + Firestore PreScreenStateProvider.
 *
 * Hoisted from prescreen-turn-handler.ts (SMS adapter) so the voice CF
 * (paVoicePrescreenTurn) reuses the same gpt-5.4-nano keyword scorer +
 * clarify composer. Same brain across channels per CLAUDE.md zero-rebuild
 * mandate.
 */
import type { Firestore } from "firebase-admin/firestore"
import {
  hardFilterClarifyText,
  type KeywordSetLlmCaller,
  type KeywordSetLlmOutput,
  type PreScreenClarifyComposer,
  type PreScreenState,
  type PreScreenStateProvider,
} from "@pa/pa-orchestrator"

/* ────────────────────────────────────────────────────────────────────────── */
/* FirestorePreScreenStore — merge:true so cfgSnapshot + e164 survive writes. */
/* ────────────────────────────────────────────────────────────────────────── */

export class FirestorePreScreenStore implements PreScreenStateProvider {
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
      .set(stripUndefined(state) as PreScreenState, { merge: true })
  }
}

export function stripUndefined<T>(v: T): T {
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
/* Production gpt-5.4-nano LLM wirings                                        */
/* ────────────────────────────────────────────────────────────────────────── */

export function makeProductionKeywordSetCaller(): KeywordSetLlmCaller {
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

export function makeProductionClarifyComposer(): PreScreenClarifyComposer {
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
