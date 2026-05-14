/**
 * v1.9 Phase 87 — Public candidate-facing job page.
 *
 * Route: /j/:jobId (no auth)
 *
 * Reads pa-jobs/{jobId}.prescreenConfig + .publicVisible.
 * Renders JD + "Start pre-screen" SMS deep link + QR code + INLINE CV upload
 * (no back-and-forth navigation to /j/:jobId/cv).
 *
 * Generates a `requestedUserId` UUID cookie per visit. CF webhook resolves
 * it on first inbound SMS via pa-prescreen-pending-invites/{requestedUserId}.
 *
 * v1.9 hotfix 2026-05-13 — Adam directive "这些应该都在一个地方来回".
 * Upload UI now lives directly on the job page instead of routing to a
 * separate /cv page. Single-page flow: see job → upload → tap iMessage.
 */
import { useEffect, useId, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { doc, getDoc, setDoc } from "firebase/firestore"

const CV_INGEST_URL = import.meta.env.VITE_CV_INGEST_URL ?? ""
import { db } from "../lib/firebase.js"
import { CandidateShell } from "./CandidateLogin.js"

interface PrescreenConfig {
  jobTitle?: string
  company?: string
  level1Reveal?: {
    salaryRange?: string
  }
}

interface PaJobDoc {
  publicVisible?: boolean
  jobTitle?: string
  company?: string
  prescreenConfig?: PrescreenConfig
  descriptionMd?: string
  location?: string
  salaryRange?: string
  roleFunction?: string[]
  industrySector?: string[]
  requiredSkills?: string[]
  seniorityLevel?: string
  jobType?: string
}

// v1.9 P88 — same djb2 hash as apps/functions/src/sendblue/pool.ts so
// candidate's pre-PII outbound first message lands on the SAME pool number
// that the server will use for replies (thread continuity).
function hashStringToUint(s: string): number {
  let h = 5381 >>> 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0
  }
  return h
}

interface PoolNumber {
  number: string
  status: "active" | "paused"
}

function pickPoolNumber(pool: PoolNumber[] | null, key: string): string | null {
  if (!pool || pool.length === 0) return null
  const active = pool.filter((n) => n.status === "active" && n.number)
  if (active.length === 0) return null
  return active[hashStringToUint(key) % active.length].number
}

function uuidV4(): string {
  // RFC 4122 v4-ish, sufficient for tracking
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/**
 * v1.9 hotfix (Adam directive 2026-05-12) — single global per-browser tempUserId
 * so a returning visitor across different /j/:jobId pages is recognized as
 * the SAME pa-user. Replaces the per-job `wkr_rid_${jobId}` scheme.
 *
 * Backwards compat: if any legacy `wkr_rid_*` key exists, hoist the first
 * one we find as the new `wkr_uid` so existing visitors keep their identity.
 */
const GLOBAL_UID_KEY = "wkr_uid"
const HAS_CV_KEY = "wkr_has_cv"

function getOrCreateRequestedUserId(_jobId: string): string {
  const existingGlobal = window.localStorage.getItem(GLOBAL_UID_KEY)
  if (existingGlobal) return existingGlobal
  // Legacy migration — find any old wkr_rid_* key and hoist.
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i)
    if (k && k.startsWith("wkr_rid_")) {
      const v = window.localStorage.getItem(k)
      if (v) {
        window.localStorage.setItem(GLOBAL_UID_KEY, v)
        return v
      }
    }
  }
  const v = uuidV4()
  window.localStorage.setItem(GLOBAL_UID_KEY, v)
  return v
}

function hasCvOnFile(): boolean {
  return window.localStorage.getItem(HAS_CV_KEY) === "true"
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const result = r.result as string
      const idx = result.indexOf(",")
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

interface InlineCvSectionProps {
  jobId: string
  requestedUserId: string
  initialHasCv: boolean
}

function InlineCvSection({ jobId, requestedUserId, initialHasCv }: InlineCvSectionProps) {
  const [hasCv, setHasCv] = useState<boolean>(initialHasCv)
  if (hasCv) {
    return (
      <p className="public-job-cv-ready">
        We have your resume on file. Tap <span>Open in iMessage</span> above to start.
      </p>
    )
  }
  return (
    <div className="public-job-card public-job-cv">
      <h2>Resume</h2>
      <p>
        PDF or DOCX, under 5 MB. We&rsquo;ll use it to tailor the pre-screen.
      </p>
      <InlineCvUpload
        jobId={jobId}
        requestedUserId={requestedUserId}
        onUploaded={() => setHasCv(true)}
      />
    </div>
  )
}

interface InlineCvUploadProps {
  jobId: string
  requestedUserId: string
  onUploaded: () => void
}

function InlineCvUpload({ jobId, requestedUserId, onUploaded }: InlineCvUploadProps) {
  const fileInputId = useId()
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<"idle" | "uploading" | "ok" | "err">("idle")
  const [errMsg, setErrMsg] = useState<string | null>(null)

  useEffect(() => {
    setStatus("idle")
    setErrMsg(null)
  }, [file])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      setStatus("err")
      setErrMsg("File must be under 5 MB.")
      return
    }
    if (!CV_INGEST_URL) {
      setStatus("err")
      setErrMsg("CV ingest endpoint not configured. Please reach out to support.")
      return
    }
    try {
      setStatus("uploading")
      const b64 = await fileToBase64(file)
      const res = await fetch(CV_INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tempUserId: requestedUserId,
          browserUid: requestedUserId,
          resumeBase64: b64,
          resumeName: file.name,
          jobIdContext: jobId,
          source: "public_job_page",
        }),
      })
      if (!res.ok) {
        setStatus("err")
        setErrMsg(`Upload failed (${res.status})`)
        return
      }
      try {
        window.localStorage.setItem(HAS_CV_KEY, "true")
      } catch {
        // localStorage disabled — non-fatal
      }
      setStatus("ok")
      onUploaded()
    } catch (err) {
      setStatus("err")
      setErrMsg(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <form onSubmit={onSubmit} className="public-job-upload">
      <div>
        <label className="public-job-file-button" htmlFor={fileInputId}>
          Choose file
        </label>
        <input
          id={fileInputId}
          className="public-job-file-input"
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={status === "uploading"}
        />
        <span className="public-job-file-name">{file?.name ?? "No file selected"}</span>
        <button
          type="submit"
          disabled={!file || status === "uploading"}
        >
          {status === "uploading" ? "Parsing resume…" : "Upload"}
        </button>
      </div>
      {status === "uploading" ? (
        <p className="public-job-muted">
          Reading your CV — takes 10-30 seconds.
        </p>
      ) : null}
      {status === "err" && errMsg ? (
        <p className="public-job-error">{errMsg}</p>
      ) : null}
    </form>
  )
}

function renderJobDescription(markdown: string, title: string, company: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let bullets: string[] = []
  const titleLower = title.toLowerCase()
  const companyLower = company.toLowerCase()
  const flushBullets = () => {
    if (bullets.length === 0) return
    const list = bullets
    bullets = []
    nodes.push(
      <ul key={`list-${nodes.length}`}>
        {list.map((item) => (
          <li key={item}>{item.replace(/\*\*/g, "")}</li>
        ))}
      </ul>
    )
  }

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim()
    if (!line) {
      flushBullets()
      continue
    }
    const cleanedLine = line.replace(/\*\*/g, "")
    const lowerLine = cleanedLine.toLowerCase()
    if (nodes.length === 0 && lowerLine.includes(titleLower) && lowerLine.includes(companyLower)) {
      continue
    }
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2).trim())
      continue
    }
    flushBullets()
    const heading = line.match(/^\*\*(.+)\*\*$/)
    if (heading) {
      nodes.push(<h3 key={`heading-${nodes.length}`}>{heading[1]}</h3>)
      continue
    }
    nodes.push(<p key={`p-${nodes.length}`}>{cleanedLine}</p>)
  }
  flushBullets()
  return nodes
}

export default function PublicJob() {
  const { jobId } = useParams<{ jobId: string }>()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [job, setJob] = useState<PaJobDoc | null>(null)
  const [pool, setPool] = useState<PoolNumber[] | null>(null)
  const [smsClicked, setSmsClicked] = useState(false)

  const requestedUserId = useMemo(() => (jobId ? getOrCreateRequestedUserId(jobId) : ""), [jobId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!jobId) {
        setErr("missing job id")
        setLoading(false)
        return
      }
      try {
        setLoading(true)
        const snap = await getDoc(doc(db(), "pa-jobs", jobId))
        if (cancelled) return
        if (!snap.exists()) {
          setErr("Job not found")
          setLoading(false)
          return
        }
        const data = snap.data() as PaJobDoc
        if (!data.publicVisible) {
          setErr("This job is not publicly visible.")
          setLoading(false)
          return
        }
        setJob(data)
        // v1.9 P88 — load active pool numbers (public read on pa-config/sendblue-pool).
        try {
          const poolSnap = await getDoc(doc(db(), "pa-config", "sendblue-pool"))
          if (poolSnap.exists()) {
            const raw = poolSnap.data() as { numbers?: PoolNumber[] }
            if (Array.isArray(raw.numbers)) setPool(raw.numbers)
          }
        } catch {
          // non-fatal — falls back to "text Claire directly" copy
        }
        // Stamp pending-invite (best effort).
        try {
          await setDoc(doc(db(), "pa-prescreen-pending-invites", requestedUserId), {
            jobId,
            requestedUserId,
            createdAt: new Date().toISOString(),
          })
        } catch {
          // pre-auth users can't write — operator-only rule. Pending invite
          // resolution still works on the inbound SMS side via webhook
          // server-side claim (uses temp doc only if pre-created). Non-fatal.
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [jobId, requestedUserId])

  if (loading) return <Page><p>Loading…</p></Page>
  if (err || !job) return <Page><h1>404</h1><p>{err ?? "Not found"}</p></Page>

  const cfg = job.prescreenConfig ?? {}
  const jobTitle = job.jobTitle ?? cfg.jobTitle ?? "Open role"
  const company = job.company ?? cfg.company ?? "Confidential employer"
  const salary = job.salaryRange ?? cfg.level1Reveal?.salaryRange

  const smsBody = `WeKruit_${jobId}_${requestedUserId}_Job`
  // v1.9 P88 — pool hash-by-requestedUserId; mirrors server-side selector
  // so candidate's outbound first message lands on the SAME pool number the
  // server will use for replies.
  const sendNumber = pickPoolNumber(pool, requestedUserId)
  const smsHref = sendNumber
    ? `sms:${sendNumber}?body=${encodeURIComponent(smsBody)}`
    : null
  const qrSrc = smsHref
    ? `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(smsHref)}`
    : null

  return (
    <Page>
      <main className="public-job-shell">
        <Link className="public-job-back" to="/">Back to jobs</Link>
        <section className="public-job-hero">
          <p className="candidate-kicker">Open role</p>
          <h1>{jobTitle}</h1>
          <p>{company}{job.location ? ` · ${job.location}` : ""}</p>
          <div className="public-job-facts">
            {salary ? <span>{salary}</span> : null}
            {job.jobType ? <span>{job.jobType}</span> : null}
            {job.seniorityLevel ? <span>{job.seniorityLevel}</span> : null}
          </div>
        </section>

        <section className="public-job-layout">
          <div className="public-job-main">
            {job.descriptionMd ? (
              <article className="public-job-card public-job-description">
                <h2>Role details</h2>
                <div>{renderJobDescription(job.descriptionMd, jobTitle, company)}</div>
              </article>
            ) : null}
            <JobTags job={job} />
          </div>

          <aside className="public-job-side">
            <div className="public-job-card public-job-start">
              <h2>Start the 5-minute screen</h2>
              <p>
            Reply to WeKruit on iMessage. We&rsquo;ll ask a few quick role-fit questions and let you know if you&rsquo;ve passed the initial screen.
              </p>
              {smsHref ? (
                <a className="candidate-primary-link" href={smsHref} onClick={() => setSmsClicked(true)}>
                  Open in iMessage
                </a>
              ) : (
                <p className="public-job-error">
                  WeKruit messaging temporarily unavailable. Please check back shortly.
                </p>
              )}
              {smsClicked ? (
                <p className="public-job-success">
                  Continue in iMessage to answer Claire. Sign in to see your status after you start.
                </p>
              ) : null}
              {qrSrc ? (
                <div className="public-job-qr">
                  <img src={qrSrc} width={180} height={180} alt="QR code to start pre-screen" />
                  <p>Scan on iPhone</p>
                </div>
              ) : null}
            </div>
            <InlineCvSection
              jobId={jobId!}
              requestedUserId={requestedUserId}
              initialHasCv={hasCvOnFile()}
            />
            {sendNumber ? (
              <p className="public-job-terms">
                By starting, you agree to our{" "}
                <a href="/legal">privacy &amp; terms</a>. WeKruit will text you from {sendNumber}.
              </p>
            ) : (
              <p className="public-job-terms">
                By starting, you agree to our <a href="/legal">privacy &amp; terms</a>.
              </p>
            )}
          </aside>
        </section>
      </main>
    </Page>
  )
}

function JobTags({ job }: { job: PaJobDoc }) {
  const groups = [
    { label: "Roles", values: job.roleFunction ?? [] },
    { label: "Industries", values: job.industrySector ?? [] },
    { label: "Skills", values: job.requiredSkills ?? [] },
  ].filter((group) => group.values.length > 0)
  if (groups.length === 0) return null
  return (
    <section className="public-job-card public-job-tags">
      <h2>What this role is looking for</h2>
      {groups.map((group) => (
        <div key={group.label}>
          <h3>{group.label}</h3>
          <p>
            {group.values.map((value) => (
              <span key={value}>{value}</span>
            ))}
          </p>
        </div>
      ))}
    </section>
  )
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <CandidateShell wide>
      <style>{PUBLIC_JOB_STYLES}</style>
      {children}
    </CandidateShell>
  )
}

const PUBLIC_JOB_STYLES = `
.public-job-shell {
  max-width: 1040px;
  margin: 0 auto;
  display: grid;
  gap: 18px;
}
.public-job-back {
  justify-self: flex-start;
  color: #46624c;
  font-weight: 800;
  text-decoration: none;
}
.public-job-hero {
  max-width: 780px;
}
.public-job-hero h1 {
  margin: 0;
  font-size: clamp(36px, 6vw, 58px);
  line-height: 1;
  letter-spacing: 0;
}
.public-job-hero p {
  margin: 12px 0 0;
  color: #364233;
  font-size: 18px;
  line-height: 1.45;
}
.public-job-facts {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 16px;
}
.public-job-facts span {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 10px;
  border-radius: 8px;
  background: #edf5ee;
  color: #24543c;
  font-weight: 900;
}
.public-job-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
  gap: 16px;
  align-items: start;
}
.public-job-main,
.public-job-side {
  display: grid;
  gap: 12px;
}
.public-job-card {
  border: 1px solid #ddd3c2;
  border-radius: 8px;
  background: #fffdf8;
  padding: 18px;
}
.public-job-card h2 {
  margin: 0 0 12px;
  font-size: 21px;
  letter-spacing: 0;
}
.public-job-description div {
  color: #364233;
  font-size: 15px;
  line-height: 1.58;
}
.public-job-description h3 {
  margin: 18px 0 8px;
  font-size: 17px;
  letter-spacing: 0;
  color: #18211a;
}
.public-job-description h3:first-child {
  margin-top: 0;
}
.public-job-description p,
.public-job-description ul {
  margin: 0 0 12px;
}
.public-job-description ul {
  padding-left: 20px;
}
.public-job-description li {
  margin: 6px 0;
}
.public-job-start {
  gap: 12px;
  display: grid;
}
.public-job-start p {
  margin: 0;
  color: #364233;
  line-height: 1.5;
}
.public-job-cv {
  display: grid;
  gap: 10px;
}
.public-job-cv p {
  margin: 0;
  color: #364233;
  line-height: 1.45;
}
.public-job-cv-ready {
  margin: 0;
  padding: 12px;
  border: 1px solid #c6e6ce;
  border-radius: 8px;
  background: #e8f5ec;
  color: #24543c;
  font-weight: 800;
}
.public-job-cv-ready span {
  white-space: nowrap;
}
.public-job-upload {
  display: grid;
  gap: 8px;
}
.public-job-upload > div {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.public-job-file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.public-job-file-button {
  display: inline-flex;
  align-items: center;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid #cfc3ae;
  border-radius: 8px;
  background: #fffdf8;
  color: #2f6f4f;
  font-weight: 800;
  cursor: pointer;
}
.public-job-file-name {
  min-width: 0;
  max-width: 100%;
  color: #5f665b;
  overflow-wrap: anywhere;
}
.public-job-upload button {
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid #2f6f4f;
  border-radius: 8px;
  background: #2f6f4f;
  color: #fffdf8;
  font-weight: 800;
  cursor: pointer;
}
.public-job-upload button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.public-job-success {
  padding: 12px;
  border: 1px solid #c6e6ce;
  border-radius: 8px;
  background: #e8f5ec;
  color: #24543c !important;
  font-weight: 800;
}
.public-job-error {
  color: #9c2b24 !important;
  font-weight: 800;
}
.public-job-qr {
  display: grid;
  justify-items: center;
  gap: 4px;
  padding-top: 4px;
}
.public-job-qr img {
  width: 180px;
  height: 180px;
}
.public-job-qr p,
.public-job-terms,
.public-job-muted {
  color: #7a6f5d;
  font-size: 13px;
}
.public-job-tags {
  display: grid;
  gap: 12px;
}
.public-job-tags h3 {
  margin: 0 0 8px;
  font-size: 15px;
  letter-spacing: 0;
}
.public-job-tags p {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0;
}
.public-job-tags span {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 9px;
  border-radius: 8px;
  background: #edf5ee;
  color: #24543c;
  font-size: 12px;
  font-weight: 800;
}
.public-job-terms {
  margin: 0;
  line-height: 1.45;
}
@media (max-width: 860px) {
  .public-job-layout {
    grid-template-columns: 1fr;
  }
}
`
