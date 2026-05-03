/**
 * v1.5 §3.8 fix — OpenAI Moderation API integration.
 *
 * BACKGROUND
 * ----------
 * Phase 46 shipped `ILLEGAL_CONTENT_PATTERNS` — a 12-entry bilingual regex
 * bank gated by `paSafetyIllegalContentEnabled` (default OFF). INTENT-PLAYBOOK
 * §3.8 documented the layer as dead code: in production the flag was never
 * flipped, so CSAM / weapons / drug-synthesis solicitation flowed straight
 * into the LLM. Adam decision (2026-05-02): replace the dead-code regex bank
 * with the OpenAI Moderation API (`omni-moderation-latest`, free tier).
 *
 * SCOPE
 * -----
 * Pure detection + routing helpers. Network call to
 * `https://api.openai.com/v1/moderations` via native `fetch` — pa-safety
 * is intentionally a low-dep package, we don't pull in the `openai` SDK
 * for one endpoint. Callers (orchestrator) own flag plumbing + audit
 * persistence + telemetry; this module returns a `ModerationVerdict`
 * with a routedAction enum that's stable across upstream API changes.
 *
 * 13 categories returned by `omni-moderation-latest`:
 *   sexual, sexual/minors, hate, hate/threatening, harassment,
 *   harassment/threatening, self-harm, self-harm/intent,
 *   self-harm/instructions, violence, violence/graphic,
 *   illicit, illicit/violent
 *
 * Routing (deterministic, severity-ranked):
 *   sexual/minors                                   → BLOCK + ESCALATE_NCMEC
 *                                                     (highest priority; silent_drop reply
 *                                                      to avoid tip-off; v1.6 will wire
 *                                                      real NCMEC submission — current
 *                                                      stub only logs + audit)
 *   self-harm/intent | self-harm/instructions       → ALLOW + WARN
 *                                                     (defer to crisis-detector hotline path
 *                                                      which already owns this surface)
 *   violence/graphic                                → BLOCK
 *   harassment/threatening | hate/threatening       → BLOCK
 *   illicit/violent                                 → BLOCK (drugs/weapons how-to)
 *   any other flagged                               → ALLOW + WARN (log only)
 *   all unflagged                                   → ALLOW
 *
 * Boundaries (Adam-locked):
 *   - sexual (vanilla, no /minors) → ALLOW. Adult consensual discussion is
 *     not blocked at this layer. Only the /minors child-safety subcategory
 *     is hard-BLOCK.
 *   - self-harm (vanilla) → ALLOW + WARN. crisis-detector.ts handles this
 *     surface with its bilingual hotline trailer; double-blocking would
 *     hide users from the hotline path.
 *
 * Auth
 * ----
 * Uses `PA_OPENAI_AGENT_API_KEY` (real OpenAI key, GCP secret) NOT
 * `OPENAI_API_KEY` (which production maps to SiliconFlow — SiliconFlow
 * does NOT expose /v1/moderations).
 *
 * Fail-open posture
 * -----------------
 * Network errors / 5xx / timeouts / missing key all return
 * `{ flagged: false, routedAction: "ALLOW", reason: "moderation_unavailable" }`
 * so a moderation outage does NOT break Claire. Caller emits
 * `pa.safety.moderation_error` telemetry.
 *
 * NCMEC stub
 * ----------
 * `routedAction === "ESCALATE_NCMEC"` is a STUB in v1.5: orchestrator
 * writes a `pa_abuse_events` row with `kind="csam_detected"` + audit row
 * with `meta.csam=true`. Real NCMEC CyberTipline submission (legal +
 * privacy + retention requirements) ships in v1.6.
 */

import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All 13 categories returned by `omni-moderation-latest`. */
export type ModerationCategory =
  | "sexual"
  | "sexual/minors"
  | "hate"
  | "hate/threatening"
  | "harassment"
  | "harassment/threatening"
  | "self-harm"
  | "self-harm/intent"
  | "self-harm/instructions"
  | "violence"
  | "violence/graphic"
  | "illicit"
  | "illicit/violent"

/**
 * Routed action — the orchestrator-facing decision enum.
 *
 *   - BLOCK           → return SAFETY_CANNED_REPLIES.escalate, write abuse row.
 *   - ESCALATE_NCMEC  → silent_drop (no reply, avoid tip-off), write abuse row
 *                       with kind=csam_detected, audit meta.csam=true.
 *                       v1.6 will wire real NCMEC CyberTipline submission.
 *   - WARN            → ALLOW the inbound (continue normal flow), log only.
 *   - ALLOW           → no signal, normal flow.
 */
export type ModerationRoutedAction =
  | "BLOCK"
  | "ESCALATE_NCMEC"
  | "WARN"
  | "ALLOW"

export interface ModerationVerdict {
  /** Top-level OpenAI flagged signal. */
  flagged: boolean
  /** Per-category boolean map (only present when API call succeeded). */
  categories: Partial<Record<ModerationCategory, boolean>>
  /** Per-category float scores 0..1 (only present when API call succeeded). */
  scores: Partial<Record<ModerationCategory, number>>
  /** Orchestrator-facing routed action. */
  routedAction: ModerationRoutedAction
  /** Stable reason code for telemetry (NOT raw text). */
  reason?: string
  /** Categories that drove the routing decision (for audit). */
  triggeredCategories?: ModerationCategory[]
  /** Sha256[:16] hex of input — PII-safe correlation id. */
  inputHash: string
  /** Length of input (chars). */
  inputLength: number
  /** Wall-clock latency of the API call in ms (0 on fail-open short-circuit). */
  latencyMs: number
}

export interface CheckOpenAIModerationOptions {
  /** Override API key. Defaults to PA_OPENAI_AGENT_API_KEY env. */
  apiKey?: string
  /** Override model. Default: `omni-moderation-latest`. */
  model?: string
  /** Override base URL. Default: `https://api.openai.com/v1`. */
  baseUrl?: string
  /** Request timeout in milliseconds. Default 3000. */
  timeoutMs?: number
  /**
   * Inject a custom fetch (test / mock). Defaults to global fetch.
   * Signature matches the standard fetch.
   */
  fetchImpl?: typeof fetch
}

// ---------------------------------------------------------------------------
// Routing — pure / deterministic
// ---------------------------------------------------------------------------

/**
 * Order matters: top-of-list wins. Mirrors the routedAction Mermaid in
 * INTENT-PLAYBOOK §3.8.
 */
const BLOCK_ORDER: ReadonlyArray<{
  cat: ModerationCategory
  action: ModerationRoutedAction
  reason: string
}> = [
  { cat: "sexual/minors", action: "ESCALATE_NCMEC", reason: "csam_detected" },
  { cat: "violence/graphic", action: "BLOCK", reason: "violence_graphic" },
  { cat: "harassment/threatening", action: "BLOCK", reason: "harassment_threatening" },
  { cat: "hate/threatening", action: "BLOCK", reason: "hate_threatening" },
  { cat: "illicit/violent", action: "BLOCK", reason: "illicit_violent" },
]

/**
 * `self-harm/intent` and `self-harm/instructions` intentionally DO NOT block —
 * crisis-detector.ts owns that surface with its hotline trailer. We log a
 * warn so we can dashboard recall but never short-circuit the LLM call.
 */
const SELF_HARM_DEFER: ReadonlyArray<ModerationCategory> = [
  "self-harm/intent",
  "self-harm/instructions",
]

/**
 * Pure routing decision over a (categories, scores) pair. No side effects.
 *
 * Caller passes the API response shape directly. Returns the routedAction
 * + reason + which categories drove the decision.
 */
export function routeModerationVerdict(
  flagged: boolean,
  categories: Partial<Record<ModerationCategory, boolean>>,
  scores: Partial<Record<ModerationCategory, number>>
): {
  routedAction: ModerationRoutedAction
  reason?: string
  triggeredCategories: ModerationCategory[]
} {
  // Highest-severity wins — walk BLOCK_ORDER first.
  for (const entry of BLOCK_ORDER) {
    if (categories[entry.cat] === true) {
      return {
        routedAction: entry.action,
        reason: entry.reason,
        triggeredCategories: [entry.cat],
      }
    }
  }

  // self-harm subcategories — defer to crisis-detector. Emit WARN so we
  // can audit recall but ALLOW the inbound to flow through.
  const selfHarmHits: ModerationCategory[] = []
  for (const cat of SELF_HARM_DEFER) {
    if (categories[cat] === true) selfHarmHits.push(cat)
  }
  if (selfHarmHits.length > 0) {
    return {
      routedAction: "WARN",
      reason: "self_harm_deferred_to_crisis_detector",
      triggeredCategories: selfHarmHits,
    }
  }

  // Any other flagged → log warn, allow.
  if (flagged) {
    const triggered = (Object.keys(categories) as ModerationCategory[]).filter(
      (c) => categories[c] === true
    )
    return {
      routedAction: "WARN",
      reason: "flagged_soft",
      triggeredCategories: triggered,
    }
  }

  return {
    routedAction: "ALLOW",
    reason: undefined,
    triggeredCategories: [],
  }
}

// ---------------------------------------------------------------------------
// Network call
// ---------------------------------------------------------------------------

interface RawModerationResponse {
  id?: string
  model?: string
  results?: Array<{
    flagged?: boolean
    categories?: Partial<Record<ModerationCategory, boolean>>
    category_scores?: Partial<Record<ModerationCategory, number>>
  }>
}

/**
 * 16-hex sha256 prefix — PII-safe correlation id.
 */
function hashForAudit(text: string): string {
  return createHash("sha256")
    .update(text ?? "")
    .digest("hex")
    .slice(0, 16)
}

/**
 * Fail-open verdict shape — used when API key missing / request errors / timeout.
 */
function failOpenVerdict(
  text: string,
  reason: string,
  latencyMs: number
): ModerationVerdict {
  return {
    flagged: false,
    categories: {},
    scores: {},
    routedAction: "ALLOW",
    reason,
    triggeredCategories: [],
    inputHash: hashForAudit(text),
    inputLength: (text ?? "").length,
    latencyMs,
  }
}

/**
 * Call OpenAI Moderation API + map to ModerationVerdict.
 *
 * Fail-open posture:
 *   - Missing API key      → ALLOW + reason="missing_api_key"
 *   - Empty input          → ALLOW + reason="empty_input"
 *   - Network/5xx/timeout  → ALLOW + reason="moderation_unavailable" / "timeout"
 *
 * On success, inputHash / inputLength / latencyMs always populated.
 */
export async function checkOpenAIModeration(
  text: string,
  opts: CheckOpenAIModerationOptions = {}
): Promise<ModerationVerdict> {
  const t0 = Date.now()
  if (!text || !text.trim()) {
    return failOpenVerdict(text ?? "", "empty_input", 0)
  }

  const apiKey =
    opts.apiKey?.trim() ||
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() ||
    ""
  if (!apiKey) {
    return failOpenVerdict(text, "missing_api_key", 0)
  }

  const baseUrl =
    opts.baseUrl?.replace(/\/+$/, "") || "https://api.openai.com/v1"
  const model = opts.model || "omni-moderation-latest"
  const timeoutMs = opts.timeoutMs ?? 3000
  const f = opts.fetchImpl ?? fetch

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let resp: Response | null = null
  try {
    resp = await f(`${baseUrl}/moderations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: text }),
      signal: ac.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    const latencyMs = Date.now() - t0
    const isAbort = err instanceof Error && err.name === "AbortError"
    return failOpenVerdict(
      text,
      isAbort ? "timeout" : "network_error",
      latencyMs
    )
  }
  clearTimeout(timer)

  const latencyMs = Date.now() - t0
  if (!resp.ok) {
    return failOpenVerdict(
      text,
      `http_${resp.status}`,
      latencyMs
    )
  }

  let parsed: RawModerationResponse
  try {
    parsed = (await resp.json()) as RawModerationResponse
  } catch {
    return failOpenVerdict(text, "parse_error", latencyMs)
  }

  const result = parsed.results?.[0]
  if (!result) {
    return failOpenVerdict(text, "empty_results", latencyMs)
  }

  const flagged = result.flagged === true
  const categories = result.categories ?? {}
  const scores = result.category_scores ?? {}
  const routed = routeModerationVerdict(flagged, categories, scores)

  return {
    flagged,
    categories,
    scores,
    routedAction: routed.routedAction,
    reason: routed.reason,
    triggeredCategories: routed.triggeredCategories,
    inputHash: hashForAudit(text),
    inputLength: text.length,
    latencyMs,
  }
}

// ---------------------------------------------------------------------------
// Re-export hashForAudit for caller telemetry consistency
// ---------------------------------------------------------------------------

export { hashForAudit as moderationHashForAudit }
