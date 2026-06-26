/**
 * `paAdminIntakeJob` — admin-only callable that brings Slack-parity job
 * enrichment to the dashboard create-job / job-edit surface.
 *
 * Thin auth+validate shim over `runIntakeJob` (apps/functions/src/headhunter-mcp/
 * job-intake.ts) — the SAME runner the Slack-agent `intake_job` tool calls. Zero
 * new business logic: it reuses the production `enrichJobTags` 3-tier LLM router
 * + `deriveJobOpportunityDraft` (the exact path the admin job-enrichment callable
 * uses) to turn raw JD text into canonical tags, hard filters, draft prescreen
 * questions, a confidence, and plain-English clarifying questions.
 *
 * Advisory + non-destructive: it creates/persists NOTHING. The operator reviews
 * the output, can fold the clarifying answers back into the JD, and re-run. So a
 * dashboard-created job gets the same enrichment a JD that arrives via Slack does.
 *
 * Auth mirrors paAdminMatchDebug / paPromoteSandboxTag: Firebase Auth
 * `auth.token.admin === true` OR the `PA_ADMIN_TOKEN` scripted-caller fallback.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { z } from "zod"
import { runIntakeJob, type IntakeJobInput } from "./headhunter-mcp/job-intake.js"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

// PA_ADMIN_TOKEN — scripted-caller fallback (mirrors paAdminMatchDebug).
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
// enrichJobTags (the 3-tier LLM router inside runIntakeJob) reads its keys from
// process.env at runtime — so we MUST bind + hydrate them, the same
// bind-then-hydrate idiom paEmployerIntakeJob / paHeadhunterMcp use. Without the
// primary key the enrichment throws and the CF returns INTERNAL.
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
// Optional Anthropic secondary/fallback tier — falls through gracefully if unset.
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY")

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * `answers` is operator-supplied free text answering the prior round's
 * clarifying questions. We fold it onto the JD before re-enriching so the
 * second pass sees the filled gaps — the same "ask, fold, re-run" loop the
 * Slack agent uses.
 */
export const AdminIntakeJobInputSchema = z.object({
  jobDescription: z.string().min(1, "jobDescription is required"),
  title: z.string().optional(),
  companyName: z.string().optional(),
  locationRaw: z.string().optional(),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
  currency: z.string().optional(),
  /** Operator answers to the previous round's clarifying questions. */
  answers: z.string().optional(),
  /** Scripted-admin fallback (mirrors paAdminMatchDebug). */
  adminToken: z.string().optional(),
})
export type AdminIntakeJobInput = z.infer<typeof AdminIntakeJobInputSchema>

/**
 * Derive a usable title when the operator leaves it blank: first non-empty
 * line of the JD, trimmed of a leading markdown heading marker. `runIntakeJob`
 * still validates and returns `{ error: "title_required" }` if this is empty.
 */
function deriveTitle(input: AdminIntakeJobInput): string {
  if (input.title && input.title.trim()) return input.title.trim()
  const firstLine = (input.jobDescription.split("\n").find((l) => l.trim().length > 0) ?? "").trim()
  return firstLine.replace(/^#+\s*/, "").slice(0, 120)
}

/**
 * Pure handler — deps-free (runIntakeJob does its own LLM calls). Folds any
 * operator answers onto the JD, then defers entirely to the shared runner.
 */
export async function runAdminIntakeJob(raw: unknown): Promise<Record<string, unknown>> {
  const parsed = AdminIntakeJobInputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error.message)
  }
  const data = parsed.data

  const jobDescription =
    data.answers && data.answers.trim()
      ? `${data.jobDescription.trim()}\n\n## Clarifying answers from hiring team\n${data.answers.trim()}`
      : data.jobDescription

  const runnerInput: IntakeJobInput = {
    title: deriveTitle(data),
    jobDescription,
    companyName: data.companyName,
    locationRaw: data.locationRaw,
    salaryMin: data.salaryMin,
    salaryMax: data.salaryMax,
    currency: data.currency,
  }

  return runIntakeJob(runnerInput)
}

// ---------------------------------------------------------------------------
// CF entry — admin-gated, delegates to the shared runIntakeJob runner.
// ---------------------------------------------------------------------------

export const paAdminIntakeJob = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    // Enrichment is a 3-tier LLM router (OpenAI → Anthropic → OpenAI) — give it
    // headroom for retries on the slow path.
    timeoutSeconds: 120,
    secrets: [PA_ADMIN_TOKEN, PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY],
  },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    // Hydrate enricher secrets into process.env BEFORE the LLM call (enrichJobTags
    // reads them at runtime). Primary is required; secondary falls through if unbound.
    process.env.PA_OPENAI_AGENT_API_KEY = PA_OPENAI_AGENT_API_KEY.value()
    try {
      process.env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY.value()
    } catch {
      /* optional secondary tier — fall through if unbound */
    }
    return runAdminIntakeJob(req.data)
  },
)
