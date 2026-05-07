/**
 * iter30 WS2 P2 — Layer 2: FREE Qwen-7B (SiliconFlow) normalize.
 *
 * Adam-locked constraints:
 *  - FREE Qwen2.5-7B-Instruct on SiliconFlow — NOT V4-Flash, NOT paid.
 *  - 429 → write pa-alerts/qwen-7b-rate-limit-{date} + log. Fail-open:
 *    mark event pending-review, no canonical yet.
 *  - timeout/429 → status="pending-review", no canonical.
 *  - English-only canonical output.
 *
 * Spec: ws-2-7-detail.md §4 Layer 2.
 */

import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"

/** Qwen-7B endpoint on SiliconFlow (free-tier, OpenAI-compat). */
const SILICONFLOW_BASE = "https://api.siliconflow.cn/v1"
const QWEN7B_MODEL = "Qwen/Qwen2.5-7B-Instruct"

// ─── Types ────────────────────────────────────────────────────────────────────

export type LlmNormalizeAction = "match" | "create" | "reject"

export interface LlmNormalizeInput {
  raw: string
  type: string
  context?: string
  /** Up to 50 known canonicals for the type — used in the prompt as examples. */
  knownCanonicals: Array<{ canonicalKey: string; displayName: string }>
  timeoutMs?: number
}

export interface LlmNormalizeResult {
  action: LlmNormalizeAction
  /** Set when action === "match". */
  canonicalKey?: string
  confidence: number
  /** Set when action === "create". */
  proposedCanonical?: {
    canonicalKey: string
    displayName: string
  }
  /** raw response for debugging */
  rawResponse?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPrompt(input: LlmNormalizeInput): string {
  const examplesText =
    input.knownCanonicals.length > 0
      ? input.knownCanonicals
          .slice(0, 50)
          .map((c) => `  - "${c.canonicalKey}" (displays as "${c.displayName}")`)
          .join("\n")
      : "  (none yet — this is a new ontology)"

  return `You are a canonical-tag normalizer. Given a raw text tag, decide:
1. "match" — it maps to an existing canonical tag in the list below
2. "create" — it is genuinely new and should become a new canonical
3. "reject" — it is noise/gibberish and should be discarded

Tag type: ${input.type}
Raw text: "${input.raw}"
${input.context ? `Context: "${input.context.slice(0, 200)}"` : ""}

Known canonical tags for this type:
${examplesText}

Rules:
- Canonical keys are lowercase kebab-case (e.g. "machine-learning", "python", "sf-bay-area").
- Display names are Title Case English (e.g. "Machine Learning", "Python", "SF Bay Area").
- If the raw text is a variant/alias of an existing canonical, use "match" with that canonicalKey.
- If the raw text represents a genuinely distinct concept not in the list, use "create".
- If the raw text is a stop word, URL, number alone, or clearly not a ${input.type} tag, use "reject".
- Never create bilingual or Chinese display names. English-only.

Respond with ONLY valid JSON matching this schema:
{
  "action": "match" | "create" | "reject",
  "canonicalKey": string | null,   // required when action=match
  "confidence": number,             // 0.0-1.0
  "proposedCanonical": {            // required when action=create
    "canonicalKey": string,         // lowercase kebab-case
    "displayName": string           // Title Case English
  } | null
}`
}

function parseResponse(text: string): LlmNormalizeResult {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim()
  let obj: unknown
  try {
    obj = JSON.parse(cleaned)
  } catch {
    logger.warn("[tag-worker][llm-normalize] JSON parse failed", { text: cleaned.slice(0, 200) })
    return { action: "reject", confidence: 0, rawResponse: text.slice(0, 500) }
  }
  if (!obj || typeof obj !== "object") {
    return { action: "reject", confidence: 0, rawResponse: text.slice(0, 500) }
  }
  const o = obj as Record<string, unknown>
  const action = (o["action"] as string) ?? "reject"
  const canonicalKey = typeof o["canonicalKey"] === "string" ? o["canonicalKey"] : undefined
  const confidence = typeof o["confidence"] === "number" ? Math.max(0, Math.min(1, o["confidence"])) : 0.5
  const proposed = o["proposedCanonical"]
  let proposedCanonical: LlmNormalizeResult["proposedCanonical"]
  if (
    proposed &&
    typeof proposed === "object" &&
    typeof (proposed as Record<string, unknown>)["canonicalKey"] === "string" &&
    typeof (proposed as Record<string, unknown>)["displayName"] === "string"
  ) {
    const p = proposed as Record<string, unknown>
    // Sanitize canonicalKey to kebab-case
    const key = String(p["canonicalKey"])
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64)
    if (key.length >= 2) {
      proposedCanonical = {
        canonicalKey: key,
        displayName: String(p["displayName"]).trim().slice(0, 80),
      }
    }
  }

  if (action === "match" && canonicalKey) {
    return { action: "match", canonicalKey, confidence, rawResponse: text.slice(0, 500) }
  }
  if (action === "create" && proposedCanonical) {
    return { action: "create", proposedCanonical, confidence, rawResponse: text.slice(0, 500) }
  }
  return { action: "reject", confidence, rawResponse: text.slice(0, 500) }
}

// ─── 429 Alert ────────────────────────────────────────────────────────────────

let _lastAlertDate = ""

async function writeRateLimitAlert(rawText: string): Promise<void> {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  // Only write one alert per calendar day to avoid write spam
  if (_lastAlertDate === date) return
  _lastAlertDate = date
  try {
    const fs = getFirestore()
    const alertId = `qwen-7b-rate-limit-${date}`
    await fs.collection("pa-alerts").doc(alertId).set(
      {
        alertId,
        type: "qwen-7b-rate-limit",
        date,
        firstSeenAt: new Date().toISOString(),
        exampleRaw: rawText.slice(0, 100),
        message: "Qwen-7B SiliconFlow free tier returned 429. Tag events may queue as pending-review.",
      },
      { merge: true },
    )
    logger.warn("[tag-worker][llm-normalize] 429 alert written to pa-alerts", { alertId })
  } catch (alertErr) {
    logger.error("[tag-worker][llm-normalize] failed to write 429 alert", {
      err: alertErr instanceof Error ? alertErr.message : String(alertErr),
    })
  }
}

// ─── Main call ────────────────────────────────────────────────────────────────

/**
 * Call Qwen-7B to normalize a raw tag text.
 *
 * Fail-open: any error (429, timeout, parse failure) returns `{action:"reject"}`
 * so the caller can mark the event "pending-review" without crashing.
 */
export async function llmNormalize(input: LlmNormalizeInput): Promise<LlmNormalizeResult> {
  // 2026-05-07 Adam directive — Qwen-7B normalize is SiliconFlow only.
  // No OPENAI_API_KEY fallback (which is also SF in prod, but the env-
  // aliasing scheme is the bug we're cleaning up).
  const { getSiliconFlowConfig } = await import("../lib/llm-providers.js")
  const cfg = getSiliconFlowConfig()
  const apiKey = cfg.apiKey
  if (!apiKey) {
    logger.warn("[tag-worker][llm-normalize] no SILICONFLOW_API_KEY, skipping LLM")
    return { action: "reject", confidence: 0 }
  }

  const timeoutMs = input.timeoutMs ?? 8000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const resp = await fetch(`${SILICONFLOW_BASE}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: QWEN7B_MODEL,
        messages: [{ role: "user", content: buildPrompt(input) }],
        max_tokens: 256,
        temperature: 0.1,
        // SiliconFlow supports response_format for newer models; use if available
        response_format: { type: "json_object" },
      }),
    })

    if (resp.status === 429) {
      logger.warn("[tag-worker][llm-normalize] Qwen-7B rate limited (429)", { raw: input.raw })
      await writeRateLimitAlert(input.raw)
      return { action: "reject", confidence: 0 }
    }

    if (!resp.ok) {
      const body = await resp.text()
      logger.warn("[tag-worker][llm-normalize] Qwen-7B non-200", { status: resp.status, body: body.slice(0, 200) })
      return { action: "reject", confidence: 0 }
    }

    type ChatResp = { choices?: Array<{ message?: { content?: string } }> }
    const json = (await resp.json()) as ChatResp
    const content = json.choices?.[0]?.message?.content ?? ""
    return parseResponse(content)
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      logger.warn("[tag-worker][llm-normalize] Qwen-7B timeout", { raw: input.raw, timeoutMs })
    } else {
      logger.warn("[tag-worker][llm-normalize] Qwen-7B error", {
        raw: input.raw,
        err: err instanceof Error ? err.message : String(err),
      })
    }
    return { action: "reject", confidence: 0 }
  } finally {
    clearTimeout(timer)
  }
}
