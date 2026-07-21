// Onboarding callables — wrappers around the openLayoff Cloud Functions.
// Ported from wekruit-layoff/src/lib/api.ts so the same signup form works
// for both layoff.wekruit.com and candidate.wekruit.com.

import { httpsCallable } from "firebase/functions"
import { functions } from "./firebase"
import type { SignupSource } from "./source"

export type RegisterInput = {
  firstName: string
  lastName: string
  email: string
  linkedin?: string
  personalWebsite?: string
  lastCompany?: string
  jobTitle?: string
  location?: string
  function?: "Design" | "Engineering" | "Product" | "GTM" | "Other"
  phone?: string
  consent: boolean
  resumeFileName?: string
  /** Post-auth onboarding — merge onto this pa-users doc. */
  candidateId?: string
  /** Dedup mode — "auto" returns { duplicate: true } when phone is on file. */
  mode?: "auto" | "reuse" | "refresh"
  /** Drives pa-users.source + SMS opener selection. */
  source?: SignupSource
}

export type RegisterOutput = {
  candidateId: string
  listPosition?: number
  smsKickoffScheduledAt?: string
  isReregistration?: boolean
  mode?: "auto" | "reuse" | "refresh"
  duplicate?: false
  /** Sticky Sendblue from-number assigned at registration; used to build the sms: deep link on the Done view. */
  senderNumber?: string
  senderGroupId?: string
  /**
   * Transit-safe phone-binding opener code (2026-06-13). Present when the
   * candidate has no bound phone yet (website-first). The Done view embeds THIS
   * in the iMessage opener ("Hi, WeKruit, my code is <CODE>") instead of the
   * corruption-prone raw uid; the inbound webhook resolves it → this candidate.
   */
  bindCode?: string
}

export type RegisterDuplicate = {
  duplicate: true
  candidateId: string
  existing: {
    firstName: string | null
    lastCompany: string | null
    jobTitle: string | null
    location: string | null
    lastLaidOffAt: string | null
  }
}

export async function registerCandidate(input: RegisterInput): Promise<RegisterOutput | RegisterDuplicate> {
  const fn = httpsCallable<RegisterInput, RegisterOutput | RegisterDuplicate>(functions(), "openRegisterLayoffCandidate")
  const res = await fn(input)
  return res.data
}

export async function initiateSmsPrescreen(candidateId: string): Promise<{ ok: boolean }> {
  const fn = httpsCallable<{ candidateId: string }, { ok: boolean }>(functions(), "openInitiateSmsPrescreen")
  const res = await fn({ candidateId })
  return res.data
}

export type EmployerSignupInput = {
  companyName: string
  companyLinkedin: string
  workEmail: string
  stage: string
  roleAtCompany: string
  rolesHiring: string[]
  /** Hard-stop filters Claire must enforce before passing a candidate. */
  hardFilters: string[]
  /** Specific evidence probes Claire should elicit in the first interview. */
  screeningQuestions: string[]
  /** Examples that calibrate the strong-pass bar and false-positive boundary. */
  calibrationExamples: string
  /** Hiring-team signal loop after accepted/rejected passed-profile intros. */
  feedbackLoop: string
  /** Employer-owned next step after WeKruit sends an accepted passed-profile intro. */
  introHandoff: string
  /** Free-form notes shown verbatim in the admin notification email. */
  notes?: string
  /** Submitter's name — displayed in the admin notification email. */
  contactName?: string
}

export async function registerEmployer(
  input: EmployerSignupInput,
): Promise<{ employerId: string }> {
  const fn = httpsCallable<EmployerSignupInput, { employerId: string }>(
    functions(),
    "openRegisterEmployer",
  )
  const res = await fn(input)
  return res.data
}

// ---------------------------------------------------------------------------
// Employer onboarding Step 5 — Calibrate Pilot Req (job enrichment)
// ---------------------------------------------------------------------------

export type EmployerIntakeJobInput = {
  title: string
  jobDescription: string
  companyName?: string
  locationRaw?: string
}

/** Canonical skill the enricher attaches to a role. */
export type IntakeSkill = {
  name: string
  bucket?: string
  proficiency?: string
}

/** Canonical job tags returned by the enricher (subset rendered as chips). */
export type IntakeEnrichedTags = {
  roleFunction?: string[]
  industrySector?: string[]
  relevantTags?: string[]
  skills?: IntakeSkill[]
  seniorityLevel?: string
  jobType?: string
  locationBuckets?: string[]
}

export type IntakeHardFilters = {
  roleFunction?: string[]
  seniorityLevel?: string
  jobType?: string
  locationBuckets?: string[]
  sponsorship?: boolean | null
}

export type IntakePrescreenQuestion = {
  id: string
  prompt: string
  required: boolean
  rubricDimensionId: string
}

export type EmployerIntakeJobOutput = {
  enrichedTags?: IntakeEnrichedTags
  hardFilters?: IntakeHardFilters
  prescreenQuestions?: IntakePrescreenQuestion[]
  clarifyingQuestions?: string[]
  confidence?: { overall?: number }
  approvalReady?: boolean
  candidateBrief?: { title?: string; body?: string }
  modelUsed?: string
  note?: string
}

/**
 * Enrich one real role through the production 3-tier LLM job enricher and get
 * back canonical tags, hard filters, auto-drafted prescreen questions, and
 * plain-English clarifying questions. Public callable (no auth), mirrors
 * registerEmployer. In-memory only — creates no job and persists nothing.
 */
export async function employerIntakeJob(
  input: EmployerIntakeJobInput,
): Promise<EmployerIntakeJobOutput> {
  const fn = httpsCallable<EmployerIntakeJobInput, EmployerIntakeJobOutput>(
    functions(),
    "paEmployerIntakeJob",
  )
  const res = await fn(input)
  return res.data
}

// ---------------------------------------------------------------------------
// Employer onboarding Step 6 sign-off — persist the calibrated pilot req
// ---------------------------------------------------------------------------

export type EmployerCreatePilotReqInput = {
  title: string
  jobDescription: string
  companyName?: string
  locationRaw?: string
  enrichedTags?: IntakeEnrichedTags
  hardFilters?: IntakeHardFilters
  prescreenQuestions?: IntakePrescreenQuestion[]
  successMetric?: string
  /**
   * Lightest viable employer key — the onboarding requester's work email. There
   * is no real employer auth on this public wizard yet, so the email is the
   * durable scoping key for "this employer's reqs" + the passed inbox. Stamped
   * server-side as `createdByEmail` (normalized lowercase) on both job docs.
   */
  employerEmail?: string
  orgName?: string
}

export type EmployerCreatePilotReqOutput = {
  reqId: string
  status: "pilot_draft"
}

/**
 * Persist the calibrated pilot req at Step 6 sign-off. Dual-writes a real
 * Firestore job (matching-jobs/{reqId} + pa-jobs/{reqId}, same reqId) so the
 * role is retrievable and soft-scored by the matcher immediately and surfaces
 * on the recruiter board as a WeKruit collaborative req. Public callable (no
 * auth), mirrors employerIntakeJob. Does NOT contact any candidates.
 */
export async function employerCreatePilotReq(
  input: EmployerCreatePilotReqInput,
): Promise<EmployerCreatePilotReqOutput> {
  const fn = httpsCallable<EmployerCreatePilotReqInput, EmployerCreatePilotReqOutput>(
    functions(),
    "paEmployerCreatePilotReq",
  )
  const res = await fn(input)
  return res.data
}

// ---------------------------------------------------------------------------
// Employer onboarding Step 7 (Launch) — consent-safe pool-match COUNT
// ---------------------------------------------------------------------------

export type EmployerMatchPilotReqInput = {
  /** The reqId persisted at Step 6 sign-off (matching-jobs/{reqId}). */
  reqId: string
}

export type EmployerMatchPilotReqOutput = {
  /** Role-relevant candidates scanned from the retained pool. */
  roleRelevantLoaded: number
  /** Top-N ranked candidates returned by the scorer (capped at 50). */
  ranked: number
  /** Ranked candidates that look like potential fits (not do_not_contact). */
  potentialFits: number
  /** True when scoring is still refining via the nightly LLM rerank. */
  scoringPending: boolean
}

/**
 * Fetch a CONSENT-SAFE pool-match count for a saved pilot req. Returns COUNTS
 * ONLY — no candidate names, emails, ids, tags, or rows ever cross this
 * boundary (CLAUDE.md v2.0 Product Rule #6). Public callable (no auth), mirrors
 * employerCreatePilotReq. Does NOT contact any candidates. Counts are an early
 * estimate that refines overnight (see scoringPending).
 */
export async function employerMatchPilotReq(
  input: EmployerMatchPilotReqInput,
): Promise<EmployerMatchPilotReqOutput> {
  const fn = httpsCallable<EmployerMatchPilotReqInput, EmployerMatchPilotReqOutput>(
    functions(),
    "paEmployerMatchPilotReq",
  )
  const res = await fn(input)
  return res.data
}

// ---------------------------------------------------------------------------
// Employer onboarding Step 4 — Invite Team (send real invite emails + record)
// ---------------------------------------------------------------------------

export type EmployerInviteRole = "admin" | "recruiter" | "hiring_manager" | "reviewer"

export type EmployerInviteTeamInput = {
  invites: Array<{ email: string; role: EmployerInviteRole }>
  orgName?: string
  inviterEmail?: string
}

export type EmployerInviteTeamOutput = {
  sent: number
  failed: Array<{ email: string; reason: string }>
  invited: Array<{ email: string; role: string }>
}

/**
 * Invite teammates at Step 4. For each valid email, records a pending invite
 * (pa-employer-team-invites) and sends a real invite email via Mailgun.
 * Returns counts + per-email failures (invalid/duplicate/delivery). Public
 * callable (no auth), mirrors employerCreatePilotReq.
 *
 * HONEST SCOPE: this sends invite emails + records invites. It does NOT yet
 * build teammate login or role-based access — that lands in a later slice.
 */
export async function employerInviteTeam(
  input: EmployerInviteTeamInput,
): Promise<EmployerInviteTeamOutput> {
  const fn = httpsCallable<EmployerInviteTeamInput, EmployerInviteTeamOutput>(
    functions(),
    "paEmployerInviteTeam",
  )
  const res = await fn(input)
  return res.data
}

// ---------------------------------------------------------------------------
// Connect Slack / Connect ATS / Import Pool — managed-setup connect requests.
// Records a request + emails ops so a human does the managed connection. This
// is NOT a live self-serve integration; it requests managed setup.
// ---------------------------------------------------------------------------

export type EmployerConnectKind = "ats" | "slack" | "pool"

export type EmployerConnectRequestInput = {
  kind: EmployerConnectKind
  provider?: string
  details?: string
  orgName?: string
  requesterEmail?: string
}

export type EmployerConnectRequestOutput = {
  ok: true
  requestId: string
  opsNotified: boolean
}

/**
 * Request managed setup of an ATS / Slack workspace / candidate pool import.
 * Records a `pa-employer-connect-requests` doc and emails ops. Public callable
 * (no auth), mirrors employerInviteTeam.
 *
 * HONEST SCOPE: this REQUESTS managed setup — our team connects it in the
 * background. It does NOT perform OAuth or a live self-serve integration.
 */
export async function employerConnectRequest(
  input: EmployerConnectRequestInput,
): Promise<EmployerConnectRequestOutput> {
  const fn = httpsCallable<EmployerConnectRequestInput, EmployerConnectRequestOutput>(
    functions(),
    "paEmployerConnectRequest",
  )
  const res = await fn(input)
  return res.data
}

// ---------------------------------------------------------------------------
// Connect ATS — pull open reqs from a PUBLIC board URL (read-only)
// Fetches + normalizes the public ATS board (Greenhouse / Lever / Ashby),
// returns reqs in-memory. Public callable (no auth). Persists nothing about
// candidates and contacts no one — this is NOT the managed ATS connect.
// ---------------------------------------------------------------------------

export type AtsBoardProvider = "greenhouse" | "lever" | "ashby"

export type AtsImportReqsInput = {
  /** Pasted public board URL, or a bare "provider:org" / org handle. */
  board: string
}

export type AtsOpenReq = {
  title: string
  location: string | null
  url: string
  department?: string | null
  team?: string | null
  jobType?: string | null
}

export type AtsImportReqsOutput = {
  ok: boolean
  provider?: AtsBoardProvider
  org?: string
  count?: number
  /** Capped to first 50 for display. */
  reqs?: AtsOpenReq[]
  error?: string
}

/**
 * Pull open reqs from a PUBLIC ATS job board URL (Greenhouse / Lever / Ashby).
 * Read-only: fetches + normalizes the public board, returns reqs in-memory.
 * Public callable (no auth), mirrors employerConnectRequest. Persists nothing
 * about candidates and contacts no one — this is NOT the managed ATS connect.
 */
export async function employerAtsImportReqs(
  input: AtsImportReqsInput,
): Promise<AtsImportReqsOutput> {
  const fn = httpsCallable<AtsImportReqsInput, AtsImportReqsOutput>(
    functions(),
    "paEmployerAtsImportReqs",
  )
  const res = await fn(input)
  return res.data
}

// ---------------------------------------------------------------------------
// Employer home — list the employer's own pilot reqs + server-persist wizard
// state, keyed by the (self-asserted) onboarding work email.
// ---------------------------------------------------------------------------

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

/**
 * List the pilot reqs created by this employer email (pa-jobs where
 * createdByEmail == email AND source == "employer_onboarding"). Returns req
 * metadata only — NO candidate data. Public callable (no auth), mirrors
 * employerMatchPilotReq.
 */
export async function employerMyReqs(employerEmail: string): Promise<EmployerMyReqsOutput> {
  const fn = httpsCallable<{ employerEmail: string }, EmployerMyReqsOutput>(
    functions(),
    "paEmployerMyReqs",
  )
  const res = await fn({ employerEmail })
  return res.data
}

export type EmployerOnboardingWizardStateWire = {
  activeStep?: number
  completion?: Record<string, "done" | "skipped">
  successMetric?: string
  pilotReqId?: string
  pilotReqTitle?: string
  updatedAt?: number
}

export type EmployerOnboardingStateOutput = {
  employerEmail: string
  found: boolean
  state: EmployerOnboardingWizardStateWire | null
  updatedAt: string | null
}

/**
 * Read or write the server mirror of the employer onboarding wizard state so
 * progress survives a closed tab. Doc keyed by sha256(email). Public callable
 * (no auth), mirrors employerMyReqs.
 */
export async function employerOnboardingState(input: {
  mode: "get" | "save"
  employerEmail: string
  state?: EmployerOnboardingWizardStateWire
  orgName?: string
}): Promise<EmployerOnboardingStateOutput> {
  const fn = httpsCallable<typeof input, EmployerOnboardingStateOutput>(
    functions(),
    "paEmployerOnboardingState",
  )
  const res = await fn(input)
  return res.data
}

// ---------------------------------------------------------------------------
// Employer LIVE passed inbox — consent-gated, PII-redacted, scoped to the
// employer's own reqs. Intro decision emits employer_intro_* FSM events.
// ---------------------------------------------------------------------------

export type PassedCandidateTranscriptTurn = {
  id: string
  role: "user" | "assistant" | "system"
  body: string
  qId?: string
  actionKind?: string
  scoreSummary?: string
  createdAt?: string
}

export type PassedCandidateRow = {
  id: string
  snapshotId: string
  candidateId: string
  jobId: string
  candidateJobStateId: string
  state: "passed" | "employer_visible" | "intro_accepted" | "intro_rejected"
  displayName: string
  resumeSummary?: string
  level1Snapshot?: Record<string, unknown>
  passReason?: string
  matchReason?: string
  createdAt: string
  latestEmployerAction?: {
    status: "accepted" | "rejected"
    reason?: string
    decidedAt: string
    decidedBy: string
    feedbackEventId: string
  }
  profile: {
    piiConsentAt?: string
    consentStatus: "granted" | "missing"
    level1Status?: string
    level1CompletedAt?: string
    onboardingStatus?: string
    candidateLifecycleState?: string
  }
  transcript: {
    prescreenSessionId?: string
    turns: PassedCandidateTranscriptTurn[]
  }
}

export type EmployerPassedCandidatesOutput = {
  employerEmail: string
  reqCount: number
  summary: {
    totalPassed: number
    withConsent: number
    missingConsent: number
    hiddenMissingConsent: number
  }
  rows: PassedCandidateRow[]
}

/**
 * Read the employer's LIVE passed-candidate inbox: pa-employer-visible-profiles
 * for THIS employer's reqs only, consent-gated + PII-redacted server-side.
 * Public callable (no auth), mirrors employerMatchPilotReq. Returns only passed
 * snapshots the employer owns; no candidate contact info ever crosses.
 */
export async function employerPassedCandidates(input: {
  employerEmail: string
  jobId?: string
  requireConsent?: boolean
}): Promise<EmployerPassedCandidatesOutput> {
  const fn = httpsCallable<typeof input, EmployerPassedCandidatesOutput>(
    functions(),
    "paEmployerPassedCandidates",
  )
  const res = await fn(input)
  return res.data
}

export type EmployerPassedCandidateIntroDecisionOutput = {
  ok: true
  snapshotId: string
  decision: "accepted" | "rejected"
  state: "intro_accepted" | "intro_rejected"
  feedbackEventId: string
}

/**
 * Record an employer's accept/decline-intro decision on a passed profile. Emits
 * an employer_intro_accepted/rejected FSM + FeedbackEvent attributed to the
 * employer. Verifies the snapshot belongs to one of the employer's reqs first.
 * Public callable (no auth), mirrors employerPassedCandidates.
 */
export async function employerPassedCandidateIntroDecision(input: {
  employerEmail: string
  snapshotId: string
  decision: "accepted" | "rejected"
  reason: string
}): Promise<EmployerPassedCandidateIntroDecisionOutput> {
  const fn = httpsCallable<typeof input, EmployerPassedCandidateIntroDecisionOutput>(
    functions(),
    "paEmployerPassedCandidateIntroDecision",
  )
  const res = await fn(input)
  return res.data
}

export function deriveFunction(title: string): "Design" | "Engineering" | "Product" | "GTM" | "Other" {
  const t = (title || "").toLowerCase()
  if (t.includes("design") || t.includes("ux") || t.includes("brand")) return "Design"
  if (t.includes("eng") || t.includes("sw") || t.includes("developer")) return "Engineering"
  if (t.includes("pm") || t.includes("product")) return "Product"
  if (t.includes("sales") || t.includes("marketing") || t.includes("ae") || t.includes("cs")) return "GTM"
  return "Other"
}
