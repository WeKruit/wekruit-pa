/**
 * Stream H5 — seed a parsedCandidateResumes row for the harness test user
 * so cv-context-injection.ts has a doc to inject during the post-fix sim.
 * Idempotent (writes a fixed doc id `harness-mike-cv-h5`).
 */
import { initializeApp, cert } from "firebase-admin/app"
import { getFirestore, Timestamp } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))
initializeApp({ credential: cert(sa), projectId: sa.project_id })
const db = getFirestore()

const HARNESS_USER_ID = process.argv[2] || "6ed951ac-1ede-4f58-9d07-36ef8e78b933"
const SOURCE_DOC_ID = "zLSRbpWz8edA7tAhRadA"
const TARGET_DOC_ID = "harness-mike-cv-h5"

const src = await db.collection("parsedCandidateResumes").doc(SOURCE_DOC_ID).get()
if (!src.exists) {
  console.error("source CV doc not found:", SOURCE_DOC_ID)
  process.exit(1)
}
const data = src.data()
data.userId = HARNESS_USER_ID
data.createdAt = Timestamp.now()
data.harnessSeed = true
data.sourceDocId = SOURCE_DOC_ID
data.note = "Stream H5 harness — copy of Mike's CV under harness userId for sim re-run"

await db.collection("parsedCandidateResumes").doc(TARGET_DOC_ID).set(data)
console.log(`OK — wrote parsedCandidateResumes/${TARGET_DOC_ID} for userId=${HARNESS_USER_ID}`)
process.exit(0)
