#!/usr/bin/env tsx
/**
 * backfill-stale-jobtype.mts — clear stale intern/new-grad targetJobType hard filters.
 *
 * ROOT CAUSE (2026-06-09): `tags.targetJobType` is an EXACT-match HARD filter in
 * V16, and negations were inexpressible through the thin tool chain — a candidate
 * who said "I am not looking for an internship" kept targetJobType=["internship"]
 * and only intern jobs ever matched. The tool/extractor fix prevents NEW staleness;
 * this script finds users already poisoned by it: a seniority profile that plainly
 * contradicts an intern/new-grad job-type filter.
 *
 * Candidate selection — pa-users where:
 *   tags.targetJobType includes "internship" OR "new_graduate"
 *   AND (
 *     tags.yoeRange[1] >= 3
 *     OR tags.careerStage ∈ { mid_level, senior, staff, principal, manager,
 *                             director, vp, c_level, founder }
 *   )
 *
 * Proposed change — SUBTRACT the stale tokens ("internship"/"new_graduate") from
 * targetJobType; a subtraction that empties the set writes [] (the explicit clear
 * the live victim needed). Other tokens (e.g. full_time) are kept. Writes go
 * through `applyPartialUserTags` (the D8 sole writer) with source "migration".
 *
 * SAFETY:
 *   - DEFAULT IS DRY-RUN: prints the proposed clear per user, writes NOTHING.
 *   - `--apply` is required to persist. Do NOT run --apply without Adam sign-off.
 *   - `--limit N` caps users scanned; `--user <uid>` targets one doc.
 *
 * Usage:
 *   tsx scripts/backfill-stale-jobtype.mts                 # dry-run audit
 *   tsx scripts/backfill-stale-jobtype.mts --limit 50
 *   tsx scripts/backfill-stale-jobtype.mts --user 8fEw...  # one user, dry-run
 *   tsx scripts/backfill-stale-jobtype.mts --apply         # PERSIST (gated)
 *
 * Auth: FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS env.
 */

import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import type { Firestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
import { applyPartialUserTags } from "@pa/pa-orchestrator"

// ─── CLI flags ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const APPLY = argv.includes("--apply")
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
        "no firebase credentials — set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS"
      )
    }
  }
  return getFirestore()
}

// ─── selection logic (pure — exported for tests) ─────────────────────────

/** Job-type tokens an established-seniority profile contradicts. */
export const STALE_JOB_TYPE_TOKENS = ["internship", "new_graduate"] as const

/** careerStage values that contradict an intern/new-grad job-type filter. */
export const ESTABLISHED_CAREER_STAGES = new Set<string>([
  "mid_level",
  "senior",
  "staff",
  "principal",
  "manager",
  "director",
  "vp",
  "c_level",
  "founder",
])

export interface StaleJobTypeProposal {
  userId: string
  targetJobType: string[]
  proposedTargetJobType: string[]
  staleTokens: string[]
  reason: string
}

/**
 * Decide whether a user's tags carry a stale intern/new-grad job-type filter.
 * Returns the proposed subtraction, or null when the doc is not a candidate.
 */
export function proposeStaleJobTypeClear(
  userId: string,
  tags: Record<string, unknown> | undefined,
): StaleJobTypeProposal | null {
  if (!tags || typeof tags !== "object") return null
  const targetJobType = Array.isArray(tags.targetJobType)
    ? (tags.targetJobType as unknown[]).filter((t): t is string => typeof t === "string")
    : []
  const staleTokens = targetJobType.filter((t) =>
    (STALE_JOB_TYPE_TOKENS as readonly string[]).includes(t),
  )
  if (staleTokens.length === 0) return null

  const reasons: string[] = []
  const yoeRange = tags.yoeRange
  if (
    Array.isArray(yoeRange) &&
    typeof yoeRange[1] === "number" &&
    Number.isFinite(yoeRange[1]) &&
    yoeRange[1] >= 3
  ) {
    reasons.push(`yoeRange=[${String(yoeRange[0])},${String(yoeRange[1])}] (max >= 3)`)
  }
  const careerStage = typeof tags.careerStage === "string" ? tags.careerStage : null
  if (careerStage && ESTABLISHED_CAREER_STAGES.has(careerStage)) {
    reasons.push(`careerStage=${careerStage}`)
  }
  if (reasons.length === 0) return null

  return {
    userId,
    targetJobType,
    proposedTargetJobType: targetJobType.filter(
      (t) => !(STALE_JOB_TYPE_TOKENS as readonly string[]).includes(t),
    ),
    staleTokens,
    reason: reasons.join(" AND "),
  }
}

// ─── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = initFirestore()
  console.log(
    `backfill-stale-jobtype — mode=${APPLY ? "APPLY (writes!)" : "dry-run"}` +
      (ONLY_USER ? ` user=${ONLY_USER}` : "") +
      (LIMIT ? ` limit=${LIMIT}` : ""),
  )

  const proposals: StaleJobTypeProposal[] = []
  let scanned = 0

  if (ONLY_USER) {
    const snap = await db.collection("pa-users").doc(ONLY_USER).get()
    scanned = 1
    if (snap.exists) {
      const p = proposeStaleJobTypeClear(
        snap.id,
        (snap.data()?.tags ?? undefined) as Record<string, unknown> | undefined,
      )
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
        const p = proposeStaleJobTypeClear(
          doc.id,
          (doc.data()?.tags ?? undefined) as Record<string, unknown> | undefined,
        )
        if (p) proposals.push(p)
        if (LIMIT && scanned >= LIMIT) break
      }
      cursor = page.docs[page.docs.length - 1] ?? null
      if (LIMIT && scanned >= LIMIT) break
      if (page.size < PAGE_SIZE) break
    }
  }

  console.log(`scanned=${scanned} stale=${proposals.length}`)
  for (const p of proposals) {
    console.log(
      `  ${p.userId}: targetJobType ${JSON.stringify(p.targetJobType)} → ` +
        `${JSON.stringify(p.proposedTargetJobType)} (drop ${p.staleTokens.join("+")}; ${p.reason})`,
    )
  }

  if (!APPLY) {
    console.log("dry-run — nothing written. Re-run with --apply to persist (Adam-gated).")
    return
  }

  let applied = 0
  for (const p of proposals) {
    // Sole writer (D8). targetJobType is shallow-REPLACED per key, so the
    // subtraction result — including an explicit [] — actually lands.
    const res = await applyPartialUserTags(
      db,
      p.userId,
      { targetJobType: p.proposedTargetJobType } as never,
      { source: "migration", log: (e, payload) => console.log(e, JSON.stringify(payload)) },
    )
    if (res.ok) applied++
    else console.error(`  WRITE FAILED ${p.userId}: ${res.error}`)
  }
  console.log(`applied=${applied}/${proposals.length}`)
}

// Only run when executed directly (keeps `proposeStaleJobTypeClear` importable in tests).
const isDirectRun = process.argv[1]?.endsWith("backfill-stale-jobtype.mts") ?? false
if (isDirectRun) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
