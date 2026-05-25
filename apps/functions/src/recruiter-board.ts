/**
 * Recruiter board HTTP Cloud Functions.
 *
 * Backs the `/recruiters` route on candidate.wekruit.com. Public, CORS-enabled.
 *
 *   GET  paCollabJobsList         -> sanitized list of WeKruit collab jobs
 *   POST paRecruiterSubmission    -> writes pa-recruiter-submissions doc
 *
 * Companion docs:
 *   .planning/INITIATIVE-recruiter-board.md
 */
import { onRequest } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore"
import { createHash, randomUUID } from "node:crypto"

// ─────────────────────────────────────────────────────────────────────────────
// Types — recruiterBoard payload (mirrored loosely; see INITIATIVE doc)
// ─────────────────────────────────────────────────────────────────────────────

export interface RecruiterBoardLabel {
  company: string
  companyCode: string
  location: string
  pills: { text: string; tone?: "warm" | "cool" | "neutral" }[]
}

export interface RecruiterBoardCulture {
  bet: string
  bullets: string[]
}

export interface RecruiterBoardChecklistItem {
  id: string
  text: string
}

export interface RecruiterBoardChecklistGroup {
  kind: "hard" | "fit" | "bonus" | "anti"
  heading: string
  items: RecruiterBoardChecklistItem[]
}

export interface RecruiterBoardChecklist {
  groups: RecruiterBoardChecklistGroup[]
}

export interface RecruiterBoardPayload {
  active: boolean
  sortOrder: number
  label: RecruiterBoardLabel
  culture: RecruiterBoardCulture
  checklist: RecruiterBoardChecklist
  interviewProcess?: string
}

export interface JdBlock {
  heading: string
  body: string
  kind?: "list" | "prose"
}

// What the public list endpoint returns. Stripped of real company identity.
export interface PublicCollabJob {
  jobId: string
  title: string
  compSummary?: string
  jdBlocks: JdBlock[]
  recruiterBoard: RecruiterBoardPayload
}

function setCors(res: { set: (k: string, v: string) => unknown }): void {
  res.set("Access-Control-Allow-Origin", "*")
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  res.set("Access-Control-Allow-Headers", "Content-Type")
  res.set("Access-Control-Max-Age", "3600")
}

// ─────────────────────────────────────────────────────────────────────────────
// paCollabJobsList — public GET
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchCollabJobs(db: Firestore): Promise<PublicCollabJob[]> {
  const snap = await db
    .collection("pa-jobs")
    .where("wekruitCollaborationStatus", "==", "collaborated")
    .get()
  const jobs: PublicCollabJob[] = []
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    const rb = d.recruiterBoard as RecruiterBoardPayload | undefined
    if (!rb || rb.active !== true) continue
    jobs.push({
      jobId: doc.id,
      title: String(d.title ?? ""),
      compSummary: typeof d.compSummary === "string" ? d.compSummary : undefined,
      jdBlocks: Array.isArray(d.jdBlocks) ? (d.jdBlocks as JdBlock[]) : [],
      recruiterBoard: rb,
    })
  }
  jobs.sort((a, b) => a.recruiterBoard.sortOrder - b.recruiterBoard.sortOrder)
  return jobs
}

export const paCollabJobsList = onRequest(
  { cors: false, region: "us-central1" },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    try {
      const jobs = await fetchCollabJobs(getFirestore())
      res.set("Cache-Control", "public, max-age=60, s-maxage=60")
      res.status(200).json({ ok: true, jobs })
    } catch (err) {
      logger.error("paCollabJobsList_failed", { error: String(err) })
      res.status(500).json({ ok: false, reason: "internal_error" })
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// paRecruiterSubmission — public POST
// ─────────────────────────────────────────────────────────────────────────────

interface SubmissionPayload {
  jobId: string
  submitter: { name: string; email: string; company?: string }
  candidate: {
    name: string
    link: string
    currentRole?: string
    yoe?: string
    notes?: string
  }
  checklist: { [itemId: string]: boolean }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0
}

function validateSubmission(input: unknown):
  | { ok: true; value: SubmissionPayload }
  | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_body" }
  const b = input as Record<string, unknown>
  if (!isNonEmptyString(b.jobId)) return { ok: false, reason: "missing_jobId" }
  if (b.jobId.length > 200) return { ok: false, reason: "jobId_too_long" }

  const s = b.submitter as Record<string, unknown> | undefined
  if (!s || typeof s !== "object") return { ok: false, reason: "missing_submitter" }
  if (!isNonEmptyString(s.name)) return { ok: false, reason: "missing_submitter_name" }
  if (!isNonEmptyString(s.email)) return { ok: false, reason: "missing_submitter_email" }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) return { ok: false, reason: "invalid_email" }
  if (s.name.length > 200 || s.email.length > 320) return { ok: false, reason: "submitter_too_long" }
  if (s.company !== undefined && (typeof s.company !== "string" || s.company.length > 200)) {
    return { ok: false, reason: "invalid_submitter_company" }
  }

  const c = b.candidate as Record<string, unknown> | undefined
  if (!c || typeof c !== "object") return { ok: false, reason: "missing_candidate" }
  if (!isNonEmptyString(c.name)) return { ok: false, reason: "missing_candidate_name" }
  if (!isNonEmptyString(c.link)) return { ok: false, reason: "missing_candidate_link" }
  if (c.name.length > 200) return { ok: false, reason: "candidate_name_too_long" }
  if (c.link.length > 2000) return { ok: false, reason: "candidate_link_too_long" }
  for (const k of ["currentRole", "yoe", "notes"] as const) {
    if (c[k] !== undefined && typeof c[k] !== "string") return { ok: false, reason: `invalid_${k}` }
    if (typeof c[k] === "string" && (c[k] as string).length > 4000) return { ok: false, reason: `${k}_too_long` }
  }

  const cl = b.checklist
  if (!cl || typeof cl !== "object") return { ok: false, reason: "missing_checklist" }
  const cleanedChecklist: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(cl as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length > 200) return { ok: false, reason: "invalid_checklist_key" }
    if (typeof v !== "boolean") return { ok: false, reason: "invalid_checklist_value" }
    cleanedChecklist[k] = v
  }

  return {
    ok: true,
    value: {
      jobId: b.jobId,
      submitter: {
        name: s.name.trim(),
        email: (s.email as string).trim().toLowerCase(),
        company: typeof s.company === "string" ? s.company.trim() : undefined,
      },
      candidate: {
        name: (c.name as string).trim(),
        link: (c.link as string).trim(),
        currentRole: typeof c.currentRole === "string" ? (c.currentRole as string).trim() : undefined,
        yoe: typeof c.yoe === "string" ? (c.yoe as string).trim() : undefined,
        notes: typeof c.notes === "string" ? (c.notes as string).trim() : undefined,
      },
      checklist: cleanedChecklist,
    },
  }
}

export interface SubmissionScore {
  hardChecked: number
  hardTotal: number
  fitChecked: number
  fitTotal: number
  bonusChecked: number
  bonusTotal: number
  antiChecked: number
  antiTotal: number
}

export function computeSubmissionScore(
  groups: RecruiterBoardChecklistGroup[],
  checklist: Record<string, boolean>,
): SubmissionScore {
  const score: SubmissionScore = {
    hardChecked: 0, hardTotal: 0,
    fitChecked: 0, fitTotal: 0,
    bonusChecked: 0, bonusTotal: 0,
    antiChecked: 0, antiTotal: 0,
  }
  for (const g of groups) {
    for (const item of g.items) {
      const checked = checklist[item.id] === true
      switch (g.kind) {
        case "hard":  score.hardTotal++;  if (checked) score.hardChecked++;  break
        case "fit":   score.fitTotal++;   if (checked) score.fitChecked++;   break
        case "bonus": score.bonusTotal++; if (checked) score.bonusChecked++; break
        case "anti":  score.antiTotal++;  if (checked) score.antiChecked++;  break
      }
    }
  }
  return score
}

export const paRecruiterSubmission = onRequest(
  { cors: false, region: "us-central1" },
  async (req, res) => {
    setCors(res)
    if (req.method === "OPTIONS") {
      res.status(204).send("")
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }

    const validated = validateSubmission(req.body)
    if (!validated.ok) {
      res.status(400).json({ ok: false, reason: validated.reason })
      return
    }
    const payload = validated.value

    const db = getFirestore()
    const jobRef = db.collection("pa-jobs").doc(payload.jobId)
    const jobSnap = await jobRef.get()
    if (!jobSnap.exists) {
      res.status(404).json({ ok: false, reason: "job_not_found" })
      return
    }
    const jobData = jobSnap.data() as Record<string, unknown>
    if (jobData.wekruitCollaborationStatus !== "collaborated") {
      res.status(403).json({ ok: false, reason: "job_not_collab" })
      return
    }
    const rb = jobData.recruiterBoard as RecruiterBoardPayload | undefined
    if (!rb || rb.active !== true) {
      res.status(403).json({ ok: false, reason: "job_not_active_on_board" })
      return
    }

    const score = computeSubmissionScore(rb.checklist.groups, payload.checklist)

    const submissionId = randomUUID()
    const ip = req.get("x-forwarded-for")?.split(",")[0]?.trim() || ""
    const submissionDoc = {
      submissionId,
      jobId: payload.jobId,
      jobTitleSnapshot: String(jobData.title ?? ""),
      companyLabelSnapshot: rb.label.company,
      submitter: payload.submitter,
      candidate: payload.candidate,
      checklist: payload.checklist,
      score,
      source: {
        userAgent: req.get("user-agent") ?? "",
        referrer: req.get("referer") ?? "",
        ipHash: ip ? createHash("sha256").update(ip).digest("hex").slice(0, 16) : "",
      },
      status: "new",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }

    try {
      await db.collection("pa-recruiter-submissions").doc(submissionId).set(submissionDoc)
    } catch (err) {
      logger.error("paRecruiterSubmission_write_failed", { error: String(err), submissionId })
      res.status(500).json({ ok: false, reason: "write_failed" })
      return
    }

    logger.info("paRecruiterSubmission_received", {
      submissionId,
      jobId: payload.jobId,
      submitterEmail: payload.submitter.email,
      hardScore: `${score.hardChecked}/${score.hardTotal}`,
    })

    res.status(200).json({
      ok: true,
      submissionId,
      score,
    })
  },
)
