#!/usr/bin/env node
/**
 * P9 retry: re-process the 307 Zod-failed docs from mass-reenrich.
 * Reads IDs from /tmp/p9-zod-failed-ids.txt, calls enrichJobTags (now
 * with normalizeLLMTags pre-Zod), updates Firestore. Concurrency=4.
 *
 * Auth: same as mass-reenrich (GOOGLE_APPLICATION_CREDENTIALS + OPENAI keys)
 */
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { enrichJobTags } from "@pa/job-tag-enricher"

const PROJECT = "wekruit-5f89b"
const IDS_FILE = process.argv[2] ?? "/tmp/p9-zod-failed-ids.txt"
const CONCURRENCY = 4

function initFirebase() {
  if (getApps().length > 0) return
  const creds = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf-8"))
  initializeApp({ credential: cert(creds), projectId: PROJECT })
}

async function processOne(db, id) {
  const ref = db.collection("matching-jobs").doc(id)
  const snap = await ref.get()
  if (!snap.exists) return { id, status: "missing" }
  const x = snap.data()
  if (x.status !== "active") return { id, status: "inactive_skip" }

  try {
    const enriched = await enrichJobTags({
      title: x.roleTitle ?? "",
      companyName: x.companyName ?? null,
      jobDescription: x.jobDescription ?? null,
      locationRaw: x.locationRaw ?? null,
      sourceRepo: x.sourceRepo ?? null,
    }, { timeoutMs: 30000 })

    const t = enriched.tags
    const update = {
      roleFunction: t.roleFunction ?? [],
      industrySector: t.industrySector ?? [],
      relevantTags: t.relevantTags ?? [],
      requiredSkills: t.skills ?? [],
      seniorityLevel: t.seniorityLevel ?? x.seniorityLevel ?? null,
      locationBuckets: t.locationBuckets ?? x.locationBuckets ?? [],
      jobType: t.jobType ?? x.jobType ?? "other",
      enrichedAt: new Date().toISOString(),
      enricherVersion: "v1.8-retry-zod-fix",
    }
    await ref.update(update)
    return { id, status: "ok", roleFunction: t.roleFunction, skillsCount: (t.skills ?? []).length }
  } catch (err) {
    return { id, status: "still_failed", error: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120) }
  }
}

async function main() {
  initFirebase()
  const db = getFirestore()
  const ids = readFileSync(IDS_FILE, "utf-8").split("\n").map(s => s.trim()).filter(Boolean)
  console.log(`[retry-zod] processing ${ids.length} failed IDs (concurrency=${CONCURRENCY})`)

  const results = { ok: 0, still_failed: 0, missing: 0, inactive_skip: 0, errors: [] }
  let idx = 0
  const t0 = Date.now()

  async function worker() {
    while (idx < ids.length) {
      const i = idx++
      const id = ids[i]
      const r = await processOne(db, id)
      results[r.status] = (results[r.status] ?? 0) + 1
      if (r.status === "still_failed") results.errors.push(`${id.slice(0,12)}: ${r.error}`)
      if ((i + 1) % 25 === 0) {
        console.log(`[retry-zod] ${i + 1}/${ids.length} done — ok=${results.ok} fail=${results.still_failed}`)
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  console.log(JSON.stringify({
    total: ids.length,
    ok: results.ok,
    still_failed: results.still_failed,
    missing: results.missing,
    inactive_skip: results.inactive_skip,
    elapsedSec: ((Date.now() - t0) / 1000).toFixed(1),
    sampleErrors: results.errors.slice(0, 5),
  }, null, 2))

  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
