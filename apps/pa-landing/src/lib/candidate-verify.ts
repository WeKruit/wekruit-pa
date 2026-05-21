import { auth } from "./firebase.js"
import { getBrowserUid, rememberStoredValue } from "./browser-identity.js"
import { isLinkedInSignIn } from "./candidate-auth-provider.js"
import { resolveSource } from "./source.js"

const DEFAULT_VERIFY_URL =
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paCandidateMagicLinkVerify"
const VERIFY_URL = import.meta.env.VITE_CANDIDATE_MAGIC_LINK_VERIFY_URL || DEFAULT_VERIFY_URL
const CANDIDATE_ID_KEY = "wkr_candidate_id"

export class CandidateVerifyError extends Error {
  readonly reason: string
  readonly status: number

  constructor(reason: string, status: number, message?: string) {
    super(message ?? reason)
    this.name = "CandidateVerifyError"
    this.reason = reason
    this.status = status
  }
}

export function readStoredCandidateId(): string | null {
  try {
    return window.localStorage.getItem(CANDIDATE_ID_KEY)
  } catch {
    return null
  }
}

export function candidateVerifyErrorMessage(reason: string): string {
  switch (reason) {
    case "email_not_verified":
      return "Your email isn't verified yet. Check your inbox or try Google sign-in again."
    case "missing_verified_email":
      return "We couldn't read an email from your sign-in. Try another method."
    default:
      return "Sign-in verification failed. Please try again."
  }
}

export async function verifyCandidateMagicLinkSession(options?: {
  source?: string
  linkedinUrl?: string | null
}): Promise<{
  candidateId: string
  idempotent: boolean
  intakeComplete: boolean
  claireConversationStarted: boolean
  hasResumeOnFile: boolean
  portalReady: boolean
  senderNumber?: string | null
  senderGroupId?: string | null
  linkedinUrl?: string | null
  linkedinLinkedViaOauth?: boolean
}> {
  const user = auth().currentUser
  if (!user) throw new CandidateVerifyError("not_signed_in", 401)
  const idToken = await user.getIdToken(true)
  const linkedinSignIn = isLinkedInSignIn(user)
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      firebaseIdToken: idToken,
      source: options?.source ?? resolveSource(),
      browserUid: getBrowserUid(),
      linkedinUrl: options?.linkedinUrl ?? null,
      linkedinSignIn,
      displayName: user.displayName ?? null,
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    candidateId?: string
    idempotent?: boolean
    intakeComplete?: boolean
    claireConversationStarted?: boolean
    hasResumeOnFile?: boolean
    portalReady?: boolean
    senderNumber?: string | null
    senderGroupId?: string | null
    linkedinUrl?: string | null
    linkedinLinkedViaOauth?: boolean
    reason?: string
  }
  if (!res.ok || !data.ok || !data.candidateId) {
    const reason = typeof data.reason === "string" ? data.reason : "verify_failed"
    throw new CandidateVerifyError(reason, res.status, candidateVerifyErrorMessage(reason))
  }
  rememberStoredValue(CANDIDATE_ID_KEY, data.candidateId)
  const claireConversationStarted = Boolean(data.claireConversationStarted)
  const hasResumeOnFile = Boolean(data.hasResumeOnFile)
  const portalReady =
    data.portalReady !== undefined
      ? Boolean(data.portalReady)
      : claireConversationStarted && hasResumeOnFile
  return {
    candidateId: data.candidateId,
    idempotent: Boolean(data.idempotent),
    intakeComplete: Boolean(data.intakeComplete),
    claireConversationStarted,
    hasResumeOnFile,
    portalReady,
    senderNumber: typeof data.senderNumber === "string" ? data.senderNumber : null,
    senderGroupId: typeof data.senderGroupId === "string" ? data.senderGroupId : null,
    linkedinUrl: data.linkedinUrl ?? null,
    linkedinLinkedViaOauth: Boolean(data.linkedinLinkedViaOauth),
  }
}
