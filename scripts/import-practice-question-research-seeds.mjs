#!/usr/bin/env node
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import {
  dedupeImportCandidates,
  mapResearchSeedQuestion,
} from "@pa/pa-persistence"
import { PA_COLLECTIONS, PracticeQuestionBankItemSchema } from "@pa/core-types"

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "wekruit-5f89b"
const APPLY = process.argv.includes("--apply")
const COLLECTION = PA_COLLECTIONS.practiceQuestionBank
const SEEDS_URL = new URL("../data/practice-question-research-seeds.json", import.meta.url)

function readServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))
  }
  return null
}

function initializeFirestore() {
  if (admin.apps.length > 0) return admin.firestore()
  const sa = readServiceAccount()
  if (sa) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: sa.project_id || PROJECT_ID,
    })
  } else {
    admin.initializeApp({ projectId: PROJECT_ID })
  }
  return admin.firestore()
}

function loadSeeds() {
  const payload = JSON.parse(readFileSync(SEEDS_URL, "utf8"))
  const sources = payload.sources || {}
  if (!Array.isArray(payload.items)) {
    throw new Error("Research seed file must contain an items array")
  }
  return payload.items.map((item) => {
    const source = sources[item.sourceKey]
    if (!source) throw new Error(`Missing source metadata for ${item.sourceKey}`)
    return { ...source, ...item }
  })
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1
}

async function main() {
  const db = initializeFirestore()
  const nowIso = new Date().toISOString()
  const seeds = loadSeeds()
  const candidates = dedupeImportCandidates(
    seeds.map((seed) => mapResearchSeedQuestion(seed, nowIso)),
  )

  for (const candidate of candidates) {
    PracticeQuestionBankItemSchema.parse(candidate.item)
  }

  const existingSnap = await db.collection(COLLECTION).get()
  const existingFingerprints = new Set()
  const existingIds = new Set()
  for (const doc of existingSnap.docs) {
    existingIds.add(doc.id)
    const fp = doc.data().contentFingerprint
    if (typeof fp === "string") existingFingerprints.add(fp)
  }

  const toCreate = candidates
    .map((candidate) => candidate.item)
    .filter((item) => !existingFingerprints.has(item.contentFingerprint) && !existingIds.has(item.id))

  if (APPLY && toCreate.length > 0) {
    for (let i = 0; i < toCreate.length; i += 450) {
      const batch = db.batch()
      for (const item of toCreate.slice(i, i + 450)) {
        batch.set(db.collection(COLLECTION).doc(item.id), item, { merge: false })
      }
      await batch.commit()
    }
  }

  const statusCounts = {}
  const kindCounts = {}
  const sourceCounts = {}
  for (const candidate of candidates) {
    increment(statusCounts, candidate.item.status)
    increment(kindCounts, candidate.item.kind)
    for (const ref of candidate.item.sourceRefs) {
      if (ref.startsWith("web-research:")) {
        increment(sourceCounts, ref.split("/")[0])
      }
    }
  }

  console.log(JSON.stringify({
    mode: APPLY ? "apply" : "dry-run",
    collection: COLLECTION,
    sourceFile: SEEDS_URL.pathname,
    inputSeeds: seeds.length,
    deduped: candidates.length,
    existingCanonicalDocs: existingSnap.size,
    createCount: toCreate.length,
    skippedExisting: candidates.length - toCreate.length,
    statusCounts,
    kindCounts,
    sourceCounts,
    sampleCreates: toCreate.slice(0, 8).map((item) => ({
      id: item.id,
      kind: item.kind,
      conversationMode: item.conversationMode,
      status: item.status,
      title: item.title,
      companyStyle: item.companyStyle,
      sourceRefs: item.sourceRefs,
    })),
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
