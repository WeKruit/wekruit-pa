import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import "../styles/submission-detail.css"
import { useRecruiterSession } from "../lib/recruiter-session-context.js"
import {
  fetchRecruiterSubmission,
  addRecruiterSubmissionComment,
  type RecruiterSubmissionItem,
} from "../lib/recruiter-board-api.js"

interface SubmissionComment {
  id: string
  authorName: string
  authorEmail?: string
  message: string
  by: "recruiter" | "wekruit"
  at?: unknown
}

function formatDate(raw: unknown): string {
  if (!raw) return ""
  const ts = typeof raw === "object" && raw !== null && "_seconds" in raw
    ? (raw as { _seconds: number })._seconds * 1000
    : typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? raw : NaN
  if (Number.isNaN(ts)) return ""
  const d = new Date(ts)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
}

function statusLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

export default function SubmissionDetailPage() {
  const { submissionId } = useParams<{ submissionId: string }>()
  const { session, authReady } = useRecruiterSession()
  const [submission, setSubmission] = useState<RecruiterSubmissionItem | null>(null)
  const [comments, setComments] = useState<SubmissionComment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [newComment, setNewComment] = useState("")
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    if (!authReady || !session || !submissionId) return
    let active = true
    setLoading(true)
    fetchRecruiterSubmission(submissionId)
      .then((r) => {
        if (!active) return
        setSubmission(r.submission)
        setComments(r.comments)
        setError(null)
      })
      .catch((e) => {
        if (!active) return
        const msg = String(e?.message ?? e)
        if (msg.includes("forbidden")) setError("You don't have access to this submission.")
        else if (msg.includes("not_found")) setError("Submission not found.")
        else setError(msg)
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [authReady, session, submissionId])

  const shareUrl = typeof window !== "undefined" ? window.location.href : ""

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  const handleAddComment = async () => {
    if (!newComment.trim() || !submissionId) return
    setPosting(true)
    try {
      await addRecruiterSubmissionComment({ submissionId, message: newComment.trim() })
      const refreshed = await fetchRecruiterSubmission(submissionId)
      setComments(refreshed.comments)
      setNewComment("")
    } catch {
      // silent — comment thread will show on next load
    } finally {
      setPosting(false)
    }
  }

  if (!authReady) return <div className="sd-page"><div className="sd-state">Loading...</div></div>
  if (!session) {
    return (
      <div className="sd-page">
        <main className="sd-main">
          <Link to="/recruiters" className="sd-back">Back</Link>
          <div className="sd-state">
            <p>Sign in to view this submission.</p>
            <Link to="/recruiters" className="sd-btn">Sign in</Link>
          </div>
        </main>
      </div>
    )
  }
  if (loading) return <div className="sd-page"><div className="sd-state">Loading submission...</div></div>
  if (error) {
    return (
      <div className="sd-page">
        <main className="sd-main">
          <Link to="/recruiters?tab=submissions" className="sd-back">&larr; My submissions</Link>
          <div className="sd-state error">{error}</div>
        </main>
      </div>
    )
  }
  if (!submission) return null

  const candidate = submission.candidate
  const status = submission.status ?? "submitted"

  return (
    <div className="sd-page">
      <main className="sd-main">
        <div className="sd-topbar">
          <Link to="/recruiters?tab=submissions" className="sd-back">&larr; My submissions</Link>
          <button type="button" className="sd-copy-btn" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>

        <section className="sd-header">
          <h1>{candidate?.name ?? "Candidate"}</h1>
          <span className={`sd-status is-${status}`}>{statusLabel(status)}</span>
        </section>

        <section className="sd-grid">
          <div className="sd-card">
            <h2>Candidate details</h2>
            <dl>
              {candidate?.email && <><dt>Email</dt><dd>{candidate.email}</dd></>}
              {candidate?.currentRole && <><dt>Role</dt><dd>{candidate.currentRole}</dd></>}
              {candidate?.currentCompany && <><dt>Company</dt><dd>{candidate.currentCompany}</dd></>}
              {candidate?.location && <><dt>Location</dt><dd>{candidate.location}</dd></>}
              {candidate?.yoe && <><dt>YoE</dt><dd>{candidate.yoe}</dd></>}
              {candidate?.workAuthorization && <><dt>Work auth</dt><dd>{candidate.workAuthorization}</dd></>}
              {candidate?.link && (
                <><dt>LinkedIn</dt><dd><a href={candidate.link} target="_blank" rel="noopener noreferrer">{candidate.link}</a></dd></>
              )}
            </dl>
          </div>

          <div className="sd-card">
            <h2>Submission</h2>
            <dl>
              <dt>Role</dt><dd>{submission.jobTitleSnapshot ?? "—"}</dd>
              <dt>Company</dt><dd>{submission.companyLabelSnapshot ?? "—"}</dd>
              <dt>Status</dt><dd>{statusLabel(status)}</dd>
              {submission.candidateConsentStatus && <><dt>Consent</dt><dd>{statusLabel(submission.candidateConsentStatus)}</dd></>}
              <dt>Submitted</dt><dd>{formatDate(submission.createdAt)}</dd>
              {submission.updatedAt && <><dt>Last update</dt><dd>{formatDate(submission.updatedAt)}</dd></>}
            </dl>
          </div>

          {submission.checklist && Object.keys(submission.checklist).length > 0 && (
            <div className="sd-card">
              <h2>Checklist</h2>
              <dl>
                {Object.entries(submission.checklist).map(([key, val]) => (
                  <span key={key}><dt>{key}</dt><dd>{String(val)}</dd></span>
                ))}
              </dl>
            </div>
          )}

          {submission.score && (
            <div className="sd-card">
              <h2>Score</h2>
              <dl>
                {typeof submission.score.hardChecked === "number" && <><dt>Hard checks</dt><dd>{submission.score.hardChecked}/{submission.score.hardTotal}</dd></>}
                {typeof submission.score.fitChecked === "number" && <><dt>Fit checks</dt><dd>{submission.score.fitChecked}/{submission.score.fitTotal}</dd></>}
              </dl>
            </div>
          )}
        </section>

        {submission.statusHistory && submission.statusHistory.length > 0 && (
          <section className="sd-card sd-timeline">
            <h2>Timeline</h2>
            <ul>
              {submission.statusHistory.map((entry, i) => (
                <li key={i}>
                  <strong>{statusLabel(entry.status)}</strong>
                  <span>{formatDate(entry.atIso)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="sd-card sd-comments">
          <h2>Discussion</h2>
          {comments.length === 0 && <p className="sd-muted">No comments yet.</p>}
          {comments.map((c) => (
            <article key={c.id} className={`sd-comment ${c.by === "wekruit" ? "is-admin" : ""}`}>
              <header>
                <strong>{c.authorName}</strong>
                {c.by === "wekruit" && <span className="sd-badge">WeKruit</span>}
                <time>{formatDate(c.at)}</time>
              </header>
              <p>{c.message}</p>
            </article>
          ))}
          <div className="sd-comment-form">
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Add a comment..."
              rows={3}
            />
            <button type="button" onClick={() => void handleAddComment()} disabled={posting || !newComment.trim()}>
              {posting ? "Posting..." : "Post comment"}
            </button>
          </div>
        </section>
      </main>
    </div>
  )
}
