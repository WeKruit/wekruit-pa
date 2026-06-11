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
import { useRecruiterSession } from "../lib/recruiter-session-context.js"
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

const KEY_TABLE_COLUMNS: SheetColumn[] = CANDIDATE_COLUMNS.filter((c) => c.key)

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

type AddRowDraft = RowDraft & { consent: boolean }

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
  return { cells: emptyCells(), notes: "", checklist: {}, extraFields: {}, consent: false }
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
        consent: Boolean(parsed.consent),
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
  return {
    name: c.name ?? "",
    email: c.email ?? "",
    linkedin: linkIsLinkedin ? link : "",
    resume: linkIsLinkedin ? "" : link,
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

function checklistShortLabel(text: string | null | undefined): string {
  const words = (text ?? "").trim().split(/\s+/).filter(Boolean)
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
  if (!draft.consent) blockers.push("Candidate consent is required.")
  return blockers
}

function formatSubmitFailure(reason?: string): string {
  if (reason === "candidate_already_submitted_for_role") {
    return "This candidate is already submitted for this role — edit their existing row instead."
  }
  if (reason === "candidate_already_sourced_for_role") {
    return "Another recruiter already has this candidate in motion for this role."
  }
  if (reason === "missing_candidate_email") return "Add the candidate email so WeKruit can confirm consent."
  if (reason === "invalid_candidate_email") return "Enter a valid candidate email."
  if (reason === "candidate_consent_required") return "Confirm candidate consent before submitting."
  if (reason === "recruiter_auth_required") return "Your session expired — sign in again from the recruiter home."
  return reason ?? "submission_failed"
}

function renderJdBody(text: string | null | undefined, items?: string[]): ReactNode[] {
  // List-kind blocks arrive as { heading, items } with a null body.
  if (typeof text !== "string" || !text.trim()) {
    if (items && items.length) {
      return [
        <ul key={0}>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>,
      ]
    }
    return []
  }
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
        candidateConsent: true,
        candidateLinkedinUrl: linkedin ?? undefined,
        candidateResumeUrl: resume ?? undefined,
        extraFields: extraFieldsPayload(addDraft, extraFieldDefs),
      })
      if (!result.ok) {
        // failure keeps every typed value in the blank row
        setSubmitError(formatSubmitFailure(result.reason))
        return
      }
      await refreshSubmissions()
      setAddDraft(emptyAddRowDraft())
      clearAddRowDraft(jobId)
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

  if (error) return <div className="rs-page"><div className="rs-state error">Could not load: {error}</div></div>
  if (!authReady) return <div className="rs-page"><div className="rs-state">Loading recruiter account…</div></div>
  if (!session) {
    return (
      <div className="rs-page">
        <main className="rs-shell">
          <div className="rs-topbar">
            <Link to="/recruiters" className="rs-back">← All roles</Link>
          </div>
          <div className="rs-state">
            <p>Recruiter access is required before submitting candidates.</p>
            <Link to="/recruiters" className="rs-btn" style={{ textDecoration: "none" }}>Sign in</Link>
          </div>
        </main>
      </div>
    )
  }
  if (!jobs) return <div className="rs-page"><div className="rs-state">Loading…</div></div>
  if (!job) {
    return (
      <div className="rs-page">
        <main className="rs-shell">
          <div className="rs-topbar">
            <Link to="/recruiters" className="rs-back">← All roles</Link>
          </div>
          <div className="rs-state error">This role is not on the board anymore.</div>
        </main>
      </div>
    )
  }

  const label = job.recruiterBoard.label
  const legendCounts = CHECKLIST_KIND_ORDER.map((kind) => ({
    kind,
    count: checklistColumns.filter((column) => column.kind === kind).length,
  })).filter((entry) => entry.count > 0)

  return (
    <div className="rs-page">
      <main className="rs-shell">
        <div className="rs-topbar">
          <Link to="/recruiters" className="rs-back">← All roles</Link>
          <span className="rs-topbar__sep">·</span>
          <h1>{job.title}</h1>
          <span className="rs-topbar__meta">{label.company} · {label.location}</span>
          {job.compSummary && (
            <>
              <span className="rs-topbar__sep">·</span>
              <span className="rs-topbar__meta">{job.compSummary}</span>
            </>
          )}
        </div>

        <details className="rs-jd" open>
          <summary>Job description</summary>
          <div className="rs-jd__body">
            {job.jdBlocks.map((block, i) => (
              <section key={i}>
                <h3>{block.heading}</h3>
                {renderJdBody(block.body, block.items)}
              </section>
            ))}
            {job.recruiterBoard.interviewProcess && (
              <section>
                <h3>Interview process</h3>
                <p>{job.recruiterBoard.interviewProcess}</p>
              </section>
            )}
            <section className="rs-jd__culture">
              <h3>Culture &amp; what they're building</h3>
              <p><strong>The bet:</strong> {job.recruiterBoard.culture.bet}</p>
              <ul>
                {job.recruiterBoard.culture.bullets.map((bullet, i) => (
                  <li key={i}>{bullet}</li>
                ))}
              </ul>
            </section>
          </div>
        </details>

        <div className="rs-legend">
          {legendCounts.map((entry, i) => (
            <span key={entry.kind}>
              {i > 0 && <span aria-hidden="true"> · </span>}
              <strong>{CHECKLIST_LEGEND_LABEL[entry.kind]} ({entry.count})</strong>
            </span>
          ))}
          <span>— hover any column header for the full requirement.</span>
        </div>

        {roleSubmissions.length > 0 && (
          <div className="rs-table-wrap">
            <table className="rs-sheet">
              <thead>
                <tr>
                  {KEY_TABLE_COLUMNS.map((column) => (
                    <th key={column.id} className={`rs-th rs-c-${column.id}`}>
                      {column.label}
                    </th>
                  ))}
                  <th className="rs-th rs-c-status">Status</th>
                  <th className="rs-th rs-c-feedback">Feedback</th>
                  <th className="rs-th rs-c-thread" aria-label="Conversation">💬</th>
                </tr>
              </thead>
              <tbody>
                {roleSubmissions.map((row) => (
                  <SheetRow
                    key={row.id}
                    row={row}
                    comments={commentsByRow[row.id]}
                    onOpenDetail={() => openThread(row)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <AddCandidateForm
          draft={addDraft}
          checklistColumns={checklistColumns}
          extraFieldDefs={extraFieldDefs}
          blockers={addBlockers}
          ready={addRowReady}
          submitting={submitting}
          jobId={job.jobId}
          onChange={changeAddDraft}
          onSubmit={() => void submitAddRow()}
        />

        {submitError && <div className="rs-sheet-error">Submission failed: {submitError}</div>}
      </main>

      {threadRow && (
        <>
          <button type="button" className="rs-drawer-scrim" aria-label="Close conversation" onClick={() => setThreadRowId(null)} />
          <DetailDrawer
            row={threadRow}
            rowDraft={rowDrafts[threadRow.id] ?? null}
            checklistColumns={checklistColumns}
            extraFieldDefs={extraFieldDefs}
            comments={commentsByRow[threadRow.id] ?? []}
            loading={commentsLoading}
            error={commentsError}
            commentText={commentDraft}
            sending={commentSending}
            saving={savingRowId === threadRow.id}
            jobId={job.jobId}
            onEdit={(mutate) => editRow(threadRow, mutate)}
            onSave={() => void saveRow(threadRow)}
            onCommentChange={setCommentDraft}
            onSend={() => void sendComment()}
            onClose={() => setThreadRowId(null)}
          />
        </>
      )}

      {toast && <div className="rs-toast" role="status">{toast}</div>}
    </div>
  )
}

function SheetRow({
  row,
  comments,
  onOpenDetail,
}: {
  row: RecruiterSubmissionItem
  comments?: RecruiterSubmissionComment[]
  onOpenDetail: () => void
}) {
  const view = cellsFromSubmission(row)
  const threadCount = comments?.length ?? (row.requestedInfo?.length || 0)

  return (
    <tr className="rs-row-real" onClick={onOpenDetail} style={{ cursor: "pointer" }}>
      {KEY_TABLE_COLUMNS.map((column) => (
        <td key={column.id} data-label={column.label} className={`rs-c-${column.id} rs-c-key`}>
          {column.id === "name" ? (
            <button type="button" className="rs-name-link" onClick={onOpenDetail}>{view[column.id] || "—"}</button>
          ) : (
            view[column.id] || "—"
          )}
        </td>
      ))}
      <td data-label="Status" className="rs-c-status rs-c-key">{sheetStageLabel(row)}</td>
      <td data-label="Feedback" className="rs-c-feedback rs-c-key" title={sheetFeedbackText(row, comments)}>
        {sheetFeedbackText(row, comments)}
      </td>
      <td data-label="Conversation" className="rs-c-thread rs-c-key">
        <button type="button" className="rs-thread-btn" onClick={(e) => { e.stopPropagation(); onOpenDetail() }}>
          💬{threadCount ? ` ${threadCount}` : ""}
        </button>
      </td>
    </tr>
  )
}

const ADD_REQUIRED_COLUMNS: SheetColumn[] = CANDIDATE_COLUMNS.filter((c) => c.required)
const ADD_CONTEXT_COLUMNS: SheetColumn[] = CANDIDATE_COLUMNS.filter((c) => !c.required)

function AddCandidateForm({
  draft,
  checklistColumns,
  extraFieldDefs,
  blockers,
  ready,
  submitting,
  jobId,
  onChange,
  onSubmit,
}: {
  draft: AddRowDraft
  checklistColumns: ChecklistColumn[]
  extraFieldDefs: RecruiterSubmitField[]
  blockers: string[]
  ready: boolean
  submitting: boolean
  jobId: string
  onChange: (draft: AddRowDraft) => void
  onSubmit: () => void
}) {
  const [showContext, setShowContext] = useState(false)
  const submitBlockerId = "rs-add-form-submit-blockers"
  const setCell = (id: SheetCellId, value: string) =>
    onChange({ ...draft, cells: { ...draft.cells, [id]: value } })

  const checklistByKind = CHECKLIST_KIND_ORDER.map((kind) => ({
    kind,
    items: checklistColumns.filter((c) => c.kind === kind),
  })).filter((g) => g.items.length > 0)

  const contextFilled = ADD_CONTEXT_COLUMNS.some((c) => draft.cells[c.id].trim())

  return (
    <div className="rs-add-form">
      <h2 className="rs-add-form__title">Submit a candidate</h2>

      <fieldset className="rs-add-form__section">
        <legend>Candidate info</legend>
        <div className="rs-add-form__grid">
          {ADD_REQUIRED_COLUMNS.map((column) => (
            <div key={column.id} className={`rs-add-form__field${column.id === "resume" ? " rs-add-form__field--resume" : ""}`}>
              <label htmlFor={`add-${column.id}`}>{column.label} *</label>
              {column.id === "resume" ? (
                <ResumeCell
                  value={draft.cells.resume}
                  fileName={draft.resumeFileName}
                  editable
                  jobId={jobId}
                  onChange={(url, name) =>
                    onChange({ ...draft, cells: { ...draft.cells, resume: url }, resumeFileName: name })
                  }
                />
              ) : (
                <input
                  id={`add-${column.id}`}
                  type={column.id === "email" ? "email" : "text"}
                  placeholder={column.label}
                  value={draft.cells[column.id]}
                  onChange={(e) => setCell(column.id, e.target.value)}
                />
              )}
            </div>
          ))}
        </div>
      </fieldset>

      <details className="rs-add-form__details" open={showContext || contextFilled} onToggle={(e) => setShowContext((e.target as HTMLDetailsElement).open)}>
        <summary>Additional details {contextFilled && <span className="rs-add-form__filled-dot" />}</summary>
        <div className="rs-add-form__grid">
          {ADD_CONTEXT_COLUMNS.map((column) => (
            <div key={column.id} className="rs-add-form__field">
              <label htmlFor={`add-${column.id}`}>{column.label}</label>
              <input
                id={`add-${column.id}`}
                type="text"
                placeholder={column.label}
                value={draft.cells[column.id]}
                onChange={(e) => setCell(column.id, e.target.value)}
              />
            </div>
          ))}
        </div>
      </details>

      {checklistByKind.length > 0 && (
        <fieldset className="rs-add-form__section">
          <legend>Checklist</legend>
          {checklistByKind.map((group) => (
            <div key={group.kind} className="rs-add-form__check-group">
              <span className={`rs-chip is-${group.kind}`}>{CHECKLIST_KIND_CHIP[group.kind]}</span>
              <span className="rs-add-form__check-label">{CHECKLIST_LEGEND_LABEL[group.kind]}</span>
              <div className="rs-add-form__check-items">
                {group.items.map((item) => (
                  <div key={item.id} className="rs-add-form__check-row">
                    <span className="rs-add-form__check-text">{item.text}</span>
                    <select
                      aria-label={item.text}
                      value={draft.checklist[item.id] ?? ""}
                      onChange={(e) =>
                        onChange({
                          ...draft,
                          checklist: { ...draft.checklist, [item.id]: e.target.value as "" | SubmissionChecklistValue },
                        })
                      }
                    >
                      {CHECKLIST_VALUE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </fieldset>
      )}

      {extraFieldDefs.length > 0 && (
        <fieldset className="rs-add-form__section">
          <legend>Role-specific fields</legend>
          <div className="rs-add-form__grid">
            {extraFieldDefs.map((field) => (
              <div key={field.id} className="rs-add-form__field">
                <label htmlFor={`add-extra-${field.id}`}>{field.label}{field.required ? " *" : ""}</label>
                <input
                  id={`add-extra-${field.id}`}
                  type="text"
                  placeholder={field.placeholder || field.label}
                  value={draft.extraFields[field.id] ?? ""}
                  onChange={(e) => onChange({ ...draft, extraFields: { ...draft.extraFields, [field.id]: e.target.value } })}
                />
              </div>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="rs-add-form__section">
        <legend>Notes</legend>
        <textarea
          aria-label="Notes about this candidate"
          placeholder="Anything else WeKruit should know about this candidate…"
          value={draft.notes}
          rows={2}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
        />
      </fieldset>

      <div className="rs-add-form__footer">
        <label className="rs-consent">
          <input
            type="checkbox"
            checked={draft.consent}
            onChange={(e) => onChange({ ...draft, consent: e.target.checked })}
          />
          <span>This candidate has agreed to be submitted for this role</span>
        </label>
        <div className="rs-add-form__actions">
          {!ready && blockers.length > 0 && (
            <div id={submitBlockerId} className="rs-submit-blockers" role="status" aria-live="polite">
              <strong>Cannot submit yet</strong>
              <ul>
                {blockers.slice(0, 4).map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
                {blockers.length > 4 && (
                  <li>Fix {blockers.length - 4} more {blockers.length - 4 === 1 ? "field" : "fields"}.</li>
                )}
              </ul>
            </div>
          )}
          <button
            type="button"
            className="rs-btn rs-btn--submit"
            disabled={!ready || submitting}
            aria-describedby={ready ? undefined : submitBlockerId}
            onClick={onSubmit}
          >
            {submitting ? "Submitting…" : "Submit candidate"}
          </button>
        </div>
      </div>
    </div>
  )
}

function DetailDrawer({
  row,
  rowDraft,
  checklistColumns,
  extraFieldDefs,
  comments,
  loading,
  error,
  commentText,
  sending,
  saving,
  jobId,
  onEdit,
  onSave,
  onCommentChange,
  onSend,
  onClose,
}: {
  row: RecruiterSubmissionItem
  rowDraft: RowDraft | null
  checklistColumns: ChecklistColumn[]
  extraFieldDefs: RecruiterSubmitField[]
  comments: RecruiterSubmissionComment[]
  loading: boolean
  error: string | null
  commentText: string
  sending: boolean
  saving: boolean
  jobId: string
  onEdit: (mutate: (draft: RowDraft) => RowDraft) => void
  onSave: () => void
  onCommentChange: (value: string) => void
  onSend: () => void
  onClose: () => void
}) {
  const model = buildSubmissionStatusStepper(row.status, row.requestedInfo)
  const editable = rowIsEditable(row)
  const dirty = rowDraft !== null
  const view = rowDraft ?? draftFromSubmission(row)

  const checklistByKind = CHECKLIST_KIND_ORDER.map((kind) => ({
    kind,
    items: checklistColumns.filter((c) => c.kind === kind),
  })).filter((g) => g.items.length > 0)

  const setCell = (id: SheetCellId, value: string) =>
    onEdit((d) => ({ ...d, cells: { ...d.cells, [id]: value } }))

  return (
    <aside className="rs-drawer" role="dialog" aria-label={`Details for ${row.candidate?.name ?? "candidate"}`}>
      <header className="rs-drawer__head">
        <h2>{row.candidate?.name || "Candidate"}</h2>
        <button type="button" className="rs-drawer__close" aria-label="Close" onClick={onClose}>✕</button>
      </header>

      <div className="rs-drawer__body">
        <div className="rs-drawer__stepper">
          <SubmissionStatusStepper status={row.status} />
        </div>
        {model.needsInfo && (
          <div className="rs-drawer__banner">
            <strong>Needs more info</strong>
            {model.needsInfoMessage && <span> — {model.needsInfoMessage}</span>}
          </div>
        )}

        <section className="rs-drawer__section">
          <h3>Candidate info</h3>
          <div className="rs-drawer__fields">
            {CANDIDATE_COLUMNS.map((column) => (
              <div key={column.id} className={`rs-drawer__field${column.id === "resume" ? " rs-drawer__field--resume" : ""}`}>
                <label>{column.label}</label>
                {column.id === "resume" ? (
                  <ResumeCell
                    value={view.cells.resume}
                    fileName={view.resumeFileName}
                    editable={editable}
                    jobId={jobId}
                    onChange={(url, name) =>
                      onEdit((d) => ({ ...d, cells: { ...d.cells, resume: url }, resumeFileName: name }))
                    }
                  />
                ) : editable ? (
                  <input type="text" value={view.cells[column.id]} onChange={(e) => setCell(column.id, e.target.value)} />
                ) : column.id === "linkedin" && view.cells.linkedin ? (
                  (() => {
                    const href = normalizeSheetUrl(view.cells.linkedin)
                    return href ? <a className="rs-link-cell" href={href} target="_blank" rel="noopener noreferrer">{excerpt(view.cells.linkedin, 40)}</a> : <span>{view.cells.linkedin}</span>
                  })()
                ) : (
                  <span>{view.cells[column.id] || "—"}</span>
                )}
              </div>
            ))}
          </div>
        </section>

        {checklistByKind.length > 0 && (
          <section className="rs-drawer__section">
            <h3>Checklist</h3>
            {checklistByKind.map((group) => (
              <div key={group.kind} className="rs-add-form__check-group">
                <span className={`rs-chip is-${group.kind}`}>{CHECKLIST_KIND_CHIP[group.kind]}</span>
                <span className="rs-add-form__check-label">{CHECKLIST_LEGEND_LABEL[group.kind]}</span>
                <div className="rs-add-form__check-items">
                  {group.items.map((item) => (
                    <div key={item.id} className="rs-add-form__check-row">
                      <span className="rs-add-form__check-text">{item.text}</span>
                      {editable ? (
                        <select
                          aria-label={item.text}
                          value={view.checklist[item.id] ?? ""}
                          onChange={(e) =>
                            onEdit((d) => ({
                              ...d,
                              checklist: { ...d.checklist, [item.id]: e.target.value as "" | SubmissionChecklistValue },
                            }))
                          }
                        >
                          {CHECKLIST_VALUE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="rs-add-form__check-value">
                          {CHECKLIST_VALUE_OPTIONS.find((o) => o.value === (view.checklist[item.id] ?? ""))?.label ?? "—"}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}

        {extraFieldDefs.length > 0 && (
          <section className="rs-drawer__section">
            <h3>Role-specific fields</h3>
            <div className="rs-drawer__fields">
              {extraFieldDefs.map((field) => (
                <div key={field.id} className="rs-drawer__field">
                  <label>{field.label}</label>
                  {editable ? (
                    <input type="text" value={view.extraFields[field.id] ?? ""} onChange={(e) =>
                      onEdit((d) => ({ ...d, extraFields: { ...d.extraFields, [field.id]: e.target.value } }))
                    } />
                  ) : (
                    <span>{view.extraFields[field.id] || "—"}</span>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="rs-drawer__section">
          <h3>Notes</h3>
          {editable ? (
            <textarea rows={2} value={view.notes} onChange={(e) => onEdit((d) => ({ ...d, notes: e.target.value }))} />
          ) : (
            <p className="rs-drawer__note-text">{view.notes || "—"}</p>
          )}
        </section>

        {editable && dirty && (
          <div className="rs-drawer__save-bar">
            <button type="button" className="rs-btn rs-btn--save" disabled={saving} onClick={onSave}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        )}

        <section className="rs-drawer__section rs-drawer__section--thread">
          <h3>Ask WeKruit</h3>
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
              value={commentText}
              onChange={(e) => onCommentChange(e.target.value)}
            />
            <button type="submit" className="rs-btn" disabled={sending || !commentText.trim()}>
              {sending ? "Sending…" : "Send"}
            </button>
          </form>
        </section>
      </div>
    </aside>
  )
}
