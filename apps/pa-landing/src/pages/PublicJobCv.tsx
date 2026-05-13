/**
 * v1.9 Phase 87 — Public CV upload flow attached to /j/:jobId/cv.
 *
 * No auth. Reads pa-jobs/{jobId} (public-flagged), accepts PDF/DOCX upload,
 * POSTs base64 body to PA_CV_INGEST_URL env (configured at build).
 *
 * tempUserId from localStorage cookie (same key as PublicJob page).
 */
import { useEffect, useMemo, useState } from "react"
import { useParams } from "react-router-dom"

const CV_INGEST_URL = import.meta.env.VITE_CV_INGEST_URL ?? ""

function uuidV4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// v1.9 hotfix (2026-05-12) — share single global UID across all /j/:jobId
// pages. Matches the same scheme in PublicJob.tsx.
const GLOBAL_UID_KEY = "wkr_uid"
const HAS_CV_KEY = "wkr_has_cv"

function getOrCreateRequestedUserId(_jobId: string): string {
  const existingGlobal = window.localStorage.getItem(GLOBAL_UID_KEY)
  if (existingGlobal) return existingGlobal
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

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const result = r.result as string
      // strip data: prefix
      const idx = result.indexOf(",")
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export default function PublicJobCv() {
  const { jobId } = useParams<{ jobId: string }>()
  const requestedUserId = useMemo(() => (jobId ? getOrCreateRequestedUserId(jobId) : ""), [jobId])
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<"idle" | "uploading" | "ok" | "err">("idle")
  const [errMsg, setErrMsg] = useState<string | null>(null)

  useEffect(() => {
    setStatus("idle")
    setErrMsg(null)
  }, [file])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file || !jobId) return
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
      // v1.9 hotfix — stamp local "has CV" flag so subsequent /j/:jobId
      // pages can skip the upload prompt for this returning user.
      try {
        window.localStorage.setItem(HAS_CV_KEY, "true")
      } catch {
        // localStorage disabled — non-fatal; upload still succeeded.
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
      <form onSubmit={onSubmit} style={{ marginTop: "1.5rem" }}>
        <input
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button
          type="submit"
          disabled={!file || status === "uploading"}
          style={{
            display: "inline-block",
            marginLeft: "0.75rem",
            padding: "0.55rem 1rem",
            background: file ? "#2f6f4f" : "#cbd5e1",
            color: "#fff7df",
            borderRadius: 999,
            border: "none",
            fontWeight: 700,
            cursor: file ? "pointer" : "not-allowed",
          }}
        >
          {status === "uploading" ? "Uploading…" : "Upload"}
        </button>
      </form>
      {status === "ok" ? (
        <p style={{ marginTop: "1rem", color: "#16643b", fontWeight: 700 }}>
          ✓ Got it. Head back to <a href={`/j/${jobId}`}>the job page</a> and tap "Open in iMessage" to start the screen.
        </p>
      ) : null}
      {status === "err" && errMsg ? (
        <p style={{ marginTop: "1rem", color: "#9c2b24" }}>{errMsg}</p>
      ) : null}
    </div>
  )
}
