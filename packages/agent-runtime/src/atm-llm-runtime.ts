/**
 * On-site WeKruit pattern: pull OpenAI-compatible LLM runtime from ATM (same as VALET’s
 * `/internal/llm-runtime-profiles/desktop-default` for Anthropic). Configure a profile
 * in ATM/Infisical that returns JSON with at least { "provider": "openai", "apiKey": "..." }.
 */
const CACHE_TTL_MS = 5 * 60 * 1000
let lastHydrateAt = 0
let lastHydrateOk = false

function getAtmBaseUrl(): string {
  return (process.env.ATM_BASE_URL || "").replace(/\/+$/, "")
}

/** Align with VALET: VALET_ATM_TOKEN preferred, plus PA_ + legacy ATM_SERVICE_TOKEN. */
export function getAtmBearerToken(): string {
  return (
    process.env.PA_ATM_TOKEN ||
    process.env.VALET_ATM_TOKEN ||
    process.env.ATM_SERVICE_TOKEN ||
    ""
  )
}

/**
 * Full URL (e.g. `https://atm.../internal/llm-runtime-profiles/personal-assistant-default`)
 * OR path relative to ATM_BASE_URL.
 */
function resolveProfileRequestUrl(): string | null {
  const full = process.env.PA_ATM_LLM_RUNTIME_URL?.trim()
  if (full) return full
  const base = getAtmBaseUrl()
  if (!base) return null
  const path =
    process.env.PA_ATM_LLM_PROFILE_PATH?.trim() ||
    "/internal/llm-runtime-profiles/personal-assistant-default"
  return `${base}${path.startsWith("/") ? path : `/${path}`}`
}

export type AtmOpenAiProfile = {
  provider?: "openai" | string
  baseUrl?: string
  apiKey: string
  defaultModel?: string
}

/**
 * Fetches once per TTL and writes into `process.env` for OpenAI SDK compatibility:
 * `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, optional `PA_ATM_DEFAULT_MODEL`.
 * Skips if `PA_ATM_DISABLE=1`, or ATM URL/token missing. Set `PA_ATM_DISABLE=1` to use only local `.env` / Infisical-injected keys.
 */
export async function hydrateOpenAiFromAtm(): Promise<{ ok: boolean; reason?: string }> {
  if (process.env.PA_ATM_DISABLE === "1" || process.env.ATM_DISABLE === "1") {
    return { ok: false, reason: "disabled" }
  }
  const url = resolveProfileRequestUrl()
  const token = getAtmBearerToken()
  if (!url || !token) {
    return { ok: false, reason: "no ATM url or token" }
  }
  const now = Date.now()
  if (lastHydrateOk && now - lastHydrateAt < CACHE_TTL_MS) {
    return { ok: true, reason: "cache" }
  }

  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 12_000)
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { ok: false, reason: `HTTP ${res.status} ${body.slice(0, 200)}` }
    }
    const data = (await res.json()) as Partial<AtmOpenAiProfile> & { provider?: string }
    if (data.provider && data.provider !== "openai") {
      return { ok: false, reason: `provider ${data.provider} is not openai` }
    }
    if (typeof data.apiKey !== "string" || !data.apiKey) {
      return { ok: false, reason: "missing apiKey in profile" }
    }
    process.env.OPENAI_API_KEY = data.apiKey
    if (typeof data.baseUrl === "string" && data.baseUrl.length > 0) {
      process.env.OPENAI_BASE_URL = data.baseUrl
    }
    if (typeof data.defaultModel === "string" && data.defaultModel.length > 0) {
      process.env.PA_ATM_DEFAULT_MODEL = data.defaultModel
    }
    lastHydrateAt = now
    lastHydrateOk = true
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(t)
  }
}
