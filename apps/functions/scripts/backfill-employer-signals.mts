#!/usr/bin/env tsx
/**
 * backfill-employer-signals.mts — derive employer-history quality signals for EXISTING users.
 *
 * Adam directive (2026-06-10): candidate profiles must carry employer-history quality signals
 * (worked at tier-1 big tech, fast-growing startups, founder/ownership scope). New ingests get
 * them at the merge-experience seam (cv-ingest + coresignal-mirror); THIS script backfills users
 * who already have a parsed work history but no derived signals yet.
 *
 * Per user with parsed workHistory (pa-users.experienceHighlights, else the newest
 * parsedCandidateResumes workHistory/experiences):
 *   1. COMPANY JOIN — top-5 distinct companies by recency → pa-companies docs (the SAME
 *      normalizeCompanyName id) → employerStages / employerTags / hasBigTechBackground /
 *      employerGrowthTier.
 *   2. OWNERSHIP EXTRACTION — ONE gpt-5.4-mini json_schema-STRICT call → founderRole /
 *      scopeOfOwnership / selectivitySignals (explicit-only, never inferred).
 * Writes ride `applyPartialUserTags` (the D8 sole writer) with source "migration". Empty
 * derivations write NOTHING (no clobber of absent fields). Idempotent — re-running re-derives the
 * same keys.
 *
 * SAFETY:
 *   - DEFAULT IS DRY-RUN: prints the proposed patch per user, writes NOTHING.
 *   - `--apply` is required to persist. Do NOT run --apply without Adam sign-off.
 *   - `--limit N` caps users scanned; `--user <uid>` targets one doc.
 *   - `--skip-llm` runs the pa-companies join only (no ownership extraction / no LLM spend).
 *
 * Usage:
 *   tsx scripts/backfill-employer-signals.mts                 # dry-run audit
 *   tsx scripts/backfill-employer-signals.mts --limit 50
 *   tsx scripts/backfill-employer-signals.mts --user 8fEw...  # one user, dry-run
 *   tsx scripts/backfill-employer-signals.mts --apply         # PERSIST (Adam-gated)
 *
 * Auth: FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS env (+ OPENAI key env for
 * the ownership extraction half).
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import type { Firestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { applyPartialUserTags } from "@pa/pa-orchestrator"
import {
  deriveEmployerHistorySignals,
  loadEmployerCompanySignals,
  makeFirestoreCompanyLoader,
  type EmployerHistoryRow,
  type EmployerHistorySignals,
} from "../src/external-supply/employer-signals.js"

// ─── CLI flags ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const APPLY = argv.includes("--apply")
const SKIP_LLM = argv.includes("--skip-llm")
const LIMIT = readNumberFlag("--limit", 0)
const ONLY_USER = readStringFlag("--user", null)
const PROJECT = readStringFlag("--project", "wekruit-5f89b")
const PAGE_SIZE = readNumberFlag("--page-size", 200)

function readStringFlag(name: string, fallback: string | null): string | null {
  const i = argv.indexOf(name)
  if (i < 0) return fallback
  const v = argv[i + 1]
  return typeof v === "string" ? v : fallback
}
function readNumberFlag(name: string, fallback: number): number {
  const i = argv.indexOf(name)
  if (i < 0) return fallback
  const v = Number(argv[i + 1])
  return Number.isFinite(v) ? v : fallback
}

// ─── Firestore init ───────────────────────────────────────────────────────

function initFirestore(): Firestore {
  if (getApps().length === 0) {
    const saJson = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"]
    const saFile = process.env["GOOGLE_APPLICATION_CREDENTIALS"]
    if (saJson) {
      initializeApp({ credential: cert(JSON.parse(saJson)), projectId: PROJECT ?? undefined })
    } else if (saFile) {
      initializeApp({
        credential: cert(JSON.parse(readFileSync(saFile, "utf8"))),
        projectId: PROJECT ?? undefined,
      })
    } else {
      throw new Error(
        "no firebase credentials — set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS",
      )
    }
  }
  return getFirestore()
}

// ─── timeline extraction (pure — exported for tests) ─────────────────────

/** Map loose experience-row shapes (highlights / workHistory / experiences) → EmployerHistoryRow. */
export function toEmployerRow(raw: unknown): EmployerHistoryRow | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const out: EmployerHistoryRow = {}
  if (typeof r.title === "string" && r.title.trim()) out.title = r.title.trim()
  if (typeof r.company === "string" && r.company.trim()) out.company = r.company.trim()
  if (typeof r.startDate === "string" && r.startDate.trim()) out.startDate = r.startDate.trim()
  if (typeof r.endDate === "string" && r.endDate.trim()) out.endDate = r.endDate.trim()
  if (r.currentRole === true || r.isCurrent === true) out.isCurrent = true
  const bullets: string[] = []
  for (const key of ["bullets", "achievements", "highlights"]) {
    const arr = r[key]
    if (Array.isArray(arr)) for (const b of arr) if (typeof b === "string" && b.trim()) bullets.push(b.trim())
  }
  if (bullets.length > 0) out.description = bullets.join(" • ").slice(0, 2_000)
  else if (typeof r.description === "string" && r.description.trim()) {
    out.description = r.description.trim().slice(0, 2_000)
  }
  return out.title || out.company ? out : null
}

/** Rows from the pa-users doc (experienceHighlights) — the merged timeline when present. */
export function rowsFromUserDoc(userData: Record<string, unknown>): EmployerHistoryRow[] {
  const hl = Array.isArray(userData.experienceHighlights) ? userData.experienceHighlights : []
  return hl.map(toEmployerRow).filter((r): r is EmployerHistoryRow => r !== null)
}

/** Rows from a parsedCandidateResumes doc (workHistory preferred, else experiences). */
export function rowsFromResumeDoc(resume: Record<string, unknown>): EmployerHistoryRow[] {
  const src = Array.isArray(resume.workHistory) && resume.workHistory.length > 0
    ? resume.workHistory
    : Array.isArray(resume.experiences)
      ? resume.experiences
      : []
  return src.map(toEmployerRow).filter((r): r is EmployerHistoryRow => r !== null)
}

// ─── main ────────────────────────────────────────────────────────────────

interface Proposal {
  userId: string
  rows: number
  patch: EmployerHistorySignals
}

async function deriveForUser(
  db: Firestore,
  userId: string,
  userData: Record<string, unknown>,
): Promise<Proposal | null> {
  let rows = rowsFromUserDoc(userData)
  if (rows.length === 0) {
    try {
      const rs = await db.collection("parsedCandidateResumes").where("userId", "==", userId).limit(5).get()
      for (const doc of rs.docs) {
        const candidate = rowsFromResumeDoc((doc.data() ?? {}) as Record<string, unknown>)
        if (candidate.length > rows.length) rows = candidate
      }
    } catch {
      /* fail-open — no resume rows */
    }
  }
  if (rows.length === 0) return null

  const patch: EmployerHistorySignals = SKIP_LLM
    ? await loadEmployerCompanySignals(rows, { getCompanyDocs: makeFirestoreCompanyLoader(db) })
    : await deriveEmployerHistorySignals(rows, { getCompanyDocs: makeFirestoreCompanyLoader(db) })
  if (Object.keys(patch).length === 0) return null
  return { userId, rows: rows.length, patch }
}

async function main(): Promise<void> {
  const db = initFirestore()
  console.log(
    `backfill-employer-signals — mode=${APPLY ? "APPLY (writes!)" : "dry-run"}` +
      (SKIP_LLM ? " skip-llm" : "") +
      (ONLY_USER ? ` user=${ONLY_USER}` : "") +
      (LIMIT ? ` limit=${LIMIT}` : ""),
  )

  const proposals: Proposal[] = []
  let scanned = 0

  if (ONLY_USER) {
    const snap = await db.collection("pa-users").doc(ONLY_USER).get()
    scanned = 1
    if (snap.exists) {
      const p = await deriveForUser(db, snap.id, (snap.data() ?? {}) as Record<string, unknown>)
      if (p) proposals.push(p)
    } else {
      console.log(`pa-users/${ONLY_USER} not found`)
    }
  } else {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null
    while (true) {
      let q = db.collection("pa-users").orderBy("__name__").limit(PAGE_SIZE)
      if (cursor) q = q.startAfter(cursor)
      const page = await q.get()
      if (page.empty) break
      for (const doc of page.docs) {
        scanned++
        const p = await deriveForUser(db, doc.id, (doc.data() ?? {}) as Record<string, unknown>)
        if (p) proposals.push(p)
        if (LIMIT && scanned >= LIMIT) break
      }
      cursor = page.docs[page.docs.length - 1] ?? null
      if (LIMIT && scanned >= LIMIT) break
      if (page.size < PAGE_SIZE) break
    }
  }

  console.log(`scanned=${scanned} with-signals=${proposals.length}`)
  for (const p of proposals) {
    console.log(`  ${p.userId} (${p.rows} rows): ${JSON.stringify(p.patch)}`)
  }

  if (!APPLY) {
    console.log("dry-run — nothing written. Re-run with --apply to persist (Adam-gated).")
    return
  }

  let applied = 0
  for (const p of proposals) {
    // Sole writer (D8); shallow-replace per key, additive — only derived keys land.
    const res = await applyPartialUserTags(db, p.userId, p.patch as never, {
      source: "migration",
      log: (e, payload) => console.log(e, JSON.stringify(payload)),
    })
    if (res.ok) applied++
    else console.error(`  WRITE FAILED ${p.userId}: ${res.error}`)
  }
  console.log(`applied=${applied}/${proposals.length}`)
}

// Only run when executed directly (keeps the row mappers importable in tests).
const isDirectRun = process.argv[1]?.endsWith("backfill-employer-signals.mts") ?? false
if (isDirectRun) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
