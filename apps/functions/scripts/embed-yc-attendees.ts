/**
 * Compute + store the people-match embeddings for an enriched cohort — TWO per record:
 * `matchEmbedding` (full profile projection) and `descriptorEmbedding` (the business descriptor
 * alone). The matcher scores a query against both and keeps the better (see `runYcPeopleMatch`).
 *
 * Uses `synthesizePeopleMatchText` (the people projection, NOT the job-matching
 * `synthesizeCvSummaryText`) and the same `text-embedding-3-small` model the rest of the platform
 * uses, so vectors stay comparable. Stored on the record as `matchEmbedding` so the matcher reads
 * rather than recomputes — 1000 embeddings per query would be absurd.
 *
 * Idempotent: skips rows that already carry a vector. Batched 100/request (OpenAI allows arrays).
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=... ; export PA_OPENAI_AGENT_API_KEY=...
 *   node --import tsx apps/functions/scripts/embed-yc-attendees.ts <cohort> [--apply]
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import {
  descriptorText,
  toPoolMember,
  YC_COHORT_2026,
  type BusinessDescriptor,
} from "../src/yc-people-match.js"

const require = createRequire("/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/serene-diffie-15b15a/apps/functions/")
const admin = require("firebase-admin")
const OpenAI = require("openai")

const BATCH = 100
const WRITE_CHUNK = 20
const MODEL = "text-embedding-3-small"

async function main() {
  const cohort = process.argv[2] ?? YC_COHORT_2026
  const apply = process.argv.includes("--apply")
  // Re-embed rows that already carry a vector — needed whenever the projection text changes
  // (e.g. after `describe-yc-attendees.ts` adds `businessDescriptor`).
  const refresh = process.argv.includes("--refresh")
  const apiKey = process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) { console.error("OPENAI key missing"); process.exit(2) }

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))),
  })
  const db = admin.firestore()
  const client = new OpenAI({ apiKey })

  const snap = await db.collection("pa-external-candidate-records").where("enrichment.cohort", "==", cohort).get()
  // TWO vectors per record: the full profile projection, and the business descriptor ALONE. Same
  // queue, same batching — only the destination field differs (see the matcher's max() scoring).
  type Row = { id: string; field: "matchEmbedding" | "descriptorEmbedding"; text: string }
  const todo: Row[] = []
  let enriched = 0
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    if (d.coresignalMatch !== "ok") continue
    enriched++
    const m = toPoolMember(doc.id, d)
    if (m.matchText.length < 20) continue
    if (refresh || !(Array.isArray(d.matchEmbedding) && d.matchEmbedding.length > 0)) {
      todo.push({ id: doc.id, field: "matchEmbedding", text: m.matchText })
    }
    // ~10 of 992 records have no descriptor; they simply get no second vector and rank on the
    // profile vector alone.
    const dText = descriptorText((d.businessDescriptor ?? null) as BusinessDescriptor | null)
    if (dText.length >= 20 && (refresh || !(Array.isArray(d.descriptorEmbedding) && d.descriptorEmbedding.length > 0))) {
      todo.push({ id: doc.id, field: "descriptorEmbedding", text: dText })
    }
  }
  const nDesc = todo.filter((r) => r.field === "descriptorEmbedding").length
  console.log(
    `[yc-embed] cohort=${cohort} records=${snap.size} enriched=${enriched} needEmbedding=${todo.length} (profile=${todo.length - nDesc} descriptor=${nDesc})`,
  )
  if (!apply) { console.log("[yc-embed] DRY RUN — pass --apply"); return }

  let done = 0
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH)
    const res = await client.embeddings.create({ model: MODEL, input: slice.map((r) => r.text) })
    // 1536 floats/doc — 100 of them blows Firestore's 10MB transaction cap, so commit in chunks.
    for (let k = 0; k < res.data.length; k += WRITE_CHUNK) {
      const wb = db.batch()
      res.data.slice(k, k + WRITE_CHUNK).forEach((e: { embedding: number[] }, j: number) => {
        const row = slice[k + j]!
        const at = new Date().toISOString()
        wb.set(
          db.collection("pa-external-candidate-records").doc(row.id),
          row.field === "matchEmbedding"
            ? { matchEmbedding: e.embedding, matchEmbeddingModel: MODEL, matchEmbeddedAt: at }
            : { descriptorEmbedding: e.embedding, descriptorEmbeddedAt: at },
          { merge: true },
        )
      })
      await wb.commit()
    }
    done += slice.length
    console.log(`[yc-embed] ${done}/${todo.length}`)
  }
  console.log(`[yc-embed] DONE ${done}`)
}

void main().then(() => process.exit(0))
