/**
 * Mem0 Cloud API (https://api.mem0.ai) — add + search
 */
export type Mem0Config = { apiKey: string; baseUrl?: string }

const DEFAULT_BASE = "https://api.mem0.ai/v1"

export async function mem0Search(
  config: Mem0Config,
  query: string,
  userId: string
): Promise<string[]> {
  const base = (config.baseUrl || DEFAULT_BASE).replace(/\/$/, "")
  const r = await fetch(`${base}/memories/search`, {
    method: "POST",
    headers: {
      Authorization: `Token ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, user_id: userId, limit: 8 }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Mem0 search ${r.status}: ${t}`)
  }
  const j = (await r.json()) as { memories?: { memory?: string; text?: string }[] } | unknown
  if (j && typeof j === "object" && "memories" in j && Array.isArray((j as { memories: unknown }).memories)) {
    return ((j as { memories: { memory?: string; text?: string }[] }).memories || [])
      .map((m) => m.memory || m.text || "")
      .filter(Boolean)
  }
  return []
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
      Authorization: `Token ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages, user_id: userId }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Mem0 add ${r.status}: ${t}`)
  }
}
