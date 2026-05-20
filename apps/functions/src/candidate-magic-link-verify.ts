import { getAuth } from "firebase-admin/auth"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { onRequest } from "firebase-functions/v2/https"
import { isPaUserSource, PA_COLLECTIONS } from "@pa/core-types"
import { claimCandidateProfile, linkCandidateHandle } from "@pa/pa-persistence"

export interface CandidateMagicLinkVerifyInput {
  firebaseIdToken?: string
  source?: string
  linkedinUrl?: string | null
  browserUid?: string | null
  displayName?: string | null
}

export interface CandidateMagicLinkVerifySuccess {
  ok: true
  candidateId: string
  idempotent: boolean
}

export interface CandidateMagicLinkVerifyFailure {
  ok: false
  reason: string
}

export type CandidateMagicLinkVerifyResult =
  | CandidateMagicLinkVerifySuccess
  | CandidateMagicLinkVerifyFailure

function setCors(res: { set: (k: string, v: string) => unknown }): void {
  res.set("Access-Control-Allow-Origin", "*")
  res.set("Access-Control-Allow-Methods", "POST,OPTIONS")
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization")
  res.set("Access-Control-Max-Age", "3600")
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim()
}

export interface CandidateMagicLinkVerifyDeps {
  db: Firestore
  verifyIdToken?: (token: string) => Promise<{
    uid: string
    email?: string
    email_verified?: boolean
    name?: string
  }>
  claimProfile?: typeof claimCandidateProfile
  linkLinkedin?: typeof linkCandidateHandle
}

export async function runCandidateMagicLinkVerify(
  input: CandidateMagicLinkVerifyInput,
  tokenFromHeader: string | undefined,
  deps: CandidateMagicLinkVerifyDeps
): Promise<{ result: CandidateMagicLinkVerifyResult; status: number }> {
  const idToken = cleanString(input.firebaseIdToken, 8192) ?? bearerToken(tokenFromHeader)
  if (!idToken) {
    return { result: { ok: false, reason: "missing_id_token" }, status: 401 }
  }

  const verifyIdToken =
    deps.verifyIdToken ??
    (async (token: string) => {
      const decoded = await getAuth().verifyIdToken(token)
      return {
        uid: decoded.uid,
        email: decoded.email,
        email_verified: decoded.email_verified,
        name: decoded.name,
      }
    })

  let decoded: Awaited<ReturnType<NonNullable<CandidateMagicLinkVerifyDeps["verifyIdToken"]>>>
  try {
    decoded = await verifyIdToken(idToken)
  } catch {
    return { result: { ok: false, reason: "invalid_id_token" }, status: 401 }
  }

  const email = cleanString(decoded.email, 320)?.toLowerCase()
  if (!email || !email.includes("@")) {
    return { result: { ok: false, reason: "missing_verified_email" }, status: 412 }
  }
  if (decoded.email_verified === false) {
    return { result: { ok: false, reason: "email_not_verified" }, status: 412 }
  }

  const browserUid = cleanString(input.browserUid, 128) ?? null
  const displayName =
    cleanString(input.displayName, 200) ?? cleanString(decoded.name, 200) ?? null
  const linkedinUrl = cleanString(input.linkedinUrl, 500) ?? null
  const sourceRaw = cleanString(input.source, 64)
  const source = sourceRaw && isPaUserSource(sourceRaw) ? sourceRaw : undefined

  try {
    const claim = await (deps.claimProfile ?? claimCandidateProfile)(deps.db, {
      firebaseUid: decoded.uid,
      email,
      browserUid,
      displayName,
    })

    if (linkedinUrl) {
      await (deps.linkLinkedin ?? linkCandidateHandle)(deps.db, {
        candidateId: claim.candidateId,
        kind: "linkedin",
        value: linkedinUrl,
        source: "candidate",
        verified: true,
        evidence: [{ source: "system", summary: "LinkedIn OAuth sign-in handle" }],
      }).catch((err: unknown) => {
        if (err instanceof Error && err.message.startsWith("identity_conflict:")) {
          throw err
        }
      })
    }

    if (source) {
      await deps.db.collection(PA_COLLECTIONS.users).doc(claim.candidateId).set(
        { source, updatedAt: new Date().toISOString() },
        { merge: true }
      )
    }

    return {
      result: {
        ok: true,
        candidateId: claim.candidateId,
        idempotent: claim.idempotent,
      },
      status: 200,
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("identity_conflict:")) {
      return { result: { ok: false, reason: "identity_conflict" }, status: 409 }
    }
    return { result: { ok: false, reason: "verify_failed" }, status: 500 }
  }
}

export const paCandidateMagicLinkVerify = onRequest(async (req, res) => {
  setCors(res)
  if (req.method === "OPTIONS") {
    res.status(204).send("")
    return
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, reason: "method_not_allowed" })
    return
  }

  const body =
    req.body && typeof req.body === "object" ? (req.body as CandidateMagicLinkVerifyInput) : {}
  const authHeader = req.header("authorization") ?? req.header("Authorization")
  const { result, status } = await runCandidateMagicLinkVerify(body, authHeader, {
    db: getFirestore(),
  })
  res.status(status).json(result)
})
