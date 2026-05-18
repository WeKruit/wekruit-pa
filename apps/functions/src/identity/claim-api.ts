import { onCall, HttpsError } from "firebase-functions/v2/https"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { claimCandidateProfile as defaultClaimCandidateProfile } from "@pa/pa-persistence"
import type { CandidateSelfProfile } from "@pa/core-types"

type CallableAuth = {
  uid?: string
  token?: Record<string, unknown>
}

export interface CandidateClaimCallableInput {
  browserUid?: string | null
  displayName?: string | null
}

export interface CandidateClaimCallableResult {
  ok: true
  candidateId: string
  selfProfile: CandidateSelfProfile
  idempotent: boolean
}

export interface CandidateClaimDeps {
  db: Firestore
  claimCandidateProfile?: typeof defaultClaimCandidateProfile
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function isInternalOperatorEmail(email: string): boolean {
  const normalized = email.toLowerCase()
  return normalized.endsWith("@wekruit.com") && normalized !== "adam.ylol@wekruit.com"
}

export async function runCandidateClaimProfile(
  data: unknown,
  auth: CallableAuth | undefined,
  deps: CandidateClaimDeps
): Promise<CandidateClaimCallableResult> {
  const firebaseUid = cleanString(auth?.uid, 128)
  if (!firebaseUid) {
    throw new HttpsError("unauthenticated", "Sign in before claiming a candidate profile.")
  }

  const email = cleanString(auth?.token?.email, 320)?.toLowerCase()
  if (!email || !email.includes("@")) {
    throw new HttpsError("failed-precondition", "Signed-in account has no verified email.")
  }
  if (auth?.token?.email_verified === false) {
    throw new HttpsError("failed-precondition", "Signed-in email is not verified.")
  }
  if (isInternalOperatorEmail(email)) {
    throw new HttpsError(
      "failed-precondition",
      "Use a candidate email for the candidate app. WeKruit operator accounts belong in the admin console."
    )
  }

  const input = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const browserUid = cleanString(input.browserUid, 128) ?? null
  const displayName =
    cleanString(input.displayName, 200) ??
    cleanString(auth?.token?.name, 200) ??
    null

  try {
    const claim = await (deps.claimCandidateProfile ?? defaultClaimCandidateProfile)(deps.db, {
      firebaseUid,
      email,
      browserUid,
      displayName,
    })
    return {
      ok: true,
      candidateId: claim.candidateId,
      selfProfile: claim.selfProfile,
      idempotent: claim.idempotent,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith("identity_conflict:")) {
      throw new HttpsError("failed-precondition", "Candidate profile claim needs operator review.")
    }
    throw err
  }
}

export const paCandidateClaimProfile = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 30,
  },
  async (req): Promise<CandidateClaimCallableResult> => {
    return runCandidateClaimProfile(req.data, req.auth, {
      db: getFirestore(),
    })
  }
)
