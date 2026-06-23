// Admin job-quality view — which collaborated jobs are missing Pay / Visa /
// Benefits. Pairs with the recruiter Logistics block: same resolver, so what an
// operator sees here is exactly what the recruiter brief renders. Reads pa-jobs
// client-side (collab set is small) and flags gaps for backfill.

import { useEffect, useMemo, useState } from "react"
import { collection, getDocs, query, where } from "firebase/firestore"
import { resolveJobLogistics } from "@pa/core-types"
import { db } from "../lib/firebase.js"
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"

interface Row {
  id: string
  title: string
  company: string
  pay?: string
  visa?: string
  benefits?: string
}

type Filter = "all" | "missing"

export default function JobQuality() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>("all")

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDocs(
          query(collection(db(), "pa-jobs"), where("wekruitCollaborationStatus", "==", "collaborated")),
        )
        const out: Row[] = []
        snap.forEach((d) => {
          const j = d.data() as Record<string, unknown>
          if (j.publicVisible !== true || j.dead === true) return
          const l = resolveJobLogistics(j)
          out.push({
            id: d.id,
            title: String(j.title ?? j.jobTitle ?? d.id),
            company: String(j.companyName ?? j.company ?? "—"),
            pay: l.pay,
            visa: l.visa,
            benefits: l.benefits,
          })
        })
        out.sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title))
        if (!cancelled) setRows(out)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const counts = useMemo(() => {
    const r = rows ?? []
    return {
      total: r.length,
      pay: r.filter((x) => !x.pay).length,
      visa: r.filter((x) => !x.visa).length,
      benefits: r.filter((x) => !x.benefits).length,
    }
  }, [rows])

  const shown = useMemo(() => {
    const r = rows ?? []
    return filter === "missing" ? r.filter((x) => !x.pay || !x.visa || !x.benefits) : r
  }, [rows, filter])

  if (err) return <ErrorState message={err} />
  if (!rows) return <LoadingState label="Loading collaborated jobs..." />

  return (
    <div>
      <PageHeader
        title="Job quality"
        description="Which collaborated jobs are missing Pay, Visa, or Benefits. Same resolver the recruiter Logistics block uses."
      />
      <Panel>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <Stat label="Collab jobs" value={counts.total} />
          <Stat label="Missing pay" value={counts.pay} tone={counts.pay ? "warn" : "ok"} />
          <Stat label="Missing visa" value={counts.visa} tone={counts.visa ? "warn" : "ok"} />
          <Stat label="Missing benefits" value={counts.benefits} tone={counts.benefits ? "warn" : "ok"} />
          <span style={{ flex: 1 }} />
          <label style={{ fontSize: 13, color: "#6a5f52", display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={filter === "missing"}
              onChange={(e) => setFilter(e.target.checked ? "missing" : "all")}
            />
            Only jobs missing something
          </label>
        </div>
        {shown.length === 0 ? (
          <EmptyState title="Nothing to show" body="No collaborated jobs match this filter." />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#9a8c7b", fontSize: 11, textTransform: "uppercase" }}>
                  <th style={th}>Company · Role</th>
                  <th style={th}>Pay</th>
                  <th style={th}>Visa</th>
                  <th style={th}>Benefits</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} style={{ borderTop: "1px solid #efe7dc" }}>
                    <td style={td}>
                      <div style={{ fontWeight: 600, color: "#2b2119" }}>{r.title}</div>
                      <div style={{ color: "#897462", fontSize: 12 }}>{r.company}</div>
                    </td>
                    <Cell value={r.pay} />
                    <Cell value={r.visa} />
                    <Cell value={r.benefits} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}

const th: React.CSSProperties = { padding: "6px 10px", fontWeight: 600 }
const td: React.CSSProperties = { padding: "8px 10px", verticalAlign: "top" }

function Cell({ value }: { value?: string }) {
  return (
    <td style={td}>
      {value ? (
        <span style={{ color: "#3a3a36" }}>{value.length > 60 ? value.slice(0, 60) + "…" : value}</span>
      ) : (
        <Badge tone="warn">Missing</Badge>
      )}
    </td>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, textTransform: "uppercase", color: "#9a8c7b" }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 700, color: tone === "warn" ? "#b4541f" : "#2b2119" }}>{value}</span>
    </div>
  )
}
