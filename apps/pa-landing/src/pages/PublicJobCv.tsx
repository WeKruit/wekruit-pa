/**
 * v1.9 Phase 87 — Public CV upload flow attached to /j/:jobId/cv (legacy).
 *
 * Requires Firebase auth — redirects unsigned users to /login.
 */
import { useEffect, useMemo, useState } from "react"
import { Link, Navigate, useNavigate, useParams } from "react-router-dom"
import { onAuthStateChanged, type User } from "firebase/auth"
import { GLOBAL_UID_KEY, getBrowserUid, readStoredValue, rememberStoredValue } from "../lib/browser-identity"
import { auth } from "../lib/firebase.js"
import { readStoredCandidateId } from "../lib/candidate-verify.js"
import { canonicalPublicJobId } from "../lib/public-job-slugs.js"

const CV_INGEST_URL = import.meta.env.VITE_CV_INGEST_URL ?? ""
const HAS_CV_KEY = "wkr_has_cv"

function getOrCreateRequestedUserId(_jobId: string): string {
  const existingGlobal = readStoredValue(GLOBAL_UID_KEY)
  if (existingGlobal) return existingGlobal
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i)
    if (k && k.startsWith("wkr_rid_")) {
      const v = window.localStorage.getItem(k)
      if (v) {
        rememberStoredValue(GLOBAL_UID_KEY, v)
        return v
      }
    }
  }
  return getBrowserUid()
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

export default function PublicJobCv() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const publicJobId = useMemo(() => (jobId ? canonicalPublicJobId(jobId) : ""), [jobId])
  const requestedUserId = useMemo(() => (publicJobId ? getOrCreateRequestedUserId(publicJobId) : ""), [publicJobId])
  const nextPath = useMemo(() => (publicJobId ? `/j/${publicJobId}/cv` : "/"), [publicJobId])
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<"idle" | "uploading" | "ok" | "err">("idle")
  const [errMsg, setErrMsg] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth(), setUser)
    return unsubscribe
  }, [])

  useEffect(() => {
    if (jobId && publicJobId && jobId !== publicJobId) {
      navigate(`/j/${publicJobId}/cv`, { replace: true })
    }
  }, [jobId, navigate, publicJobId])

  useEffect(() => {
    setStatus("idle")
    setErrMsg(null)
  }, [file])

  if (user === undefined) {
    return (
      <div style={{ maxWidth: 540, margin: "0 auto", padding: "2rem 1.25rem" }}>
        <p style={{ color: "#5f665b" }}>Checking your sign-in…</p>
      </div>
    )
  }

  if (!user) {
    return <Navigate to={`/login?next=${encodeURIComponent(nextPath)}`} replace />
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file || !publicJobId) return
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
    const candidateId = readStoredCandidateId()
    if (!candidateId) {
      setStatus("err")
      setErrMsg("Finish sign-in verification before uploading your resume.")
      return
    }
    try {
      setStatus("uploading")
      const idToken = await user!.getIdToken()
      const b64 = await fileToBase64(file)
      const res = await fetch(CV_INGEST_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          userId: candidateId,
          browserUid: requestedUserId,
          resumeBase64: b64,
          resumeName: file.name,
          jobIdContext: publicJobId,
          source: "public_job_page",
        }),
      })
      if (!res.ok) {
        setStatus("err")
        setErrMsg(`Upload failed (${res.status})`)
        return
      }
      try {
        rememberStoredValue(HAS_CV_KEY, "true")
      } catch {
        // localStorage disabled — non-fatal
      }
      setStatus("ok")
    } catch (err) {
      setStatus("err")
      setErrMsg(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div style={{ maxWidth: 540, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <strong style={{ fontSize: "1.1rem", letterSpacing: "-0.02em" }}>WeKruit</strong>
      </header>
      <h1 style={{ marginBottom: "0.25rem" }}>Upload your resume</h1>
      <p style={{ color: "#5f665b", marginTop: 0 }}>
        PDF or DOCX, under 5 MB. We&rsquo;ll use it to tailor the pre-screen.
      </p>
      <p style={{ color: "#5f665b", fontSize: 14 }}>
        Signed in as {user.email ?? "your account"}.{" "}
        <Link to={`/j/${publicJobId}`}>Back to job</Link>
      </p>
      <form onSubmit={onSubmit} style={{ marginTop: "1.5rem" }}>
        <input
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={status === "uploading" || status === "ok"}
        />
        <button
          type="submit"
          disabled={!file || status === "uploading" || status === "ok"}
          style={{ marginTop: "1rem", padding: "0.6rem 1.2rem", cursor: "pointer" }}
        >
          {status === "uploading" ? "Uploading…" : "Upload"}
        </button>
        {status === "ok" ? (
          <p style={{ color: "#2d6a4f", marginTop: "1rem" }}>Resume uploaded. You can close this tab.</p>
        ) : null}
        {status === "err" && errMsg ? (
          <p style={{ color: "#9d3a2d", marginTop: "1rem" }}>{errMsg}</p>
        ) : null}
      </form>
    </div>
  )
}
