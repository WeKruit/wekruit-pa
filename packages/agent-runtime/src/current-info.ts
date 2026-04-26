import { Agent, OpenAIProvider, Runner, webSearchTool } from "@openai/agents"
import OpenAI from "openai"

export type CurrentInfoSearchInput = {
  query: string
  nowIso: string
  locale?: string
  location?: string
}

export type CurrentInfoCitation = {
  title?: string
  url: string
}

export type CurrentInfoSearchResult = {
  summary: string
  sources: CurrentInfoCitation[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function currentInfoPrompt(input: CurrentInfoSearchInput) {
  return [
    `Current time: ${input.nowIso}`,
    input.locale ? `Locale: ${input.locale}` : null,
    input.location ? `Location: ${input.location}` : null,
    "Answer with current information from web search only. Keep it concise for iMessage. Include citations when available.",
    `User question: ${input.query}`,
  ]
    .filter(Boolean)
    .join("\n")
}

function collectOpenAiCitations(value: unknown): CurrentInfoCitation[] {
  const out: CurrentInfoCitation[] = []
  const seen = new Set<string>()
  const add = (candidate: unknown) => {
    if (!isRecord(candidate) || typeof candidate.url !== "string" || candidate.url.trim() === "") return
    const url = candidate.url.trim()
    if (seen.has(url)) return
    seen.add(url)
    out.push({
      ...(typeof candidate.title === "string" && candidate.title.trim()
        ? { title: candidate.title.trim() }
        : {}),
      url,
    })
  }

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (!isRecord(node)) return
    if (node.type === "url_citation") add(node)
    if (isRecord(node.url_citation)) add(node.url_citation)
    if (Array.isArray(node.sources)) {
      for (const source of node.sources) add(source)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value) || isRecord(value)) visit(value)
    }
  }

  visit(value)
  return out.slice(0, 5)
}

export async function runOpenAIAgentsCurrentInfo(input: CurrentInfoSearchInput): Promise<CurrentInfoSearchResult> {
  const apiKey = process.env.PA_OPENAI_AGENT_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("PA_OPENAI_AGENT_API_KEY is not configured")
  }

  // The Agents SDK's OpenAIProvider falls through to env OPENAI_BASE_URL when
  // no openAIClient is passed, which is poisoned by SiliconFlow elsewhere in
  // the orchestrator. Construct our own OpenAI client pinned to the official
  // endpoint so hosted tools (web_search, etc.) work.
  const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || "https://api.openai.com/v1"
  const openAIClient = new OpenAI({ apiKey, baseURL })
  const provider = new OpenAIProvider({
    useResponses: true,
    openAIClient,
  })
  try {
    const agent = new Agent({
      name: "PA Current Info",
      instructions:
        "You answer only with current information from live web search. If search results do not support an answer, say that clearly and do not rely on stale model knowledge.",
      model: process.env.PA_OPENAI_AGENT_MODEL || "gpt-4.1-mini",
      tools: [webSearchTool({ searchContextSize: "low", externalWebAccess: true })],
      modelSettings: {
        toolChoice: "web_search",
        maxTokens: 700,
      },
    })

    const runner = new Runner({
      modelProvider: provider,
      tracingDisabled: true,
    })
    const result = await runner.run(agent, currentInfoPrompt(input), { maxTurns: 2 })
    const summary = String(result.finalOutput ?? "").trim()
    const sources = collectOpenAiCitations(result.rawResponses.map((response) => response.providerData))
    return { summary, sources }
  } finally {
    await provider.close()
  }
}
