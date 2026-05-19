#!/usr/bin/env node
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import {
  dedupeImportCandidates,
  mapAlgoliaQuestion,
  mapDataCaseProblem,
  mapObjectDesignProblem,
  mapSystemDesignProblem,
} from "@pa/pa-persistence"
import { PA_COLLECTIONS } from "@pa/core-types"

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "wekruit-5f89b"
const APPLY = process.argv.includes("--apply")
const COLLECTION = PA_COLLECTIONS.practiceQuestionBank
const ALGOLIA_INDEXES = [
  "wekruit-interview-question-bank",
  "wekruit-interview-question-bank-behavior-question",
]

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

function envAny(names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name]
  }
  return ""
}

async function allDocs(db, collectionName) {
  const snap = await db.collection(collectionName).get()
  return snap.docs.map((doc) => ({ docId: doc.id, data: doc.data() }))
}

function solutionMap(solutionDocs) {
  const byKey = new Map()
  for (const doc of solutionDocs) {
    const key = doc.data.questionPrimaryKey || doc.data.primaryKey
    if (typeof key === "string" && key) byKey.set(key, doc)
  }
  return byKey
}

async function fetchAlgoliaIndex(indexName) {
  const appId = envAny(["ALGOLIA_APP_ID", "VITE_ALGOLIA_APP_ID", "REACT_APP_ALGOLIA_APP_ID"])
  const apiKey = envAny(["ALGOLIA_SEARCH_KEY", "VITE_ALGOLIA_SEARCH_KEY", "REACT_APP_ALGOLIA_SEARCH_KEY"])
  if (!appId || !apiKey) {
    throw new Error("Missing Algolia read credentials: set ALGOLIA_APP_ID + ALGOLIA_SEARCH_KEY")
  }
  const hits = []
  let page = 0
  let nbPages = 1
  while (page < nbPages) {
    const res = await fetch(`https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-algolia-api-key": apiKey,
        "x-algolia-application-id": appId,
      },
      body: JSON.stringify({
        params: new URLSearchParams({
          query: "",
          hitsPerPage: "1000",
          page: String(page),
        }).toString(),
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Algolia ${indexName} page ${page} failed: ${res.status} ${body}`)
    }
    const json = await res.json()
    hits.push(...(json.hits || []))
    nbPages = json.nbPages || 1
    page += 1
  }
  return hits
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1
}

async function main() {
  const db = initializeFirestore()
  const nowIso = new Date().toISOString()
  const candidates = []
  const sourceCounts = {}

  const [systemProblems, systemSolutions, oodProblems, oodSolutions, dataCases] = await Promise.all([
    allDocs(db, "systemDesignProblems"),
    allDocs(db, "systemDesignSolutions"),
    allDocs(db, "objectOrientedDesignProblems"),
    allDocs(db, "objectOrientedDesignSolutions"),
    allDocs(db, "dataCaseProblems"),
  ])

  const systemSolutionsByKey = solutionMap(systemSolutions)
  for (const problem of systemProblems) {
    const key = typeof problem.data.primaryKey === "string" ? problem.data.primaryKey : problem.docId
    candidates.push(mapSystemDesignProblem(problem, systemSolutionsByKey.get(key) || null, nowIso))
    increment(sourceCounts, "firestore:systemDesignProblems")
  }

  const oodSolutionsByKey = solutionMap(oodSolutions)
  for (const problem of oodProblems) {
    const key = typeof problem.data.primaryKey === "string" ? problem.data.primaryKey : problem.docId
    candidates.push(mapObjectDesignProblem(problem, oodSolutionsByKey.get(key) || null, nowIso))
    increment(sourceCounts, "firestore:objectOrientedDesignProblems")
  }

  for (const problem of dataCases) {
    candidates.push(mapDataCaseProblem(problem, nowIso))
    increment(sourceCounts, "firestore:dataCaseProblems")
  }

  for (const indexName of ALGOLIA_INDEXES) {
    const hits = await fetchAlgoliaIndex(indexName)
    for (const hit of hits) {
      candidates.push(mapAlgoliaQuestion(hit, indexName, nowIso))
      increment(sourceCounts, `algolia:${indexName}`)
    }
  }

  const deduped = dedupeImportCandidates(candidates)
  const existingSnap = await db.collection(COLLECTION).get()
  const existingFingerprints = new Set()
  const existingIds = new Set()
  for (const doc of existingSnap.docs) {
    existingIds.add(doc.id)
    const fp = doc.data().contentFingerprint
    if (typeof fp === "string") existingFingerprints.add(fp)
  }

  const toCreate = deduped
    .map((candidate) => candidate.item)
    .filter((item) => !existingFingerprints.has(item.contentFingerprint) && !existingIds.has(item.id))

  const statusCounts = {}
  const kindCounts = {}
  for (const candidate of deduped) {
    increment(statusCounts, candidate.item.status)
    increment(kindCounts, candidate.item.kind)
  }

  if (APPLY && toCreate.length > 0) {
    for (let i = 0; i < toCreate.length; i += 450) {
      const batch = db.batch()
      for (const item of toCreate.slice(i, i + 450)) {
        batch.set(db.collection(COLLECTION).doc(item.id), item, { merge: false })
      }
      await batch.commit()
    }
  }

  console.log(JSON.stringify({
    mode: APPLY ? "apply" : "dry-run",
    collection: COLLECTION,
    inputCandidates: candidates.length,
    deduped: deduped.length,
    existingCanonicalDocs: existingSnap.size,
    createCount: toCreate.length,
    skippedExisting: deduped.length - toCreate.length,
    sourceCounts,
    statusCounts,
    kindCounts,
    sampleCreates: toCreate.slice(0, 5).map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      title: item.title,
      sourceRefs: item.sourceRefs,
    })),
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

