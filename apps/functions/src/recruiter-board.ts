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
import { getAuth } from "firebase-admin/auth"
import { createHash, randomUUID } from "node:crypto"
import { appendSubmissionToSheet } from "./recruiter-board-sheet.js"

// Optional environment variable. When set and the runtime SA has Editor access
// on the sheet, each submission is appended to a per-jobId tab. If unset, the
// Firestore write still happens and sheet sync is skipped.
const RECRUITER_BOARD_SHEET_ID_ENV = "RECRUITER_BOARD_SHEET_ID"

// ─────────────────────────────────────────────────────────────────────────────
// Hiring-board admin gating
//
// Anonymous visitors of https://wekruit.github.io/hiring-board/ must NEVER
// see the real company name on a collab job. Authenticated `@wekruit.com`
// staff get the full payload (real company, real Firestore doc id) so they
// can perform admin operations from the same surface.
// ─────────────────────────────────────────────────────────────────────────────

const HIRING_BOARD_ADMIN_EMAIL_DOMAIN = "@wekruit.com"

/**
 * Verifies a Bearer Firebase ID token and returns true when the caller's
 * email ends with `@wekruit.com`. Any missing/malformed/expired/invalid
 * token returns false (we never throw — anonymous viewing is allowed, just
 * with the anonymized payload).
 *
 * `verifyIdToken` is dependency-injected so unit tests can run without
 * Firebase Auth wired up.
 */
export async function isHiringBoardAdmin(
  req: { headers: { authorization?: string } },
  verifyIdToken?: (token: string) => Promise<{ email?: string }>,
): Promise<boolean> {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith("Bearer ")) return false
  const token = auth.slice("Bearer ".length).trim()
  if (!token) return false
  const verify =
    verifyIdToken ??
    (async (t: string) => {
      const decoded = await getAuth().verifyIdToken(t)
      return { email: decoded.email }
    })
  try {
    const decoded = await verify(token)
    return (decoded.email ?? "").toLowerCase().endsWith(HIRING_BOARD_ADMIN_EMAIL_DOMAIN)
  } catch {
    return false
  }
}

/**
 * Maps a hiring-board public-facing `jobId` (which is the opaque
 * `publicId` for anonymous viewers) back to the real Firestore doc id.
 *
 * Accepts both:
 *   - A real Firestore doc id (admin path, or legacy bookmark) — returned
 *     as-is when the doc exists.
 *   - A `publicId` UUID — resolved via `where("publicId", "==", X)`.
 *
 * Returns null when neither resolves to a collab job.
 */
export async function resolvePublicIdToDocId(
  db: Firestore,
  jobId: string,
): Promise<string | null> {
  // Try direct doc id first — cheap, common admin path.
  const directSnap = await db.collection("pa-jobs").doc(jobId).get()
  if (directSnap.exists) return directSnap.id

  // Fall back to publicId lookup for anonymized URLs.
  const query = await db
    .collection("pa-jobs")
    .where("publicId", "==", jobId)
    .limit(1)
    .get()
  if (query.empty) return null
  return query.docs[0]!.id
}

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

// What the public list endpoint returns. For non-admins the `jobId` is the
// opaque `publicId` and `recruiterBoard.label.company` is anonymized (e.g.
// `"Co. A · early-stage AI infra startup"`). Admins see the real doc id and
// full payload.
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
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization")
  res.set("Access-Control-Max-Age", "3600")
}

// ─────────────────────────────────────────────────────────────────────────────
// paCollabJobsList — public GET (+ admin-elevated view via Bearer token)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strips the real company name from a recruiter-board label when the
 * caller is not a hiring-board admin. The anonymized form is expected to
 * be of the shape `"Co. X · <description>"`; if upstream content already
 * contains a real name we fall back to `"Co. <companyCode>"` so we never
 * leak identity even on a malformed doc.
 */
function anonymizeCompanyLabel(
  label: RecruiterBoardLabel,
): RecruiterBoardLabel {
  const raw = label.company ?? ""
  // Already in the expected `"Co. A · ..."` shape — pass through.
  if (/^Co\.\s/.test(raw)) {
    return label
  }
  const code = (label.companyCode ?? "X").trim() || "X"
  return {
    ...label,
    company: `Co. ${code}`,
  }
}

export async function fetchCollabJobs(
  db: Firestore,
  options: { isAdmin: boolean } = { isAdmin: false },
): Promise<PublicCollabJob[]> {
  const snap = await db
    .collection("pa-jobs")
    .where("wekruitCollaborationStatus", "==", "collaborated")
    .get()
  const jobs: PublicCollabJob[] = []
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    const rb = d.recruiterBoard as RecruiterBoardPayload | undefined
    if (!rb || rb.active !== true) continue

    const publicId = typeof d.publicId === "string" ? d.publicId : undefined
    // Admin path: keep real Firestore doc id so admin operations resolve
    // against the same id used elsewhere in the dashboard. Non-admin: use
    // the opaque publicId; fall back to doc id only if the migration
    // hasn't run yet on this doc.
    const jobIdForCaller = options.isAdmin
      ? doc.id
      : (publicId ?? doc.id)

    const recruiterBoardForCaller: RecruiterBoardPayload = options.isAdmin
      ? rb
      : { ...rb, label: anonymizeCompanyLabel(rb.label) }

    jobs.push({
      jobId: jobIdForCaller,
      title: String(d.title ?? ""),
      compSummary: typeof d.compSummary === "string" ? d.compSummary : undefined,
      jdBlocks: Array.isArray(d.jdBlocks) ? (d.jdBlocks as JdBlock[]) : [],
      recruiterBoard: recruiterBoardForCaller,
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
      const isAdmin = await isHiringBoardAdmin(req)
      const jobs = await fetchCollabJobs(getFirestore(), { isAdmin })
      // Admin payloads contain real company identity — never cache on a
      // shared/CDN layer. Anonymous payloads are safe to cache (60s).
      if (isAdmin) {
        res.set("Cache-Control", "private, max-age=0, no-store")
      } else {
        res.set("Cache-Control", "public, max-age=60, s-maxage=60")
      }
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
    // Frontend may send either the real Firestore doc id (admin path) or
    // an opaque `publicId` UUID (anonymous hiring-board path). Resolve to
    // the real doc id so every downstream reference is consistent.
    const realJobId = await resolvePublicIdToDocId(db, payload.jobId)
    if (!realJobId) {
      res.status(404).json({ ok: false, reason: "job_not_found" })
      return
    }
    const jobRef = db.collection("pa-jobs").doc(realJobId)
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
      // Canonical Firestore doc id (what admin tooling expects). When the
      // caller used the public/anonymized id, `inboundJobId` preserves the
      // original lineage for audit.
      jobId: realJobId,
      inboundJobId: payload.jobId,
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
      jobId: realJobId,
      submitterEmail: payload.submitter.email,
      hardScore: `${score.hardChecked}/${score.hardTotal}`,
    })

    // Best-effort Sheet sync. Failure does not block the 200 — the Firestore
    // write is the source of truth and the doc keeps an error breadcrumb so
    // a retry job can pick it up later.
    const sheetId = (process.env[RECRUITER_BOARD_SHEET_ID_ENV] ?? "").trim()
    if (sheetId) {
      const sheetResult = await appendSubmissionToSheet(sheetId, {
        submissionId,
        jobId: realJobId,
        companyLabel: rb.label.company,
        submitter: payload.submitter,
        candidate: payload.candidate,
        checklist: payload.checklist,
        score,
        jobChecklistGroups: rb.checklist.groups,
        jobTitle: String(jobData.title ?? ""),
      })
      try {
        if (sheetResult.ok) {
          await db.collection("pa-recruiter-submissions").doc(submissionId).update({
            sheetSyncedAt: FieldValue.serverTimestamp(),
            sheetRowId: sheetResult.rowId,
          })
        } else {
          await db.collection("pa-recruiter-submissions").doc(submissionId).update({
            sheetSyncError: sheetResult.reason.slice(0, 500),
          })
        }
      } catch (err) {
        logger.error("paRecruiterSubmission_sheet_update_failed", {
          error: String(err),
          submissionId,
        })
      }
    }

    res.status(200).json({
      ok: true,
      submissionId,
      score,
    })
  },
)
