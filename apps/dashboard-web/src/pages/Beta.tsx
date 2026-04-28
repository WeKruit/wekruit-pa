/**
 * Phase 23 BETA-04 / BETA-05 — Beta participants CRUD + kill switch.
 *
 * Section A: Beta Participants
 *   - List pa_beta_participants, CRUD (add/suspend/reactivate/remove)
 *   - "Add Participant" form: contactHandle (auto-detect phone vs email), notes, cohort
 *
 * Section B: Kill Switch
 *   - Toggle pa_remote_config/platform.outboundPaused
 *   - Confirmation modal. When ON: banner across top.
 *   - Audit event written on each flip.
 */
import { PA_COLLECTIONS, PA_REMOTE_CONFIG_DOC } from "@pa/core-types"
import { getAuth } from "firebase/auth"
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
} from "firebase/firestore"
import { useEffect, useState } from "react"
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
  type DataTableColumn,
} from "../components/ui.js"
import { db, getFirebaseApp } from "../lib/firebase.js"

type Participant = {
  id: string
  contactHandle: string
  contactType: "phone" | "email"
  userId: string | null
  status: "invited" | "active" | "suspended" | "removed"
  addedAt: string
  addedBy: string
  removedAt: string | null
  notes: string | null
  metadata: { cohort?: string; source?: string }
}

function normalizeHandle(raw: string): { handle: string; contactType: "phone" | "email" } {
  const trimmed = raw.trim()
  if (trimmed.includes("@")) {
    return { handle: trimmed.toLowerCase(), contactType: "email" }
  }
  const digits = trimmed.replace(/\D/g, "")
  if (!digits) return { handle: trimmed, contactType: "phone" }
  if (trimmed.startsWith("+")) return { handle: `+${digits}`, contactType: "phone" }
  if (digits.length === 10) return { handle: `+1${digits}`, contactType: "phone" }
  return { handle: `+${digits}`, contactType: "phone" }
}

function operatorEmail(): string {
  return getAuth(getFirebaseApp()).currentUser?.email ?? "unknown@wekruit.com"
}

async function appendAuditRow(message: string, meta: Record<string, unknown>) {
  await addDoc(collection(db(), PA_COLLECTIONS.auditEvents), {
    kind: "turn_state",
    actor: "operator",
    message,
    meta,
    createdAt: new Date().toISOString(),
  })
}

export function Beta() {
  const [participants, setParticipants] = useState<Participant[]>([])
  const [outboundPaused, setOutboundPaused] = useState(false)
  const [pausedAt, setPausedAt] = useState<string | null>(null)
  const [pausedBy, setPausedBy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Add form state
  const [addHandle, setAddHandle] = useState("")
  const [addNotes, setAddNotes] = useState("")
  const [addCohort, setAddCohort] = useState("beta-v1")
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  async function loadAll() {
    setLoading(true)
    setErr(null)
    try {
      const [snap, configSnap] = await Promise.all([
        getDocs(
          query(
            collection(db(), PA_COLLECTIONS.betaParticipants),
            orderBy("addedAt", "desc"),
            limit(200)
          )
        ),
        getDoc(doc(db(), PA_COLLECTIONS.remoteConfig, PA_REMOTE_CONFIG_DOC)),
      ])
      setParticipants(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Participant, "id">) }))
      )
      if (configSnap.exists()) {
        const cfg = configSnap.data() as {
          outboundPaused?: boolean
          pausedAt?: string
          pausedBy?: string
        }
        setOutboundPaused(cfg.outboundPaused === true)
        setPausedAt(cfg.pausedAt ?? null)
        setPausedBy(cfg.pausedBy ?? null)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  async function updateStatus(id: string, status: Participant["status"]) {
    setBusy(true)
    try {
      const patch: Record<string, unknown> = { status, updatedAt: new Date().toISOString() }
      if (status === "removed") patch["removedAt"] = new Date().toISOString()
      await updateDoc(doc(db(), PA_COLLECTIONS.betaParticipants, id), patch)
      await loadAll()
    } catch (e) {
      alert(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  async function addParticipant() {
    setAddError(null)
    if (!addHandle.trim()) {
      setAddError("Contact handle is required (phone or email).")
      return
    }
    setAdding(true)
    try {
      const { handle, contactType } = normalizeHandle(addHandle)
      const now = new Date().toISOString()
      await addDoc(collection(db(), PA_COLLECTIONS.betaParticipants), {
        contactHandle: handle,
        contactType,
        userId: null,
        status: "invited",
        addedAt: now,
        addedBy: operatorEmail(),
        removedAt: null,
        notes: addNotes.trim() || null,
        metadata: { cohort: addCohort.trim() || "beta-v1" },
      })
      setAddHandle("")
      setAddNotes("")
      await loadAll()
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e))
    } finally {
      setAdding(false)
    }
  }

  async function toggleKillSwitch() {
    const next = !outboundPaused
    const confirmMsg = next
      ? "Pause ALL outbound? PA will stop replying until you unpause."
      : "Unpause outbound? PA will resume sending replies."
    if (!window.confirm(confirmMsg)) return
    setBusy(true)
    const now = new Date().toISOString()
    const opEmail = operatorEmail()
    try {
      const patch: Record<string, unknown> = {
        outboundPaused: next,
        updatedAt: now,
      }
      if (next) {
        patch["pausedAt"] = now
        patch["pausedBy"] = opEmail
      } else {
        patch["unpausedAt"] = now
        patch["unpausedBy"] = opEmail
      }
      await setDoc(
        doc(db(), PA_COLLECTIONS.remoteConfig, PA_REMOTE_CONFIG_DOC),
        patch,
        { merge: true }
      )
      await appendAuditRow(
        `Outbound ${next ? "paused" : "unpaused"} by operator`,
        { outboundPaused: next, operatorEmail: opEmail }
      )
      setOutboundPaused(next)
      if (next) {
        setPausedAt(now)
        setPausedBy(opEmail)
      } else {
        setPausedAt(null)
        setPausedBy(null)
      }
    } catch (e) {
      alert(`Kill switch failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const participantColumns: DataTableColumn<Participant>[] = [
    {
      key: "contactHandle",
      header: "Handle",
      render: (r) => <span style={{ fontSize: "0.85em" }}>{r.contactHandle}</span>,
    },
    {
      key: "contactType",
      header: "Type",
      render: (r) => <StatusBadge value={r.contactType} />,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusBadge value={r.status} />,
    },
    {
      key: "addedAt",
      header: "Added",
      render: (r) => (
        <span style={{ fontSize: "0.82em", whiteSpace: "nowrap" }}>
          {r.addedAt?.slice(0, 10) ?? "—"}
        </span>
      ),
    },
    {
      key: "addedBy",
      header: "Added By",
      render: (r) => (
        <span style={{ fontSize: "0.82em" }}>{r.addedBy?.split("@")[0] ?? "—"}</span>
      ),
    },
    {
      key: "notes",
      header: "Notes",
      render: (r) => (
        <span style={{ fontSize: "0.82em", color: "#64748b" }}>
          {r.notes ?? (r.metadata?.cohort ? `cohort: ${r.metadata.cohort}` : "—")}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (r) => (
        <span style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
          {r.status === "active" || r.status === "invited" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void updateStatus(r.id, "suspended")}
              style={{ fontSize: "0.8em" }}
            >
              Suspend
            </button>
          ) : null}
          {r.status === "suspended" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void updateStatus(r.id, "active")}
              style={{ fontSize: "0.8em" }}
            >
              Reactivate
            </button>
          ) : null}
          {r.status !== "removed" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                window.confirm(`Remove ${r.contactHandle}?`) &&
                void updateStatus(r.id, "removed")
              }
              style={{ fontSize: "0.8em", color: "#ef4444" }}
            >
              Remove
            </button>
          ) : null}
        </span>
      ),
    },
  ]

  if (loading) return <LoadingState label="Loading beta panel…" />
  if (err && participants.length === 0) return <ErrorState message={err} />

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Closed beta"
        title="Beta Participants"
        description="Manage pa_beta_participants and outbound kill switch. No env edits or redeploys needed."
        actions={
          <button type="button" disabled={loading} onClick={() => void loadAll()}>
            Refresh
          </button>
        }
      />

      {/* Kill switch banner */}
      {outboundPaused ? (
        <div
          className="notice notice-bad"
          style={{ fontWeight: 600, display: "flex", justifyContent: "space-between", alignItems: "center" }}
        >
          <span>
            OUTBOUND PAUSED — flipped {pausedAt?.slice(0, 16).replace("T", " ") ?? "?"} by{" "}
            {pausedBy?.split("@")[0] ?? "?"}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void toggleKillSwitch()}
            style={{ fontSize: "0.85em", marginLeft: "1rem" }}
          >
            Unpause
          </button>
        </div>
      ) : null}

      {/* Section A: Participants */}
      <Panel
        eyebrow="Section A"
        title="Beta Participants"
        actions={
          <span style={{ fontSize: "0.85em", color: "#64748b" }}>
            {participants.filter((p) => p.status === "active").length} active /{" "}
            {participants.length} total
          </span>
        }
      >
        <DataTable
          rows={participants}
          columns={participantColumns}
          empty={
            <EmptyState
              title="No participants yet"
              body="Add a participant below to begin the onboarding flow."
            />
          }
        />

        {/* Add Participant form */}
        <div
          style={{
            marginTop: "1.5rem",
            padding: "1rem",
            background: "#f8fafc",
            borderRadius: "0.5rem",
            border: "1px solid #e2e8f0",
          }}
        >
          <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.95rem" }}>Add Participant</h3>
          {addError ? (
            <div className="notice notice-bad" style={{ marginBottom: "0.5rem" }}>
              {addError}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.8em", marginBottom: "0.25rem" }}>
                Phone or Email *
              </label>
              <input
                type="text"
                value={addHandle}
                onChange={(e) => setAddHandle(e.target.value)}
                placeholder="+14155550001 or user@example.com"
                style={{ minWidth: "220px" }}
                onKeyDown={(e) => e.key === "Enter" && void addParticipant()}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.8em", marginBottom: "0.25rem" }}>
                Notes
              </label>
              <input
                type="text"
                value={addNotes}
                onChange={(e) => setAddNotes(e.target.value)}
                placeholder="Optional notes"
                style={{ minWidth: "160px" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.8em", marginBottom: "0.25rem" }}>
                Cohort
              </label>
              <input
                type="text"
                value={addCohort}
                onChange={(e) => setAddCohort(e.target.value)}
                placeholder="beta-v1"
                style={{ minWidth: "100px" }}
              />
            </div>
            <button
              type="button"
              disabled={adding || !addHandle.trim()}
              onClick={() => void addParticipant()}
            >
              {adding ? "Adding…" : "Add"}
            </button>
          </div>
          <p style={{ fontSize: "0.78em", color: "#94a3b8", marginTop: "0.5rem", marginBottom: 0 }}>
            Status defaults to <code>invited</code>. First inbound message triggers Claire's onboarding flow.
          </p>
        </div>
      </Panel>

      {/* Section B: Kill Switch */}
      <Panel eyebrow="Section B" title="Kill Switch">
        <p style={{ color: "#475569", fontSize: "0.9em", marginTop: 0, maxWidth: 560 }}>
          Pausing outbound stops ALL PA replies within the next listener tick (≤60s). Use this for
          incidents, unexpected behavior, or before maintenance. Recovery requires explicit unpause.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginTop: "0.75rem" }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => void toggleKillSwitch()}
            style={{
              background: outboundPaused ? "#22c55e" : "#ef4444",
              color: "white",
              fontWeight: 700,
              padding: "0.6rem 1.2rem",
              border: "none",
              borderRadius: "0.375rem",
              cursor: busy ? "not-allowed" : "pointer",
              fontSize: "0.95em",
            }}
          >
            {outboundPaused ? "Unpause All Outbound" : "Pause All Outbound"}
          </button>
          <span style={{ fontSize: "0.85em", color: "#64748b" }}>
            {outboundPaused
              ? `Paused ${pausedAt?.slice(0, 16).replace("T", " ") ?? ""} by ${pausedBy ?? "?"}`
              : "Outbound is active."}
          </span>
        </div>
        <p
          style={{
            fontSize: "0.8em",
            color: "#94a3b8",
            marginTop: "0.75rem",
            maxWidth: 480,
          }}
        >
          Writes <code>pa_remote_config/platform.outboundPaused = true</code>. Outbox listeners check
          this flag before dispatching. Audit event written on each toggle.
        </p>
      </Panel>
    </div>
  )
}
