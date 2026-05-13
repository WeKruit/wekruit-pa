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
import { useEffect, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import { doc, getDoc, setDoc } from "firebase/firestore"

const CV_INGEST_URL = import.meta.env.VITE_CV_INGEST_URL ?? ""
import { db } from "../lib/firebase.js"

interface PrescreenConfig {
  jobTitle?: string
  company?: string
  level1Reveal?: {
    salaryRange?: string
  }
}

interface PaJobDoc {
  publicVisible?: boolean
  prescreenConfig?: PrescreenConfig
  descriptionMd?: string
  location?: string
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
      <p
        style={{
          marginTop: "1rem",
          fontSize: "0.9em",
          color: "#16643b",
          fontWeight: 700,
          background: "#e8f5ec",
          padding: "0.75rem 1rem",
          borderRadius: 12,
          border: "1px solid #c6e6ce",
        }}
      >
        ✓ We have your resume on file — tap{" "}
        <span style={{ whiteSpace: "nowrap" }}>"Open in iMessage"</span> above to start.
      </p>
    )
  }
  return (
    <div
      style={{
        marginTop: "1rem",
        padding: "1rem",
        background: "#fff",
        border: "1px solid #e3dccd",
        borderRadius: 18,
      }}
    >
      <h3 style={{ marginTop: 0, marginBottom: "0.25rem", fontSize: "1rem" }}>
        Have a resume? Upload it here (optional)
      </h3>
      <p style={{ margin: "0 0 0.5rem", color: "#5f665b", fontSize: "0.85em" }}>
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
    <form onSubmit={onSubmit} style={{ marginTop: "0.5rem" }}>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={status === "uploading"}
        />
        <button
          type="submit"
          disabled={!file || status === "uploading"}
          style={{
            padding: "0.55rem 1.25rem",
            background: file && status !== "uploading" ? "#2f6f4f" : "#cbd5e1",
            color: "#fff7df",
            borderRadius: 999,
            border: "none",
            fontWeight: 700,
            cursor: file && status !== "uploading" ? "pointer" : "not-allowed",
            whiteSpace: "nowrap",
          }}
        >
          {status === "uploading" ? "Parsing resume…" : "Upload"}
        </button>
      </div>
      {status === "uploading" ? (
        <p style={{ marginTop: "0.5rem", fontSize: "0.85em", color: "#7a6f5d" }}>
          Reading your CV — takes 10-30 seconds.
        </p>
      ) : null}
      {status === "err" && errMsg ? (
        <p style={{ marginTop: "0.5rem", color: "#9c2b24", fontWeight: 700 }}>{errMsg}</p>
      ) : null}
    </form>
  )
}

export default function PublicJob() {
  const { jobId } = useParams<{ jobId: string }>()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [job, setJob] = useState<PaJobDoc | null>(null)
  const [pool, setPool] = useState<PoolNumber[] | null>(null)

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
  const jobTitle = cfg.jobTitle ?? "Open role"
  const company = cfg.company ?? "Confidential employer"
  const salary = cfg.level1Reveal?.salaryRange

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
      <h1 style={{ marginBottom: "0.25rem" }}>{jobTitle}</h1>
      <p style={{ color: "#5f665b", marginTop: 0 }}>{company}{job.location ? ` · ${job.location}` : ""}</p>
      {salary ? <p style={{ color: "#16643b", fontWeight: 700 }}>{salary}</p> : null}
      {job.descriptionMd ? (
        <article
          style={{
            background: "#fffaf0",
            padding: "1rem",
            border: "1px solid #e3dccd",
            borderRadius: 18,
            margin: "1rem 0",
            whiteSpace: "pre-wrap",
            fontSize: "0.95rem",
            lineHeight: 1.5,
          }}
        >
          {job.descriptionMd}
        </article>
      ) : null}
      <div
        style={{
          display: "flex",
          gap: "1.5rem",
          alignItems: "center",
          flexWrap: "wrap",
          padding: "1rem",
          background: "#fff",
          border: "1px solid #e3dccd",
          borderRadius: 18,
        }}
      >
        <div>
          <h3 style={{ marginTop: 0 }}>Start the 5-minute screen</h3>
          <p style={{ margin: "0.25rem 0", color: "#5f665b" }}>
            Reply to WeKruit on iMessage. We&rsquo;ll ask a few quick role-fit questions and let you know if you&rsquo;ve passed the initial screen.
          </p>
          {smsHref ? (
            <a
              href={smsHref}
              style={{
                display: "inline-block",
                marginTop: "0.5rem",
                padding: "0.75rem 1.25rem",
                background: "#2f6f4f",
                color: "#fff7df",
                borderRadius: 999,
                textDecoration: "none",
                fontWeight: 700,
              }}
            >
              Open in iMessage →
            </a>
          ) : (
            <p style={{ color: "#9c2b24", fontWeight: 700, marginTop: "0.5rem" }}>
              WeKruit messaging temporarily unavailable. Please check back shortly.
            </p>
          )}
        </div>
        {qrSrc ? (
          <div style={{ textAlign: "center" }}>
            <img src={qrSrc} width={180} height={180} alt="QR code to start pre-screen" />
            <p style={{ margin: "0.25rem 0", fontSize: "0.8em", color: "#7a6f5d" }}>
              Scan on iPhone
            </p>
          </div>
        ) : null}
      </div>
      {/* v1.9 hotfix 2026-05-13 — inline upload UI (no /cv route). */}
      <InlineCvSection
        jobId={jobId!}
        requestedUserId={requestedUserId}
        initialHasCv={hasCvOnFile()}
      />
      {sendNumber ? (
        <p style={{ fontSize: "0.75em", color: "#a59781", marginTop: "2rem" }}>
          By starting, you agree to our{" "}
          <a href="/legal">privacy &amp; terms</a>. WeKruit will text you from {sendNumber}.
        </p>
      ) : (
        <p style={{ fontSize: "0.75em", color: "#a59781", marginTop: "2rem" }}>
          By starting, you agree to our <a href="/legal">privacy &amp; terms</a>.
        </p>
      )}
    </Page>
  )
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "2rem 1.25rem" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <strong style={{ fontSize: "1.1rem", letterSpacing: "-0.02em" }}>WeKruit</strong>
      </header>
      {children}
    </div>
  )
}
