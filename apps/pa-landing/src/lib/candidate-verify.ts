import { httpsCallable } from "firebase/functions"
import { auth, functions } from "./firebase.js"
import {
  deriveRegistrationEntryFromPath,
  getBrowserUid,
  rememberStoredValue,
} from "./browser-identity.js"
import { isLinkedInSignIn } from "./candidate-auth-provider.js"
import { clearReferralSlug, readReferralSlug } from "./referral.js"
import { resolveSource } from "./source.js"

import {
  CandidateVerifyError,
  candidateVerifyErrorMessage,
} from "./candidate-verify-error.js"

export {
  CandidateVerifyError,
  candidateVerifyErrorMessage,
  shouldSignOutOnVerifyError,
} from "./candidate-verify-error.js"

const DEFAULT_VERIFY_URL =
  "https://us-central1-wekruit-5f89b.cloudfunctions.net/paCandidateMagicLinkVerify"
const VERIFY_URL = import.meta.env.VITE_CANDIDATE_MAGIC_LINK_VERIFY_URL || DEFAULT_VERIFY_URL
const CANDIDATE_ID_KEY = "wkr_candidate_id"

export function readStoredCandidateId(): string | null {
  try {
    return window.localStorage.getItem(CANDIDATE_ID_KEY)
  } catch {
    return null
  }
}

export async function verifyCandidateMagicLinkSession(options?: {
  source?: string
  referralSlug?: string | null
  linkedinUrl?: string | null
  registrationEntryPath?: string | null
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
  const referralSlug = options?.referralSlug ?? readReferralSlug()
  const registrationEntry = deriveRegistrationEntryFromPath(options?.registrationEntryPath)
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      firebaseIdToken: idToken,
      source: options?.source ?? resolveSource(),
      referralSlug,
      browserUid: getBrowserUid(),
      linkedinUrl: options?.linkedinUrl ?? null,
      linkedinSignIn,
      displayName: user.displayName ?? null,
      registrationEntry,
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
  if (referralSlug) clearReferralSlug(referralSlug)
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

// ---------------------------------------------------------------------------
// WS-3(a) connect-phone — a candidate who registered FIRST via phone (iMessage)
// and later visits the website binds the two via a 6-digit verification code.
// These wrap the two onCall callables (mirror of verifyCandidateMagicLinkSession's
// Bearer-idToken seam — httpsCallable carries the Firebase auth automatically).
// ---------------------------------------------------------------------------

export interface ConnectPhoneStartResult {
  ok: boolean
  reason?: string
  codeSent?: boolean
}

export interface ConnectPhoneVerifyResult {
  ok: boolean
  reason?: string
  candidateId?: string
}

/** STEP 1: request a verification code to be texted to the phone thread. */
export async function connectPhoneStart(phoneE164: string): Promise<ConnectPhoneStartResult> {
  const user = auth().currentUser
  if (!user) throw new CandidateVerifyError("not_signed_in", 401)
  const call = httpsCallable<{ phoneE164: string }, ConnectPhoneStartResult>(
    functions(),
    "paCandidateConnectPhoneStart",
  )
  const res = await call({ phoneE164: phoneE164.trim() })
  return res.data
}

/** STEP 2: verify the texted code; on ok, the web session is bound to the phone profile. */
export async function connectPhoneVerify(code: string): Promise<ConnectPhoneVerifyResult> {
  const user = auth().currentUser
  if (!user) throw new CandidateVerifyError("not_signed_in", 401)
  const call = httpsCallable<{ code: string }, ConnectPhoneVerifyResult>(
    functions(),
    "paCandidateConnectPhoneVerify",
  )
  const res = await call({ code: code.trim() })
  if (res.data.ok && res.data.candidateId) {
    rememberStoredValue(CANDIDATE_ID_KEY, res.data.candidateId)
  }
  return res.data
}
