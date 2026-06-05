import { httpsCallable } from "firebase/functions"
import { auth, functions } from "./firebase.js"
import {
  getBrowserUid,
  ONBOARDING_CANDIDATE_ID_KEY,
  rememberStoredValue,
} from "./browser-identity.js"
import { clearPortalCache, mergePortalCache } from "./portal-cache.js"

export type CandidatePhoneLinkStartResult =
  | {
      ok: true
      requestId: string
      phoneMasked: string
      expiresAt: string
    }
  | {
      ok: false
      reason: string
      message: string
    }

export type CandidatePhoneLinkVerifyResult =
  | {
      ok: true
      candidateId: string
      phoneMasked: string
      claireConversationStarted: true
      portalReady: true
    }
  | {
      ok: false
      reason: string
      message: string
    }

export async function startCandidatePhoneLink(
  phone: string,
): Promise<CandidatePhoneLinkStartResult> {
  const call = httpsCallable<
    { phone: string; browserUid: string },
    CandidatePhoneLinkStartResult
  >(functions(), "paCandidatePhoneLinkStart")
  const result = await call({ phone, browserUid: getBrowserUid() })
  return result.data
}

export async function verifyCandidatePhoneLink(
  requestId: string,
  code: string,
): Promise<CandidatePhoneLinkVerifyResult> {
  const call = httpsCallable<
    { requestId: string; code: string; browserUid: string },
    CandidatePhoneLinkVerifyResult
  >(functions(), "paCandidatePhoneLinkVerify")
  const result = await call({ requestId, code, browserUid: getBrowserUid() })
  if (result.data.ok) {
    rememberStoredValue(ONBOARDING_CANDIDATE_ID_KEY, result.data.candidateId)
    const firebaseUid = auth().currentUser?.uid
    if (firebaseUid) {
      clearPortalCache(firebaseUid)
      mergePortalCache(firebaseUid, {
        portalReady: true,
        candidateId: result.data.candidateId,
      })
    }
  }
  return result.data
}
