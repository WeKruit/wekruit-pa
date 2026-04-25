/**
 * Mem0 Cloud API (https://api.mem0.ai) — add + search
 */
export type Mem0Config = { apiKey: string; baseUrl?: string; apiMode?: "cloud" | "oss" }

const DEFAULT_BASE = "https://api.mem0.ai/v1"

function authHeader(config: Mem0Config) {
  return config.apiMode === "oss" ? `Bearer ${config.apiKey}` : `Token ${config.apiKey}`
}

function normalizeMemories(j: unknown): string[] {
  if (Array.isArray(j)) {
    return j.map((m) => (typeof m === "string" ? m : m?.memory || m?.text || m?.content || "")).filter(Boolean)
  }
  if (j && typeof j === "object" && "memories" in j && Array.isArray((j as { memories: unknown }).memories)) {
    return normalizeMemories((j as { memories: unknown }).memories)
  }
  if (j && typeof j === "object" && "results" in j && Array.isArray((j as { results: unknown }).results)) {
    return normalizeMemories((j as { results: unknown }).results)
  }
  return []
}

export async function mem0Search(
  config: Mem0Config,
  query: string,
  userId: string
): Promise<string[]> {
  const base = (config.baseUrl || DEFAULT_BASE).replace(/\/$/, "")
  const r = await fetch(`${base}/memories/search`, {
    method: "POST",
    headers: {
      Authorization: authHeader(config),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, user_id: userId, limit: 8 }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Mem0 search ${r.status}: ${t}`)
  }
  return normalizeMemories(await r.json())
}

export async function mem0Add(
  config: Mem0Config,
  messages: { role: "user" | "assistant"; content: string }[],
  userId: string
): Promise<void> {
  const base = (config.baseUrl || DEFAULT_BASE).replace(/\/$/, "")
  const r = await fetch(`${base}/memories`, {
    method: "POST",
    headers: {
      Authorization: authHeader(config),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages, user_id: userId }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Mem0 add ${r.status}: ${t}`)
  }
}
