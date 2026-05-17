/**
 * Repairs Rain job docs seeded with open-ended compensation sentinels.
 *
 * The Rain source text says compensation is based on experience, but the
 * seed payload used salaryMin=50000 and salaryMax=999000. That produced
 * candidate-visible "$50000-999000/yr" copy and a meaningless compensation
 * prescreen question. Treat that pair as missing compensation.
 *
 * Dry run:
 *   node --import tsx apps/functions/scripts/repair-rain-compensation-sentinel.ts
 *
 * Apply:
 *   node --import tsx apps/functions/scripts/repair-rain-compensation-sentinel.ts --apply
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { FieldPath, FieldValue, getFirestore } from "firebase-admin/firestore"

type Question = Record<string, unknown>

const apply = process.argv.includes("--apply")
const actor = "system:repair-rain-compensation-sentinel"

loadEnv()
initFirebase()

const db = getFirestore()

function loadEnv(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..")
  const envPath = join(root, ".env")
  if (!existsSync(envPath) || process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="))
  if (line) process.env.FIREBASE_SERVICE_ACCOUNT_JSON = line.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length)
}

function initFirebase(): void {
  if (getApps().length) return
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing")
  const serviceAccount = JSON.parse(raw) as { project_id?: string }
  initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
}

function isCompensationSentinel(data: Record<string, unknown>): boolean {
  const min = typeof data.salaryMin === "number" ? data.salaryMin : null
  const max = typeof data.salaryMax === "number" ? data.salaryMax : null
  const reveal = String(((data.prescreenConfig as Record<string, unknown> | undefined)?.level1Reveal as Record<string, unknown> | undefined)?.salaryRange ?? "")
  const direct = String(data.salaryRange ?? "")
  return (min !== null && max !== null && min <= 60_000 && max >= 900_000) || /999000|999k/i.test(`${reveal} ${direct}`)
}

function removeCompensationQuestion(questions: unknown): Question[] | undefined {
  if (!Array.isArray(questions)) return undefined
  return questions.filter((question) => {
    if (!question || typeof question !== "object") return true
    const q = question as Question
    return q.qId !== "compensation_alignment" && q.id !== "compensation_alignment"
  })
}

async function main(): Promise<void> {
  const now = new Date().toISOString()
  const snap = await db.collection("pa-jobs").where("companyId", "==", "rain-xyz").get()
  let repaired = 0
  for (const doc of snap.docs) {
    const data = doc.data()
    if (!isCompensationSentinel(data)) continue

    const questions = removeCompensationQuestion((data.prescreenConfig as Record<string, unknown> | undefined)?.questions)
    const paPatch: Record<string, unknown> = {
      salaryMin: FieldValue.delete(),
      salaryMax: FieldValue.delete(),
      salaryRange: FieldValue.delete(),
      "prescreenConfig.level1Reveal.salaryRange": FieldValue.delete(),
      "prescreenConfig.lastEditedBy": actor,
      "prescreenConfig.lastEditedAt": now,
      updatedAt: now,
    }
    if (questions) paPatch["prescreenConfig.questions"] = questions

    const matchingPatch: Record<string, unknown> = {
      salaryMin: FieldValue.delete(),
      salaryMax: FieldValue.delete(),
      salaryRange: FieldValue.delete(),
      updatedAt: now,
    }

    console.log(`${apply ? "repair" : "would repair"} ${doc.id}: remove compensation sentinel${questions ? `; questions ${questions.length}` : ""}`)
    if (apply) {
      await db.collection("pa-jobs").doc(doc.id).update(paPatch)
      await db.collection("pa-jobs").doc(doc.id).update(
        new FieldPath("prescreenConfig.lastEditedBy"),
        FieldValue.delete(),
        new FieldPath("prescreenConfig.lastEditedAt"),
        FieldValue.delete(),
        new FieldPath("prescreenConfig.questions"),
        FieldValue.delete(),
      )
      await db.collection("matching-jobs").doc(doc.id).set(matchingPatch, { merge: true })
    }
    repaired += 1
  }
  console.log(`${apply ? "DONE" : "DRY RUN"} repaired=${repaired}`)
}

main().catch((err) => {
  console.error("[repair-rain-compensation-sentinel] FAILED", err)
  process.exit(1)
})
