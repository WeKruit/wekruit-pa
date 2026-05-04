#!/usr/bin/env node
/**
 * iter31 — archive stale parsedCandidateResumes for a user, keeping only the
 * most recent (or a specific keep-id when --keep is supplied).
 *
 * Adam's iter30 follow-up: 5 stale parsedCandidateResumes for test user
 * e5d97cd8 from pre-iter30. Archive 4 of 5 (keep most recent
 * zLSRbpWz8edA7tAhRadA) so job-rec has a single canonical CV.
 *
 * NOTE: parsedCandidateResumes is a CROSS-PRODUCT collection shared with the
 * main hiring app — we do NOT delete, we mark `archived=true` + `archivedAt`.
 * Hiring app's read paths can opt to filter or include based on that flag.
 *
 * Usage:
 *   node apps/functions/scripts/archive-stale-cvs.mjs <userId> --keep <docId>
 *   node apps/functions/scripts/archive-stale-cvs.mjs e5d97cd8-... --keep zLSRbpWz8edA7tAhRadA
 *
 * Dry run by default; pass --apply to actually write.
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const PROJECT_ID = process.env.PA_FIREBASE_PROJECT_ID || "wekruit-5f89b"

if (!getApps().length) {
  initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
}
const db = getFirestore()

function parseArgs(argv) {
  const args = argv.slice(2)
  let userId
  let keep
  let apply = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--keep") {
      keep = args[++i]
    } else if (a === "--apply") {
      apply = true
    } else if (!userId && !a.startsWith("--")) {
      userId = a
    }
  }
  return { userId, keep, apply }
}

async function main() {
  const { userId, keep, apply } = parseArgs(process.argv)
  if (!userId) {
    console.error("usage: archive-stale-cvs.mjs <userId> [--keep <docId>] [--apply]")
    process.exit(2)
  }
  // parsedCandidateResumes typically scoped by userId field. Some hiring app
  // schemas use `candidateId` or a doc-id prefix. We try userId first; caller
  // can adapt the where field if needed.
  const snap = await db
    .collection("parsedCandidateResumes")
    .where("userId", "==", userId)
    .get()
  if (snap.empty) {
    console.log(`No parsedCandidateResumes found for userId=${userId}`)
    return
  }
  const rows = snap.docs.map((d) => ({
    id: d.id,
    archived: Boolean(d.data().archived),
    parsedAt: d.data().parsedAt ?? d.data().createdAt ?? d.data().updatedAt,
  }))
  console.log(`Found ${rows.length} parsedCandidateResumes for userId=${userId}`)
  for (const r of rows) {
    console.log(`  ${r.id} · archived=${r.archived} · parsedAt=${r.parsedAt}`)
  }
  // Resolve which to keep: explicit --keep, else most-recent by parsedAt.
  let keepId = keep
  if (!keepId) {
    const sorted = [...rows]
      .filter((r) => !r.archived)
      .sort((a, b) => String(b.parsedAt ?? "").localeCompare(String(a.parsedAt ?? "")))
    keepId = sorted[0]?.id
  }
  if (!keepId) {
    console.error("Could not resolve a keep-id (no --keep and no parsedAt to sort by)")
    process.exit(2)
  }
  console.log(`\nKeep: ${keepId}`)
  const targets = rows.filter((r) => r.id !== keepId && !r.archived)
  if (targets.length === 0) {
    console.log("Nothing to archive.")
    return
  }
  console.log(`\nArchive (${apply ? "APPLY" : "dry-run"}):`)
  for (const t of targets) {
    console.log(`  ${t.id}`)
    if (apply) {
      await db.collection("parsedCandidateResumes").doc(t.id).set(
        {
          archived: true,
          archivedAt: new Date().toISOString(),
          archivedBy: process.env.USER || "ops-script",
          archivedReason: "iter31 stale CV cleanup — keep canonical " + keepId,
        },
        { merge: true }
      )
    }
  }
  if (!apply) {
    console.log("\n(dry-run; pass --apply to write)")
  } else {
    console.log(`\n✓ archived ${targets.length} stale CV(s); kept ${keepId}`)
  }
}

main().catch((e) => {
  console.error("fatal", e)
  process.exit(1)
})
