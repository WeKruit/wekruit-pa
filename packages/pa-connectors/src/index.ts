import { createHash, randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import { PA_COLLECTIONS, type AgentDef, type PaToolCall } from "@pa/core-types"
import { appendAuditEvent } from "@pa/pa-broker"
import { canUseConnector } from "@pa/pa-safety"

export type ConnectorContext = {
  db: Firestore
  agent: AgentDef
  turnId: string
  userId: string
  sessionId: string
}

export type ConnectorDef<I, O> = {
  name: string
  version: string
  description: string
  inputSchema: z.ZodType<I>
  outputSchema: z.ZodType<O>
  execute: (input: I, ctx: ConnectorContext) => Promise<O>
}

const FakeInputSchema = z.object({
  query: z.string().min(1),
})
const FakeOutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
})

const MatchingInputSchema = z.object({
  query: z.string().min(1),
})
const MatchingOutputSchema = z.object({
  ok: z.boolean(),
  source: z.literal("wekruit-matching"),
  summary: z.string(),
})

const FindxInputSchema = z.object({
  query: z.string().min(1),
})
const FindxOutputSchema = z.object({
  ok: z.boolean(),
  source: z.literal("findx"),
  summary: z.string(),
})

const ScoringInputSchema = z.object({
  text: z.string().min(1),
})
const ScoringOutputSchema = z.object({
  ok: z.boolean(),
  score: z.number().min(0).max(1),
  summary: z.string(),
})

const CurrentInfoInputSchema = z.object({
  query: z.string().min(1),
  nowIso: z.string().min(1),
  locale: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
})
const CurrentInfoCitationSchema = z.object({
  title: z.string().optional(),
  url: z.string().min(1),
})
const CurrentInfoOutputSchema = z.object({
  ok: z.boolean(),
  source: z.literal("openai-web-search"),
  summary: z.string(),
  asOf: z.string(),
  sources: z.array(CurrentInfoCitationSchema),
})

export type CurrentInfoConnectorInput = z.infer<typeof CurrentInfoInputSchema>
export type CurrentInfoConnectorOutput = z.infer<typeof CurrentInfoOutputSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function extractOpenAiOutputText(value: unknown): string {
  if (!isRecord(value)) return ""
  if (typeof value.output_text === "string") return value.output_text
  const output = Array.isArray(value.output) ? value.output : []
  const parts: string[] = []
  for (const item of output) {
    if (!isRecord(item)) continue
    const content = Array.isArray(item.content) ? item.content : []
    for (const block of content) {
      if (isRecord(block) && typeof block.text === "string") parts.push(block.text)
    }
  }
  return parts.join("\n").trim()
}

function collectOpenAiCitations(value: unknown): { title?: string; url: string }[] {
  const out: { title?: string; url: string }[] = []
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

function currentInfoPrompt(input: CurrentInfoConnectorInput) {
  return [
    `Current time: ${input.nowIso}`,
    input.locale ? `Locale: ${input.locale}` : null,
    input.location ? `Location: ${input.location}` : null,
    "Answer with current information from web search only. Keep it concise for iMessage. Include citations.",
    `User question: ${input.query}`,
  ]
    .filter(Boolean)
    .join("\n")
}

export const connectorRegistry = {
  "fake-echo": {
    name: "fake-echo",
    version: "1",
    description: "Deterministic fake connector used for broker/runtime E2E.",
    inputSchema: FakeInputSchema,
    outputSchema: FakeOutputSchema,
    execute: async (input: z.infer<typeof FakeInputSchema>) => ({
      ok: true,
      summary: `fake-echo:${input.query.slice(0, 80)}`,
    }),
  } satisfies ConnectorDef<z.infer<typeof FakeInputSchema>, z.infer<typeof FakeOutputSchema>>,
  "wekruit-matching": {
    name: "wekruit-matching",
    version: "1",
    description: "First real downstream connector; calls PA_MATCHING_URL when configured.",
    inputSchema: MatchingInputSchema,
    outputSchema: MatchingOutputSchema,
    execute: async (input: z.infer<typeof MatchingInputSchema>) => {
      const url = process.env.PA_MATCHING_URL
      if (!url) {
        return {
          ok: false,
          source: "wekruit-matching",
          summary: "PA_MATCHING_URL is not configured; connector policy/audit path executed only.",
        }
      }
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.PA_MATCHING_TOKEN
            ? { Authorization: `Bearer ${process.env.PA_MATCHING_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({ query: input.query }),
      })
      const text = await res.text()
      return {
        ok: res.ok,
        source: "wekruit-matching",
        summary: text.slice(0, 1000),
      }
    },
  } satisfies ConnectorDef<z.infer<typeof MatchingInputSchema>, z.infer<typeof MatchingOutputSchema>>,
  findx: {
    name: "findx",
    version: "1",
    description: "FindX people/company lookup skeleton; calls FINDX_URL when configured.",
    inputSchema: FindxInputSchema,
    outputSchema: FindxOutputSchema,
    execute: async (input: z.infer<typeof FindxInputSchema>) => {
      const url = process.env.FINDX_URL
      if (!url) {
        return { ok: false, source: "findx", summary: "FINDX_URL is not configured." }
      }
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.FINDX_TOKEN ? { Authorization: `Bearer ${process.env.FINDX_TOKEN}` } : {}),
        },
        body: JSON.stringify({ query: input.query }),
      })
      const text = await res.text()
      return { ok: res.ok, source: "findx", summary: text.slice(0, 1000) }
    },
  } satisfies ConnectorDef<z.infer<typeof FindxInputSchema>, z.infer<typeof FindxOutputSchema>>,
  scoring: {
    name: "scoring",
    version: "1",
    description: "Local scoring skeleton for policy/audit integration.",
    inputSchema: ScoringInputSchema,
    outputSchema: ScoringOutputSchema,
    execute: async (input: z.infer<typeof ScoringInputSchema>) => ({
      ok: true,
      score: Math.min(1, Math.max(0, input.text.length / 500)),
      summary: "Length-based placeholder score until real scoring service is wired.",
    }),
  } satisfies ConnectorDef<z.infer<typeof ScoringInputSchema>, z.infer<typeof ScoringOutputSchema>>,
  "current-info": {
    name: "current-info",
    version: "1",
    description: "Current information lookup via OpenAI Responses API web search.",
    inputSchema: CurrentInfoInputSchema,
    outputSchema: CurrentInfoOutputSchema,
    execute: async (input: CurrentInfoConnectorInput) => {
      const apiKey = process.env.PA_CURRENT_INFO_OPENAI_API_KEY?.trim()
      if (!apiKey) {
        return {
          ok: false,
          source: "openai-web-search",
          summary: "PA_CURRENT_INFO_OPENAI_API_KEY is not configured; current-info connector unavailable.",
          asOf: input.nowIso,
          sources: [],
        }
      }

      try {
        const res = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: process.env.PA_CURRENT_INFO_MODEL || "gpt-4.1-mini",
            tools: [{ type: "web_search" }],
            include: ["web_search_call.action.sources"],
            input: currentInfoPrompt(input),
            max_tool_calls: 1,
            max_output_tokens: 700,
          }),
        })
        if (!res.ok) {
          return {
            ok: false,
            source: "openai-web-search",
            summary: `OpenAI web search failed with HTTP ${res.status}.`,
            asOf: input.nowIso,
            sources: [],
          }
        }

        const payload = await res.json() as unknown
        const summary = extractOpenAiOutputText(payload).trim()
        if (!summary) {
          return {
            ok: false,
            source: "openai-web-search",
            summary: "OpenAI web search returned no answer text.",
            asOf: input.nowIso,
            sources: collectOpenAiCitations(payload),
          }
        }
        return {
          ok: true,
          source: "openai-web-search",
          summary: summary.slice(0, 1400),
          asOf: input.nowIso,
          sources: collectOpenAiCitations(payload),
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        return {
          ok: false,
          source: "openai-web-search",
          summary: `OpenAI web search unavailable: ${err.slice(0, 160)}`,
          asOf: input.nowIso,
          sources: [],
        }
      }
    },
  } satisfies ConnectorDef<CurrentInfoConnectorInput, CurrentInfoConnectorOutput>,
}

export type ConnectorName = keyof typeof connectorRegistry

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function redact(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return { value: String(value) }
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = /token|secret|password|key/i.test(key) ? "[redacted]" : v
  }
  return out
}

export async function runConnector(
  name: ConnectorName,
  args: unknown,
  ctx: ConnectorContext & { usedThisTurn?: number }
): Promise<unknown> {
  const def = connectorRegistry[name]
  const toolCallId = randomUUID()
  const startedAt = new Date().toISOString()
  const policy = canUseConnector(ctx.agent, name, ctx.usedThisTurn ?? 0)
  const base: PaToolCall = {
    id: toolCallId,
    turnId: ctx.turnId,
    connectorName: name,
    connectorVersion: def.version,
    status: policy.allow ? "running" : "denied",
    argsDigest: digest(args),
    argsRedacted: redact(args),
    policyDecision: policy.allow ? "allow" : "deny",
    policyReason: policy.reason,
    startedAt,
  }
  await ctx.db.collection(PA_COLLECTIONS.toolCalls).doc(toolCallId).set(base)

  if (!policy.allow) {
    const audit = await appendAuditEvent(ctx.db, {
      actor: "orchestrator",
      kind: "tool_policy_denied",
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolCallId,
      message: `Connector ${name} denied: ${policy.reason}`,
      meta: { connectorName: name },
    })
    await ctx.db.collection(PA_COLLECTIONS.toolCalls).doc(toolCallId).set(
      { auditEventIds: [audit.id], completedAt: new Date().toISOString() },
      { merge: true }
    )
    throw new Error(`Connector ${name} denied: ${policy.reason}`)
  }

  const parsed = def.inputSchema.parse(args)
  const startAudit = await appendAuditEvent(ctx.db, {
    actor: "orchestrator",
    kind: "tool_call_started",
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    toolCallId,
    message: `Connector ${name} started`,
    meta: { connectorName: name },
  })

  try {
    const execute = def.execute as (input: unknown, c: ConnectorContext) => Promise<unknown>
    const rawResult = await execute(parsed, ctx)
    const result = def.outputSchema.parse(rawResult)
    const doneAudit = await appendAuditEvent(ctx.db, {
      actor: "orchestrator",
      kind: "tool_call_completed",
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolCallId,
      message: `Connector ${name} completed`,
      meta: { connectorName: name },
    })
    await ctx.db.collection(PA_COLLECTIONS.toolCalls).doc(toolCallId).set(
      {
        status: "completed",
        resultSummary: JSON.stringify(result).slice(0, 1000),
        completedAt: new Date().toISOString(),
        auditEventIds: [startAudit.id, doneAudit.id],
      },
      { merge: true }
    )
    return result
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    const failAudit = await appendAuditEvent(ctx.db, {
      actor: "orchestrator",
      kind: "connector_error",
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolCallId,
      message: `Connector ${name} failed: ${err}`,
      meta: { connectorName: name },
    })
    await ctx.db.collection(PA_COLLECTIONS.toolCalls).doc(toolCallId).set(
      {
        status: "failed",
        error: err,
        completedAt: new Date().toISOString(),
        auditEventIds: [startAudit.id, failAudit.id],
      },
      { merge: true }
    )
    throw e
  }
}
