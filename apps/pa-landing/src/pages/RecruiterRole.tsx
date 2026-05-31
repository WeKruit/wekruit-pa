/**
 * Recruiter board single-role view — /recruiters/job/:jobId
 *
 * JD primary, checklist + submission form secondary. POSTs to
 * paRecruiterSubmission CF on submit; checklist + form state persisted in
 * localStorage so a recruiter can come back later.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { onAuthStateChanged } from "firebase/auth"
import { Link, useNavigate, useParams } from "react-router-dom"
import "../styles/recruiter-board.css"
import {
  fetchCollabJobs,
  getRecruiterProfile,
  submitRecruiterCandidate,
  type CollabJob,
  type RecruiterSession,
  type SubmissionResponse,
} from "../lib/recruiter-board-api.js"
import { auth } from "../lib/firebase.js"

const STORAGE_KEY_PREFIX = "rb-state-v1:"

interface FormState {
  submitterName: string
  submitterEmail: string
  candidateName: string
  candidateLink: string
  candidateCurrentRole: string
  candidateYoe: string
  candidateNotes: string
  candidateConsent: boolean
  checklist: Record<string, boolean>
}

function emptyForm(): FormState {
  return {
    submitterName: "",
    submitterEmail: "",
    candidateName: "",
    candidateLink: "",
    candidateCurrentRole: "",
    candidateYoe: "",
    candidateNotes: "",
    candidateConsent: false,
    checklist: {},
  }
}

function loadFormState(jobId: string): FormState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + jobId)
    if (raw) return { ...emptyForm(), ...JSON.parse(raw) }
  } catch (e) {
    // ignore
  }
  return emptyForm()
}

function saveFormState(jobId: string, state: FormState): void {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + jobId, JSON.stringify(state))
  } catch (e) {
    // ignore
  }
}

function withRecruiterDefaults(state: FormState, session: RecruiterSession | null): FormState {
  if (!session) return state
  return {
    ...state,
    submitterName: state.submitterName || session.recruiter.name,
    submitterEmail: state.submitterEmail || session.recruiter.email,
  }
}

// Minimal Markdown → React renderer for jdBlocks.body. Supports `-` bullet
// lists, blank-line paragraphs, and inline `**bold**` / `*em*` / `` `code` ``.
function renderMarkdown(text: string): ReactNode[] {
  const lines = text.split("\n")
  const out: ReactNode[] = []
  let listBuffer: string[] = []
  let key = 0
  const flushList = () => {
    if (listBuffer.length) {
      out.push(
        <ul key={key++}>
          {listBuffer.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>,
      )
      listBuffer = []
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith("- ")) {
      listBuffer.push(line.slice(2))
    } else if (line === "") {
      flushList()
    } else {
      flushList()
      out.push(<p key={key++}>{renderInline(line)}</p>)
    }
  }
  flushList()
  return out
}

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  // Tokenize on **bold**, *em*, `code`
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[1]
    if (tok.startsWith("**")) parts.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith("`")) parts.push(<code key={key++}>{tok.slice(1, -1)}</code>)
    else parts.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    last = regex.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export default function RecruiterRole() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const [session, setSession] = useState<RecruiterSession | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [jobs, setJobs] = useState<CollabJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [submitting, setSubmitting] = useState(false)
  const [submission, setSubmission] = useState<SubmissionResponse | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const unsubscribe = onAuthStateChanged(auth(), (user) => {
      void (async () => {
        if (!user) {
          if (!active) return
          setSession(null)
          setAuthReady(true)
          return
        }
        try {
          const next = await getRecruiterProfile()
          if (active) setSession(next)
        } catch {
          if (active) setSession(null)
        } finally {
          if (active) setAuthReady(true)
        }
      })()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  // Restore persisted form once we know the jobId.
  useEffect(() => {
    if (jobId) setForm(withRecruiterDefaults(loadFormState(jobId), session))
  }, [jobId, session])

  // Fetch list once; pull out the role this page renders.
  useEffect(() => {
    fetchCollabJobs()
      .then((list) => setJobs(list))
      .catch((e) => setError(String(e?.message ?? e)))
  }, [])

  // Persist form on every change.
  useEffect(() => {
    if (jobId) saveFormState(jobId, form)
  }, [jobId, form])

  const job = useMemo(() => jobs?.find((j) => j.jobId === jobId) ?? null, [jobs, jobId])

  if (error) return <div className="rb-page"><div className="rb-state error">Could not load: {error}</div></div>
  if (!authReady) return <div className="rb-page"><div className="rb-state">Loading recruiter account...</div></div>
  if (!session) {
    return (
      <div className="rb-page rb-page--access-required">
        <main className="rb-main">
          <Link to="/recruiters" className="rb-back">Back to recruiter access</Link>
          <div className="rb-access-required">
            <p className="rb-overline">Invite required</p>
            <h1>Recruiter access is required before submitting candidates.</h1>
            <p>Enter your WeKruit recruiter code first. After that, role pages can submit and track candidates under your account.</p>
            <Link to="/recruiters" className="rb-btn primary">Enter access code</Link>
          </div>
        </main>
      </div>
    )
  }
  if (!jobs) return <div className="rb-page"><div className="rb-state">Loading…</div></div>
  if (!job) {
    return (
      <div className="rb-page">
        <main className="rb-main">
          <Link to="/recruiters" className="rb-back">← All roles</Link>
          <div className="rb-state error">
            Role <code>{jobId}</code> not found or no longer active.
          </div>
        </main>
      </div>
    )
  }

  const groups = job.recruiterBoard.checklist.groups
  const totals = {
    hard: groups.find((g) => g.kind === "hard")?.items.length ?? 0,
    fit: groups.find((g) => g.kind === "fit")?.items.length ?? 0,
    bonus: groups.find((g) => g.kind === "bonus")?.items.length ?? 0,
    anti: groups.find((g) => g.kind === "anti")?.items.length ?? 0,
  }
  const checkedCounts = {
    hard: (groups.find((g) => g.kind === "hard")?.items ?? []).filter((i) => form.checklist[i.id]).length,
    fit: (groups.find((g) => g.kind === "fit")?.items ?? []).filter((i) => form.checklist[i.id]).length,
    bonus: (groups.find((g) => g.kind === "bonus")?.items ?? []).filter((i) => form.checklist[i.id]).length,
    anti: (groups.find((g) => g.kind === "anti")?.items ?? []).filter((i) => form.checklist[i.id]).length,
  }
  const totalChecked = Object.values(checkedCounts).reduce((s, n) => s + n, 0)
  const totalItems = Object.values(totals).reduce((s, n) => s + n, 0)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!session) {
      setSubmitError("recruiter_access_required")
      return
    }
    if (!form.candidateConsent) {
      setSubmitError("candidate_consent_required")
      return
    }
    setSubmitError(null)
    setSubmitting(true)
    const result = await submitRecruiterCandidate({
      jobId: job.jobId,
      submitter: {
        name: form.submitterName.trim(),
        email: form.submitterEmail.trim(),
      },
      candidate: {
        name: form.candidateName.trim(),
        link: form.candidateLink.trim(),
        currentRole: form.candidateCurrentRole.trim() || undefined,
        yoe: form.candidateYoe.trim() || undefined,
        notes: form.candidateNotes.trim() || undefined,
      },
      checklist: form.checklist,
      candidateConsent: true,
    })
    setSubmitting(false)
    if (result.ok) {
      setSubmission(result)
      saveFormState(job.jobId, withRecruiterDefaults(emptyForm(), session))
      window.scrollTo({ top: 0, behavior: "smooth" })
    } else {
      setSubmitError(result.reason ?? "submission_failed")
    }
  }

  const resetChecklist = () => {
    if (!confirm("Clear this role's checklist and candidate fields?")) return
    setForm(withRecruiterDefaults(emptyForm(), session))
  }

  const submitAnother = () => {
    setSubmission(null)
  }

  return (
    <div className="rb-page">
      <main className="rb-main">
        <Link to="/recruiters" className="rb-back">← All roles</Link>

        <div className="rb-role-header">
          <div>
            <h2>{job.title}</h2>
            <div className="meta">
              <span>{job.recruiterBoard.label.company}</span>
              <span>{job.recruiterBoard.label.location}</span>
              <span>
                {job.recruiterBoard.label.pills.map((p, i) => (
                  <span key={i} className={`rb-pill ${p.tone ?? ""}`}>{p.text}</span>
                ))}
              </span>
            </div>
          </div>
        </div>

        {submission && submission.ok && (
          <div className="rb-success">
            <strong>Candidate submitted.</strong> We&apos;ll review and update your tracker.
            {submission.score && (
              <div style={{ marginTop: 6, color: "#1a1a1a" }}>
                Score: Hard {submission.score.hardChecked}/{submission.score.hardTotal}{" "}
                · Fit {submission.score.fitChecked}/{submission.score.fitTotal}{" "}
                · Bonus {submission.score.bonusChecked}/{submission.score.bonusTotal}{" "}
                · Anti {submission.score.antiChecked}/{submission.score.antiTotal}
              </div>
            )}
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button className="rb-btn" onClick={submitAnother}>Submit another for this role</button>
              <button className="rb-btn" onClick={() => navigate("/recruiters?tab=submissions")}>Track status</button>
            </div>
          </div>
        )}

        <div className="rb-jd">
          {job.compSummary && <div className="rb-comp"><strong>Comp:</strong> {job.compSummary}</div>}
          {job.jdBlocks.map((block, i) => (
            <section className="block" key={i}>
              <h3>{block.heading}</h3>
              {renderMarkdown(block.body)}
            </section>
          ))}
          {job.recruiterBoard.interviewProcess && (
            <section className="block">
              <h3>Interview process</h3>
              <p>{job.recruiterBoard.interviewProcess}</p>
            </section>
          )}
        </div>

        <div className="rb-culture">
          <h3>Culture &amp; what they're building</h3>
          <p><strong>The bet:</strong> {job.recruiterBoard.culture.bet}</p>
          <ul>
            {job.recruiterBoard.culture.bullets.map((b, i) => (
              <li key={i}>{renderInline(b)}</li>
            ))}
          </ul>
        </div>

        <div className="rb-banner">
          <strong>Recruiters: please return this checklist with each candidate.</strong>
          <span className="small">
            Fill in your contact + the candidate fields, tick every box the candidate satisfies, then hit
            <em> Submit candidate</em> below. Saved in your browser; you can come back later.
          </span>
          <span className="chip">$10K+ placement fee on successful hire</span>
        </div>

        <form className="rb-form-section rb-form" onSubmit={onSubmit}>
          <h3 className="section-title">Your contact (for follow-up)</h3>
          <p className="rb-form-note">Submitting as {session.recruiter.email}. WeKruit status updates will appear in your recruiter tracker.</p>
          <div className="field">
            <label>Your name *</label>
            <input
              type="text"
              required
              value={form.submitterName}
              onChange={(e) => setForm({ ...form, submitterName: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Your email *</label>
            <input
              type="email"
              required
              value={form.submitterEmail}
              onChange={(e) => setForm({ ...form, submitterEmail: e.target.value })}
            />
          </div>

          <h3 className="section-title" style={{ marginTop: 24 }}>Candidate</h3>
          <div className="field">
            <label>Candidate name *</label>
            <input
              type="text"
              required
              value={form.candidateName}
              onChange={(e) => setForm({ ...form, candidateName: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Resume / LinkedIn *</label>
            <input
              type="text"
              required
              placeholder="https://linkedin.com/in/…"
              value={form.candidateLink}
              onChange={(e) => setForm({ ...form, candidateLink: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Current role</label>
            <input
              type="text"
              value={form.candidateCurrentRole}
              onChange={(e) => setForm({ ...form, candidateCurrentRole: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Years of experience</label>
            <input
              type="text"
              value={form.candidateYoe}
              onChange={(e) => setForm({ ...form, candidateYoe: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Notes for us</label>
            <textarea
              value={form.candidateNotes}
              onChange={(e) => setForm({ ...form, candidateNotes: e.target.value })}
            />
          </div>
          <label className="rb-consent">
            <input
              type="checkbox"
              required
              checked={form.candidateConsent}
              onChange={(e) => setForm({ ...form, candidateConsent: e.target.checked })}
            />
            <span>I confirm this candidate gave consent to be submitted to WeKruit for this role.</span>
          </label>

          <h3 className="section-title" style={{ marginTop: 24 }}>Fit checklist</h3>
          {groups.map((group) => (
            <div className={`rb-group ${group.kind}`} key={group.kind}>
              <h4>
                {group.heading}
                <span className="count">
                  {checkedCounts[group.kind]} / {group.items.length}
                </span>
              </h4>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!form.checklist[item.id]}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            checklist: { ...form.checklist, [item.id]: e.target.checked },
                          })
                        }
                      />
                      <span className="item-text">{item.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {submitError && <div className="rb-error">Submission failed: {submitError}</div>}

          <div className="rb-actions">
            <button type="submit" className="rb-btn primary" disabled={submitting}>
              {submitting ? "Submitting…" : "Submit candidate"}
            </button>
            <button type="button" className="rb-btn" onClick={resetChecklist} disabled={submitting}>
              Reset checklist
            </button>
            <div className="rb-progress">
              <strong>{totalChecked}</strong> of {totalItems} boxes checked
            </div>
          </div>
        </form>
      </main>
    </div>
  )
}
