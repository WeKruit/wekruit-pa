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

export function deriveFunction(title: string): "Design" | "Engineering" | "Product" | "GTM" | "Other" {
  const t = (title || "").toLowerCase()
  if (t.includes("design") || t.includes("ux") || t.includes("brand")) return "Design"
  if (t.includes("eng") || t.includes("sw") || t.includes("developer")) return "Engineering"
  if (t.includes("pm") || t.includes("product")) return "Product"
  if (t.includes("sales") || t.includes("marketing") || t.includes("ae") || t.includes("cs")) return "GTM"
  return "Other"
}
