/**
 * E2E in-process verification of the inline-base64 createBatch path.
 *
 * Bypasses the HTTPS callable layer (which requires a Firebase user ID
 * token we can't easily mint from a service account). Exercises the full
 * runCreateBatch handler with the real Firestore admin client, real adapter
 * registry, and real `parseManualSheetBuffer` — so any drift between the
 * server schema, the registry, and the loose-CSV adapter blows up here
 * before we send a customer at it.
 *
 * Usage:
 *   node --import tsx apps/functions/scripts/e2e-inline-commit.ts \
 *     '/Users/adam/Downloads/lessie_export (1).xlsx' rain-xyz rain-android-engineer-c1351eb6
 */
import { readFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { basename } from "node:path"
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { runCreateBatch, makeFirestoreDeps } from "../src/external-supply/import.js"

async function main() {
  const [, , filePath, companyId, jobId] = process.argv
  if (!filePath || !companyId || !jobId) {
    console.error("usage: e2e-inline-commit.ts <xlsx> <companyId> <jobId>")
    process.exit(2)
  }
  const buf = readFileSync(filePath)
  const sha256 = createHash("sha256").update(buf).digest("hex")
  const fname = basename(filePath)
  if (!getApps().length) initializeApp({ credential: applicationDefault() })
  const db = getFirestore()
  const deps = {
    ...makeFirestoreDeps(db),
    downloadFile: async () => buf,
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    log: (...args: unknown[]) => console.log("[e2e][cf]", ...args),
  }
  // NOTE: source intentionally set to "lessie" so we also exercise the
  // server-side dispatchAdapter PK-magic auto-route to manual_csv. If the
  // xlsx hits lessie's csv-parse path the seed will throw.
  const result = await runCreateBatch(
    {
      source: "lessie",
      storageUri: `inline://manual_csv/${sha256}/${fname}`,
      sha256,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: buf.length,
      companyId,
      jobId,
      importedBy: "script:e2e-inline-commit",
    },
    deps,
  )
  console.log("[e2e][cf] DONE", result)
  process.exit(0)
}

main().catch((err) => {
  console.error("[e2e][cf] FAILED:", err)
  process.exit(1)
})
