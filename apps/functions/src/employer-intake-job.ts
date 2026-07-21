/**
 * employer-intake-job.ts — `paEmployerIntakeJob` public onCall.
 *
 * Backs Step 5 ("Calibrate Pilot Req") of the customer-facing employer
 * onboarding wizard (apps/pa-landing/.../EmployerOnboarding.tsx). It takes one
 * real role (title + JD/role brief) and runs the SAME production enrichment
 * path the AI-headhunter and admin job-intake use (`runIntakeJob` →
 * `enrichJobTags` 3-tier LLM router + `deriveJobOpportunityDraft`), returning
 * canonical tags, hard filters, auto-drafted prescreen questions, and
 * plain-English clarifying questions so the employer can "calibrate, don't
 * configure".
 *
 * AUTH: public — mirrors the existing customer-facing employer callable
 * `openRegisterEmployer` (cors:true, NO auth/app-check gate). This is a
 * read-only, in-memory enrichment; it creates NO job doc and persists nothing.
 * Wiring the approved draft into matching/persistence is a separate operator
 * step.
 *
 * SECRETS: `enrichJobTags` reads its keys from process.env at runtime, so we
 * bind PA_OPENAI_AGENT_API_KEY (required primary) + ANTHROPIC_API_KEY (optional
 * secondary) and hydrate them into process.env before calling runIntakeJob —
 * the same hydrate-then-call idiom paHeadhunterMcp/openRegisterEmployer use.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { defineSecret } from "firebase-functions/params"

import { runIntakeJob, type IntakeJobInput } from "./headhunter-mcp/job-intake.js"

// Primary OpenAI tier for enrichJobTags; without it enrichment fails.
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
// Optional Anthropic secondary/fallback tier; falls through gracefully if unset.
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY")

export type EmployerIntakeJobInput = {
  title: string
  jobDescription: string
  companyName?: string
  locationRaw?: string
}

export const paEmployerIntakeJob = onCall<EmployerIntakeJobInput>(
  {
    region: "us-central1",
    cors: true,
    memory: "512MiB",
    timeoutSeconds: 120,
    secrets: [PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY],
  },
  async (req) => {
    const data = req.data ?? ({} as EmployerIntakeJobInput)
    const title = (data.title ?? "").trim()
    const jobDescription = (data.jobDescription ?? "").trim()

    logger.info("paEmployerIntakeJob.entry", {
      hasTitle: Boolean(title),
      jdLen: jobDescription.length,
      hasCompany: Boolean(data.companyName),
    })

    if (!title) throw new HttpsError("invalid-argument", "title is required")
    if (!jobDescription) throw new HttpsError("invalid-argument", "jobDescription is required")

    // Hydrate enricher secrets into process.env before the LLM call.
    process.env.PA_OPENAI_AGENT_API_KEY = PA_OPENAI_AGENT_API_KEY.value()
    try {
      process.env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY.value()
    } catch {
      /* optional secondary tier — fall through if unbound */
    }

    const input: IntakeJobInput = {
      title,
      jobDescription,
      companyName: data.companyName?.trim() || undefined,
      locationRaw: data.locationRaw?.trim() || undefined,
    }

    const result = await runIntakeJob(input)

    // runIntakeJob returns { error } on guard failure — surface as a typed error.
    const errorCode = (result as { error?: string }).error
    if (errorCode) throw new HttpsError("invalid-argument", errorCode)

    return result
  },
)
