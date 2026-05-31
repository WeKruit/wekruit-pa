import { httpsCallable, type Functions } from "firebase/functions"

export const CANDIDATE_PROFILE_CORRECTION_CALLABLE = "paCandidateProfileCorrection"

export interface CandidateSelfProfile {
  candidateId: string
  lifecycleState: string
  displayName?: string
  emailMasked?: string
  phoneMasked?: string
  latestResumeArtifactId?: string
  profileSummary?: string
  linkedinUrl?: string
  handles?: Array<{ kind: string; verifiedAt?: string | null; source?: string }>
  globalTags?: {
    roleFunction?: string[]
    skills?: string[]
    industrySector?: string[]
    targetLocations?: string[]
    targetJobType?: string[]
    relevantTags?: string[]
    careerStage?: string
    careerStageRange?: [string, string]
    companySizePreference?: string[]
    companyStage?: string[]
    minSalaryUsd?: number
  }
}

export interface CandidateProfileCorrectionInput {
  correctionText: string
  structuredFields?: Record<string, unknown>
}

export interface CandidateProfileCorrectionPayload {
  correctionText: string
  sourceSurface: "me_profile"
  structuredFields?: Record<string, unknown>
}

export interface CandidateProfileCorrectionResult {
  ok: true
  candidateId: string
  selfProfile: CandidateSelfProfile
  appliedKeys?: string[]
  correctionEventId?: string
}

export type CandidateProfileCorrectionInvoker = (
  name: string,
  data: CandidateProfileCorrectionPayload
) => Promise<CandidateProfileCorrectionResult>

export async function submitCandidateProfileCorrection(
  invoke: CandidateProfileCorrectionInvoker,
  input: CandidateProfileCorrectionInput
): Promise<CandidateProfileCorrectionResult> {
  const correctionText = input.correctionText.trim()
  if (!correctionText) {
    throw new Error("Add a correction before submitting.")
  }

  const payload: CandidateProfileCorrectionPayload = {
    correctionText,
    sourceSurface: "me_profile",
  }
  if (input.structuredFields) {
    payload.structuredFields = input.structuredFields
  }

  return invoke(CANDIDATE_PROFILE_CORRECTION_CALLABLE, payload)
}

export function createCandidateProfileCorrectionSubmitter(functions: Functions) {
  return (input: CandidateProfileCorrectionInput) =>
    submitCandidateProfileCorrection(async (name, data) => {
      const callable = httpsCallable<CandidateProfileCorrectionPayload, CandidateProfileCorrectionResult>(
        functions,
        name
      )
      const result = await callable(data)
      return result.data
    }, input)
}
