/**
 * employer-home.ts — `paEmployerMyReqs` + `paEmployerOnboardingState` public onCalls.
 *
 * Phase 4 "a returning employer has a home". The customer-facing onboarding
 * wizard (apps/pa-landing/.../EmployerOnboarding.tsx) previously persisted
 * NOTHING server-side — wizard progress lived only in localStorage and pilot
 * reqs were orphan docs with no employer-scoping field. This module closes both
 * gaps with the lightest viable employer key: the onboarding requester's work
 * email (normalized lowercase). There is no real employer auth on this public
 * flow yet, so the email is SELF-ASSERTED, not verified — these callables are a
 * convenience home, not an authorization boundary, and they return ONLY the
 * employer's own non-PII req metadata + their own wizard state. No candidate PII
 * crosses these callables (passed-candidate inbox is a separate, consent-gated
 * callable — see employer-passed-candidates.ts).
 *
 *   - paEmployerMyReqs({ employerEmail })  → lists pa-jobs where
 *       createdByEmail == <normalized email> AND source == "employer_onboarding".
 *       Returns reqId/title/company/status/createdAt per req. No candidate data.
 *   - paEmployerOnboardingState({ mode:"get"|"save", employerEmail, state? })  →
 *       reads/writes pa-employer-onboarding/{emailHash} mirroring the client
 *       WizardState so progress survives a closed tab.
 *
 * AUTH: public — mirrors paEmployerCreatePilotReq / paEmployerMatchPilotReq
 * (cors:true, no auth/app-check gate). Doc id is sha256(email), never the raw
 * email (v2.0 identity rule: no raw PII as a public doc id). The firebase-admin
 * app is initialized globally in index.ts before this module is imported.
 */
import { createHash } from "node:crypto"
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { normalizeEmployerEmail } from "./employer-create-pilot-req.js"

// ---- Doc-id hashing ---------------------------------------------------------

/** sha256(normalized email) → stable, non-PII doc id for the onboarding state. */
export function employerEmailHash(normalizedEmail: string): string {
  return createHash("sha256").update(normalizedEmail, "utf8").digest("hex").slice(0, 40)
}

// ---- paEmployerMyReqs --------------------------------------------------------

export type EmployerMyReqsInput = {
  employerEmail: string
}

export type EmployerReqRow = {
  reqId: string
  title: string
  companyName: string | null
  status: string
  createdAt: string | null
}

export type EmployerMyReqsOutput = {
  employerEmail: string
  reqs: EmployerReqRow[]
}

function isoFromAny(value: unknown): string | null {
  if (!value) return null
  if (typeof value === "string") return value
  // Firestore Timestamp (admin) has toDate(); serverTimestamp resolves to one.
  if (typeof value === "object" && value !== null && typeof (value as { toDate?: unknown }).toDate === "function") {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString()
    } catch {
      return null
    }
  }
  return null
}

export async function runEmployerMyReqs(
  raw: unknown,
  deps: { db: Firestore },
): Promise<EmployerMyReqsOutput> {
  const data = (raw ?? {}) as Partial<EmployerMyReqsInput>
  const employerEmail = normalizeEmployerEmail(data.employerEmail)
  if (!employerEmail) {
    throw new HttpsError("invalid-argument", "A valid employer email is required.")
  }

  // List the employer's own pilot reqs. pa-jobs carries the pilotReq draft +
  // createdAt, so it is the list source (matching-jobs is the matcher mirror).
  // No orderBy on createdAt at the query layer (some legacy docs may lack it +
  // it avoids needing a composite index); sort in memory.
  const snap = await deps.db
    .collection(PA_COLLECTIONS.jobs)
    .where("createdByEmail", "==", employerEmail)
    .where("source", "==", "employer_onboarding")
    .limit(200)
    .get()

  const reqs: EmployerReqRow[] = snap.docs.map((doc) => {
    const d = doc.data() as Record<string, unknown>
    const pilot = (d.pilotReq && typeof d.pilotReq === "object" ? d.pilotReq : {}) as Record<string, unknown>
    const status =
      (typeof d.status === "string" && d.status.trim()) ||
      (typeof pilot.status === "string" && pilot.status.trim()) ||
      "pilot_draft"
    return {
      reqId: typeof d.jobId === "string" && d.jobId ? d.jobId : doc.id,
      title: typeof d.title === "string" ? d.title : "",
      companyName: typeof d.companyName === "string" && d.companyName.trim() ? d.companyName.trim() : null,
      status,
      createdAt: isoFromAny(d.createdAt) ?? isoFromAny(d.firstSeenAt),
    }
  })

  // Newest first (null createdAt sinks to the bottom).
  reqs.sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt)
    if (a.createdAt) return -1
    if (b.createdAt) return 1
    return 0
  })

  logger.info("paEmployerMyReqs.list", { count: reqs.length })
  return { employerEmail, reqs }
}

export const paEmployerMyReqs = onCall<EmployerMyReqsInput>(
  { region: "us-central1", cors: true, memory: "256MiB", timeoutSeconds: 60 },
  async (req): Promise<EmployerMyReqsOutput> => runEmployerMyReqs(req.data, { db: getFirestore() }),
)

// ---- paEmployerOnboardingState ----------------------------------------------
//
// Server mirror of the client WizardState. We keep the shape loose + defensive
// (the client owns the canonical type in employer-onboarding-state.ts) so a
// future client field doesn't require a backend deploy. We only validate the
// envelope, then store the state blob verbatim alongside the derived
// pilotReqIds + activeStep for cheap server-side inspection.

export type EmployerOnboardingStateMode = "get" | "save"

export type EmployerOnboardingWizardState = {
  activeStep?: number
  completion?: Record<string, "done" | "skipped">
  successMetric?: string
  pilotReqId?: string
  pilotReqTitle?: string
  updatedAt?: number
}

export type EmployerOnboardingStateInput = {
  mode: EmployerOnboardingStateMode
  employerEmail: string
  /** Required when mode === "save". The client WizardState blob. */
  state?: EmployerOnboardingWizardState
  orgName?: string
}

export type EmployerOnboardingStateOutput = {
  employerEmail: string
  found: boolean
  state: EmployerOnboardingWizardState | null
  updatedAt: string | null
}

function sanitizeWizardState(raw: unknown): EmployerOnboardingWizardState {
  const s = (raw ?? {}) as Record<string, unknown>
  const out: EmployerOnboardingWizardState = {}
  if (typeof s.activeStep === "number" && Number.isFinite(s.activeStep)) {
    out.activeStep = Math.max(0, Math.min(20, Math.trunc(s.activeStep)))
  }
  if (s.completion && typeof s.completion === "object") {
    const completion: Record<string, "done" | "skipped"> = {}
    for (const [k, v] of Object.entries(s.completion as Record<string, unknown>)) {
      if ((v === "done" || v === "skipped") && typeof k === "string") completion[k.slice(0, 60)] = v
    }
    out.completion = completion
  }
  if (typeof s.successMetric === "string" && s.successMetric.trim()) {
    out.successMetric = s.successMetric.trim().slice(0, 80)
  }
  if (typeof s.pilotReqId === "string" && s.pilotReqId.trim()) out.pilotReqId = s.pilotReqId.trim().slice(0, 200)
  if (typeof s.pilotReqTitle === "string" && s.pilotReqTitle.trim()) out.pilotReqTitle = s.pilotReqTitle.trim().slice(0, 200)
  if (typeof s.updatedAt === "number" && Number.isFinite(s.updatedAt)) out.updatedAt = s.updatedAt
  return out
}

export async function runEmployerOnboardingState(
  raw: unknown,
  deps: { db: Firestore; now?: () => string },
): Promise<EmployerOnboardingStateOutput> {
  const data = (raw ?? {}) as Partial<EmployerOnboardingStateInput>
  const mode = data.mode === "save" ? "save" : data.mode === "get" ? "get" : null
  if (!mode) throw new HttpsError("invalid-argument", "mode must be 'get' or 'save'.")
  const employerEmail = normalizeEmployerEmail(data.employerEmail)
  if (!employerEmail) {
    throw new HttpsError("invalid-argument", "A valid employer email is required.")
  }
  const nowIso = deps.now?.() ?? new Date().toISOString()
  const ref = deps.db.collection(PA_COLLECTIONS.employerOnboarding).doc(employerEmailHash(employerEmail))

  if (mode === "get") {
    const snap = await ref.get()
    if (!snap.exists) {
      return { employerEmail, found: false, state: null, updatedAt: null }
    }
    const d = snap.data() as Record<string, unknown>
    const state = d.state ? sanitizeWizardState(d.state) : null
    return {
      employerEmail,
      found: true,
      state,
      updatedAt: isoFromAny(d.updatedAt),
    }
  }

  // mode === "save"
  const state = sanitizeWizardState(data.state)
  const orgName = (data.orgName ?? "").trim() || null
  await ref.set(
    {
      // employerEmailLower is the joinable scoping field (matches createdByEmail
      // stamped on the reqs); the doc id is the hash.
      employerEmailLower: employerEmail,
      ...(orgName ? { orgName } : {}),
      state,
      activeStep: typeof state.activeStep === "number" ? state.activeStep : FieldValue.delete(),
      ...(state.pilotReqId ? { lastPilotReqId: state.pilotReqId } : {}),
      updatedAt: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )

  logger.info("paEmployerOnboardingState.save", {
    activeStep: state.activeStep,
    hasPilotReq: Boolean(state.pilotReqId),
  })
  return { employerEmail, found: true, state, updatedAt: nowIso }
}

export const paEmployerOnboardingState = onCall<EmployerOnboardingStateInput>(
  { region: "us-central1", cors: true, memory: "256MiB", timeoutSeconds: 60 },
  async (req): Promise<EmployerOnboardingStateOutput> =>
    runEmployerOnboardingState(req.data, { db: getFirestore() }),
)
