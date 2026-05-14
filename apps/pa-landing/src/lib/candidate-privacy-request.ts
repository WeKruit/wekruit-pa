import { httpsCallable, type Functions } from "firebase/functions"

export const CANDIDATE_PRIVACY_REQUEST_CALLABLE = "paCandidatePrivacyRequest"

export type CandidatePrivacyRequestKind = "export" | "delete" | "stop_outreach" | "privacy_question"

export interface CandidatePrivacyRequestInput {
  kind: CandidatePrivacyRequestKind
  detailText?: string
}

export interface CandidatePrivacyRequestPayload {
  kind: CandidatePrivacyRequestKind
  detailText?: string
  sourceSurface: "me_profile"
}

export interface CandidatePrivacyRequestResult {
  ok: true
  candidateId: string
  requestId: string
  kind: CandidatePrivacyRequestKind
  status: string
  created: boolean
  existingOpen: boolean
}

export type CandidatePrivacyRequestInvoker = (
  name: string,
  data: CandidatePrivacyRequestPayload
) => Promise<CandidatePrivacyRequestResult>

export async function submitCandidatePrivacyRequest(
  invoke: CandidatePrivacyRequestInvoker,
  input: CandidatePrivacyRequestInput
): Promise<CandidatePrivacyRequestResult> {
  const detailText = input.detailText?.trim()
  const payload: CandidatePrivacyRequestPayload = {
    kind: input.kind,
    sourceSurface: "me_profile",
  }
  if (detailText) payload.detailText = detailText
  return invoke(CANDIDATE_PRIVACY_REQUEST_CALLABLE, payload)
}

export function createCandidatePrivacyRequestSubmitter(functions: Functions) {
  return (input: CandidatePrivacyRequestInput) =>
    submitCandidatePrivacyRequest(async (name, data) => {
      const callable = httpsCallable<CandidatePrivacyRequestPayload, CandidatePrivacyRequestResult>(
        functions,
        name
      )
      const result = await callable(data)
      return result.data
    }, input)
}
