#!/usr/bin/env node
/**
 * iter30/WS8 — Seed Firestore match-weights table from
 * `apps/job-rec/src/match-weights.ts` AI_AGENT_SKILL_WEIGHTS.
 *
 * Layout (per WS8 detail-plan §3 schema migration):
 *   pa-match-weight-tables/{tableKey}                  — table metadata
 *   pa-match-weight-tables/{tableKey}/items/{skillKey} — one row per weight
 *
 * Default mode is DRY-RUN. Pass `--confirm` to actually write to Firestore.
 * Idempotent: re-running with --confirm overwrites existing rows in place
 * (set + merge) and bumps `updatedAt`; no duplicate creation.
 *
 * Usage:
 *   # Dry-run (default — prints what would be written):
 *   node apps/functions/scripts/seed-match-weights.mjs
 *
 *   # Real write:
 *   node apps/functions/scripts/seed-match-weights.mjs --confirm
 *
 *   # Optional override (default ai-agent-2026):
 *   node apps/functions/scripts/seed-match-weights.mjs --table=ai-agent-2026
 *
 * Auth: same pattern as cleanup-cluster-v1-orphans.mjs (applicationDefault()).
 * Source GOOGLE_APPLICATION_CREDENTIALS from FIREBASE_SERVICE_ACCOUNT_JSON
 * in `.env` per CLAUDE.md guidance, OR rely on `gcloud auth
 * application-default login` if pre-authd. Run from repo root.
 *
 * Idempotency:
 *   - skillKey = lower-case skill string with spaces collapsed to hyphens
 *     (e.g. "tool calling" → "tool-calling"). Stable across runs.
 *   - Batch write (max 500/batch — well under cap for ~30-row source).
 *   - Audit row written to PA_COLLECTIONS.auditEvents on each --confirm
 *     run (action: "match-weight.seed").
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { FieldValue, getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..", "..", "..")

const TABLES_COLLECTION = "pa-match-weight-tables"
const ITEMS_SUBCOLLECTION = "items"
const AUDIT_COLLECTION = "pa-audit-events"

function parseArgs(argv) {
  return {
    confirm: argv.includes("--confirm"),
    table:
      (argv.find((a) => a.startsWith("--table=")) ?? "").split("=")[1] ??
      "ai-agent-2026",
    project:
      (argv.find((a) => a.startsWith("--project=")) ?? "").split("=")[1] ??
      process.env.GCLOUD_PROJECT ??
      "wekruit-5f89b",
  }
}

/**
 * Parse the AI_AGENT_SKILL_WEIGHTS const out of match-weights.ts using a
 * deliberate non-eval regex pass. Avoids dragging tsc into a seed script
 * and keeps the dependency surface flat (firebase-admin + node stdlib).
 *
 * Source pattern (from apps/job-rec/src/match-weights.ts):
 *   { skill: "rag", weight: 3.0, category: "core" },
 */
function parseWeightsFromSource() {
  const path = join(repoRoot, "apps/job-rec/src/match-weights.ts")
  const text = readFileSync(path, "utf8")
  const constStart = text.indexOf("AI_AGENT_SKILL_WEIGHTS")
  if (constStart === -1) {
    throw new Error("[seed-match-weights] AI_AGENT_SKILL_WEIGHTS not found in source")
  }
  // Skip past the type annotation (e.g. ": readonly SkillWeight[]") and find
  // the first `= [` opening the actual array literal. Using `indexOf("[")`
  // alone matches the `[]` in `SkillWeight[]` first.
  const eqStart = text.indexOf("= [", constStart)
  if (eqStart === -1) {
    throw new Error("[seed-match-weights] could not locate `= [` array opener")
  }
  const arrStart = text.indexOf("[", eqStart)
  const arrEnd = text.indexOf("]", arrStart)
  if (arrStart === -1 || arrEnd === -1) {
    throw new Error("[seed-match-weights] could not locate weight array bounds")
  }
  const body = text.slice(arrStart + 1, arrEnd)
  const rowRe =
    /\{\s*skill:\s*"([^"]+)"\s*,\s*weight:\s*([\d.]+)\s*,\s*category:\s*"(core|supporting|generic)"\s*\}/g
  const rows = []
  for (const m of body.matchAll(rowRe)) {
    rows.push({
      skill: m[1],
      weight: Number(m[2]),
      category: m[3],
    })
  }
  if (rows.length === 0) {
    throw new Error("[seed-match-weights] regex parsed zero rows — source format changed?")
  }
  return rows
}

function skillToKey(skill) {
  return skill.toLowerCase().trim().replace(/\s+/g, "-")
}

async function main() {
  const { confirm, table, project } = parseArgs(process.argv.slice(2))

  console.log(`[seed-match-weights] table: ${table}`)
  console.log(`[seed-match-weights] project: ${project}`)
  console.log(
    `[seed-match-weights] mode: ${confirm ? "WRITE (real)" : "DRY-RUN (default)"}`
  )

  const rows = parseWeightsFromSource()
  console.log(`[seed-match-weights] parsed ${rows.length} rows from source`)

  if (!confirm) {
    console.log("[seed-match-weights] DRY-RUN preview (first 5):")
    for (const r of rows.slice(0, 5)) {
      console.log(`  - ${skillToKey(r.skill)} → ${r.weight} (${r.category})`)
    }
    console.log("[seed-match-weights] Pass --confirm to write to Firestore.")
    return
  }

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: project })
  }
  const db = getFirestore()

  const tableRef = db.collection(TABLES_COLLECTION).doc(table)
  const itemsCol = tableRef.collection(ITEMS_SUBCOLLECTION)

  const batch = db.batch()
  batch.set(
    tableRef,
    {
      tableKey: table,
      name:
        table === "ai-agent-2026"
          ? "AI Agent / LLM Engineer 2026"
          : table,
      description:
        "Seeded from apps/job-rec/src/match-weights.ts AI_AGENT_SKILL_WEIGHTS.",
      rowCount: rows.length,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: "seed-match-weights.mjs",
    },
    { merge: true }
  )

  for (const r of rows) {
    const key = skillToKey(r.skill)
    batch.set(
      itemsCol.doc(key),
      {
        skill: r.skill,
        weight: r.weight,
        category: r.category,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: "seed-match-weights.mjs",
      },
      { merge: true }
    )
  }

  // Audit row — single event covering the seed batch.
  const auditRef = db.collection(AUDIT_COLLECTION).doc()
  batch.set(auditRef, {
    actor: "seed-match-weights.mjs",
    action: "match-weight.seed",
    key: table,
    oldValue: null,
    newValue: { rowCount: rows.length },
    reason: "iter30/WS8 Day-1 seed of AI_AGENT_SKILL_WEIGHTS",
    ts: FieldValue.serverTimestamp(),
  })

  await batch.commit()
  console.log(
    `[seed-match-weights] wrote table ${table} + ${rows.length} item rows + 1 audit row`
  )
}

main().catch((err) => {
  console.error("[seed-match-weights] FAILED:", err)
  process.exit(1)
})
