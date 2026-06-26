/**
 * /admin/interviews — all interview bookings (pa-interview-bookings) with a
 * per-row operator outcome-stamp control.
 *
 * Data: paAdminInterviewBookingsList (admin-gated callable; reuses the
 * runSchedulingStatus per-row projection). Outcome: paAdminInterviewOutcome
 * (writes booking status + emits the parallel candidate×job FSM event).
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import {
  getCandidateScheduling,
  setCandidateScheduling,
  type CandidateSchedulingState,
} from "../lib/candidate-scheduling-api.js"

const LIST_CALLABLE = "paAdminInterviewBookingsList"
const OUTCOME_CALLABLE = "paAdminInterviewOutcome"

type BookingRow = {
  bookingId: string
  userId?: string
  candidateName?: string
  candidateEmail?: string
  jobId?: string
  jobTitle?: string
  companyName?: string
  status?: string
  timeZone?: string
  offeredCount: number
  selectedSlotIso?: string
  when?: string
  meetingUrl?: string
  calBookingUid?: string
  source?: string
  confirmationEmailSentAt?: string
  outcomeAt?: string
  outcomeNote?: string
  lastError?: string
  fsmState?: string
  updatedAt?: string
}

type ListResult = {
  rows: BookingRow[]
  total: number
  truncated: boolean
  generatedAt: string
}

type Outcome = "completed" | "no_show" | "cancelled"

async function loadBookings(): Promise<ListResult> {
  const [{ httpsCallable }, firebase] = await Promise.all([
    import("firebase/functions"),
    import("../lib/firebase.js"),
  ])
  const fn = httpsCallable<Record<string, never>, ListResult>(firebase.functions(), LIST_CALLABLE)
  const result = await fn({})
  return result.data
}

async function stampOutcome(bookingId: string, outcome: Outcome, note?: string): Promise<void> {
  const [{ httpsCallable }, firebase] = await Promise.all([
    import("firebase/functions"),
    import("../lib/firebase.js"),
  ])
  const fn = httpsCallable(firebase.functions(), OUTCOME_CALLABLE)
  await fn({ bookingId, outcome, ...(note ? { note } : {}) })
}

function statusTone(status?: string): "ok" | "warn" | "info" | "muted" {
  switch (status) {
    case "confirmed":
    case "booked":
    case "completed":
      return "ok"
    case "failed":
    case "no_show":
    case "cancelled":
      return "warn"
    case "offered":
      return "info"
    default:
      return "muted"
  }
}

function formatWhen(iso?: string): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

const STATUS_FILTERS = ["all", "offered", "booked", "confirmed", "completed", "no_show", "cancelled", "failed"] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

export default function Interviews() {
  const [data, setData] = useState<ListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>("all")
  // Per-candidate scheduling eligibility, keyed by userId. Lazily loaded.
  const [scheduling, setScheduling] = useState<Record<string, CandidateSchedulingState>>({})
  const [schedBusyUid, setSchedBusyUid] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    void loadBookings()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleOutcome = useCallback(
    async (row: BookingRow, outcome: Outcome) => {
      const verb = outcome === "no_show" ? "no-show" : outcome
      const note = window.prompt(`Optional note for marking this interview ${verb}:`) ?? undefined
      // prompt → null when cancelled; empty string is a valid "no note". Treat
      // an explicit Cancel (null from prompt) as abort only when the user
      // dismisses; here we proceed since the action button was the intent.
      setBusyId(row.bookingId)
      try {
        await stampOutcome(row.bookingId, outcome, note?.trim() || undefined)
        load()
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyId(null)
      }
    },
    [load],
  )

  const rows = useMemo(() => {
    const all = data?.rows ?? []
    const filtered = filter === "all" ? all : all.filter((r) => r.status === filter)
    // Sort by `when` (the slot) desc, falling back to updatedAt.
    return [...filtered].sort((a, b) => {
      const ax = a.when ?? a.updatedAt ?? ""
      const bx = b.when ?? b.updatedAt ?? ""
      return bx.localeCompare(ax)
    })
  }, [data, filter])

  // Lazily fetch scheduling eligibility for every distinct candidate uid in view.
  useEffect(() => {
    const uids = Array.from(
      new Set(rows.map((r) => r.userId).filter((u): u is string => typeof u === "string" && u.length > 0)),
    )
    let cancelled = false
    for (const uid of uids) {
      if (scheduling[uid]) continue // already loaded
      void getCandidateScheduling(uid)
        .then((state) => {
          if (!cancelled) setScheduling((prev) => ({ ...prev, [uid]: state }))
        })
        .catch(() => {
          // Non-fatal: leave the cell as "—" if eligibility can't be read.
        })
    }
    return () => {
      cancelled = true
    }
  }, [rows, scheduling])

  const handleToggleScheduling = useCallback(
    async (uid: string, candidateName: string, nextEnabled: boolean) => {
      if (nextEnabled) {
        const ok = window.confirm(
          `Enable REAL interview scheduling for ${candidateName}?\n\n` +
            "This lets Claire book an actual interview for this real candidate. " +
            "Only this one candidate is affected — the global flag is not changed.",
        )
        if (!ok) return
      }
      setSchedBusyUid(uid)
      try {
        const res = await setCandidateScheduling(uid, nextEnabled)
        setScheduling((prev) => ({
          ...prev,
          [uid]: { userId: uid, enabled: res.eligible, isDevUid: res.isDevUid },
        }))
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err))
      } finally {
        setSchedBusyUid(null)
      }
    },
    [],
  )

  if (loading) return <LoadingState label="Loading interviews…" />
  if (error) return <ErrorState message={error} />

  const isTerminal = (status?: string) =>
    status === "completed" || status === "no_show" || status === "cancelled"

  return (
    <div className="page-stack">
      <PageHeader
        title="Interviews"
        description="Every Cal.com interview booking. Stamp an outcome to record completed / no-show / cancelled — this also annotates the candidate×job pipeline."
        actions={
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as StatusFilter)}
              style={{ padding: "0.3rem 0.6rem", borderRadius: 6, border: "1px solid var(--ink-6, #ccc)", fontSize: "0.85rem" }}
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "All statuses" : s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn--sm" onClick={load}>
              Refresh
            </button>
          </div>
        }
      />

      <Panel
        title={`${rows.length} booking(s)${data?.truncated ? " · truncated (scan cap hit)" : ""}`}
      >
        {rows.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", opacity: 0.6 }}>No interview bookings in this filter.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Job</th>
                  <th>Status</th>
                  <th>When</th>
                  <th>Join</th>
                  <th>Pipeline state</th>
                  <th>Scheduling</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.bookingId}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{row.candidateName ?? row.userId ?? "—"}</div>
                      {row.candidateEmail && (
                        <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>{row.candidateEmail}</div>
                      )}
                    </td>
                    <td>
                      <div>{row.jobTitle ?? row.jobId ?? "—"}</div>
                      {row.companyName && (
                        <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>{row.companyName}</div>
                      )}
                    </td>
                    <td>
                      <Badge tone={statusTone(row.status)}>{(row.status ?? "—").replace(/_/g, " ")}</Badge>
                      {row.lastError && (
                        <div style={{ fontSize: "0.75rem", color: "var(--red, #ef4444)" }}>{row.lastError}</div>
                      )}
                    </td>
                    <td>
                      <div>{formatWhen(row.when)}</div>
                      {row.timeZone && (
                        <div style={{ fontSize: "0.75rem", opacity: 0.65 }}>{row.timeZone}</div>
                      )}
                    </td>
                    <td>
                      {row.meetingUrl ? (
                        <a href={row.meetingUrl} target="_blank" rel="noopener noreferrer" className="btn btn--sm">
                          Join
                        </a>
                      ) : (
                        <span style={{ opacity: 0.5 }}>—</span>
                      )}
                    </td>
                    <td>
                      {row.fsmState ? (
                        <span style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>
                          {row.fsmState.replace(/_/g, " ")}
                        </span>
                      ) : (
                        <span style={{ opacity: 0.5 }}>—</span>
                      )}
                      {row.outcomeAt && (
                        <div style={{ fontSize: "0.72rem", opacity: 0.65 }}>
                          stamped {formatWhen(row.outcomeAt)}
                          {row.outcomeNote ? ` · ${row.outcomeNote}` : ""}
                        </div>
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {(() => {
                        const uid = row.userId
                        if (!uid) return <span style={{ opacity: 0.5 }}>—</span>
                        const state = scheduling[uid]
                        if (!state) return <span style={{ opacity: 0.5 }}>…</span>
                        if (state.isDevUid) {
                          return <Badge tone="info">dev (always on)</Badge>
                        }
                        const name = row.candidateName ?? row.candidateEmail ?? uid
                        return (
                          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                            <Badge tone={state.enabled ? "ok" : "muted"}>
                              {state.enabled ? "enabled" : "disabled"}
                            </Badge>
                            <button
                              type="button"
                              className="btn btn--sm"
                              disabled={schedBusyUid === uid}
                              onClick={() => handleToggleScheduling(uid, name, !state.enabled)}
                              title={
                                state.enabled
                                  ? "Disable real interview scheduling for this candidate"
                                  : "Enable real interview scheduling for this candidate (books a real interview)"
                              }
                            >
                              {state.enabled ? "Disable" : "Enable"}
                            </button>
                          </div>
                        )
                      })()}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: "0.3rem" }}>
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={busyId === row.bookingId}
                          onClick={() => handleOutcome(row, "completed")}
                          title="Mark interview completed"
                        >
                          Completed
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={busyId === row.bookingId}
                          onClick={() => handleOutcome(row, "no_show")}
                          title="Mark candidate no-show"
                        >
                          No-show
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={busyId === row.bookingId}
                          onClick={() => handleOutcome(row, "cancelled")}
                          title="Mark interview cancelled"
                        >
                          Cancelled
                        </button>
                      </div>
                      {isTerminal(row.status) && (
                        <div style={{ fontSize: "0.72rem", opacity: 0.6, marginTop: "0.2rem" }}>
                          re-stamp updates the outcome
                        </div>
                      )}
                    </td>
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
