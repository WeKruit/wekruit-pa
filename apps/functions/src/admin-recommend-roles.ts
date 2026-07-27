/**
 * `paAdminRecommendRolesForSubmission` — "this candidate is wrong for THIS role, which of our
 * other roles do they actually fit?" (Adam 2026-07-26).
 *
 * A candidate rejected for Photon · Backend Engineer is not a bad candidate, they are a candidate
 * against the wrong rubric — the pool holds ~28 roles across 10+ companies, several of them
 * founding-engineer shaped. Rejecting without checking the rest throws away supply we already paid
 * to acquire, which is the opposite of the retention marketplace.
 *
 * SHAPE: ONE LLM call that ranks the candidate across the WHOLE role catalogue, not one call per
 * role. 28 calls per candidate would be ~30-60s and 28x the spend for a question the model can
 * answer in a single pass over compact role summaries.
 *
 * EVIDENCE DISCIPLINE is the same as the submission judge — a technology named in a skills list is
 * a claim, not experience — because the failure mode here is worse: a keyword-matched "fit" sends a
 * real recruiter to pitch a real hiring manager on someone who cannot do the job.
 *
 * REUSE, NOT REBUILD: candidate evidence comes from the submission itself plus the Coresignal
 * research ALREADY stored on `aiEvaluation.research` by the eval trigger (no new provider call, no
 * new spend), and the résumé through the same reader the judge uses. Role rubrics come from the
 * same `recruiterBoard.checklist` the judge scores against.
 *
 * LABEL-ONLY: writes `roleRecommendations` onto the submission. Never touches status, never creates
 * a submission, never messages anyone. Acting on a recommendation is an explicit operator click in
 * the dashboard, which goes through the normal `paRecruiterSubmission` path.
 */
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { callWithFallback } from "@pa/pa-resume-parser"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"
import { extractChecklistGroups, defaultFetchResumeText } from "./recruiter-submission-eval.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY")

const SUBMISSIONS = "pa-recruiter-submissions"
const JOBS = "pa-jobs"

/** Roles a candidate can be re-routed into. A job with no checklist has no bar to judge against. */
const CLOSED_STATUSES = new Set(["inactive", "closed", "archived", "filled", "paused"])
/** Enough for the whole catalogue several times over; a hit means the prompt would be truncated. */
const ROLE_CAP = 60
const TOP_N = 5

export const RECOMMEND_SYSTEM_PROMPT = `You are WeKruit's internal role-routing analyst. A candidate was submitted for ONE role. Your job is to say which OTHER roles in the catalogue they would genuinely be a strong candidate for, so an operator can re-route them instead of dropping them.

Rules:
- EVIDENCE, NOT KEYWORDS. A technology named only in a skills list, a summary line, coursework, or a certification is a CLAIM. A role fits only when the candidate's described WORK supports it — what they built, where, for how long, what they personally owned. Never rank a role highly because its title or required stack appears as a word on the résumé.
- BE HONEST ABOUT A BAD POOL. If none of the roles genuinely fit, return an EMPTY list. A padded list costs a recruiter a wasted pitch to a hiring manager and burns the candidate's goodwill. Returning nothing is a correct, useful answer.
- Rank by how well the candidate clears that role's HARD requirements specifically. A candidate who clears 4/4 hard items on a mid-level role outranks one who clears 2/5 on a senior role.
- fitScore is 0..1: 0.8+ = would clearly clear the hard bar, 0.5-0.8 = plausible, needs a human read, below 0.5 = do not recommend (leave it out).
- whyFits: 1-2 short sentences citing the SPECIFIC work that supports it (named systems, companies, scale, ownership). No generic praise.
- whatsMissing: the hard requirements of that role you could NOT evidence, or "" when none. Be concrete.
- Consider seniority honestly in both directions: do not route a junior into a staff role, and do not route a seasoned founder-type into an early-career role.
- Output STRICT JSON matching the schema. Nothing else.`

export const RECOMMEND_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["recommendations"],
  properties: {
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["jobId", "fitScore", "whyFits", "whatsMissing"],
        properties: {
          jobId: { type: "string" },
          fitScore: { type: "number" },
          whyFits: { type: "string" },
          whatsMissing: { type: "string" },
        },
      },
    },
  },
}

export type RoleRecommendation = {
  jobId: string
  title: string
  company: string
  fitScore: number
  whyFits: string
  whatsMissing: string
}

export type RoleRecommendationsDoc = {
  generatedAt: string
  model: string
  /** The submission's own job — recorded so a stale cache from a different role is visible. */
  sourceJobId: string
  candidateRoleCount: number
  items: RoleRecommendation[]
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Compact rubric line per role — title, company, and the HARD items, which are what gate a fit. */
export function buildRoleCatalogueText(
  roles: Array<{ id: string; title: string; company: string; hard: string[]; fit: string[] }>,
): string {
  return roles
    .map((r) => {
      const hard = r.hard.length ? r.hard.map((h) => `      - ${h}`).join("\n") : "      (none listed)"
      const fit = r.fit.length ? `\n    Strong-fit signals: ${r.fit.join("; ")}` : ""
      return `- jobId: ${r.id}\n    ${r.title} @ ${r.company}\n    Hard requirements:\n${hard}${fit}`
    })
    .join("\n\n")
}

export function buildRecommendUserText(args: {
  candidate: Record<string, unknown>
  notes: string
  currentRoleLabel: string
  research?: unknown
  resumeText?: string
  catalogue: string
  topN: number
}): string {
  const c = args.candidate
  return `# Candidate

Name: ${str(c.name) || "(unknown)"}
Current role: ${str(c.currentRole) || "(unknown)"}${str(c.currentCompany) ? ` @ ${str(c.currentCompany)}` : ""}
Years of experience (as submitted): ${str(c.yoe) || "(unstated)"}
LinkedIn: ${str(c.linkedinUrl) || str(c.link) || "(none)"}

They were submitted for: ${args.currentRoleLabel}. Do NOT include that role in your answer.

## Résumé full text
${args.resumeText ? args.resumeText.slice(0, 12_000) : "(no résumé available — judge on the notes and research below; be correspondingly careful, and prefer fewer recommendations)"}

## Recruiter / sourcing notes
${args.notes ? args.notes.slice(0, 6_000) : "(none)"}

## Independent research (corroboration only; can be stale, sparse, or a wrong-identity match)
${args.research ? JSON.stringify(args.research).slice(0, 4_000) : "(none)"}

# Role catalogue

${args.catalogue}

Return at most ${args.topN} roles, best first, each with fitScore >= 0.5. Return an empty list if none genuinely fit.`
}

export async function runRecommendRoles(
  deps: {
    db: Firestore
    openaiKey: string
    anthropicKey?: string
    fetchResumeText?: (url: string) => Promise<string | undefined>
    /** Test seam. Prod uses the shared 3-tier router. */
    callModel?: typeof callWithFallback
    nowIso?: () => string
    log?: (event: string, fields?: Record<string, unknown>) => void
  },
  input: { submissionId: string; refresh?: boolean },
): Promise<{ ok: true; cached: boolean; result: RoleRecommendationsDoc } | { ok: false; reason: string }> {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())
  const ref = deps.db.collection(SUBMISSIONS).doc(input.submissionId)
  const snap = await ref.get()
  if (!snap.exists) return { ok: false, reason: "submission_not_found" }
  const sub = (snap.data() ?? {}) as Record<string, unknown>
  const sourceJobId = str(sub.jobId)

  const cached = rec(sub.roleRecommendations) as unknown as RoleRecommendationsDoc | undefined
  if (!input.refresh && cached && Array.isArray(cached.items) && cached.sourceJobId === sourceJobId) {
    return { ok: true, cached: true, result: cached }
  }

  // Catalogue: every job with a real rubric, minus this one and anything closed. `status` is
  // sometimes absent on hand-seeded collab jobs (several founding roles have none) — absence must
  // NOT mean closed, or the most re-routable roles in the pool would be invisible here.
  const jobsSnap = await deps.db.collection(JOBS).limit(ROLE_CAP * 4).get()
  const roles: Array<{ id: string; title: string; company: string; hard: string[]; fit: string[] }> = []
  const labelById = new Map<string, { title: string; company: string }>()
  for (const doc of jobsSnap.docs) {
    if (doc.id === sourceJobId) continue
    const j = (doc.data() ?? {}) as Record<string, unknown>
    if (CLOSED_STATUSES.has(str(j.status).toLowerCase())) continue
    const groups = extractChecklistGroups(j)
    const hard = groups.filter((g) => g.kind === "hard").flatMap((g) => g.items.map((i) => i.text))
    if (!hard.length) continue // no bar to judge against
    const title = str(j.title) || str(j.roleTitle) || doc.id
    const company = str(j.companyName) || str(j.company) || "—"
    roles.push({
      id: doc.id,
      title,
      company,
      hard,
      fit: groups.filter((g) => g.kind === "fit").flatMap((g) => g.items.map((i) => i.text)),
    })
    labelById.set(doc.id, { title, company })
  }
  if (!roles.length) return { ok: false, reason: "no_other_roles_with_a_rubric" }

  const candidate = rec(sub.candidate)
  const resumeUrl = str(candidate.resumeUrl)
  const fetchResume = deps.fetchResumeText ?? ((u: string) => defaultFetchResumeText(u, deps.log))
  const resumeText = resumeUrl ? await fetchResume(resumeUrl).catch(() => undefined) : undefined

  const userText = buildRecommendUserText({
    candidate,
    notes: str(candidate.notes),
    currentRoleLabel: `${str(sub.jobTitleSnapshot) || sourceJobId}`,
    // Already fetched and stored by the eval trigger — reused, never re-bought.
    research: rec(sub.aiEvaluation).research,
    resumeText,
    catalogue: buildRoleCatalogueText(roles.slice(0, ROLE_CAP)),
    topN: TOP_N,
  })

  const out = await (deps.callModel ?? callWithFallback)({
    apiKey: deps.openaiKey,
    anthropicApiKey: deps.anthropicKey,
    systemPrompt: RECOMMEND_SYSTEM_PROMPT,
    userText,
    schemaName: "role_recommendations",
    schema: RECOMMEND_JSON_SCHEMA,
    log: (event: string, fields?: Record<string, unknown>) => deps.log?.(event, fields),
  })

  const parsed = JSON.parse(out.rawJson) as { recommendations?: unknown }
  const items: RoleRecommendation[] = (Array.isArray(parsed.recommendations) ? parsed.recommendations : [])
    .flatMap((raw) => {
      const r = rec(raw)
      const jobId = str(r.jobId)
      const label = labelById.get(jobId)
      // A hallucinated jobId is dropped, not shown — a recommendation for a role that does not
      // exist would send an operator to pitch nothing.
      if (!label) return []
      const fitScore = typeof r.fitScore === "number" ? Math.max(0, Math.min(1, r.fitScore)) : 0
      if (fitScore < 0.5) return []
      return [{ jobId, title: label.title, company: label.company, fitScore, whyFits: str(r.whyFits), whatsMissing: str(r.whatsMissing) }]
    })
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, TOP_N)

  const result: RoleRecommendationsDoc = {
    generatedAt: nowIso(),
    model: out.usedModel || "unknown",
    sourceJobId,
    candidateRoleCount: roles.length,
    items,
  }
  await ref.set({ roleRecommendations: result }, { merge: true })
  return { ok: true, cached: false, result }
}

const Input = z.object({
  submissionId: z.string().min(1),
  refresh: z.boolean().nullish(),
  adminToken: z.string().nullish(),
})

export const paAdminRecommendRolesForSubmission = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 300,
    secrets: [PA_ADMIN_TOKEN, PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY],
  },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const input = Input.safeParse(req.data ?? {})
    if (!input.success) throw new HttpsError("invalid-argument", "submissionId required")
    const openaiKey = (PA_OPENAI_AGENT_API_KEY.value() ?? "").trim()
    if (!openaiKey) throw new HttpsError("failed-precondition", "PA_OPENAI_AGENT_API_KEY not configured")
    return runRecommendRoles(
      {
        db: getFirestore(),
        openaiKey,
        anthropicKey: (ANTHROPIC_API_KEY.value() ?? "").trim() || undefined,
        log: (event, fields) => logger.info("[recommend-roles]", { event, ...fields }),
      },
      { submissionId: input.data.submissionId, refresh: input.data.refresh ?? false },
    )
  },
)
