/**
 * One-shot ingest: the YC Startup School attendee sheet → an external-supply batch + one
 * candidate record per attendee, so the people matcher has a pool to rank against.
 *
 * WHY A SCRIPT AND NOT THE CF: `paExternalSupplyCreateBatch` would work, but this list needs two
 * things the generic path does not do — dropping `No Result` rows before they become records, and
 * carrying `Match Status` onto each record so a semi-automatic (possibly wrong) LinkedIn match can
 * be demoted later. Everything else reuses the existing pipeline verbatim:
 * `parseManualSheetBuffer` (loose manual_csv adapter) → `dedupeWithinBatch` → the same two
 * collections, idempotent on (sha256, source), same as scripts/seed-lessie-xlsx.ts.
 *
 * COHORT TAG — deliberately NOT `sourceTags`. That field is read as SKILLS downstream
 * (`legacy-user-tags-bridge.ts:82` slices it into candidateProfile.skills;
 * `coresignal-experiences-mirror.ts:387` does `const skills = record.sourceTags ?? []`), so
 * "yc_startup_school_2026" there would become a fake skill on 1000+ profiles and poison matching.
 * The cohort lives in `batch.meta.cohort` + each record's `enrichment.cohort`, and the batchId is
 * the real scoping key (it is what paExternalSupplyListBatchCandidates already filters on).
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp) && \
 *     grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | \
 *     sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//' > "$GOOGLE_APPLICATION_CREDENTIALS"
 *   node --import tsx apps/functions/scripts/import-yc-attendees.ts \
 *     '/Users/adam/Downloads/YC Startup School 2026 - Attendees.csv' [--apply]
 */
import { readFileSync, statSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { basename } from "node:path"
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { dedupeWithinBatch } from "@pa/external-supply"
import { parseManualSheetBuffer } from "../src/external-supply/adapters/manual-csv.js"

/** The cohort label. A future event is a new value here, not new code. */
const COHORT = "yc_startup_school_2026"
const SOURCE = "manual_csv" as const
const NORMALIZER_VERSION = "manual-csv-2026-05-B"

/**
 * The sheet's own header row is not row 0 — the file opens with a multi-line disclaimer cell.
 * Find the real header, drop `No Result` rows (156 of 1284: the compiler found no LinkedIn at all,
 * so there is nothing to match on), and re-emit a clean CSV for the adapter.
 */
function preprocess(raw: Buffer): { csv: Buffer; kept: number; dropped: number; statusByUrl: Map<string, string> } {
  const text = raw.toString("utf8")
  const rows = parseCsv(text)
  const headerIdx = rows.findIndex((r) => r[0]?.trim() === "Name")
  if (headerIdx < 0) throw new Error("could not find the 'Name' header row")
  const header = rows[headerIdx]!
  const col = (n: string) => header.findIndex((c) => c.trim() === n)
  const iName = col("Name")
  const iUrl = col("LinkedIn Profile URL")
  const iStatus = col("Match Status")
  if (iName < 0 || iUrl < 0) throw new Error("missing Name / LinkedIn Profile URL columns")

  const statusByUrl = new Map<string, string>()
  const out: string[][] = [["Name", "LinkedIn Profile URL", "Match Status"]]
  let dropped = 0
  for (const r of rows.slice(headerIdx + 1)) {
    const name = (r[iName] ?? "").trim()
    const url = (r[iUrl] ?? "").trim()
    const status = iStatus >= 0 ? (r[iStatus] ?? "").trim() : ""
    if (!name || !url) { dropped++; continue }
    if (status === "No Result") { dropped++; continue }
    out.push([name, url, status])
    statusByUrl.set(url.toLowerCase(), status)
  }
  const csv = out.map((r) => r.map(csvCell).join(",")).join("\n")
  return { csv: Buffer.from(csv, "utf8"), kept: out.length - 1, dropped, statusByUrl }
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** Minimal RFC4180 reader — the sheet has quoted cells containing commas and newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += c
      continue
    }
    if (c === '"') { quoted = true; continue }
    if (c === ",") { row.push(cell); cell = ""; continue }
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue }
    if (c === "\r") continue
    cell += c
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

async function main() {
  const filePath = process.argv[2]
  const apply = process.argv.includes("--apply")
  if (!filePath) {
    console.error("usage: import-yc-attendees.ts <csv-path> [--apply]")
    process.exit(2)
  }
  const raw = readFileSync(filePath)
  const size = statSync(filePath).size
  const fname = basename(filePath)
  console.log(`[yc-import] file=${fname} size=${size}B cohort=${COHORT}`)

  const { csv, kept, dropped, statusByUrl } = preprocess(raw)
  console.log(`[yc-import] preprocessed kept=${kept} dropped(No Result / blank)=${dropped}`)

  // sha256 of the PREPROCESSED bytes — that is what actually became records, so idempotency
  // tracks the real input. Re-running with the same source sheet hits the same batch.
  const sha256 = createHash("sha256").update(csv).digest("hex")

  const { drafts, sheetKind, effectiveMapping } = parseManualSheetBuffer(csv, "yc-attendees.csv", {
    // `LinkedIn Profile URL` does NOT auto-map: auto-map.ts:46-56 has no pattern with the word
    // "Profile" in the middle. Explicit mapping is required or every row loses its identity.
    name: "Name",
    linkedinUrl: "LinkedIn Profile URL",
  })
  console.log(`[yc-import] parsed kind=${sheetKind} rows=${drafts.length} mapping=${JSON.stringify(effectiveMapping)}`)

  const dedupe = dedupeWithinBatch(drafts)
  const withLinkedIn = dedupe.kept.filter((r) => Boolean(r.canonicalLinkedInUrl)).length
  console.log(
    `[yc-import] dedup kept=${dedupe.kept.length} dupes=${dedupe.duplicateCount} withCanonicalLinkedIn=${withLinkedIn}`,
  )

  if (!apply) {
    console.log("\n[yc-import] DRY RUN — pass --apply to write. Sample of 3:")
    for (const d of dedupe.kept.slice(0, 3)) {
      console.log(`   ${d.name} | ${d.canonicalLinkedInUrl} | status=${statusByUrl.get((d.rawPayload as Record<string, string>)?.["LinkedIn Profile URL"]?.toLowerCase() ?? "") ?? "?"}`)
    }
    return
  }

  if (!getApps().length) initializeApp({ credential: applicationDefault() })
  const db = getFirestore()

  const existing = await db
    .collection("pa-external-sourcing-batches")
    .where("sha256", "==", sha256)
    .where("source", "==", SOURCE)
    .limit(1)
    .get()
  const batchId = existing.empty ? randomUUID() : existing.docs[0]!.id
  console.log(`[yc-import] batchId=${batchId} (${existing.empty ? "new" : "existing — overwriting"})`)

  const nowIso = new Date().toISOString()
  await db.collection("pa-external-sourcing-batches").doc(batchId).set(
    {
      batchId,
      source: SOURCE,
      rawFileRef: { storageUri: `inline://${SOURCE}/${sha256}/${fname}`, mime: "text/csv", sha256, sizeBytes: csv.length },
      normalizerVersion: NORMALIZER_VERSION,
      adapterVersion: NORMALIZER_VERSION,
      storageUri: `inline://${SOURCE}/${sha256}/${fname}`,
      sha256,
      mime: "text/csv",
      sizeBytes: csv.length,
      rowCount: drafts.length,
      validLinkedInCount: withLinkedIn,
      validEmailCount: 0,
      duplicateCount: dedupe.duplicateCount,
      needsReviewCount: 0,
      readyToProfileCount: dedupe.kept.filter((r) => r.normalizationStatus === "ok").length,
      importedBy: "script:import-yc-attendees",
      importedAt: nowIso,
      status: "normalized" as const,
      createdAt: nowIso,
      updatedAt: nowIso,
      // The cohort lives HERE (and on each record's enrichment) — never in sourceTags.
      meta: { cohort: COHORT, filename: fname, sheetKind, droppedNoResult: dropped },
    },
    { merge: true },
  )

  // Re-runs must not multiply records.
  const stale = await db.collection("pa-external-candidate-records").where("batchId", "==", batchId).get()
  if (!stale.empty) {
    console.log(`[yc-import] cleaning ${stale.size} stale records`)
    for (let i = 0; i < stale.docs.length; i += 400) {
      const b = db.batch()
      for (const d of stale.docs.slice(i, i + 400)) b.delete(d.ref)
      await b.commit()
    }
  }

  let written = 0
  for (let i = 0; i < dedupe.kept.length; i += 400) {
    const b = db.batch()
    for (const draft of dedupe.kept.slice(i, i + 400)) {
      const recordId = randomUUID()
      const rawUrl = (draft.rawPayload as Record<string, string> | undefined)?.["LinkedIn Profile URL"] ?? ""
      const doc: Record<string, unknown> = {
        ...draft,
        recordId,
        batchId,
        createdAt: nowIso,
        enrichment: {
          ...(draft.enrichment ?? {}),
          cohort: COHORT,
          // Carried so a "Needs Review" (semi-automatic, possibly wrong person) match can be
          // demoted in ranking rather than silently trusted.
          matchStatus: statusByUrl.get(rawUrl.toLowerCase()) ?? null,
        },
      }
      for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k]
      b.set(db.collection("pa-external-candidate-records").doc(recordId), doc)
      written++
    }
    await b.commit()
  }
  console.log(`[yc-import] wrote ${written} records under batchId=${batchId}`)
  console.log(`[yc-import] next: enrich them from Coresignal (see enrich-yc-attendees.ts)`)
}

void main().then(() => process.exit(0))
