import { createHash, randomUUID } from "node:crypto"
import { resolveToolFamily } from "./tool-family.js"
export { resolveToolFamily, PA_TOOL_FAMILIES, type PaToolFamily } from "./tool-family.js"
import type { Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import { PA_COLLECTIONS, type AgentDef, type PaToolCall } from "@pa/core-types"
import {
  createConfirmedMemoryFact,
  listConfirmedMemoryFacts,
  recordMemoryAction,
  shouldRejectMemoryFact,
} from "@pa/memory"
import { appendAuditEvent } from "@pa/pa-broker"
import { canUseConnector, isUnsafeMemoryContent } from "@pa/pa-safety"

export type {
  ConnectorContext,
  ConnectorDef,
  ConnectorNarrationTemplates,
  MatchConnectorHooks,
} from "./connector-types.js"

import type { ConnectorContext, ConnectorDef } from "./connector-types.js"
import {
  FIND_MATCH_CONNECTOR,
  MATCH_COLLAB_CONNECTOR,
  FIND_MATCH_NARRATION,
} from "./match-connectors.js"

export { FIND_MATCH_NARRATION, MATCH_COLLAB_NARRATION } from "./match-connectors.js"

const FakeInputSchema = z.object({
  query: z.string().min(1),
})
const FakeOutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
})

const MatchingInputSchema = z.object({
  query: z.string().min(1).max(500),
  // Phase 13 — strict-mode-compatible filters. Every nested key is in
  // `required`; optional values are encoded as `T | null` per Phase 10.5
  // hot-fix #4 (NOT Zod `.optional()`). `filters` itself may be null when
  // the LLM has no structured signal; the orchestrator's runConnector
  // schema-validates inputs so callers must pass the key explicitly.
  filters: z
    .object({
      location: z.string().nullable(),
      roleType: z.string().nullable(),
      seniority: z.string().nullable(),
    })
    .nullable(),
})
const MatchingRoleSchema = z.object({
  roleId: z.string(),
  title: z.string(),
  company: z.string(),
  fitScore: z.number().min(0).max(1),
  applyUrl: z.string().nullable(),
  summary: z.string(),
})
const MatchingOutputSchema = z.object({
  ok: z.boolean(),
  source: z.literal("wekruit-matching"),
  // `reason` carries the degraded-mode tag (e.g.
  // "matching_service_not_configured", "backend_5xx", "backend_timeout").
  // Null on success. The dashboard reads this to render the empty state cleanly.
  reason: z.string().nullable(),
  // Human-readable top-line surfaced to the LLM; ≤1000 chars to fit
  // runConnector's `resultSummary.slice(0,1000)` audit truncation.
  summary: z.string(),
  // Structured ranked list. Null when no roles (degraded mode or empty
  // backend response); the dashboard renders an empty state from this.
  roles: z.array(MatchingRoleSchema).nullable(),
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

// OpenAI Responses API rejects tool schemas where `required` does not
// list every property. Keep this schema flat (single required field) so
// the SDK's zod→JSON-schema conversion produces a strict-mode-compatible
// shape. Sensitivity is enforced at runtime via pa-safety
// `isUnsafeMemoryContent`, not via tool input.
const RememberFactInputSchema = z.object({
  content: z.string().min(1).max(500),
})
const RememberFactOutputSchema = z.object({
  ok: z.boolean(),
  factId: z.string().optional(),
  conflict: z.boolean().optional(),
  reason: z.string().optional(),
})

export type RememberFactConnectorInput = z.infer<typeof RememberFactInputSchema>
export type RememberFactConnectorOutput = z.infer<typeof RememberFactOutputSchema>

function normalizeFactContent(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase()
}


// ---------------------------------------------------------------------------
// Stream F4 — saveJobProfile connector
//
// Lets Claire (default agent) persist the user's job-search preferences to
// pa-job-profiles/{userId} in a single tool call. Replaces the deprecated
// RecruiterAgent path; this is the canonical surface for the probing flow
// described in Bible v5 hard-rule JOB-PREF PROBE.
//
// Schema is flat (single-level required block) so OpenAI Responses API's
// strict JSON-schema mode doesn't reject it. salaryMin is nullable rather
// than optional for the same reason.
//
// Idempotency: `pa-job-profiles/{userId}` is upserted with a Firestore
// transaction. createdAt is preserved across re-saves; status is preserved
// when "paused" (operator pause), otherwise advances to "active". Safe to
// call multiple times during the 4-question probe.
// ---------------------------------------------------------------------------

const SAVE_JOB_PROFILE_INDUSTRY_TAGS = [
  "tech_software",
  "tech_hardware",
  "fintech_finance",
  "ai_ml",
  "healthcare_biotech",
  "consumer_retail",
  "media_entertainment",
  "manufacturing_industrial",
  "education",
  "other",
] as const

const SaveJobProfileInputSchema = z.object({
  // 1..3 canonical industry tags. Locked enum lives in
  // apps/functions/src/cv-ingest/industry-tags.ts; replicated here so
  // pa-connectors stays free of the apps/* import boundary.
  industryTags: z
    .array(z.enum(SAVE_JOB_PROFILE_INDUSTRY_TAGS))
    .min(1)
    .max(3),
  sponsorshipNeeded: z.enum(["H1B", "GC", "none"]),
  // Free-text — "湾区" / "NYC" / "remote" / "不挑" / "anywhere".
  locationPreference: z.string().min(1).max(100),
  sizePreference: z.enum(["big", "startup", "mid", "any"]),
  // Total-comp floor in USD. Null when the user didn't volunteer one
  // (which is the default — we never demand salary up front).
  salaryMin: z.number().int().nonnegative().nullable(),
})
const SaveJobProfileOutputSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
})

export type SaveJobProfileConnectorInput = z.infer<typeof SaveJobProfileInputSchema>
export type SaveJobProfileConnectorOutput = z.infer<typeof SaveJobProfileOutputSchema>

const JOB_PROFILES_COLLECTION = "pa-job-profiles"

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
    description:
      "Find ranked job-role matches for the user from the WeKruit catalog. " +
      "Use this ONLY when the user explicitly asks for job recommendations / matches " +
      "(e.g. \"看看有什么岗位匹配\", \"find me jobs\", \"最近有没有推荐机会\"). " +
      "Do not call this for casual chit-chat or for non-discovery turns.",
    inputSchema: MatchingInputSchema,
    outputSchema: MatchingOutputSchema,
    execute: async (
      input: z.infer<typeof MatchingInputSchema>,
      ctx: ConnectorContext
    ) => {
      // Phase 13 degraded-mode contract: connector NEVER throws inside
      // execute. Every failure mode resolves to a structured `ok:false`
      // payload so the LLM can apologize and the dashboard can render an
      // empty state.
      const disabled = process.env.PA_MATCHING_DISABLED === "true"
      const url = process.env.PA_MATCHING_URL
      if (disabled || !url) {
        return {
          ok: false,
          source: "wekruit-matching" as const,
          reason: disabled ? "matching_service_disabled" : "matching_service_not_configured",
          summary: "暂时无法获取匹配结果，请稍后再试。",
          roles: null,
        }
      }
      // Phase 13 — single-retry contract on transient failure (network
      // or 5xx). 4xx never retries (it's our caller bug, not the
      // backend's). Total ceiling = 8s timeout × 2 attempts + 250ms
      // backoff ≈ 16.25s — safely under runConnector's 90s scenario
      // timeout but above the typical 1-2s p95 of a healthy backend.
      const TIMEOUT_MS = 8000
      const RETRY_BACKOFF_MS = 250
      const body = JSON.stringify({
        userId: ctx.userId,
        query: input.query,
        filters: input.filters,
      })
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }
      const token = process.env.PA_MATCHING_TOKEN
      if (token) headers.Authorization = `Bearer ${token}`

      type Attempt = {
        ok: boolean
        status: number
        text: string
      } | { aborted: true } | { networkError: string }
      const attempt = async (): Promise<Attempt> => {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
        try {
          const res = await fetch(url, {
            method: "POST",
            headers,
            body,
            signal: ctrl.signal,
          })
          const text = await res.text()
          return { ok: res.ok, status: res.status, text }
        } catch (e: unknown) {
          if (e instanceof Error && (e.name === "AbortError" || ctrl.signal.aborted)) {
            return { aborted: true }
          }
          return { networkError: e instanceof Error ? e.message : String(e) }
        } finally {
          clearTimeout(timer)
        }
      }

      const isRetryable = (a: Attempt): boolean => {
        if ("aborted" in a) return true
        if ("networkError" in a) return true
        return a.status >= 500
      }

      let res = await attempt()
      if (isRetryable(res)) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
        res = await attempt()
      }

      if ("aborted" in res) {
        return {
          ok: false,
          source: "wekruit-matching" as const,
          reason: "backend_timeout",
          summary: "匹配服务超时，请稍后再试。",
          roles: null,
        }
      }
      if ("networkError" in res) {
        return {
          ok: false,
          source: "wekruit-matching" as const,
          reason: "backend_network_error",
          summary: "匹配服务暂时不可达，请稍后再试。",
          roles: null,
        }
      }
      if (res.status >= 500) {
        return {
          ok: false,
          source: "wekruit-matching" as const,
          reason: "backend_5xx",
          summary: "匹配服务返回异常，已记录。",
          roles: null,
        }
      }
      if (!res.ok) {
        // 4xx — caller-side problem; surface but do NOT retry.
        return {
          ok: false,
          source: "wekruit-matching" as const,
          reason: "backend_4xx",
          summary: "匹配服务拒绝请求，已记录。",
          roles: null,
        }
      }

      // Parse backend payload: { roles: Role[] }. Defensive — anything
      // off-shape collapses to ok:false with reason backend_payload_invalid.
      let payload: unknown
      try {
        payload = JSON.parse(res.text)
      } catch {
        return {
          ok: false,
          source: "wekruit-matching" as const,
          reason: "backend_payload_invalid",
          summary: "匹配服务返回异常，已记录。",
          roles: null,
        }
      }
      const rawRoles =
        payload && typeof payload === "object" && Array.isArray((payload as { roles?: unknown }).roles)
          ? (payload as { roles: unknown[] }).roles
          : null
      if (!rawRoles) {
        return {
          ok: false,
          source: "wekruit-matching" as const,
          reason: "backend_payload_invalid",
          summary: "匹配服务返回异常，已记录。",
          roles: null,
        }
      }
      // Schema-validate each role; drop rows that don't fit. This shields
      // the LLM from a backend regression that adds a partially-malformed
      // entry.
      const sanitized = rawRoles
        .map((r) => MatchingRoleSchema.safeParse(r))
        .filter((p): p is { success: true; data: z.infer<typeof MatchingRoleSchema> } => p.success)
        .map((p) => p.data)
        .slice(0, 5)
      const titleList = sanitized.map((r) => r.title).join(", ")
      const summary =
        sanitized.length > 0
          ? `匹配到 ${sanitized.length} 个岗位：${titleList}`.slice(0, 200)
          : "暂时没有合适的岗位推荐。"
      return {
        ok: true,
        source: "wekruit-matching" as const,
        reason: null,
        summary,
        roles: sanitized.length > 0 ? sanitized : null,
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
  "remember-fact": {
    name: "remember-fact",
    version: "1",
    description:
      "Persist a single confirmed user fact to long-term memory. Use when the user explicitly asks PA to remember something (e.g., '记得我...', 'remember that ...'). Sensitive content (PII, credentials, financial) will be rejected; PA must not retry.",
    inputSchema: RememberFactInputSchema,
    outputSchema: RememberFactOutputSchema,
    execute: async (input: RememberFactConnectorInput, ctx: ConnectorContext) => {
      // Ground-truth safety gate is owned by pa-safety, not the connector.
      // The optional `sensitivity` hint from the LLM is advisory only.
      const reject = shouldRejectMemoryFact(input.content)
      if (isUnsafeMemoryContent(input.content) || reject.reject) {
        // Do NOT throw — the LLM must be able to apologize to the user.
        return {
          ok: false,
          reason: reject.reason ?? "sensitive_content",
        }
      }

      // Duplicate detection: if a confirmed fact with normalized identical
      // content already exists, return its id with conflict=true and skip
      // the write. Prevents repeated "remember X" turns from spamming
      // pa_memory_facts.
      const facts = await listConfirmedMemoryFacts(ctx.db, ctx.userId)
      const target = normalizeFactContent(input.content)
      const existing = facts.find((f) => normalizeFactContent(f.content) === target)
      if (existing) {
        return { ok: true, factId: existing.id, conflict: true }
      }

      const factId = await createConfirmedMemoryFact(
        ctx.db,
        ctx.userId,
        input.content,
        "explicit_user"
      )
      // Mirror the legacy regex path so the dashboard memory_actions tab
      // continues to render the same shape. recordMemoryAction is the
      // canonical helper; do not write directly to pa_memory_actions.
      await recordMemoryAction(ctx.db, {
        userId: ctx.userId,
        action: "remember",
        status: "succeeded",
        content: input.content,
        factIds: [factId],
      })
      return { ok: true, factId, conflict: false }
    },
  } satisfies ConnectorDef<RememberFactConnectorInput, RememberFactConnectorOutput>,
  "save-job-profile": {
    name: "save-job-profile",
    version: "1",
    description:
      "Persist the candidate's job-search preferences (industry tags, sponsorship need, location, company size, optional salary floor) so the daily job recommender can deliver personalised matches. Use ONLY when the user has volunteered all four required fields across the probing flow (industryTags, sponsorshipNeeded, locationPreference, sizePreference). Calling this multiple times is safe — later calls merge with earlier ones.",
    inputSchema: SaveJobProfileInputSchema,
    outputSchema: SaveJobProfileOutputSchema,
    execute: async (
      input: SaveJobProfileConnectorInput,
      ctx: ConnectorContext
    ): Promise<SaveJobProfileConnectorOutput> => {
      try {
        const ts = new Date().toISOString()
        const ref = ctx.db.collection(JOB_PROFILES_COLLECTION).doc(ctx.userId)
        await ctx.db.runTransaction(async (tx) => {
          const cur = await tx.get(ref)
          const profilePayload = {
            industryTags: input.industryTags,
            sponsorshipNeeded: input.sponsorshipNeeded,
            locationPreference: input.locationPreference,
            sizePreference: input.sizePreference,
            // salaryMin: nullable, NOT undefined (Firestore doesn't store undefined).
            salaryMin: input.salaryMin,
          }
          if (cur.exists) {
            const prev = cur.data() as { status?: unknown; createdAt?: unknown } | undefined
            const next = {
              userId: ctx.userId,
              profile: profilePayload,
              // Preserve operator-paused status; otherwise advance to active.
              status: prev?.status === "paused" ? "paused" : "active",
              createdAt: typeof prev?.createdAt === "string" ? prev.createdAt : ts,
              updatedAt: ts,
            }
            tx.set(ref, next, { merge: true })
          } else {
            const doc = {
              userId: ctx.userId,
              profile: profilePayload,
              status: "active",
              createdAt: ts,
              updatedAt: ts,
              cvParsedAt: ts,
              lastJobBatchSentAt: null,
            }
            tx.set(ref, doc)
          }
        })
        return { ok: true }
      } catch (err) {
        // Audit logger upstream (runConnector) records the actual error;
        // surface a stable reason to the LLM so it can apologize cleanly.
        return {
          ok: false,
          reason: err instanceof Error ? err.message.slice(0, 200) : "save_failed",
        }
      }
    },
  } satisfies ConnectorDef<SaveJobProfileConnectorInput, SaveJobProfileConnectorOutput>,
  "find-match": FIND_MATCH_CONNECTOR,
  "match-against-collab-jobs": MATCH_COLLAB_CONNECTOR,
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
    toolFamily: resolveToolFamily(name),
    connectorVersion: def.version,
    status: policy.allow ? "running" : "denied",
    argsDigest: digest(args),
    argsRedacted: redact(args),
    policyDecision: policy.allow ? "allow" : "deny",
    ...(policy.reason ? { policyReason: policy.reason } : {}),
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
