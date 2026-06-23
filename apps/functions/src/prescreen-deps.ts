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
  buildKeywordSetPrompt,
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
      const { system, user } = buildKeywordSetPrompt({ reply, lang, keywords, questionPrompt })
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-5.4-nano",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
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

export function prescreenClarifyRoundGuidance(round: number, _lang: "zh" | "en"): string {
  const normalizedRound = Math.max(1, Math.floor(round))
  if (normalizedRound === 1)
    return "Find the closest relevant project: context, personal ownership, and user or business outcome."
  if (normalizedRound === 2)
    return "Probe ownership and system boundary: what they personally built, and which systems or data it touched."
  if (normalizedRound === 3)
    return "Probe the hardest failure, tradeoff, or validation: what broke, what they changed, and how they knew it worked."
  return "Final concrete check: smallest provable shipped work, measurable result, or explicit gap; do not keep circling."
}

export function normalizePrescreenClarifyTextForRound(text: string, round: number, _lang: "zh" | "en"): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return normalized
  const openerByRound = [
    "Got it - ",
    "The ownership piece matters here - ",
    "The systems detail is the useful signal - ",
    "One last concrete check before I score it - ",
  ]
  const idx = Math.min(Math.max(1, Math.floor(round)), openerByRound.length) - 1
  const genericAckPattern =
    /^(that'?s helpful|that is helpful|that helps|thanks|thank you|got it|interesting|nice)[\s,.:;!—-]*/i
  if (!genericAckPattern.test(normalized)) return normalized
  const withoutAck = normalized.replace(genericAckPattern, "").trim()
  if (!withoutAck) return normalized
  const replacement = `${openerByRound[idx]}${withoutAck.charAt(0).toLowerCase()}${withoutAck.slice(1)}`
  return replacement
}

export function makeProductionClarifyComposer(opts?: { voice?: boolean }): PreScreenClarifyComposer {
  // voice=true folds humanization INTO this single generation call (Adam 2026-06-23):
  // a spoken-phone system prompt + we SKIP normalizePrescreenClarifyTextForRound (the
  // robotic "Got it -" opener forcer), so the voice clarify needs no second-pass rewrite.
  // SMS (voice=false, the default) is byte-for-byte unchanged.
  const voice = opts?.voice === true
  return async (input) => {
    // Session-cumulative opener index + already-said list so openers rotate across
    // the WHOLE call (not reset to "Got it - " each question) and the model avoids
    // reusing its own prior follow-ups ("that helps" repetition).
    const priorClarifyTexts = (input.state.recentClarifyTexts ?? []).slice(-5)
    const sessionClarifyIndex = (input.state.recentClarifyTexts?.length ?? 0) + 1
    const hardFilterText = hardFilterClarifyText(input.question.qId, input.lang)
    // SMS: return the hard-filter line verbatim (normalized). Voice: fall through to the
    // LLM so the same required ask is SPOKEN naturally (anchored on hardFilterText below).
    if (hardFilterText && !voice) {
      return normalizePrescreenClarifyTextForRound(hardFilterText, sessionClarifyIndex, input.lang)
    }
    const apiKey = process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY
    if (!apiKey) {
      // Fail-safe: never wedge a live call — speak the deterministic ask if no key.
      if (voice) return hardFilterText ?? input.fallbackText
      throw new Error("missing OpenAI API key")
    }
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
    const system = voice
      ? [
          "You are Claire from WeKruit on a live PHONE call. Ask ONE warm, natural SPOKEN follow-up that probes like a thoughtful recruiter friend learning the candidate's story.",
          "Do not reject the candidate. Do not conclude fit. Do not repeat your prior phrasing.",
          "STAY ON the topic of the original question / required ask below — use the candidate's latest answer and the weak areas to ask the next most useful detail. Do NOT switch to an unrelated topic.",
          "NEVER reveal machinery or meta: no 'Got it', 'That helps', 'to score', 'fairly', 'compensation check', 'the ownership piece', 'the systems detail is the useful signal', 'I need to confirm', 'for the record'.",
          "No checklist, no 'X or Y' multiple-choice phrasing, no lists, no markdown, no emoji. Spoken English, contractions, 1-2 short sentences.",
          'Output strict JSON only: {"text":"..."}.',
        ].join("\n")
      : [
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
      ...(voice && hardFilterText
        ? [`This is a HARD REQUIREMENT to confirm — ask this exact thing, just spoken naturally: ${hardFilterText}`]
        : []),
      `Clarify round for this same question: ${input.clarifyRound}`,
      `Required probe angle for this round: ${prescreenClarifyRoundGuidance(input.clarifyRound, input.lang)}`,
      `Reason: ${input.reason}`,
      `Latest candidate reply: """${input.reply}"""`,
      `Prior answers for this same question: ${JSON.stringify(input.state.questions[input.question.qId]?.evidenceReplies ?? [])}`,
      `Follow-ups YOU already sent this call (do NOT reuse these openers or phrasings): ${JSON.stringify(priorClarifyTexts)}`,
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
        temperature: voice ? 0.5 : 0.2,
        response_format: { type: "json_object" },
      }),
    })
    if (!res.ok) {
      if (voice) return hardFilterText ?? input.fallbackText
      throw new Error(`OpenAI clarify ${res.status}: ${await res.text().catch(() => "?")}`)
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = json.choices?.[0]?.message?.content
    if (!content) {
      if (voice) return hardFilterText ?? input.fallbackText
      throw new Error("OpenAI clarify empty response")
    }
    const parsed = JSON.parse(content) as { text?: unknown }
    if (typeof parsed.text !== "string" || !parsed.text.trim()) {
      if (voice) return hardFilterText ?? input.fallbackText
      throw new Error("OpenAI clarify missing text")
    }
    // Voice: no robotic opener normalizer — the spoken prompt already produced a natural line.
    if (voice) return parsed.text.trim().slice(0, 400)
    return normalizePrescreenClarifyTextForRound(parsed.text, sessionClarifyIndex, input.lang)
  }
}
