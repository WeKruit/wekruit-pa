#!/usr/bin/env tsx
/**
 * EX1 PR-B — pa-users experience-model migration.
 *
 * Walks `pa-users`, calls the experience-extractor primitive per
 * work-history entry, aggregates into a `DerivedExperienceModel`, and
 * writes it back to `pa-users/{uid}.derivedExperience` plus the cache
 * subcollection `pa-users/{uid}/workEntries/{entryId}`.
 *
 * Idempotency:
 *   - `derivedExperienceVersion === "v1"` short-circuits (override with
 *     `--force-rerun`).
 *   - Per-entry cache hits avoid re-calling the LLM on unchanged data.
 *
 * Cursor resume:
 *   - Pagination uses `__name__` cursor; pass `--resume-from <docId>`.
 *
 * Cost guardrails:
 *   - Default `--dry-run` writes nothing (still calls LLM unless every
 *     entry is cached). Use `--apply` to persist.
 *   - `--limit N` caps the number of users processed.
 *
 * Auth:
 *   - GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON env.
 *   - OPENAI_API_KEY env required (unless every entry is cached).
 *
 * Usage:
 *   tsx scripts/migrate-experience-model.mts --dry-run
 *   tsx scripts/migrate-experience-model.mts --apply --limit 5
 *   tsx scripts/migrate-experience-model.mts --apply --resume-from <docId>
 *   tsx scripts/migrate-experience-model.mts --apply --force-rerun
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import type { Firestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"

import {
  computeEntryId,
  deriveExperienceModel,
  extractWorkEntrySkills,
  firestoreExtractionCache,
  type DeriveEntryInput,
  type DerivedExperienceModel,
  type WorkEntryExtractionInput,
} from "@pa/pa-experience-extractor"

// ─── CLI flags ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const APPLY = argv.includes("--apply")
const DRY_RUN = !APPLY
const FORCE_RERUN = argv.includes("--force-rerun")
const VERBOSE = argv.includes("--verbose")
const LIMIT = readNumberFlag("--limit", 0)
const RESUME_FROM = readStringFlag("--resume-from", null)
const PROJECT = readStringFlag("--project", "wekruit-5f89b")
const PAGE_SIZE = readNumberFlag("--page-size", 100)
const RATE_LIMIT_MS = readNumberFlag("--rate-limit-ms", 100)

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
      initializeApp({ credential: cert(JSON.parse(saJson)), projectId: PROJECT })
    } else if (saFile) {
      initializeApp({
        credential: cert(JSON.parse(readFileSync(saFile, "utf8"))),
        projectId: PROJECT,
      })
    } else {
      throw new Error(
        "no firebase credentials — set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS"
      )
    }
  }
  return getFirestore()
}

// ─── pa-users shape (subset we need) ──────────────────────────────────────

interface PaUserWorkHistoryEntry {
  title?: unknown
  company?: unknown
  startDate?: unknown
  endDate?: unknown
  currentRole?: unknown
  description?: unknown
  bullets?: unknown
  achievements?: unknown
}

interface PaUserDoc {
  skills?: unknown
  workHistory?: unknown
  derivedExperienceVersion?: unknown
}

function asStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t.length > 0 ? t : null
}
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
}
function asWorkHistory(v: unknown): PaUserWorkHistoryEntry[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is PaUserWorkHistoryEntry => !!x && typeof x === "object")
}

// ─── Per-user pipeline ────────────────────────────────────────────────────

interface MigrateStats {
  scanned: number
  skippedAlreadyV1: number
  skippedNoWorkHistory: number
  migrated: number
  failed: number
  cacheHits: number
  llmCalls: number
}

async function migrateOneUser(
  db: Firestore,
  uid: string,
  user: PaUserDoc,
  stats: MigrateStats,
  openaiApiKey: string | undefined
): Promise<void> {
  if (!FORCE_RERUN && user.derivedExperienceVersion === "v1") {
    stats.skippedAlreadyV1++
    if (VERBOSE) log("skip_already_v1", { uid })
    return
  }
  const workHistory = asWorkHistory(user.workHistory)
  if (workHistory.length === 0) {
    stats.skippedNoWorkHistory++
    if (VERBOSE) log("skip_no_work_history", { uid })
    return
  }
  const claimedSkills = asStringArray(user.skills)
  const cache = firestoreExtractionCache(db)

  const deriveInputs: DeriveEntryInput[] = []

  for (let index = 0; index < workHistory.length; index++) {
    const wh = workHistory[index]!
    const title = asStringOrNull(wh.title) ?? ""
    if (!title) continue
    const startDate = asStringOrNull(wh.startDate)
    const endDate = asStringOrNull(wh.endDate)
    const entryId = computeEntryId({ uid, index, title, startDate })

    const extractionInput: WorkEntryExtractionInput = {
      entryId,
      title,
      company: asStringOrNull(wh.company) ?? "(unknown)",
      startDate,
      endDate,
      description: asStringOrNull(wh.description),
      bullets: asStringArray(wh.bullets),
      achievements: asStringArray(wh.achievements),
      candidateSkills: claimedSkills,
    }

    try {
      const { output, source } = await extractWorkEntrySkills({
        uid,
        input: extractionInput,
        cache,
        openaiApiKey,
      })
      if (source === "cache") stats.cacheHits++
      else stats.llmCalls++
      deriveInputs.push({ output, startDate, endDate, title })
    } catch (err) {
      stats.failed++
      log("entry_extract_failed", {
        uid,
        entryId,
        title,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
  }

  if (deriveInputs.length === 0) {
    stats.skippedNoWorkHistory++
    return
  }

  const derived: DerivedExperienceModel = deriveExperienceModel({
    entries: deriveInputs,
    claimedSkills,
  })

  if (DRY_RUN) {
    log("dry_run_would_write", {
      uid,
      yearsTotal: derived.yearsTotal,
      skillsTotal: Object.keys(derived.yearsPerSkill).length,
      titleTrajectory: derived.titleTrajectory,
      seniorityCurrent: derived.seniorityCurrent,
    })
  } else {
    await db.collection("pa-users").doc(uid).set(
      {
        derivedExperience: derived,
        derivedExperienceVersion: "v1",
      },
      { merge: true }
    )
    log("migrated", {
      uid,
      yearsTotal: derived.yearsTotal,
      skillsTotal: Object.keys(derived.yearsPerSkill).length,
    })
  }
  stats.migrated++
}

// ─── Walker ───────────────────────────────────────────────────────────────

async function* paginate(
  db: Firestore,
  fromCursor: string | null
): AsyncGenerator<{ id: string; data: PaUserDoc }> {
  let cursor: string | null = fromCursor
  for (;;) {
    let q = db.collection("pa-users").orderBy("__name__").limit(PAGE_SIZE)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    if (snap.empty) return
    for (const d of snap.docs) {
      yield { id: d.id, data: d.data() as PaUserDoc }
    }
    cursor = snap.docs[snap.docs.length - 1]!.id
    if (snap.docs.length < PAGE_SIZE) return
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const db = initFirestore()
  const openaiApiKey = process.env["OPENAI_API_KEY"]

  log("start", {
    apply: APPLY,
    forceRerun: FORCE_RERUN,
    limit: LIMIT || "all",
    resumeFrom: RESUME_FROM,
    project: PROJECT,
    pageSize: PAGE_SIZE,
    rateLimitMs: RATE_LIMIT_MS,
    hasOpenAI: !!openaiApiKey,
  })

  const stats: MigrateStats = {
    scanned: 0,
    skippedAlreadyV1: 0,
    skippedNoWorkHistory: 0,
    migrated: 0,
    failed: 0,
    cacheHits: 0,
    llmCalls: 0,
  }

  for await (const userDoc of paginate(db, RESUME_FROM)) {
    if (LIMIT > 0 && stats.scanned >= LIMIT) break
    stats.scanned++
    try {
      await migrateOneUser(db, userDoc.id, userDoc.data, stats, openaiApiKey)
    } catch (err) {
      stats.failed++
      log("user_failed", {
        uid: userDoc.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
    if (stats.scanned % 25 === 0) log("progress", stats)
  }

  log("done", stats)
  // Surface a clearly-greppable last line for log-tail consumers.
  console.log(
    `[migrate-experience-model] done apply=${APPLY} ${JSON.stringify(stats)}`
  )
  return 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function log(event: string, payload: Record<string, unknown> = {}): void {
  console.log(`[migrate-experience-model] ${event} ${JSON.stringify(payload)}`)
}

main().then(
  (code) => {
    process.exit(code)
  },
  (err) => {
    log("fatal", { error: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  }
)
