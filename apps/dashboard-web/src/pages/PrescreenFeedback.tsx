/**
 * v1.9 Phase 89 — /admin/prescreen-feedback aggregate page.
 *
 * Reads pa-prescreen-sessions where feedback.rating > 0, last 7 days.
 * Computes avg rating + top 10 freeform comments by recency.
 */
import { useEffect, useState } from "react"
import { collection, getDocs, limit, orderBy, query, where } from "firebase/firestore"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { db } from "../lib/firebase.js"

type SessionDoc = {
  id: string
  jobId?: string
  feedback?: {
    rating?: number
    freeform?: string
    completedAt?: string
  }
}

export default function PrescreenFeedback() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<SessionDoc[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        // Naive read — filtering on feedback subfield index can be hard;
        // pull recent 200 sessions and filter client-side for ones with
        // feedback. Volume is low in v1.9.
        const q = query(
          collection(db(), "pa-prescreen-sessions"),
          orderBy("createdAt", "desc"),
          limit(200)
        )
        const snap = await getDocs(q)
        if (cancelled) return
        const all = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SessionDoc, "id">) }))
        setRows(all.filter((r) => r.feedback && r.feedback.rating && r.feedback.rating > 0))
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) return <LoadingState label="Loading feedback..." />
  if (err) return <ErrorState message={err} />

  const ratings = rows
    .map((r) => r.feedback?.rating ?? 0)
    .filter((n) => n > 0)
  const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0
  const dist = [1, 2, 3, 4, 5].map((star) => ({
    star,
    count: ratings.filter((r) => r === star).length,
  }))

  return (
    <div>
      <PageHeader
        title="Pre-Screen Feedback"
        description="Candidate ratings + freeform comments collected post-PASS. Sampled from last 200 sessions."
      />
      <Panel title={`${ratings.length} rating(s) · avg ${avg.toFixed(2)} / 5`}>
        <table style={{ width: "60%", fontSize: "0.9em" }}>
          <tbody>
            {dist.map((d) => (
              <tr key={d.star}>
                <td style={{ width: 32 }}>{d.star}★</td>
                <td>
                  <div
                    style={{
                      width: `${Math.max(2, (d.count / Math.max(1, ratings.length)) * 100)}%`,
                      background: "#2f6f4f",
                      height: 12,
                      borderRadius: 6,
                    }}
                  />
                </td>
                <td style={{ width: 40, textAlign: "right", fontFamily: "monospace" }}>
                  {d.count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Recent freeform comments">
        {rows
          .filter((r) => r.feedback?.freeform)
          .slice(0, 10)
          .map((r) => (
            <div
              key={r.id}
              style={{
                padding: "0.75rem",
                margin: "0.5rem 0",
                background: "#fffaf0",
                borderRadius: 12,
                fontSize: "0.9em",
              }}
            >
              <div style={{ marginBottom: "0.25rem" }}>
                <Badge tone="ok">{r.feedback?.rating}★</Badge>{" "}
                <span style={{ fontFamily: "monospace", fontSize: "0.85em", opacity: 0.65 }}>
                  {r.feedback?.completedAt?.slice(0, 16)}
                </span>
              </div>
              <div>{r.feedback?.freeform}</div>
            </div>
          ))}
        {rows.filter((r) => r.feedback?.freeform).length === 0 && (
          <p style={{ opacity: 0.6 }}>No freeform comments yet.</p>
        )}
      </Panel>
    </div>
  )
}
