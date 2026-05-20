import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0
}

function hasTimestampLike(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === "string") return value.trim().length > 0
  return typeof value === "object"
}

/**
 * True when pa-users (or resume subcollections) show a stored resume artifact
 * or parsed CV for this candidate.
 */
export async function candidateHasResumeOnFile(
  db: Firestore,
  candidateId: string,
  userData: Record<string, unknown>,
): Promise<boolean> {
  if (nonEmptyString(userData.latestResumeArtifactId)) return true
  if (hasTimestampLike(userData.cvUploadedAt)) return true
  if (nonEmptyString(userData.resumeStoragePath)) return true
  if (nonEmptyString(userData.resumeUrl)) return true

  const parsedSnap = await db
    .collection("parsedCandidateResumes")
    .where("userId", "==", candidateId)
    .limit(1)
    .get()
  if (!parsedSnap.empty) return true

  const artifactSnap = await db
    .collection(PA_COLLECTIONS.resumeArtifacts)
    .where("candidateId", "==", candidateId)
    .limit(1)
    .get()
  return !artifactSnap.empty
}

/** Stamp first inbound iMessage evidence on pa-users (idempotent). */
export async function markClaireConversationStarted(
  db: Firestore,
  candidateId: string,
): Promise<void> {
  const ref = db.collection(PA_COLLECTIONS.users).doc(candidateId)
  const snap = await ref.get()
  const data = snap.data() ?? {}
  if (data.claireConversationStarted === true) return
  if (nonEmptyString(data.claireConversationStartedAt)) return
  const isoNow = new Date().toISOString()
  await ref.set(
    {
      claireConversationStarted: true,
      claireConversationStartedAt: isoNow,
      updatedAt: isoNow,
    },
    { merge: true },
  )
}

/**
 * True when the candidate has sent at least one inbound iMessage to Claire.
 * Requires a bound phone on pa-users (web intake or Hello-WeKruit opener bind)
 * plus evidence of an inbound turn in sessions, inbound-events, or messages.
 */
export async function candidateClaireConversationStarted(
  db: Firestore,
  candidateId: string,
  userData: Record<string, unknown>,
): Promise<boolean> {
  if (userData.claireConversationStarted === true) return true
  const startedAt = userData.claireConversationStartedAt
  if (typeof startedAt === "string" && startedAt.trim().length > 0) return true

  const phoneE164 =
    typeof userData.phoneE164 === "string" ? userData.phoneE164.trim() : ""
  if (!phoneE164) return false

  const sessionsSnap = await db
    .collection(PA_COLLECTIONS.sessions)
    .where("userId", "==", candidateId)
    .limit(8)
    .get()
  if (
    sessionsSnap.docs.some((doc) => {
      const lastInboundAt = doc.data()?.lastInboundAt
      return typeof lastInboundAt === "string" && lastInboundAt.length > 0
    })
  ) {
    return true
  }

  const inboundSnap = await db
    .collection(PA_COLLECTIONS.inboundEvents)
    .where("userId", "==", candidateId)
    .limit(1)
    .get()
  if (!inboundSnap.empty) return true

  const messageSnap = await db
    .collection(PA_COLLECTIONS.messages)
    .where("userId", "==", candidateId)
    .where("role", "==", "user")
    .limit(1)
    .get()
  return !messageSnap.empty
}
