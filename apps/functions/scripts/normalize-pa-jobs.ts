/**
 * One-shot normalize pa-jobs to a single canonical shape.
 *
 * Canonical top-level fields every job exposes:
 *   - title: string
 *   - companyId: string         (FK to pa-companies)
 *   - companyName: string       (denormalized for fast list rendering)
 *   - location: string          (free-text display)
 *   - descriptionMd: string     (markdown)
 *   - atsApplyUrl?: string
 *   - jobType?: string
 *   - salaryMin?, salaryMax?
 *   - publicVisible / wekruitCollaborationStatus / candidatePageStatus
 *
 * Matching-pipeline fields (roleFunction, seniorityLevel, industrySector,
 * locationBuckets, etc.) stay as-is; they're optional and downstream.
 *
 * `prescreenConfig` stays on jobs that have one — it controls SCREENING
 * behavior, not display. Display now reads only the top-level canonical
 * fields (Landing.tsx / PublicJob.tsx already updated).
 *
 * Pre-flight: also seed pa-companies/invoko + pa-companies/paradigm when
 * missing so the companyId → companyName resolver finds something.
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

interface JobDoc {
  // Existing varieties:
  title?: string
  company?: string
  companyId?: string
  companyName?: string
  location?: string
  rawLocation?: string
  descriptionMd?: string
  jdRaw?: string
  atsApplyUrl?: string
  jobType?: string
  salaryMin?: number | null
  salaryMax?: number | null
  prescreenConfig?: {
    jobTitle?: string
    company?: string
    jobType?: string
    region?: string
    level1Reveal?: { salaryRange?: string }
  }
}

const KNOWN_COMPANIES: Record<string, { companyId: string; name: string }> = {
  // Invoko jobs carry company="invoko.ai" string but no companyId.
  "invoko.ai": { companyId: "invoko", name: "invoko.ai" },
  invoko: { companyId: "invoko", name: "invoko.ai" },
  // Paradigm hs-* job has none — derive from id.
  paradigm: { companyId: "paradigm", name: "Paradigm" },
}

function inferCompanyFromJobId(id: string): { companyId: string; name: string } | null {
  // hs-<num>-<slug> — middle slug often encodes company.
  const m = /^hs-\d+-([a-z0-9]+)/i.exec(id)
  if (m) {
    const slug = m[1]!.toLowerCase()
    if (slug in KNOWN_COMPANIES) return KNOWN_COMPANIES[slug]!
    return { companyId: slug, name: slug.charAt(0).toUpperCase() + slug.slice(1) }
  }
  return null
}

async function ensureCompany(db: FirebaseFirestore.Firestore, info: { companyId: string; name: string }) {
  const ref = db.collection("pa-companies").doc(info.companyId)
  const snap = await ref.get()
  if (snap.exists) return
  await ref.set(
    {
      companyId: info.companyId,
      name: info.name,
      createdAt: new Date().toISOString(),
      seededBy: "normalize-pa-jobs",
    },
    { merge: true },
  )
  console.log(`[normalize] seeded pa-companies/${info.companyId} name="${info.name}"`)
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dryRun")
  if (!getApps().length) initializeApp({ credential: applicationDefault() })
  const db = getFirestore()
  const snap = await db.collection("pa-jobs").get()
  console.log(`[normalize] scanning ${snap.size} pa-jobs${dryRun ? " — DRY RUN" : ""}`)

  interface Op {
    id: string
    patch: Record<string, unknown>
    summary: string
  }
  const ops: Op[] = []
  const companiesToEnsure = new Map<string, { companyId: string; name: string }>()

  for (const d of snap.docs) {
    const data = d.data() as JobDoc
    const id = d.id

    // Resolve canonical companyId + name.
    let companyId: string | undefined = data.companyId
    let companyName: string | undefined = data.companyName ?? data.company
    if (!companyId) {
      // Try the legacy `company` field, then jobId inference.
      const fromKnown = data.company
        ? KNOWN_COMPANIES[(data.company ?? "").toLowerCase()]
        : null
      const inferred = fromKnown ?? inferCompanyFromJobId(id)
      if (inferred) {
        companyId = inferred.companyId
        companyName = companyName ?? inferred.name
      }
    }
    if (!companyName && companyId) {
      // Best-effort: fetch from pa-companies.
      const cs = await db.collection("pa-companies").doc(companyId).get()
      if (cs.exists) companyName = (cs.data() as { name?: string }).name
    }
    if (companyId && companyName) {
      companiesToEnsure.set(companyId, { companyId, name: companyName })
    }

    // Title — top-level, fall back to prescreenConfig.jobTitle.
    const title = data.title ?? data.prescreenConfig?.jobTitle

    // Location — prefer location, then rawLocation, then prescreenConfig.region.
    const location = data.location ?? data.rawLocation ?? data.prescreenConfig?.region

    // Description — top-level, fall back to jdRaw.
    const descriptionMd = data.descriptionMd ?? data.jdRaw

    // jobType + salary already canonical when present; only fill from prescreenConfig.
    const jobType = data.jobType ?? data.prescreenConfig?.jobType

    const patch: Record<string, unknown> = {}
    const changes: string[] = []
    if (companyId && data.companyId !== companyId) {
      patch.companyId = companyId
      changes.push(`companyId=${companyId}`)
    }
    if (companyName && data.companyName !== companyName) {
      patch.companyName = companyName
      changes.push(`companyName="${companyName}"`)
    }
    if (title && data.title !== title) {
      patch.title = title
      changes.push("title")
    }
    if (location && data.location !== location) {
      patch.location = location
      changes.push("location")
    }
    if (descriptionMd && data.descriptionMd !== descriptionMd) {
      patch.descriptionMd = descriptionMd
      changes.push("descriptionMd")
    }
    if (jobType && data.jobType !== jobType) {
      patch.jobType = jobType
      changes.push("jobType")
    }
    if (changes.length === 0) continue
    ops.push({ id, patch, summary: changes.join(", ") })
  }

  console.log(`[normalize] companies to ensure: ${companiesToEnsure.size}`)
  for (const c of companiesToEnsure.values()) console.log(`  ${c.companyId}: "${c.name}"`)

  console.log(`[normalize] would patch ${ops.length} jobs`)
  for (const op of ops.slice(0, 10)) console.log(`  ${op.id}: ${op.summary}`)
  if (dryRun) {
    process.exit(0)
  }

  for (const c of companiesToEnsure.values()) {
    await ensureCompany(db, c)
  }

  for (let i = 0; i < ops.length; i += 400) {
    const slice = ops.slice(i, i + 400)
    const batch = db.batch()
    for (const op of slice) {
      const ref = db.collection("pa-jobs").doc(op.id)
      batch.set(ref, op.patch, { merge: true })
    }
    await batch.commit()
    console.log(`[normalize] wrote ${i + 1}..${i + slice.length}`)
  }
  console.log(`[normalize] DONE — patched ${ops.length}`)
  process.exit(0)
}

main().catch((err) => {
  console.error("[normalize] FAILED:", err)
  process.exit(1)
})
