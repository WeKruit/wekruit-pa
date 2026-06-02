/**
 * `/admin/layoff-employers` — WeKruit Open employer signups.
 *
 * Backs `layoff_employers/{id}` writes from openRegisterEmployer (called by
 * layoff.wekruit.com/employer). Ops reviews each row, flips
 * verificationStatus to "verified" once they've sanity-checked the work
 * email + company. Verified employers can then call
 * openListLayoffCandidates (runListLayoffCandidates filters by
 * `verificationStatus === "verified"`).
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react"
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  setDoc,
} from "firebase/firestore"

import { auth, db } from "../lib/firebase.js"
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"

const COLLECTION = "layoff_employers"

type VerificationStatus = "pending" | "verified" | "rejected" | string

type EmployerRow = {
  id: string
  companyName?: string
  companyLinkedin?: string
  workEmail?: string
  workEmailLower?: string
  stage?: string
  roleAtCompany?: string
  rolesHiring?: string[]
  hardFilters?: string[]
  screeningQuestions?: string[]
  calibrationExamples?: string
  feedbackLoop?: string
  introHandoff?: string
  screeningPacket?: {
    version?: number
    source?: string
    reviewStatus?: string
    roleBrief?: string[]
    hardFilters?: string[]
    evidenceProbes?: string[]
    calibrationExamples?: string
    feedbackLoop?: string
    introHandoff?: string
  }
  contactName?: string
  notes?: string
  verificationStatus?: VerificationStatus
  verifiedAt?: string | null
  verifiedBy?: string | null
  rejectedAt?: string | null
  rejectedBy?: string | null
  registeredAt?: { toDate?: () => Date } | string | null
  registeredByUid?: string | null
}

type StatusFilter = "all" | "pending" | "verified" | "rejected"

function operatorEmail(): string {
  return auth().currentUser?.email ?? "unknown@wekruit.com"
}

function fmtRegistered(value: EmployerRow["registeredAt"]): string {
  if (!value) return "—"
  if (typeof value === "string") return value.slice(0, 19).replace("T", " ")
  if (typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString().slice(0, 19).replace("T", " ")
  }
  return "—"
}

function pillStyle(status: VerificationStatus | undefined): CSSProperties {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 500,
    border: "1px solid",
    fontFamily: "inherit",
  }
  if (status === "verified") return { ...base, background: "#e6f6ec", color: "#1f7a3a", borderColor: "#bbe1c5" }
  if (status === "rejected") return { ...base, background: "#fde8e8", color: "#9a2929", borderColor: "#f3c0c0" }
  return { ...base, background: "#fff4d6", color: "#7a5a14", borderColor: "#ecd790" }
}

export default function LayoffEmployers() {
  const [rows, setRows] = useState<EmployerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [search, setSearch] = useState("")
  const [acting, setActing] = useState<Record<string, boolean>>({})

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const q = query(collection(db(), COLLECTION), orderBy("registeredAt", "desc"))
      const snap = await getDocs(q)
      const next: EmployerRow[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<EmployerRow, "id">) }))
      setRows(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (statusFilter !== "all" && (r.verificationStatus ?? "pending") !== statusFilter) return false
      if (!needle) return true
      const hay = [
        r.companyName,
        r.workEmailLower ?? r.workEmail,
        r.contactName,
        r.roleAtCompany,
        r.stage,
        ...(r.hardFilters ?? []),
        ...(r.screeningQuestions ?? []),
        ...(r.screeningPacket?.roleBrief ?? []),
        ...(r.screeningPacket?.hardFilters ?? []),
        ...(r.screeningPacket?.evidenceProbes ?? []),
        r.screeningPacket?.calibrationExamples,
        r.screeningPacket?.feedbackLoop,
        r.screeningPacket?.introHandoff,
        r.calibrationExamples,
        r.feedbackLoop,
        r.introHandoff,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return hay.includes(needle)
    })
  }, [rows, statusFilter, search])

  async function setStatus(id: string, status: VerificationStatus) {
    if (acting[id]) return
    setActing((prev) => ({ ...prev, [id]: true }))
    try {
      const patch: Record<string, unknown> = {
        verificationStatus: status,
        lastReviewedBy: operatorEmail(),
        lastReviewedAt: new Date().toISOString(),
      }
      if (status === "verified") {
        patch.verifiedAt = new Date().toISOString()
        patch.verifiedBy = operatorEmail()
      } else if (status === "rejected") {
        patch.rejectedAt = new Date().toISOString()
        patch.rejectedBy = operatorEmail()
      }
      await setDoc(doc(db(), COLLECTION, id), patch, { merge: true })
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } as EmployerRow : r)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }

  const counts = useMemo(() => {
    const c = { all: rows.length, pending: 0, verified: 0, rejected: 0 }
    for (const r of rows) {
      const s = (r.verificationStatus ?? "pending") as keyof typeof c
      if (s in c) c[s] += 1
    }
    return c
  }, [rows])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16 }}>
      <PageHeader
        title="Layoff employers"
        description="layoff.wekruit.com /employer signups. Verify before the marketplace lists their access."
      />
      <Panel>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <StatusTabs current={statusFilter} counts={counts} onChange={setStatusFilter} />
          <div style={{ flex: 1 }} />
          <input
            type="search"
            placeholder="Search company / email / contact…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              padding: "8px 12px",
              border: "1px solid #d0d0d0",
              borderRadius: 6,
              fontSize: 14,
              minWidth: 280,
            }}
          />
          <button
            onClick={() => void load()}
            style={{
              padding: "8px 14px",
              border: "1px solid #d0d0d0",
              background: "#fff",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Reload
          </button>
        </div>
      </Panel>

      {loading ? (
        <LoadingState label="Loading employer signups…" />
      ) : error ? (
        <ErrorState message={error} />
      ) : filtered.length === 0 ? (
        <EmptyState title="No employer signups" body="Once someone fills /employer on layoff.wekruit.com they'll show up here." />
      ) : (
        <Panel>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ background: "#fafafa", textAlign: "left" }}>
                <th style={th}>Company</th>
                <th style={th}>Contact</th>
                <th style={th}>Roles hiring</th>
                <th style={th}>Stage</th>
                <th style={th}>Registered</th>
                <th style={th}>Status</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #eee", verticalAlign: "top" }}>
                  <td style={td}>
                    <div style={{ fontWeight: 500 }}>{r.companyName ?? "—"}</div>
                    {r.companyLinkedin && (
                      <a
                        href={r.companyLinkedin}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 12, color: "#666" }}
                      >
                        LinkedIn ↗
                      </a>
                    )}
                  </td>
                  <td style={td}>
                    <div>{r.contactName ?? "—"}</div>
                    <div style={{ fontSize: 12, color: "#666" }}>{r.roleAtCompany ?? "—"}</div>
                    <a href={`mailto:${r.workEmailLower ?? r.workEmail ?? ""}`} style={{ fontSize: 12, color: "#3a6ea5" }}>
                      {r.workEmailLower ?? r.workEmail ?? "—"}
                    </a>
                  </td>
                  <td style={td}>
                    {r.rolesHiring?.length ? r.rolesHiring.join(", ") : "—"}
                    {r.screeningPacket ? <ScreeningPacketDetails packet={r.screeningPacket} /> : null}
                    {r.hardFilters?.length ? (
                      <details style={{ marginTop: 6, fontSize: 12, color: "#555" }}>
                        <summary style={{ cursor: "pointer", color: "#3a6ea5" }}>Hard filters</summary>
                        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                          {r.hardFilters.map((filter) => (
                            <li key={filter}>{filter}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {r.screeningQuestions?.length ? (
                      <details style={{ marginTop: 6, fontSize: 12, color: "#555" }}>
                        <summary style={{ cursor: "pointer", color: "#3a6ea5" }}>Screening questions</summary>
                        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                          {r.screeningQuestions.map((question) => (
                            <li key={question}>{question}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {r.calibrationExamples ? (
                      <details style={{ marginTop: 6, fontSize: 12, color: "#555" }}>
                        <summary style={{ cursor: "pointer", color: "#3a6ea5" }}>Calibration examples</summary>
                        <pre style={{ whiteSpace: "pre-wrap", margin: "6px 0 0", fontFamily: "inherit" }}>
                          {r.calibrationExamples}
                        </pre>
                      </details>
                    ) : null}
                    {r.feedbackLoop ? (
                      <details style={{ marginTop: 6, fontSize: 12, color: "#555" }}>
                        <summary style={{ cursor: "pointer", color: "#3a6ea5" }}>Feedback loop</summary>
                        <pre style={{ whiteSpace: "pre-wrap", margin: "6px 0 0", fontFamily: "inherit" }}>
                          {r.feedbackLoop}
                        </pre>
                      </details>
                    ) : null}
                    {r.introHandoff ? (
                      <details style={{ marginTop: 6, fontSize: 12, color: "#555" }}>
                        <summary style={{ cursor: "pointer", color: "#3a6ea5" }}>Intro handoff</summary>
                        <pre style={{ whiteSpace: "pre-wrap", margin: "6px 0 0", fontFamily: "inherit" }}>
                          {r.introHandoff}
                        </pre>
                      </details>
                    ) : null}
                    {r.notes && (
                      <details style={{ marginTop: 6, fontSize: 12, color: "#555" }}>
                        <summary style={{ cursor: "pointer", color: "#3a6ea5" }}>Notes</summary>
                        <pre style={{ whiteSpace: "pre-wrap", margin: "6px 0 0", fontFamily: "inherit" }}>{r.notes}</pre>
                      </details>
                    )}
                  </td>
                  <td style={td}>{r.stage ?? "—"}</td>
                  <td style={td}>{fmtRegistered(r.registeredAt)}</td>
                  <td style={td}>
                    <span style={pillStyle(r.verificationStatus)}>{r.verificationStatus ?? "pending"}</span>
                  </td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={() => void setStatus(r.id, "verified")}
                        disabled={r.verificationStatus === "verified" || !!acting[r.id]}
                        style={btnPrimary(r.verificationStatus === "verified")}
                      >
                        Verify
                      </button>
                      <button
                        onClick={() => void setStatus(r.id, "rejected")}
                        disabled={r.verificationStatus === "rejected" || !!acting[r.id]}
                        style={btnGhost(r.verificationStatus === "rejected")}
                      >
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  )
}

function screeningPacketStatusLabel(status: string | undefined): string {
  if (status === "needs_wekruit_review") return "needs WeKruit review before Claire screens"
  return status ?? "needs WeKruit review before Claire screens"
}

function ScreeningPacketDetails({
  packet,
}: {
  packet: NonNullable<EmployerRow["screeningPacket"]>
}) {
  return (
    <details open style={{ marginTop: 8, fontSize: 12, color: "#444" }}>
      <summary style={{ cursor: "pointer", color: "#1f4f80", fontWeight: 600 }}>
        Claire screening packet
      </summary>
      <div
        style={{
          border: "1px solid #d8e3ef",
          borderRadius: 6,
          background: "#f7fbff",
          marginTop: 6,
          padding: 8,
        }}
      >
        <div style={{ fontWeight: 600, color: "#1f4f80", marginBottom: 6 }}>
          {screeningPacketStatusLabel(packet.reviewStatus)}
        </div>
        <ScreeningPacketList label="Role brief" values={packet.roleBrief} />
        <ScreeningPacketList label="Hard filters" values={packet.hardFilters} />
        <ScreeningPacketList label="Evidence probes" values={packet.evidenceProbes} />
        <ScreeningPacketText label="Calibration examples" value={packet.calibrationExamples} />
        <ScreeningPacketText label="Feedback loop" value={packet.feedbackLoop} />
        <ScreeningPacketText label="Intro handoff" value={packet.introHandoff} />
      </div>
    </details>
  )
}

function ScreeningPacketList({ label, values }: { label: string; values?: string[] }) {
  if (!values?.length) return null
  return (
    <div style={{ marginTop: 6 }}>
      <strong>{label}</strong>
      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
        {values.map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ul>
    </div>
  )
}

function ScreeningPacketText({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div style={{ marginTop: 6 }}>
      <strong>{label}</strong>
      <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0 0", fontFamily: "inherit" }}>{value}</pre>
    </div>
  )
}

function StatusTabs({
  current,
  counts,
  onChange,
}: {
  current: StatusFilter
  counts: { all: number; pending: number; verified: number; rejected: number }
  onChange: (s: StatusFilter) => void
}) {
  const tabs: { value: StatusFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: counts.all },
    { value: "pending", label: "Pending", count: counts.pending },
    { value: "verified", label: "Verified", count: counts.verified },
    { value: "rejected", label: "Rejected", count: counts.rejected },
  ]
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {tabs.map((t) => {
        const active = current === t.value
        return (
          <button
            key={t.value}
            onClick={() => onChange(t.value)}
            style={{
              padding: "6px 12px",
              border: "1px solid " + (active ? "#3a6ea5" : "#d0d0d0"),
              background: active ? "#eaf2fb" : "#fff",
              color: active ? "#1f4f80" : "#333",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: active ? 600 : 400,
            }}
          >
            {t.label} <span style={{ color: "#888", fontWeight: 400 }}>({t.count})</span>
          </button>
        )
      })}
    </div>
  )
}

const th: CSSProperties = {
  padding: "10px 12px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "#666",
  fontWeight: 600,
}

const td: CSSProperties = {
  padding: "12px",
}

function btnPrimary(disabled: boolean): CSSProperties {
  return {
    padding: "6px 10px",
    border: "1px solid #1f7a3a",
    background: disabled ? "#cfe9d5" : "#1f7a3a",
    color: disabled ? "#5a8966" : "#fff",
    borderRadius: 6,
    cursor: disabled ? "default" : "pointer",
    fontSize: 12,
  }
}

function btnGhost(disabled: boolean): CSSProperties {
  return {
    padding: "6px 10px",
    border: "1px solid #9a2929",
    background: "#fff",
    color: disabled ? "#c69999" : "#9a2929",
    borderRadius: 6,
    cursor: disabled ? "default" : "pointer",
    fontSize: 12,
  }
}
