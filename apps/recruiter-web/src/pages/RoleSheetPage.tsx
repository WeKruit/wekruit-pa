/**
 * Role sheet — /recruiters/job/:jobId
 *
 * The whole page is one spreadsheet-style table: every submission the
 * signed-in recruiter made for this role is a row, the last row is always a
 * blank add row, and each checklist item / per-role submit field is a column.
 * JD lives in a collapsed section above the sheet; a comment thread opens in a
 * right side drawer per row.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import "../styles/recruiter-board.css"
import "../styles/role-sheet.css"
import {
  addRecruiterSubmissionComment,
  fetchCollabJobs,
  fetchRecruiterSubmissionComments,
  fetchRecruiterSubmissions,
  RecruiterApiError,
  submitRecruiterCandidate,
  updateRecruiterSubmission,
  uploadResumeFile,
  validateResumeFile,
  type CollabJob,
  type RecruiterSubmissionComment,
  type RecruiterSubmissionItem,
  type RecruiterSubmitField,
  type SubmissionCandidateCells,
  type SubmissionChecklistValue,
} from "../lib/recruiter-board-api.js"
import { trackEvent } from "../lib/analytics.js"
import { useRecruiterSession } from "../lib/recruiter-session-context.js"
import { RecruiterShell } from "../components/RecruiterShell.js"
import { buildSubmissionStatusStepper, SubmissionStatusStepper } from "../components/SubmissionStatusStepper.js"

const SHEET_DRAFT_KEY_PREFIX = "rs-draft-v1:"

// Rows stay editable while WeKruit still owns them; from client_review on the
// row locks and renders as plain text.
const EDITABLE_STATUSES = new Set(["submitted", "new", "reviewing", "wekruit_interview"])

type SheetCellId =
  | "name"
  | "email"
  | "linkedin"
  | "resume"
  | "currentCompany"
  | "currentTitle"
  | "location"
  | "yoe"
  | "workAuthorization"
  | "employmentStatus"
  | "compensationExpectation"
  | "noticePeriod"
  | "interviewAvailability"

type SheetColumn = {
  id: SheetCellId
  label: string
  required?: boolean
  // key columns stay visible when rows degrade to cards on small screens
  key?: boolean
}

const CANDIDATE_COLUMNS: SheetColumn[] = [
  { id: "name", label: "Candidate name", required: true, key: true },
  { id: "email", label: "Email", required: true },
  { id: "linkedin", label: "LinkedIn", required: true },
  { id: "resume", label: "Resume", required: true },
  { id: "currentCompany", label: "Current company", key: true },
  { id: "currentTitle", label: "Current title", key: true },
  { id: "location", label: "Location", key: true },
  { id: "yoe", label: "Years of exp" },
  { id: "workAuthorization", label: "Work auth" },
  { id: "employmentStatus", label: "Employment status" },
  { id: "compensationExpectation", label: "Comp expectation" },
  { id: "noticePeriod", label: "Notice period" },
  { id: "interviewAvailability", label: "Availability" },
]

type ChecklistKind = CollabJob["recruiterBoard"]["checklist"]["groups"][number]["kind"]

const CHECKLIST_KIND_ORDER: ChecklistKind[] = ["hard", "fit", "bonus", "anti"]

const CHECKLIST_KIND_CHIP: Record<ChecklistKind, string> = {
  hard: "Hard",
  fit: "Fit",
  bonus: "Bonus",
  anti: "Anti",
}

const CHECKLIST_LEGEND_LABEL: Record<ChecklistKind, string> = {
  hard: "Hard filters",
  fit: "Strong fit",
  bonus: "Bonus",
  anti: "Anti-signals",
}

const CHECKLIST_VALUE_OPTIONS: Array<{ value: "" | SubmissionChecklistValue; label: string }> = [
  { value: "", label: "—" },
  { value: "strong", label: "Strong" },
  { value: "yes", label: "Yes" },
  { value: "partial", label: "Partial" },
  { value: "no", label: "No" },
]

type ChecklistColumn = { id: string; text: string; kind: ChecklistKind }

type SheetCells = Record<SheetCellId, string>

type RowDraft = {
  cells: SheetCells
  notes: string
  checklist: Record<string, "" | SubmissionChecklistValue>
  extraFields: Record<string, string>
  resumeFileName?: string
}

type AddRowDraft = RowDraft

function emptyCells(): SheetCells {
  return {
    name: "",
    email: "",
    linkedin: "",
    resume: "",
    currentCompany: "",
    currentTitle: "",
    location: "",
    yoe: "",
    workAuthorization: "",
    employmentStatus: "",
    compensationExpectation: "",
    noticePeriod: "",
    interviewAvailability: "",
  }
}

function emptyAddRowDraft(): AddRowDraft {
  return { cells: emptyCells(), notes: "", checklist: {}, extraFields: {} }
}

function loadAddRowDraft(jobId: string): AddRowDraft {
  try {
    const raw = localStorage.getItem(SHEET_DRAFT_KEY_PREFIX + jobId)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AddRowDraft>
      return {
        ...emptyAddRowDraft(),
        ...parsed,
        cells: { ...emptyCells(), ...(parsed.cells ?? {}) },
        checklist: parsed.checklist ?? {},
        extraFields: parsed.extraFields ?? {},
      }
    }
  } catch {
    // ignore — a broken draft just starts blank
  }
  return emptyAddRowDraft()
}

function saveAddRowDraft(jobId: string, draft: AddRowDraft): void {
  try {
    localStorage.setItem(SHEET_DRAFT_KEY_PREFIX + jobId, JSON.stringify(draft))
  } catch {
    // ignore
  }
}

function clearAddRowDraft(jobId: string): void {
  try {
    localStorage.removeItem(SHEET_DRAFT_KEY_PREFIX + jobId)
  } catch {
    // ignore
  }
}

function looksLikeLinkedinUrl(value: string): boolean {
  return value.toLowerCase().includes("linkedin.")
}

function normalizeSheetUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(withScheme)
    return parsed.hostname.includes(".") ? withScheme : null
  } catch {
    return null
  }
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function excerpt(text: string, max = 90): string {
  const clean = text.trim().replace(/\s+/g, " ")
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function timestampMs(raw: unknown): number {
  if (!raw) return 0
  if (typeof raw === "string") return Date.parse(raw) || 0
  if (typeof raw === "object" && typeof (raw as { seconds?: unknown }).seconds === "number") {
    return (raw as { seconds: number }).seconds * 1000
  }
  return 0
}

function submissionApiId(row: RecruiterSubmissionItem): string {
  return row.submissionId || row.id
}

function rowIsEditable(row: RecruiterSubmissionItem): boolean {
  return EDITABLE_STATUSES.has(row.status || "submitted")
}

function cellsFromSubmission(row: RecruiterSubmissionItem): SheetCells {
  const c: SubmissionCandidateCells = row.candidate ?? {}
  const link = (c.link ?? "").trim()
  const linkIsLinkedin = looksLikeLinkedinUrl(link)
  const linkedin = (c.linkedinUrl ?? "").trim() || (linkIsLinkedin ? link : "")
  const resume = (c.resumeUrl ?? "").trim() || (linkIsLinkedin ? "" : link)
  return {
    name: c.name ?? "",
    email: c.email ?? "",
    linkedin,
    resume,
    currentCompany: c.currentCompany ?? "",
    currentTitle: c.currentRole ?? "",
    location: c.location ?? "",
    yoe: c.yoe ?? "",
    workAuthorization: c.workAuthorization ?? "",
    employmentStatus: c.employmentStatus ?? "",
    compensationExpectation: c.compensationExpectation ?? "",
    noticePeriod: c.noticePeriod ?? "",
    interviewAvailability: c.interviewAvailability ?? "",
  }
}

function checklistFromSubmission(row: RecruiterSubmissionItem): Record<string, "" | SubmissionChecklistValue> {
  const out: Record<string, "" | SubmissionChecklistValue> = {}
  for (const [itemId, value] of Object.entries(row.checklist ?? {})) {
    if (value === true) out[itemId] = "yes"
    else if (value === "strong" || value === "yes" || value === "partial" || value === "no") out[itemId] = value
  }
  return out
}

function draftFromSubmission(row: RecruiterSubmissionItem): RowDraft {
  return {
    cells: cellsFromSubmission(row),
    notes: row.candidate?.notes ?? "",
    checklist: checklistFromSubmission(row),
    extraFields: { ...(row.extraFields ?? {}) },
  }
}

function candidatePayload(draft: RowDraft): SubmissionCandidateCells & { name: string; email: string; link: string } {
  const linkedin = normalizeSheetUrl(draft.cells.linkedin) ?? draft.cells.linkedin.trim()
  const resume = normalizeSheetUrl(draft.cells.resume) ?? draft.cells.resume.trim()
  return {
    name: draft.cells.name.trim(),
    email: draft.cells.email.trim(),
    link: linkedin || resume,
    currentRole: draft.cells.currentTitle.trim(),
    yoe: draft.cells.yoe.trim(),
    notes: draft.notes.trim(),
    currentCompany: draft.cells.currentCompany.trim(),
    location: draft.cells.location.trim(),
    workAuthorization: draft.cells.workAuthorization.trim(),
    employmentStatus: draft.cells.employmentStatus.trim(),
    compensationExpectation: draft.cells.compensationExpectation.trim(),
    noticePeriod: draft.cells.noticePeriod.trim(),
    interviewAvailability: draft.cells.interviewAvailability.trim(),
  }
}

function checklistPayload(draft: RowDraft): Record<string, SubmissionChecklistValue> {
  const out: Record<string, SubmissionChecklistValue> = {}
  for (const [itemId, value] of Object.entries(draft.checklist)) {
    if (value) out[itemId] = value
  }
  return out
}

function extraFieldsPayload(draft: RowDraft, fields: RecruiterSubmitField[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of fields) {
    const value = (draft.extraFields[field.id] ?? "").trim().slice(0, 500)
    if (value) out[field.id] = value
  }
  return out
}

function checklistShortLabel(text: string): string {
  const words = text.trim().split(/\s+/)
  const head = words.slice(0, 4).join(" ")
  return words.length > 4 ? `${head}…` : head
}

function orderedChecklistColumns(job: CollabJob): ChecklistColumn[] {
  const groups = [...job.recruiterBoard.checklist.groups].sort(
    (a, b) => CHECKLIST_KIND_ORDER.indexOf(a.kind) - CHECKLIST_KIND_ORDER.indexOf(b.kind),
  )
  return groups.flatMap((group) => group.items.map((item) => ({ id: item.id, text: item.text, kind: group.kind })))
}

function roleSubmitFields(job: CollabJob): RecruiterSubmitField[] {
  return job.recruiterBoard.submitFields ?? []
}

// Compact read-only stage label for the Status column, derived from the pinned
// 4-step model (Submitted → WeKruit interview → With client → Outcome).
function sheetStageLabel(row: RecruiterSubmissionItem): string {
  const model = buildSubmissionStatusStepper(row.status, row.requestedInfo)
  const base = model.terminal ? model.outcome.label : model.steps[model.currentStep]?.label ?? "Submitted"
  return model.needsInfo ? `${base} · needs info` : base
}

// Feedback column: latest WeKruit comment when the thread is loaded, otherwise
// the latest requested-info message or stored WeKruit note; em-dash when none.
function sheetFeedbackText(row: RecruiterSubmissionItem, comments?: RecruiterSubmissionComment[]): string {
  const latestWekruit = [...(comments ?? [])].reverse().find((c) => c.by === "wekruit" && c.message.trim())
  if (latestWekruit) return excerpt(latestWekruit.message)
  const requested = (row.requestedInfo ?? []).map((entry) => entry?.message).filter((m): m is string => Boolean(m && m.trim()))
  if (requested.length) return excerpt(requested[requested.length - 1])
  if (row.recruiterFeedbackNote?.trim()) return excerpt(row.recruiterFeedbackNote)
  return "—"
}

function addRowBlockers(draft: AddRowDraft, fields: RecruiterSubmitField[]): string[] {
  const blockers: string[] = []
  if (!draft.cells.name.trim()) blockers.push("Candidate name is required.")
  const email = draft.cells.email.trim()
  if (!email) blockers.push("Candidate email is required.")
  else if (!isValidEmail(email)) blockers.push("Candidate email looks invalid.")
  const linkedin = draft.cells.linkedin.trim()
  const resume = draft.cells.resume.trim()
  if (!linkedin) blockers.push("LinkedIn URL is required.")
  else if (!normalizeSheetUrl(linkedin)) blockers.push("LinkedIn URL must be a valid URL.")
  if (!resume) blockers.push("Resume is required — paste a link or drop a file.")
  else if (!normalizeSheetUrl(resume) && !draft.resumeFileName) blockers.push("Resume must be a valid URL or an uploaded file.")
  for (const field of fields) {
    const value = (draft.extraFields[field.id] ?? "").trim()
    if (field.required && !value) blockers.push(`${field.label} is required for this role.`)
    else if (value && field.kind === "url" && !normalizeSheetUrl(value)) blockers.push(`${field.label} must be a link.`)
  }
  return blockers
}

function formatSubmitFailure(reason?: string): string {
  if (reason === "candidate_already_submitted_for_role") {
    return "This candidate is already submitted for this role — edit their existing row instead."
  }
  if (reason === "candidate_already_sourced_for_role") {
    return "Another recruiter already has this candidate in motion for this role."
  }
  if (reason === "missing_candidate_email") return "Add the candidate email."
  if (reason === "invalid_candidate_email") return "Enter a valid candidate email."
  if (reason === "recruiter_auth_required") return "Your session expired — sign in again from the recruiter home."
  return reason ?? "submission_failed"
}

function renderJdBody(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let listBuffer: string[] = []
  let key = 0
  const flushList = () => {
    if (listBuffer.length) {
      out.push(
        <ul key={key++}>
          {listBuffer.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>,
      )
      listBuffer = []
    }
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/\*\*([^*]+)\*\*/g, "$1")
    if (line.startsWith("- ")) listBuffer.push(line.slice(2))
    else if (line === "") flushList()
    else {
      flushList()
      out.push(<p key={key++}>{line}</p>)
    }
  }
  flushList()
  return out
}

function ResumeCell({
  value,
  fileName,
  editable,
  jobId,
  onChange,
}: {
  value: string
  fileName?: string
  editable: boolean
  jobId: string
  onChange: (url: string, fileName?: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const handleFile = async (file: File) => {
    const err = validateResumeFile(file)
    if (err) { setUploadError(err); return }
    setUploading(true)
    setUploadError(null)
    try {
      const url = await uploadResumeFile(file, jobId)
      onChange(url, file.name)
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed.")
    } finally {
      setUploading(false)
    }
  }

  if (!editable) {
    if (value) {
      const href = normalizeSheetUrl(value)
      if (href) {
        return (
          <a className="rs-link-cell" href={href} target="_blank" rel="noopener noreferrer">
            {fileName || excerpt(value, 40)}
          </a>
        )
      }
    }
    return <>{value || "—"}</>
  }

  return (
    <div
      className={`rs-resume-cell${dragOver ? " rs-resume-drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const file = e.dataTransfer.files[0]
        if (file) void handleFile(file)
      }}
    >
      {uploading ? (
        <span className="rs-resume-uploading">Uploading…</span>
      ) : fileName ? (
        <span className="rs-resume-file">
          {fileName}
          <button type="button" className="rs-resume-clear" onClick={() => onChange("", undefined)} title="Remove">×</button>
        </span>
      ) : (
        <>
          <input
            type="text"
            aria-label="Resume URL"
            placeholder="Paste link or drop file"
            value={value}
            onChange={(e) => onChange(e.target.value, undefined)}
          />
          <button type="button" className="rs-resume-pick" onClick={() => fileRef.current?.click()} title="Upload file">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 1v10M4 5l4-4 4 4M2 12v2h12v-2"/>
            </svg>
          </button>
        </>
      )}
      {uploadError && <span className="rs-resume-err">{uploadError}</span>}
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.doc,.docx"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleFile(file)
          e.target.value = ""
        }}
      />
    </div>
  )
}

export default function RoleSheetPage() {
  const { jobId } = useParams<{ jobId: string }>()
  const { session, authReady, setSession } = useRecruiterSession()
  const [jobs, setJobs] = useState<CollabJob[] | null>(null)
  const [submissions, setSubmissions] = useState<RecruiterSubmissionItem[]>([])
  const [error, setError] = useState<string | null>(null)

  const [rowDrafts, setRowDrafts] = useState<Record<string, RowDraft>>({})
  const [savingRowId, setSavingRowId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  const [addDraft, setAddDraft] = useState<AddRowDraft>(() =>
    jobId ? loadAddRowDraft(jobId) : emptyAddRowDraft(),
  )
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  // Inline detail panel (click a candidate) + inline add panel (+ Add candidate)
  // — both keep everything on one page, no separate route.
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const [threadRowId, setThreadRowId] = useState<string | null>(null)
  const [commentsByRow, setCommentsByRow] = useState<Record<string, RecruiterSubmissionComment[]>>({})
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState("")
  const [commentSending, setCommentSending] = useState(false)

  useEffect(() => {
    fetchCollabJobs()
      .then((list) => setJobs(list))
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])

  useEffect(() => {
    if (!session) return
    let active = true
    fetchRecruiterSubmissions()
      .then((rows) => {
        if (active) setSubmissions(rows)
      })
      .catch(() => {
        // sheet still renders with the add row; per-row data shows up on retry
      })
    return () => {
      active = false
    }
  }, [session?.recruiterId])

  // Blank add row drafts persist per job so a half-filled candidate survives
  // a reload. Reload the draft if the route moves to another role.
  useEffect(() => {
    if (jobId) setAddDraft(loadAddRowDraft(jobId))
  }, [jobId])

  useEffect(() => {
    if (jobId) void trackEvent("role_sheet_viewed", { job_id: jobId })
  }, [jobId])

  const changeAddDraft = (next: AddRowDraft) => {
    setAddDraft(next)
    if (jobId) saveAddRowDraft(jobId, next)
  }

  const job = useMemo(() => jobs?.find((j) => j.jobId === jobId) ?? null, [jobs, jobId])

  const roleSubmissions = useMemo(() => {
    if (!job) return []
    return submissions
      .filter((row) => row.inboundJobId === job.jobId || row.jobId === job.jobId)
      .sort((a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt))
  }, [job, submissions])

  const checklistColumns = useMemo(() => (job ? orderedChecklistColumns(job) : []), [job])
  const extraFieldDefs = useMemo(() => (job ? roleSubmitFields(job) : []), [job])

  const showToast = (message: string) => {
    setToast(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4200)
  }

  const editRow = (row: RecruiterSubmissionItem, mutate: (draft: RowDraft) => RowDraft) => {
    setRowDrafts((drafts) => {
      const current = drafts[row.id] ?? draftFromSubmission(row)
      return { ...drafts, [row.id]: mutate(current) }
    })
  }

  const refreshSubmissions = async () => {
    try {
      const rows = await fetchRecruiterSubmissions()
      setSubmissions(rows)
    } catch {
      // keep the stale rows rather than blanking the sheet
    }
  }

  const saveRow = async (row: RecruiterSubmissionItem) => {
    const draft = rowDrafts[row.id]
    if (!draft || savingRowId) return
    setSavingRowId(row.id)
    try {
      const updated = await updateRecruiterSubmission({
        submissionId: submissionApiId(row),
        candidate: candidatePayload(draft),
        checklist: checklistPayload(draft),
        extraFields: extraFieldsPayload(draft, extraFieldDefs),
      })
      setSubmissions((rows) => rows.map((r) => (r.id === row.id ? { ...r, ...updated, id: r.id } : r)))
      setRowDrafts((drafts) => {
        const { [row.id]: _dropped, ...rest } = drafts
        return rest
      })
      showToast("Row saved.")
    } catch (e) {
      if (e instanceof RecruiterApiError && e.status === 409) {
        showToast("Row locked — candidate is with the client")
        setRowDrafts((drafts) => {
          const { [row.id]: _dropped, ...rest } = drafts
          return rest
        })
        void refreshSubmissions()
      } else {
        showToast(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    } finally {
      setSavingRowId(null)
    }
  }

  const addBlockers = useMemo(() => addRowBlockers(addDraft, extraFieldDefs), [addDraft, extraFieldDefs])
  const addRowReady = addBlockers.length === 0

  const submitAddRow = async () => {
    if (!job || !jobId || !session || !addRowReady || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const linkedin = normalizeSheetUrl(addDraft.cells.linkedin)
      const resume = normalizeSheetUrl(addDraft.cells.resume)
      const result = await submitRecruiterCandidate({
        jobId: job.jobId,
        submitter: { name: session.recruiter.name, email: session.recruiter.email },
        candidate: candidatePayload(addDraft),
        checklist: checklistPayload(addDraft),
        candidateLinkedinUrl: linkedin ?? undefined,
        candidateResumeUrl: resume ?? undefined,
        extraFields: extraFieldsPayload(addDraft, extraFieldDefs),
      })
      if (!result.ok) {
        // failure keeps every typed value in the blank row
        setSubmitError(formatSubmitFailure(result.reason))
        return
      }
      void trackEvent("submission_created", { job_id: job.jobId })
      await refreshSubmissions()
      setAddDraft(emptyAddRowDraft())
      clearAddRowDraft(jobId)
      setAddOpen(false)
      showToast("Candidate submitted.")
    } catch (e) {
      setSubmitError(formatSubmitFailure(e instanceof Error ? e.message : String(e)))
    } finally {
      setSubmitting(false)
    }
  }

  const threadRow = useMemo(
    () => roleSubmissions.find((row) => row.id === threadRowId) ?? null,
    [roleSubmissions, threadRowId],
  )

  const loadComments = async (row: RecruiterSubmissionItem) => {
    setCommentsLoading(true)
    setCommentsError(null)
    try {
      const comments = await fetchRecruiterSubmissionComments(submissionApiId(row))
      setCommentsByRow((cache) => ({ ...cache, [row.id]: comments }))
    } catch (e) {
      setCommentsError(e instanceof Error ? e.message : String(e))
    } finally {
      setCommentsLoading(false)
    }
  }

  const openThread = (row: RecruiterSubmissionItem) => {
    setThreadRowId(row.id)
    setCommentDraft("")
    setCommentsError(null)
    void loadComments(row)
  }

  const sendComment = async () => {
    if (!threadRow || !commentDraft.trim() || commentSending) return
    setCommentSending(true)
    setCommentsError(null)
    try {
      await addRecruiterSubmissionComment({
        submissionId: submissionApiId(threadRow),
        message: commentDraft.trim(),
      })
      setCommentDraft("")
      await loadComments(threadRow)
    } catch (e) {
      setCommentsError(e instanceof Error ? e.message : String(e))
    } finally {
      setCommentSending(false)
    }
  }

  if (error) return <RecruiterShell><div className="rs-state error">Could not load: {error}</div></RecruiterShell>
  if (!authReady) return <RecruiterShell><div className="rs-state">Loading recruiter account…</div></RecruiterShell>
  if (!jobs) return <RecruiterShell><div className="rs-state">Loading…</div></RecruiterShell>
  if (!job) {
    return (
      <RecruiterShell>
        <div className="rs-state error">This role is not on the board anymore.</div>
      </RecruiterShell>
    )
  }

  const label = job.recruiterBoard.label

  const selectedRow = roleSubmissions.find((row) => row.id === selectedRowId) ?? null

  return (
    <RecruiterShell openRolesCount={jobs.length} submissionsCount={submissions.length}>
      <main className={`rs-shell2${selectedRow ? " has-detail" : ""}`}>
        {/* LEFT — role brief: title, comp, the rubric WeKruit screens for, full JD */}
        <aside className="rs-brief">
          <Link to="/recruiters/jobs" className="rs-brief__back">← All roles</Link>
          <h1 className="rs-brief__title">{job.title}</h1>
          <p className="rs-brief__co">
            {job.companyWebsite ? (
              <a href={job.companyWebsite} target="_blank" rel="noopener noreferrer">{label.company} ↗</a>
            ) : label.company}
            {" · "}{label.location}
          </p>
          {job.compSummary && <p className="rs-brief__comp">{job.compSummary}</p>}

          <div className="rs-brief__rubric">
            <h3 className="rs-brief__rubric-h">What WeKruit screens for</h3>
            {job.recruiterBoard.checklist.groups.map((group) => (
              <div key={group.kind} className={`rs-rgroup is-${group.kind}`}>
                <span className="rs-rgroup__tag">{CHECKLIST_LEGEND_LABEL[group.kind]}</span>
                <ul>
                  {group.items.map((item) => <li key={item.id}>{item.text}</li>)}
                </ul>
              </div>
            ))}
          </div>

          <details className="rs-brief__jd">
            <summary>Full job description</summary>
            <div className="rs-brief__jd-body">
              {job.jdBlocks.map((block, i) => (
                <section key={i}>
                  <h4>{block.heading}</h4>
                  {renderJdBody(block.body ?? "")}
                </section>
              ))}
              {job.recruiterBoard.interviewProcess && (
                <section><h4>Interview process</h4><p>{job.recruiterBoard.interviewProcess}</p></section>
              )}
              <section>
                <h4>Culture &amp; what they're building</h4>
                <p><strong>The bet:</strong> {job.recruiterBoard.culture.bet}</p>
                <ul>{job.recruiterBoard.culture.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
              </section>
            </div>
          </details>
        </aside>

        {/* RIGHT — your candidates: clean table + inline add, no separate page */}
        <section className="rs-cands">
          {!session ? (
            <div className="rs-auth-prompt">
              <p>Sign in to see and submit candidates for this role.</p>
              <Link to="/recruiters" className="rs-auth-prompt__link">Go to recruiter home →</Link>
            </div>
          ) : (
            <>
              <div className="rs-cands__head">
                <h2>Your candidates <span className="rs-cands__count">{roleSubmissions.length}</span></h2>
                {!addOpen && (
                  <button type="button" className="rs-add-btn" onClick={() => { setAddOpen(true); setSelectedRowId(null) }}>
                    + Add candidate
                  </button>
                )}
              </div>

              {addOpen && (
                <AddCandidatePanel
                  draft={addDraft}
                  checklistColumns={checklistColumns}
                  extraFieldDefs={extraFieldDefs}
                  blockers={addBlockers}
                  ready={addRowReady}
                  submitting={submitting}
                  error={submitError}
                  jobId={job.jobId}
                  onChange={changeAddDraft}
                  onSubmit={() => void submitAddRow()}
                  onClose={() => setAddOpen(false)}
                />
              )}

              {roleSubmissions.length === 0 ? (
                !addOpen && (
                  <div className="rs-cands__empty">
                    <p>No candidates submitted for this role yet.</p>
                    <button type="button" className="rs-add-btn" onClick={() => setAddOpen(true)}>+ Add your first candidate</button>
                  </div>
                )
              ) : (
                <table className="rs-ctable">
                  <thead>
                    <tr><th>Candidate</th><th>Submitted</th><th>Status</th><th>Feedback</th></tr>
                  </thead>
                  <tbody>
                    {roleSubmissions.map((row) => {
                      const c = row.candidate ?? {}
                      const model = buildSubmissionStatusStepper(row.status, row.requestedInfo)
                      const tone = model.terminal ? model.outcome.tone : "pending"
                      const fb = sheetFeedbackText(row, commentsByRow[row.id])
                      return (
                        <tr
                          key={row.id}
                          className={`rs-crow${selectedRowId === row.id ? " is-sel" : ""}`}
                          onClick={() => { setSelectedRowId(row.id); setAddOpen(false) }}
                        >
                          <td className="rs-crow__cand">
                            <strong>{c.name || "—"}</strong>
                            <span>{c.currentRole || c.currentCompany || ""}</span>
                          </td>
                          <td className="rs-crow__date">{shortSubmittedDate(row.createdAt)}</td>
                          <td><span className={`rs-status is-${tone}`}>{sheetStageLabel(row)}</span></td>
                          <td className="rs-crow__fb" title={fb}>{fb}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
        </section>

        {/* inline candidate detail — no separate page */}
        {session && selectedRow && (
          <CandidateDetailPanel
            row={selectedRow}
            draft={rowDrafts[selectedRow.id] ?? null}
            checklistColumns={checklistColumns}
            extraFieldDefs={extraFieldDefs}
            comments={commentsByRow[selectedRow.id]}
            saving={savingRowId === selectedRow.id}
            jobId={job.jobId}
            onEdit={(mutate) => editRow(selectedRow, mutate)}
            onSave={() => void saveRow(selectedRow)}
            onOpenThread={() => openThread(selectedRow)}
            onClose={() => setSelectedRowId(null)}
          />
        )}
      </main>

      {threadRow && (
        <>
          <button type="button" className="rs-drawer-scrim" aria-label="Close conversation" onClick={() => setThreadRowId(null)} />
          <ThreadDrawer
            row={threadRow}
            comments={commentsByRow[threadRow.id] ?? []}
            loading={commentsLoading}
            error={commentsError}
            draft={commentDraft}
            sending={commentSending}
            onDraftChange={setCommentDraft}
            onSend={() => void sendComment()}
            onClose={() => setThreadRowId(null)}
          />
        </>
      )}

      {toast && <div className="rs-toast" role="status">{toast}</div>}
    </RecruiterShell>
  )
}

function shortSubmittedDate(value: RecruiterSubmissionItem["createdAt"]): string {
  const ms = timestampMs(value)
  if (!ms) return "—"
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  } catch {
    return "—"
  }
}

// Inline candidate detail — opens beside the table, no separate route.
function CandidateDetailPanel({
  row,
  draft,
  checklistColumns,
  extraFieldDefs,
  comments,
  saving,
  jobId,
  onEdit,
  onSave,
  onOpenThread,
  onClose,
}: {
  row: RecruiterSubmissionItem
  draft: RowDraft | null
  checklistColumns: ChecklistColumn[]
  extraFieldDefs: RecruiterSubmitField[]
  comments?: RecruiterSubmissionComment[]
  saving: boolean
  jobId: string
  onEdit: (mutate: (draft: RowDraft) => RowDraft) => void
  onSave: () => void
  onOpenThread: () => void
  onClose: () => void
}) {
  const editable = rowIsEditable(row)
  const dirty = draft !== null
  const view = draft ?? draftFromSubmission(row)
  const model = buildSubmissionStatusStepper(row.status, row.requestedInfo)
  const tone = model.terminal ? model.outcome.tone : "pending"
  const rejectReason = row.status === "rejected" ? (row.recruiterFeedbackNote?.trim() ?? "") : ""
  const threadCount = comments?.length ?? (row.requestedInfo?.length || 0)
  const setCell = (id: SheetCellId, value: string) => onEdit((d) => ({ ...d, cells: { ...d.cells, [id]: value } }))

  return (
    <aside className="rs-detail" aria-label="Candidate detail">
      <div className="rs-detail__head">
        <div>
          <h3>{view.cells.name || "Candidate"}</h3>
          <span className={`rs-status is-${tone}`}>{sheetStageLabel(row)}</span>
        </div>
        <button type="button" className="rs-detail__close" onClick={onClose} aria-label="Close">×</button>
      </div>

      {rejectReason && (
        <div className="rs-detail__reason">
          <span className="rs-reason-tag">Not moving forward</span>
          <p>{rejectReason}</p>
        </div>
      )}

      <div className="rs-detail__fields">
        {CANDIDATE_COLUMNS.map((col) => {
          const value = view.cells[col.id]
          const href = col.id === "linkedin" || col.id === "resume" ? normalizeSheetUrl(value) : null
          return (
            <label key={col.id} className="rs-field">
              <span className="rs-field__label">{col.label}{col.required ? " *" : ""}</span>
              {col.id === "resume" ? (
                <ResumeCell
                  value={view.cells.resume}
                  fileName={view.resumeFileName}
                  editable={editable}
                  jobId={jobId}
                  onChange={(url, name) => onEdit((d) => ({ ...d, cells: { ...d.cells, resume: url }, resumeFileName: name }))}
                />
              ) : editable ? (
                <input type="text" value={value} onChange={(e) => setCell(col.id, e.target.value)} />
              ) : href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" className="rs-field__link">{value}</a>
              ) : (
                <span className="rs-field__val">{value || "—"}</span>
              )}
            </label>
          )
        })}
        {extraFieldDefs.map((f) => (
          <label key={f.id} className="rs-field">
            <span className="rs-field__label">{f.label}{f.required ? " *" : ""}</span>
            {editable ? (
              <input type="text" value={view.extraFields[f.id] ?? ""} onChange={(e) => onEdit((d) => ({ ...d, extraFields: { ...d.extraFields, [f.id]: e.target.value } }))} />
            ) : (
              <span className="rs-field__val">{view.extraFields[f.id] || "—"}</span>
            )}
          </label>
        ))}
        <label className="rs-field rs-field--wide">
          <span className="rs-field__label">Notes</span>
          {editable ? (
            <textarea value={view.notes} onChange={(e) => onEdit((d) => ({ ...d, notes: e.target.value }))} />
          ) : (
            <span className="rs-field__val">{view.notes || "—"}</span>
          )}
        </label>
      </div>

      {checklistColumns.length > 0 && (
        <div className="rs-detail__checklist">
          <h4>Screening checklist</h4>
          {checklistColumns.map((col) => (
            <div key={col.id} className={`rs-clrow is-${col.kind}`}>
              <span className="rs-clrow__text">{col.text}</span>
              {editable ? (
                <select
                  aria-label={col.text}
                  value={view.checklist[col.id] ?? ""}
                  onChange={(e) => onEdit((d) => ({ ...d, checklist: { ...d.checklist, [col.id]: e.target.value as "" | SubmissionChecklistValue } }))}
                >
                  {CHECKLIST_VALUE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <span className="rs-clrow__val">{CHECKLIST_VALUE_OPTIONS.find((o) => o.value === (view.checklist[col.id] ?? ""))?.label ?? "—"}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rs-detail__actions">
        <button type="button" className="rs-detail__thread" onClick={onOpenThread}>💬 Conversation{threadCount ? ` (${threadCount})` : ""}</button>
        {editable && dirty && (
          <button type="button" className="rs-btn rs-btn--save" disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save changes"}</button>
        )}
        {!editable && <span className="rs-detail__locked">Locked — candidate is with the client</span>}
      </div>
    </aside>
  )
}

// Clean inline "Add candidate" form — replaces the wide spreadsheet add row.
function AddCandidatePanel({
  draft,
  checklistColumns,
  extraFieldDefs,
  blockers,
  ready,
  submitting,
  error,
  jobId,
  onChange,
  onSubmit,
  onClose,
}: {
  draft: AddRowDraft
  checklistColumns: ChecklistColumn[]
  extraFieldDefs: RecruiterSubmitField[]
  blockers: string[]
  ready: boolean
  submitting: boolean
  error: string | null
  jobId: string
  onChange: (draft: AddRowDraft) => void
  onSubmit: () => void
  onClose: () => void
}) {
  const setCell = (id: SheetCellId, value: string) => onChange({ ...draft, cells: { ...draft.cells, [id]: value } })
  return (
    <div className="rs-addpanel">
      <div className="rs-addpanel__head">
        <h3>Add a candidate</h3>
        <button type="button" className="rs-detail__close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="rs-addpanel__grid">
        {CANDIDATE_COLUMNS.map((col) => (
          <label
            key={col.id}
            className={`rs-field${["name", "email", "linkedin", "resume"].includes(col.id) ? " rs-field--key" : ""}`}
          >
            <span className="rs-field__label">{col.label}{col.required ? " *" : ""}</span>
            {col.id === "resume" ? (
              <ResumeCell
                value={draft.cells.resume}
                fileName={draft.resumeFileName}
                editable
                jobId={jobId}
                onChange={(url, name) => onChange({ ...draft, cells: { ...draft.cells, resume: url }, resumeFileName: name })}
              />
            ) : (
              <input type="text" placeholder={col.label} value={draft.cells[col.id]} onChange={(e) => setCell(col.id, e.target.value)} />
            )}
          </label>
        ))}
        {extraFieldDefs.map((f) => (
          <label key={f.id} className="rs-field">
            <span className="rs-field__label">{f.label}{f.required ? " *" : ""}</span>
            <input type="text" placeholder={f.placeholder || f.label} value={draft.extraFields[f.id] ?? ""} onChange={(e) => onChange({ ...draft, extraFields: { ...draft.extraFields, [f.id]: e.target.value } })} />
          </label>
        ))}
        <label className="rs-field rs-field--wide">
          <span className="rs-field__label">Notes</span>
          <input type="text" placeholder="Anything WeKruit should know" value={draft.notes} onChange={(e) => onChange({ ...draft, notes: e.target.value })} />
        </label>
      </div>

      {checklistColumns.length > 0 && (
        <div className="rs-addpanel__checklist">
          <h4>Screening checklist</h4>
          {checklistColumns.map((col) => (
            <div key={col.id} className={`rs-clrow is-${col.kind}`}>
              <span className="rs-clrow__text">{col.text}</span>
              <select
                aria-label={col.text}
                value={draft.checklist[col.id] ?? ""}
                onChange={(e) => onChange({ ...draft, checklist: { ...draft.checklist, [col.id]: e.target.value as "" | SubmissionChecklistValue } })}
              >
                {CHECKLIST_VALUE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}

      {error && <div className="rs-sheet-error">Submission failed: {error}</div>}

      <div className="rs-addpanel__foot">
        <div className="rs-addpanel__foot-btns">
          <button type="button" className="rs-btn rs-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="rs-btn rs-btn--save" disabled={!ready || submitting} onClick={onSubmit}>
            {submitting ? "Submitting…" : "Submit candidate"}
          </button>
        </div>
        {!ready && blockers.length > 0 && (
          <div className="rs-submit-blockers" role="status" aria-live="polite">
            <strong>To submit:</strong>
            <ul>
              {blockers.slice(0, 5).map((b) => <li key={b}>{b}</li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

function ThreadDrawer({
  row,
  comments,
  loading,
  error,
  draft,
  sending,
  onDraftChange,
  onSend,
  onClose,
}: {
  row: RecruiterSubmissionItem
  comments: RecruiterSubmissionComment[]
  loading: boolean
  error: string | null
  draft: string
  sending: boolean
  onDraftChange: (value: string) => void
  onSend: () => void
  onClose: () => void
}) {
  const model = buildSubmissionStatusStepper(row.status, row.requestedInfo)
  return (
    <aside className="rs-drawer" role="dialog" aria-label={`Conversation about ${row.candidate?.name ?? "candidate"}`}>
      <header className="rs-drawer__head">
        <h2>{row.candidate?.name || "Candidate"}</h2>
        <button type="button" className="rs-drawer__close" aria-label="Close" onClick={onClose}>✕</button>
      </header>
      <div className="rs-drawer__stepper">
        <SubmissionStatusStepper status={row.status} statusHistory={row.statusHistory} />
      </div>
      {model.needsInfo && (
        <div className="rs-drawer__banner">
          <strong>Needs more info</strong>
          {model.needsInfoMessage && <span> — {model.needsInfoMessage}</span>}
        </div>
      )}
      <div className="rs-drawer__messages">
        {loading && <p className="rs-drawer__empty">Loading conversation…</p>}
        {error && <p className="rs-drawer__empty">Could not load comments: {error}</p>}
        {!loading && !error && comments.length === 0 && (
          <p className="rs-drawer__empty">No messages yet — ask WeKruit anything about this candidate.</p>
        )}
        {comments.map((comment, i) => (
          <div key={i} className={`rs-msg is-${comment.by === "recruiter" ? "recruiter" : "wekruit"}`}>
            {comment.message}
            <em>{comment.authorName || (comment.by === "recruiter" ? "You" : "WeKruit")}{comment.at ? ` · ${new Date(comment.at).toLocaleDateString()}` : ""}</em>
          </div>
        ))}
      </div>
      <form
        className="rs-drawer__form"
        onSubmit={(e) => {
          e.preventDefault()
          onSend()
        }}
      >
        <input
          type="text"
          aria-label="Message WeKruit"
          placeholder="Write a message…"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <button type="submit" className="rs-btn" disabled={sending || !draft.trim()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </aside>
  )
}
