import { z } from "zod"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { ConnectorContext, ConnectorDef } from "./connector-types.js"

/**
 * Valet connectors — let Claire act on the user's WeKruit Valet account
 * (job-application automation) through Valet's PA gateway.
 *
 * Auth: shared service key (PA_VALET_SERVICE_KEY) + per-user account link.
 * Valet only accepts calls for candidates with an active link, created here
 * by verified-email match (the email comes from the candidate's profile,
 * which PA verified via magic-link/OAuth at signup).
 *
 * Degraded-mode contract (Phase 13): execute() NEVER throws — every failure
 * resolves to a structured `ok:false` payload the LLM can narrate.
 */

const TIMEOUT_MS = 8000
const RETRY_BACKOFF_MS = 250

type ValetConfig = { baseUrl: string; serviceKey: string }

function valetConfig(): ValetConfig | null {
  const baseUrl = process.env.PA_VALET_API_URL
  const serviceKey = process.env.PA_VALET_SERVICE_KEY
  if (!baseUrl || !serviceKey || process.env.PA_VALET_DISABLED === "true") return null
  return { baseUrl: baseUrl.replace(/\/$/, ""), serviceKey }
}

/** fetch with timeout + single retry on network error / 5xx (4xx never retries). */
async function valetFetch(
  config: ValetConfig,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; json: Record<string, unknown> } | { status: 0; json: null }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      const res = await fetch(`${config.baseUrl}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          "X-PA-Service-Key": config.serviceKey,
        },
        body: init?.body != null ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status >= 500 && attempt === 0) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
        continue
      }
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return { status: res.status, json }
    } catch {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
        continue
      }
      return { status: 0, json: null }
    }
  }
  return { status: 0, json: null }
}

/**
 * Ensure the candidate has an active Valet account link.
 * Returns null on success, or an `ok:false` reason string.
 */
async function ensureValetLink(config: ValetConfig, ctx: ConnectorContext): Promise<string | null> {
  const existing = await valetFetch(config, `/api/v1/pa/links/${encodeURIComponent(ctx.userId)}`)
  if (existing.status === 200) return null
  if (existing.status === 0) return "valet_unreachable"

  // Not linked yet — link by the candidate's verified email.
  const userSnap = await ctx.db.collection(PA_COLLECTIONS.users).doc(ctx.userId).get()
  const user = userSnap.data() as
    | { statedPreferences?: { contactEmail?: string } }
    | undefined
  const email = user?.statedPreferences?.contactEmail
  if (!email) return "no_email_on_profile"

  const linked = await valetFetch(config, "/api/v1/pa/links", {
    method: "POST",
    body: { paCandidateId: ctx.userId, email },
  })
  if (linked.status === 200) return null
  if (linked.status === 404) return "no_valet_account"
  if (linked.status === 0) return "valet_unreachable"
  return "link_failed"
}

const REASON_SUMMARIES: Record<string, string> = {
  valet_not_configured: "Valet integration is not configured yet — try again later.",
  valet_unreachable: "Valet is temporarily unreachable — try again in a few minutes.",
  no_email_on_profile:
    "I don't have a verified email for you yet — share the email you use for Valet first.",
  no_valet_account:
    "You don't have a Valet account yet — visit candidate.wekruit.com/auto-apply to get set up, then ask me again.",
  link_failed: "Couldn't link your Valet account — try again later.",
  no_resume:
    "Your Valet setup isn't finished — open the Valet desktop app and complete the quick setup (resume + preferences), then ask me again.",
  no_desktop_app:
    "You haven't installed the Valet desktop app yet — download it at candidate.wekruit.com/auto-apply, sign in with this email, and I can apply for you.",
  not_linked:
    "Your Valet account isn't linked yet — visit candidate.wekruit.com/auto-apply to get set up, then ask me again.",
  task_not_found: "I couldn't find that application in Valet.",
}

// ── valet-apply ───────────────────────────────────────────────

const ValetApplyInputSchema = z.object({
  jobUrl: z.string().min(8).max(2000),
})
const ValetApplyOutputSchema = z.object({
  ok: z.boolean(),
  source: z.literal("valet-apply"),
  reason: z.string().nullable(),
  taskId: z.string().nullable(),
  status: z.string().nullable(),
  summary: z.string(),
})

export type ValetApplyInput = z.infer<typeof ValetApplyInputSchema>
export type ValetApplyOutput = z.infer<typeof ValetApplyOutputSchema>

export const VALET_APPLY_CONNECTOR: ConnectorDef<ValetApplyInput, ValetApplyOutput> = {
  name: "valet-apply",
  version: "1",
  description:
    "Submit a job application on the user's behalf via their WeKruit Valet account. " +
    "Use ONLY when the user explicitly asks to apply to a specific job and you have " +
    "the job posting URL. The application runs asynchronously on the user's machine; " +
    "report the returned status, do not promise instant completion.",
  inputSchema: ValetApplyInputSchema,
  outputSchema: ValetApplyOutputSchema,
  expectedLatencyMs: 4000,
  execute: async (input, ctx) => {
    const fail = (reason: string): ValetApplyOutput => ({
      ok: false,
      source: "valet-apply" as const,
      reason,
      taskId: null,
      status: null,
      summary: REASON_SUMMARIES[reason] ?? `Could not submit the application (${reason}).`,
    })

    const config = valetConfig()
    if (!config) return fail("valet_not_configured")

    const linkError = await ensureValetLink(config, ctx)
    if (linkError) return fail(linkError)

    const res = await valetFetch(config, "/api/v1/pa/tasks", {
      method: "POST",
      body: { paCandidateId: ctx.userId, jobUrl: input.jobUrl },
    })
    if (res.status === 0) return fail("valet_unreachable")
    if (res.status === 201 && res.json?.ok) {
      const taskId = String(res.json.taskId)
      const status = String(res.json.status)
      const desktopOnline = res.json.desktopOnline === true
      return {
        ok: true,
        source: "valet-apply" as const,
        reason: null,
        taskId,
        status,
        summary: desktopOnline
          ? `Application submitted to Valet (task ${taskId}, status: ${status}). The user's desktop app is online — it should start shortly.`
          : `Application queued in Valet (task ${taskId}, status: ${status}). The user's Valet desktop app is currently closed — it will run the next time they open it; suggest opening the app.`,
      }
    }
    const reason = typeof res.json?.reason === "string" ? res.json.reason : "rejected"
    const message = typeof res.json?.message === "string" ? res.json.message : null
    return {
      ok: false,
      source: "valet-apply" as const,
      reason,
      taskId: null,
      status: null,
      summary: message ?? REASON_SUMMARIES[reason] ?? "Valet rejected the application request.",
    }
  },
}

// ── valet-apply-status ────────────────────────────────────────

const ValetApplyStatusInputSchema = z.object({
  taskId: z.string().min(1).max(100),
})
const ValetApplyStatusOutputSchema = z.object({
  ok: z.boolean(),
  source: z.literal("valet-apply-status"),
  reason: z.string().nullable(),
  status: z.string().nullable(),
  errorMessage: z.string().nullable(),
  summary: z.string(),
})

export type ValetApplyStatusInput = z.infer<typeof ValetApplyStatusInputSchema>
export type ValetApplyStatusOutput = z.infer<typeof ValetApplyStatusOutputSchema>

export const VALET_APPLY_STATUS_CONNECTOR: ConnectorDef<
  ValetApplyStatusInput,
  ValetApplyStatusOutput
> = {
  name: "valet-apply-status",
  version: "1",
  description:
    "Check the status of a job application previously submitted via Valet. " +
    "Use when the user asks how their application is going and you have a Valet task id.",
  inputSchema: ValetApplyStatusInputSchema,
  outputSchema: ValetApplyStatusOutputSchema,
  expectedLatencyMs: 2000,
  execute: async (input, ctx) => {
    const fail = (reason: string): ValetApplyStatusOutput => ({
      ok: false,
      source: "valet-apply-status" as const,
      reason,
      status: null,
      errorMessage: null,
      summary: REASON_SUMMARIES[reason] ?? `Could not check the application (${reason}).`,
    })

    const config = valetConfig()
    if (!config) return fail("valet_not_configured")

    const res = await valetFetch(
      config,
      `/api/v1/pa/tasks/${encodeURIComponent(input.taskId)}?paCandidateId=${encodeURIComponent(ctx.userId)}`
    )
    if (res.status === 0) return fail("valet_unreachable")
    if (res.status === 200 && res.json?.ok) {
      const status = String(res.json.status)
      const errorMessage =
        typeof res.json.errorMessage === "string" ? res.json.errorMessage : null
      return {
        ok: true,
        source: "valet-apply-status" as const,
        reason: null,
        status,
        errorMessage,
        summary: errorMessage
          ? `Application status: ${status} — ${errorMessage}`
          : `Application status: ${status}.`,
      }
    }
    const reason = typeof res.json?.reason === "string" ? res.json.reason : "status_failed"
    return fail(reason)
  },
}
