/**
 * v2.1 P3 — LLM-powered pitch email generator.
 *
 * Loads a candidate (pa-users) + job (matching-jobs) and produces a
 * personalized outreach email subject + body using gpt-5.4-nano (Sonnet
 * fallback). Hardened with an evidence-only prompt: the LLM may only
 * reference facts that appear in the candidate_evidence / job_evidence
 * blocks. If overlap is insufficient, the function returns
 * `{ status: "insufficient_evidence" }` instead of fabricating.
 *
 * This is a compute-only callable — it does NOT touch pa-outreach-plans.
 * P4 wires the result into the approve-and-send flow.
 *
 * Why no plan write here:
 *  - keeps the LLM path testable end-to-end with a single, side-effect-free
 *    surface
 *  - operator can preview the draft in the dashboard before committing it
 *    to a plan doc
 *  - decouples LLM cost (per-call) from outbound state (per-plan)
 */
import { randomUUID } from "node:crypto"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { runWithOpenAI as defaultRunWithOpenAI } from "@pa/agent-runtime"
import { requireExternalSupplyAdmin } from "./resolve-identity.js"

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY")
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

// ---------------------------------------------------------------------------
// Input + output schemas
// ---------------------------------------------------------------------------

export const GeneratePitchEmailInputSchema = z.object({
  candidateId: z.string().min(1),
  jobId: z.string().min(1),
  /** Optional tone hint. */
  tone: z.enum(["warm_professional", "concise_recruiter", "personal_referral"]).optional(),
})
export type GeneratePitchEmailInput = z.infer<typeof GeneratePitchEmailInputSchema>

export interface GeneratePitchEmailResult {
  status: "ok" | "insufficient_evidence"
  candidateId: string
  jobId: string
  // Set when status="ok"
  subject?: string
  body?: string
  usedEvidence?: Array<{
    type: "candidate_experience" | "candidate_skill" | "job_requirement"
    text: string
  }>
  confidence?: number
  riskFlags?: string[]
  // Set when status="insufficient_evidence"
  reason?: string
  // Debug
  modelUsed: string
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are writing a recruiter outreach email. You may ONLY reference facts present in the provided candidate_evidence, job_evidence, and (optional) match_evidence blocks. If a relevant fact is missing, omit it — do not infer.

NEVER mention:
- age, gender, race, religion, marital status, health, immigration status
- candidate's perceived seniority unless explicitly tagged
- compensation expectations

REQUIRED:
- candidate first name from candidate_evidence.full_name
- exactly 1 specific experience overlap from candidate_evidence.experiences
- exactly 1 job requirement from job_evidence.requirements that overlaps
- closing line: "Reply 'stop' and I won't follow up."

LENGTH: 80-150 words.

OUTPUT JSON ONLY (no markdown fence, no commentary):
{
  "subject": "<70 chars>",
  "body": "<plain text, no markdown>",
  "used_evidence": [{"type":"candidate_experience"|"candidate_skill"|"job_requirement","text":"<verbatim quote>"}],
  "confidence": 0.0-1.0,
  "risk_flags": []
}

If candidate_evidence.experiences is empty OR no overlap with job_evidence.requirements is found, return EXACTLY:
{"status":"insufficient_evidence","reason":"<short reason>"}`

// ---------------------------------------------------------------------------
// Evidence builders
// ---------------------------------------------------------------------------

interface CandidateEvidence {
  full_name: string | null
  first_name: string | null
  experiences: Array<{ company: string; title: string }>
  skills: string[]
}

interface JobEvidence {
  company_name: string
  title: string
  requirements: string[]
}

function readCandidateEvidence(userDoc: Record<string, unknown> | undefined): CandidateEvidence | null {
  if (!userDoc) return null
  const tags = (userDoc.tags ?? {}) as Record<string, unknown>
  const experiencesRaw = (userDoc.experiences ?? []) as Array<{ company?: string; title?: string }>
  const experiences = experiencesRaw
    .filter((e) => e.company && e.title)
    .slice(0, 5)
    .map((e) => ({ company: String(e.company), title: String(e.title) }))
  const skillsRaw = (tags.skills ?? []) as Array<string | { name?: string }>
  const skills = skillsRaw
    .map((s) => (typeof s === "string" ? s : typeof s?.name === "string" ? s.name : null))
    .filter((s): s is string => s !== null && s.length > 0)
    .slice(0, 20)
  const fullName =
    (userDoc.name as string | undefined) ??
    (userDoc.candidateName as string | undefined) ??
    null
  const firstName = fullName ? fullName.split(/\s+/)[0] : null
  // Fallback: recentRoleTitle + recentCompany if experiences[] empty
  if (experiences.length === 0) {
    const recentTitle = tags.recentRoleTitle as string | undefined
    const recentCompany = tags.recentCompany as string | undefined
    if (recentTitle && recentCompany) {
      experiences.push({ company: recentCompany, title: recentTitle })
    }
  }
  return {
    full_name: fullName,
    first_name: firstName,
    experiences,
    skills,
  }
}

function readJobEvidence(jobDoc: Record<string, unknown> | undefined): JobEvidence | null {
  if (!jobDoc) return null
  const companyName = (jobDoc.company as string | undefined) ?? "the company"
  const title = (jobDoc.title as string | undefined) ?? "this role"
  // Pull from a few common job-shape fields, dedup
  const requirements = new Set<string>()
  for (const field of ["requiredSkills", "niceToHaveSkills", "relevantTags"] as const) {
    const v = jobDoc[field]
    if (Array.isArray(v)) {
      for (const item of v) {
        const t = typeof item === "string" ? item : null
        if (t && t.trim().length > 0) requirements.add(t.trim())
      }
    }
  }
  return {
    company_name: companyName,
    title,
    requirements: [...requirements].slice(0, 20),
  }
}

function hasOverlap(cand: CandidateEvidence, job: JobEvidence): boolean {
  if (cand.experiences.length === 0) return false
  if (job.requirements.length === 0) return false
  const candTokens = new Set(
    [
      ...cand.skills.map((s) => s.toLowerCase()),
      ...cand.experiences.map((e) => e.title.toLowerCase()),
    ].flatMap((s) => s.split(/[\s,_/-]+/).filter((t) => t.length > 2)),
  )
  for (const req of job.requirements) {
    const reqTokens = req.toLowerCase().split(/[\s,_/-]+/).filter((t) => t.length > 2)
    for (const rt of reqTokens) {
      if (candTokens.has(rt)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface GeneratePitchEmailDeps {
  loadCandidate: (id: string) => Promise<Record<string, unknown> | undefined>
  loadJob: (id: string) => Promise<Record<string, unknown> | undefined>
  runLLM: (args: { systemPrompt: string; userMessage: string; model: string; apiKey: string }) => Promise<{ text: string }>
  apiKey: string
  now?: () => string
  log?: (msg: string, fields?: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// Pure runner
// ---------------------------------------------------------------------------

export async function runGeneratePitchEmail(
  input: GeneratePitchEmailInput,
  deps: GeneratePitchEmailDeps,
): Promise<GeneratePitchEmailResult> {
  const now = (deps.now ?? (() => new Date().toISOString()))()

  const [candidateDoc, jobDoc] = await Promise.all([
    deps.loadCandidate(input.candidateId),
    deps.loadJob(input.jobId),
  ])

  if (!candidateDoc) {
    throw new HttpsError("not-found", `candidate_not_found:${input.candidateId}`)
  }
  if (!jobDoc) {
    throw new HttpsError("not-found", `job_not_found:${input.jobId}`)
  }

  const candEvidence = readCandidateEvidence(candidateDoc)
  const jobEvidence = readJobEvidence(jobDoc)

  if (!candEvidence || !jobEvidence) {
    return {
      status: "insufficient_evidence",
      candidateId: input.candidateId,
      jobId: input.jobId,
      reason: "evidence_blocks_missing",
      modelUsed: "none",
      generatedAt: now,
    }
  }

  if (!hasOverlap(candEvidence, jobEvidence)) {
    return {
      status: "insufficient_evidence",
      candidateId: input.candidateId,
      jobId: input.jobId,
      reason: "no_overlap_between_candidate_skills_and_job_requirements",
      modelUsed: "none",
      generatedAt: now,
    }
  }

  const userMessage = JSON.stringify(
    {
      candidate_evidence: candEvidence,
      job_evidence: jobEvidence,
      tone: input.tone ?? "warm_professional",
    },
    null,
    2,
  )

  const model = "gpt-5.4-nano"
  let raw: string
  try {
    const res = await deps.runLLM({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      model,
      apiKey: deps.apiKey,
    })
    raw = res.text
  } catch (err) {
    deps.log?.("pa.coresignal.pitch_email.llm_call_failed", {
      err: (err as Error).message,
    })
    throw new HttpsError("internal", `llm_call_failed:${(err as Error).message}`)
  }

  // Strip code fence if present
  let parsedRaw = raw.trim()
  if (parsedRaw.startsWith("```")) {
    parsedRaw = parsedRaw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(parsedRaw)
  } catch (err) {
    deps.log?.("pa.coresignal.pitch_email.parse_failed", {
      raw: raw.slice(0, 500),
    })
    throw new HttpsError("internal", `llm_response_not_json: ${raw.slice(0, 200)}`)
  }

  if (parsed.status === "insufficient_evidence") {
    return {
      status: "insufficient_evidence",
      candidateId: input.candidateId,
      jobId: input.jobId,
      reason: typeof parsed.reason === "string" ? parsed.reason : "llm_returned_insufficient_evidence",
      modelUsed: model,
      generatedAt: now,
    }
  }

  if (typeof parsed.subject !== "string" || typeof parsed.body !== "string") {
    throw new HttpsError(
      "internal",
      `llm_response_missing_required_fields: ${JSON.stringify(parsed).slice(0, 200)}`,
    )
  }

  return {
    status: "ok",
    candidateId: input.candidateId,
    jobId: input.jobId,
    subject: parsed.subject,
    body: parsed.body,
    usedEvidence: Array.isArray(parsed.used_evidence)
      ? (parsed.used_evidence as Array<{ type: GeneratePitchEmailResult["usedEvidence"] extends Array<infer X> | undefined ? X extends { type: infer T } ? T : never : never; text: string }>)
          .filter(
            (e) =>
              typeof e?.text === "string" &&
              typeof e?.type === "string" &&
              ["candidate_experience", "candidate_skill", "job_requirement"].includes(
                e.type as string,
              ),
          )
      : [],
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    riskFlags: Array.isArray(parsed.risk_flags) ? (parsed.risk_flags as string[]) : [],
    modelUsed: model,
    generatedAt: now,
  }
}

// ---------------------------------------------------------------------------
// Default LLM adapter using @pa/agent-runtime
// ---------------------------------------------------------------------------

async function defaultRunLLM(args: {
  systemPrompt: string
  userMessage: string
  model: string
  apiKey: string
}): Promise<{ text: string }> {
  // runWithOpenAI signature: (agent, { messages, signal? }, client?).
  // Default client reads OPENAI_API_KEY from process.env — Firebase v2
  // secret bindings inject it automatically when the function declares
  // OPENAI_API_KEY in `secrets:`.
  if (process.env.OPENAI_API_KEY !== args.apiKey) {
    process.env.OPENAI_API_KEY = args.apiKey
  }
  const result = await defaultRunWithOpenAI(
    {
      id: "coresignal-pitch-email",
      name: "CoreSignal pitch email writer",
      provider: "openai",
      model: args.model,
      temperature: 0.4,
      maxTokens: 600,
      systemPrompt: args.systemPrompt,
      version: "2026-05-21-A",
      memoryMode: "firestore_only",
      toolPolicy: "none",
    } as Parameters<typeof defaultRunWithOpenAI>[0],
    {
      messages: [
        { role: "system", content: args.systemPrompt },
        { role: "user", content: args.userMessage },
      ],
    },
  )
  return { text: result.text ?? "" }
}

// ---------------------------------------------------------------------------
// Callable wrapper
// ---------------------------------------------------------------------------

export const paGeneratePitchEmail = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: [OPENAI_API_KEY, PA_ADMIN_TOKEN],
  },
  async (req): Promise<GeneratePitchEmailResult> => {
    const { uid } = requireExternalSupplyAdmin(req.auth)
    const parsed = GeneratePitchEmailInputSchema.safeParse(req.data)
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", parsed.error.message)
    }

    const apiKey = OPENAI_API_KEY.value()
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "OPENAI_API_KEY missing")
    }

    const db = getFirestore()
    return runGeneratePitchEmail(parsed.data, {
      loadCandidate: async (id) => {
        const snap = await db.collection("pa-users").doc(id).get()
        return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
      },
      loadJob: async (id) => {
        const snap = await db.collection("matching-jobs").doc(id).get()
        return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
      },
      runLLM: defaultRunLLM,
      apiKey,
      now: () => new Date().toISOString(),
      log: (msg, fields) => logger.info(msg, { uid, ...fields }),
    })
  },
)
