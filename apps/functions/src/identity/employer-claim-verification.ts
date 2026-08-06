import { onCall, HttpsError } from "firebase-functions/v2/https"
import { getFirestore, type Firestore } from "firebase-admin/firestore"

const EMPLOYERS_COLLECTION = "layoff_employers"

type CallableAuth = {
  uid?: string
  token?: Record<string, unknown>
}

export interface EmployerClaimVerificationInput {
  employerId?: string | null
}

export interface EmployerClaimVerificationResult {
  ok: true
  employerId: string
  verificationStatus: "verified"
}

export interface EmployerClaimVerificationDeps {
  db: Firestore
  now?: () => string
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

function cleanEmail(value: unknown): string | undefined {
  const email = cleanString(value, 320)?.toLowerCase()
  return email && email.includes("@") ? email : undefined
}

async function findEmployerByEmail(
  db: Firestore,
  email: string,
): Promise<{ employerId: string; data: Record<string, unknown> } | null> {
  const snap = await db
    .collection(EMPLOYERS_COLLECTION)
    .where("workEmailLower", "==", email)
    .limit(1)
    .get()
  const first = snap.docs[0]
  return first ? { employerId: first.id, data: (first.data() ?? {}) as Record<string, unknown> } : null
}

export async function runEmployerClaimVerification(
  data: unknown,
  auth: CallableAuth | undefined,
  deps: EmployerClaimVerificationDeps,
): Promise<EmployerClaimVerificationResult> {
  const firebaseUid = cleanString(auth?.uid, 128)
  if (!firebaseUid) {
    throw new HttpsError("unauthenticated", "Sign in before verifying an employer account.")
  }
  const email = cleanEmail(auth?.token?.email)
  if (!email) {
    throw new HttpsError("failed-precondition", "Signed-in account has no verified work email.")
  }
  if (auth?.token?.email_verified === false) {
    throw new HttpsError("failed-precondition", "Signed-in email is not verified.")
  }

  const input = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const requestedEmployerId = cleanString(input.employerId, 160)
  let employerId = requestedEmployerId
  let employerData: Record<string, unknown> | undefined

  if (employerId) {
    const snap = await deps.db.collection(EMPLOYERS_COLLECTION).doc(employerId).get()
    if (!snap.exists) throw new HttpsError("not-found", "Employer registration not found.")
    employerData = (snap.data() ?? {}) as Record<string, unknown>
  } else {
    const found = await findEmployerByEmail(deps.db, email)
    if (!found) throw new HttpsError("not-found", "Employer registration not found for this email.")
    employerId = found.employerId
    employerData = found.data
  }

  const registeredEmail = cleanEmail(employerData.workEmailLower) ?? cleanEmail(employerData.workEmail)
  if (registeredEmail !== email) {
    throw new HttpsError("permission-denied", "Signed-in email does not match this employer registration.")
  }

  const now = deps.now?.() ?? new Date().toISOString()
  await deps.db.collection(EMPLOYERS_COLLECTION).doc(employerId).set(
    {
      verificationStatus: "verified",
      verifiedAt: now,
      verifiedByUid: firebaseUid,
      verifiedEmail: email,
      updatedAt: now,
    },
    { merge: true },
  )

  return {
    ok: true,
    employerId,
    verificationStatus: "verified",
  }
}

export const paEmployerClaimVerification = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 30,
  },
  async (req): Promise<EmployerClaimVerificationResult> => {
    return runEmployerClaimVerification(req.data, req.auth, {
      db: getFirestore(),
    })
  },
)
