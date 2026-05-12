/**
 * v1.9 Phase 87 — Public candidate-facing job page.
 *
 * Route: /j/:jobId (no auth)
 *
 * Reads pa-jobs/{jobId}.prescreenConfig + .publicVisible.
 * Renders JD + "Start pre-screen" SMS deep link + QR code + optional
 * CV upload flow.
 *
 * Generates a `requestedUserId` UUID cookie per visit. CF webhook resolves
 * it on first inbound SMS via pa-prescreen-pending-invites/{requestedUserId}.
 */
import { useEffect, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import { doc, getDoc, setDoc } from "firebase/firestore"
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

function getOrCreateRequestedUserId(jobId: string): string {
  const key = `wkr_rid_${jobId}`
  const existing = window.localStorage.getItem(key)
  if (existing) return existing
  const v = uuidV4()
  window.localStorage.setItem(key, v)
  return v
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
      <p style={{ marginTop: "1rem", fontSize: "0.85em", color: "#7a6f5d" }}>
        Have a resume? You can{" "}
        <a href={`/j/${jobId}/cv`}>upload it here</a>{" "}
        before starting — it makes the screen faster.
      </p>
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
