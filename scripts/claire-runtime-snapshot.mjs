import { readFileSync } from "node:fs"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const UID = process.env.CLAIRE_TEST_UID ?? "U7AwKT8nLDRa35DkuBxq"
const JOB_ID = process.env.CLAIRE_TEST_JOB_ID ?? "rain-software-engineer-fullstack-8849f6ef"

function loadServiceAccount() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inline?.trim()) return JSON.parse(inline)
  const env = readFileSync(".env", "utf8")
  const line = env.split(/\r?\n/).find((entry) => entry.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="))
  if (!line) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing")
  return JSON.parse(line.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length))
}

function pick(obj, keys) {
  const out = {}
  for (const key of keys) out[key] = obj?.[key] ?? null
  return out
}

if (!getApps().length) {
  const serviceAccount = loadServiceAccount()
  initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
}

const db = getFirestore()
const userSnap = await db.collection("pa-users").doc(UID).get()
const user = userSnap.data() ?? {}
const sessionsSnap = await db
  .collection("pa-prescreen-sessions")
  .where("userId", "==", UID)
  .where("jobId", "==", JOB_ID)
  .orderBy("updatedAt", "desc")
  .limit(5)
  .get()
const sessions = sessionsSnap.docs.map((doc) => ({
  id: doc.id,
  ...pick(doc.data(), [
    "jobId",
    "userId",
    "currentQId",
    "terminal",
    "terminalReason",
    "score",
    "createdAt",
    "updatedAt",
    "workSession",
  ]),
}))
const latestSessionId = sessions[0]?.id ?? null
const candidateJobStateId = `${UID}__${JOB_ID}`
const candidateJobStateSnap = await db.collection("pa-candidate-job-states").doc(candidateJobStateId).get()
const employerVisibleSnap = await db.collection("pa-employer-visible-profiles").doc(`${JOB_ID}__${UID}`).get()
const memoryEventSnap = latestSessionId
  ? await db.collection("pa-prescreen-memory-events").doc(latestSessionId).get()
  : null
const latestTurnsSnap = latestSessionId
  ? await db
    .collection("pa-prescreen-sessions")
    .doc(latestSessionId)
    .collection("turns")
    .orderBy("ts", "asc")
    .limit(20)
    .get()
  : null
const latestTurns = latestTurnsSnap?.docs.map((doc) => ({
  id: doc.id,
  ...pick(doc.data(), [
    "role",
    "kind",
    "qId",
    "reply",
    "text",
    "answer",
    "agentText",
    "action",
    "scored",
    "ts",
    "createdAt",
    "messageHandle",
    "coalesceTurnId",
    "inboundEventId",
  ]),
})) ?? []
const inboundSnap = await db
  .collection("pa-inbound-events")
  .orderBy("createdAt", "desc")
  .limit(80)
  .get()
const inboundEvents = inboundSnap.docs.flatMap((doc) => {
  const data = doc.data()
  if (data.rawPayload?.fromNumber !== (user.phoneE164 ?? "+14243201960")) return []
  return [{
    id: doc.id,
    ...pick(data, [
      "channel",
      "createdAt",
      "updatedAt",
      "coalescing",
      "coalesceFallback",
      "coalesceTurnId",
      "coalescedAt",
      "status",
      "routedTo",
      "expiresAtTs",
    ]),
    rawPayload: pick(data.rawPayload, [
      "fromNumber",
      "toNumber",
      "text",
      "messageHandle",
      "chatId",
    ]),
  }]
}).slice(0, 12)

console.log(JSON.stringify({
  capturedAt: new Date().toISOString(),
  uid: UID,
  jobId: JOB_ID,
  user: pick(user, [
    "email",
    "emailLower",
    "phoneE164",
    "source",
    "onboardingState",
    "onboardingStatus",
    "workSession",
    "lastPrescreenMemoryUpdate",
  ]),
  sessions,
  candidateJobState: {
    id: candidateJobStateId,
    exists: candidateJobStateSnap.exists,
    data: pick(candidateJobStateSnap.data(), ["state", "reason", "prescreenSessionId", "updatedAt"]),
  },
  employerVisible: {
    id: `${JOB_ID}__${UID}`,
    exists: employerVisibleSnap.exists,
    data: pick(employerVisibleSnap.data(), ["prescreenSessionId", "updatedAt"]),
  },
  latestTurns,
  inboundEvents,
  memoryEvent: {
    id: latestSessionId,
    exists: Boolean(memoryEventSnap?.exists),
    data: pick(memoryEventSnap?.data(), ["terminal", "updatedAt", "evidenceTags", "summary"]),
  },
}, null, 2))
