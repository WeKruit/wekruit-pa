/**
 * "Wrong role, not a wrong candidate" — client for
 * `paAdminRecommendRolesForSubmission` (apps/functions/src/admin-recommend-roles.ts),
 * plus the one-click re-route that submits the same candidate to a recommended role.
 *
 * The re-route posts the PUBLIC `paRecruiterSubmission` endpoint rather than writing
 * Firestore directly, so the server still computes the score, the identity keys and the
 * doc id, and the create still fires `paRecruiterSubmissionEval` — the new row is
 * indistinguishable from one a recruiter submitted by hand. The ORIGINAL submitter is
 * carried through so the recruiter who sourced the candidate keeps the credit.
 */
import { httpsCallable } from "firebase/functions"
import { functions } from "./firebase.js"

const FUNCTIONS_BASE = "https://us-central1-wekruit-5f89b.cloudfunctions.net"

export interface RoleRecommendation {
  jobId: string
  title: string
  company: string
  fitScore: number
  whyFits: string
  whatsMissing: string
}

export interface RoleRecommendationsDoc {
  generatedAt: string
  model: string
  sourceJobId: string
  candidateRoleCount: number
  items: RoleRecommendation[]
}

type RecommendResult =
  | { ok: true; cached: boolean; result: RoleRecommendationsDoc }
  | { ok: false; reason: string }

export async function recommendRolesForSubmission(
  submissionId: string,
  refresh = false,
): Promise<RecommendResult> {
  const fn = httpsCallable<{ submissionId: string; refresh: boolean }, RecommendResult>(
    functions(),
    "paAdminRecommendRolesForSubmission",
  )
  const res = await fn({ submissionId, refresh })
  return res.data
}

/**
 * Submit an already-sourced candidate to a different role. Idempotent per
 * (submission, target role): a second click returns the existing row instead of
 * creating a duplicate submission for the same person.
 */
export async function submitCandidateToRole(args: {
  submissionId: string
  jobId: string
  submitter: { name: string; email: string }
  candidate: Record<string, unknown>
  sourceRoleLabel: string
}): Promise<{ ok: boolean; reason?: string; submissionId?: string; idempotent?: boolean }> {
  const notes = [
    typeof args.candidate.notes === "string" ? args.candidate.notes : "",
    `Re-routed from "${args.sourceRoleLabel}" by a WeKruit operator: the candidate was sourced for that role and looks like a better fit here. Checklist left blank on purpose — nothing has been attested for THIS role's rubric.`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4000)

  const res = await fetch(`${FUNCTIONS_BASE}/paRecruiterSubmission`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Deterministic: re-clicking cannot create a second row for the same person+role.
      "idempotency-key": `reroute-${args.submissionId}-${args.jobId}`.slice(0, 200),
    },
    body: JSON.stringify({
      jobId: args.jobId,
      source: "api",
      submitter: args.submitter,
      candidate: { ...args.candidate, notes },
      // No ticks: a tick is a CLAIM the judge verifies, and nobody has assessed this
      // candidate against THIS role's checklist yet.
      checklist: {},
    }),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.status === 200) {
    return { ok: true, submissionId: String(body.submissionId ?? ""), idempotent: Boolean(body.idempotent) }
  }
  return { ok: false, reason: String(body.reason ?? `http_${res.status}`) }
}
