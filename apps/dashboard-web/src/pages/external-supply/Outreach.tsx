/**
 * v2.0 External Supply V1 — Wave D — `/admin/external-supply/outreach`.
 *
 * Outreach plan queue. Filter chips for approvalStatus. Per-row chip showing
 * suppression gate result. Click row → drawer with `OutreachCopyEditor`.
 * Buttons: Approve, Reject, Sync (dry-run / live), Assign LinkedIn,
 * Mark LinkedIn task status. Live sync button only renders if both
 * `liveOutreachEnabled` and `instantlyConfigured` come back true from
 * `getExternalSupplyConfig`.
 */
import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import type { OutreachApprovalStatus, OutreachPlan } from "@pa/core-types"
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../../components/ui.js"
import { EvaluationTierBadge } from "../../components/external-supply/EvaluationTierBadge.js"
import { OutreachCopyEditor } from "../../components/external-supply/OutreachCopyEditor.js"
import { SuppressionGateChip } from "../../components/external-supply/SuppressionGateChip.js"
import { outreachApprovalBadge } from "../../components/external-supply/badges.helpers.js"
import {
  approveOutreachPlan,
  assignManualLinkedInTask,
  getExternalSupplyConfig,
  getOutreachPlan,
  listOutreachPlans,
  markManualLinkedInTaskStatus,
  rejectOutreachPlan,
  syncPlanToInstantly,
  type ExternalSupplyConfig,
  type OutreachCopyEdits,
} from "../../lib/external-supply-client.js"

const STATUS_FILTERS: Array<{ key: "all" | OutreachApprovalStatus; label: string }> = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "awaiting_approval", label: "Awaiting approval" },
  { key: "approved", label: "Approved" },
  { key: "sent", label: "Sent" },
  { key: "rejected", label: "Rejected" },
  { key: "failed", label: "Failed" },
]

export function Outreach() {
  const [searchParams] = useSearchParams()
  const [plans, setPlans] = useState<OutreachPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [config, setConfig] = useState<ExternalSupplyConfig | null>(null)
  const [filter, setFilter] = useState<"all" | OutreachApprovalStatus>(() => {
    const s = searchParams.get("status")
    if (s && (STATUS_FILTERS as { key: string }[]).some((f) => f.key === s)) {
      return s as OutreachApprovalStatus
    }
    return "all"
  })
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [selectedPlan, setSelectedPlan] = useState<OutreachPlan | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState("")
  const [showReject, setShowReject] = useState(false)
  const [linkedinAssignee, setLinkedinAssignee] = useState("")
  const [syncListId, setSyncListId] = useState("")
  const [syncCampaignId, setSyncCampaignId] = useState("")

  useEffect(() => {
    getExternalSupplyConfig({})
      .then(setConfig)
      .catch((e) => {
        // Non-fatal — we just hide the live button.

        console.warn("[outreach] config load failed", e)
        setConfig({ liveOutreachEnabled: false, instantlyConfigured: false })
      })
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listOutreachPlans({
      approvalStatus: filter === "all" ? undefined : filter,
      limit: 200,
    })
      .then((res) => {
        if (!cancelled) setPlans(res.rows)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [filter, refreshKey])

  useEffect(() => {
    if (!selectedPlanId) {
      setSelectedPlan(null)
      return
    }
    let cancelled = false
    getOutreachPlan(selectedPlanId)
      .then((p) => {
        if (!cancelled) setSelectedPlan(p)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [selectedPlanId, refreshKey])

  async function doApprove(edits: OutreachCopyEdits) {
    if (!selectedPlan) return
    setBusy(true)
    setActionMsg(null)
    try {
      const res = await approveOutreachPlan({
        planId: selectedPlan.planId,
        edits: Object.keys(edits).length > 0 ? edits : undefined,
      })
      setActionMsg(
        `Plan approved · status=${res.approvalStatus}${res.correctionEventId ? ` · audit=${res.correctionEventId.slice(0, 8)}…` : ""}`,
      )
      setRefreshKey((n) => n + 1)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function doReject() {
    if (!selectedPlan) return
    if (!rejectReason.trim()) {
      setActionMsg("Reject reason required.")
      return
    }
    setBusy(true)
    setActionMsg(null)
    try {
      await rejectOutreachPlan({
        planId: selectedPlan.planId,
        reason: rejectReason.trim(),
      })
      setActionMsg("Plan rejected.")
      setShowReject(false)
      setRejectReason("")
      setRefreshKey((n) => n + 1)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function doSync(mode: "dry_run" | "live") {
    if (!selectedPlan) return
    setBusy(true)
    setActionMsg(null)
    try {
      const res = await syncPlanToInstantly({
        planId: selectedPlan.planId,
        mode,
        ...(syncListId.trim() ? { listId: syncListId.trim() } : {}),
        ...(syncCampaignId.trim() ? { campaignId: syncCampaignId.trim() } : {}),
      })
      setActionMsg(
        `Sync ${res.mode} · status=${res.syncStatus}${res.downgraded ? ` · downgraded=${res.downgradedReason}` : ""}${res.instantlyLeadId ? ` · lead=${res.instantlyLeadId}` : ""}`,
      )
      setRefreshKey((n) => n + 1)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function doAssignLinkedIn() {
    if (!selectedPlan) return
    if (!linkedinAssignee.trim()) {
      setActionMsg("Assignee required (operator email or uid).")
      return
    }
    setBusy(true)
    try {
      await assignManualLinkedInTask({
        planId: selectedPlan.planId,
        assignee: linkedinAssignee.trim(),
      })
      setActionMsg("LinkedIn task assigned.")
      setRefreshKey((n) => n + 1)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function doMarkLinkedInStatus(status: "todo" | "sent" | "replied" | "skipped") {
    if (!selectedPlan) return
    setBusy(true)
    try {
      await markManualLinkedInTaskStatus({ planId: selectedPlan.planId, status })
      setActionMsg(`LinkedIn task → ${status}`)
      setRefreshKey((n) => n + 1)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const liveAvailable = Boolean(config?.liveOutreachEnabled && config?.instantlyConfigured)

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 External Supply V1 / Admin"
        title="Outreach"
        description={
          config
            ? `Manage outreach plans · live ${config.liveOutreachEnabled ? "enabled" : "disabled"} · instantly ${
                config.instantlyConfigured ? "configured" : "missing key"
              }`
            : "Manage outreach plans"
        }
        actions={
          <button type="button" onClick={() => setRefreshKey((n) => n + 1)} style={secondaryBtnStyle}>
            Refresh
          </button>
        }
      />

      <Panel title="Filter" eyebrow="approvalStatus">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setFilter(s.key)}
              style={s.key === filter ? activeFilterBtn : inactiveFilterBtn}
            >
              {s.label}
            </button>
          ))}
        </div>
      </Panel>

      {error && <ErrorState message={error} />}
      {actionMsg && <div className="notice notice-bad" style={{ fontSize: "0.85em" }}>{actionMsg}</div>}

      <div style={twoColStyle}>
        <Panel title={`Plans (${plans.length})`} eyebrow="pa-outreach-plans">
          {loading && plans.length === 0 ? (
            <LoadingState label="Loading plans…" />
          ) : plans.length === 0 ? (
            <EmptyState
              title="No plans"
              body="Run an evaluation, then draft outreach for high-tier candidates."
            />
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {plans.map((p) => {
                const approval = outreachApprovalBadge(p.approvalStatus)
                return (
                  <li key={p.planId}>
                    <button
                      type="button"
                      onClick={() => setSelectedPlanId(p.planId)}
                      style={p.planId === selectedPlanId ? activeRowBtn : inactiveRowBtn}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <strong style={{ fontSize: "0.85em" }}>{p.candidateId.slice(0, 8)}…</strong>
                        <span className={`status-badge ${approval.tone}`}>{approval.label}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
                        <EvaluationTierBadge tier={p.tier} />
                        <SuppressionGateChip result={p.suppressionGateResult} inline />
                      </div>
                      <div style={{ fontSize: "0.75em", color: "#64748b", marginTop: 4 }}>
                        {p.channelDecision} · {p.createdAt.slice(0, 16).replace("T", " ")}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>

        <Panel
          title={selectedPlan ? `Plan ${selectedPlan.planId.slice(0, 8)}…` : "Select a plan"}
          eyebrow={selectedPlan ? `${selectedPlan.tier} · ${selectedPlan.channelDecision}` : ""}
        >
          {!selectedPlan ? (
            <EmptyState
              title="No plan selected"
              body="Pick a plan from the list to edit its copy and approve / sync."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className={`status-badge ${outreachApprovalBadge(selectedPlan.approvalStatus).tone}`}>
                  {selectedPlan.approvalStatus}
                </span>
                <SuppressionGateChip result={selectedPlan.suppressionGateResult} />
                {selectedPlan.manualLinkedInTaskStatus && (
                  <span className="status-badge warn">
                    LinkedIn: {selectedPlan.manualLinkedInTaskStatus}
                    {selectedPlan.manualLinkedInTaskAssignee
                      ? ` · ${selectedPlan.manualLinkedInTaskAssignee}`
                      : ""}
                  </span>
                )}
              </div>

              <OutreachCopyEditor
                plan={selectedPlan}
                onSave={(edits) => doApprove(edits)}
                busy={busy}
              />

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => doApprove({})}
                  disabled={
                    busy ||
                    (selectedPlan.approvalStatus !== "draft" &&
                      selectedPlan.approvalStatus !== "awaiting_approval")
                  }
                  style={primaryBtnStyle}
                >
                  Approve (no edits)
                </button>
                <button
                  type="button"
                  onClick={() => setShowReject((v) => !v)}
                  disabled={busy || selectedPlan.approvalStatus === "sent" || selectedPlan.approvalStatus === "rejected"}
                  style={dangerBtnStyle}
                >
                  Reject
                </button>
              </div>

              {showReject && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <textarea
                    rows={2}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Reason for rejection…"
                    style={textareaStyle}
                  />
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button type="button" onClick={() => setShowReject(false)} style={secondaryBtnStyle}>
                      Cancel
                    </button>
                    <button type="button" onClick={doReject} disabled={busy} style={dangerBtnStyle}>
                      Confirm reject
                    </button>
                  </div>
                </div>
              )}

              <Panel title="Sync to Instantly" eyebrow="paExternalSupplySyncPlanToInstantly">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85em" }}>
                    <span>List ID</span>
                    <input
                      type="text"
                      value={syncListId}
                      onChange={(e) => setSyncListId(e.target.value)}
                      style={inputStyle}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85em" }}>
                    <span>Campaign ID (optional)</span>
                    <input
                      type="text"
                      value={syncCampaignId}
                      onChange={(e) => setSyncCampaignId(e.target.value)}
                      style={inputStyle}
                    />
                  </label>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => doSync("dry_run")}
                    disabled={busy || selectedPlan.approvalStatus !== "approved"}
                    style={secondaryBtnStyle}
                  >
                    Dry-run sync
                  </button>
                  {liveAvailable && (
                    <button
                      type="button"
                      onClick={() => doSync("live")}
                      disabled={busy || selectedPlan.approvalStatus !== "approved"}
                      style={primaryBtnStyle}
                    >
                      Live sync
                    </button>
                  )}
                  {!liveAvailable && (
                    <span style={{ fontSize: "0.8em", color: "#94a3b8" }}>
                      Live sync hidden (env or API key not configured).
                    </span>
                  )}
                </div>
              </Panel>

              {selectedPlan.tier === "tier_1_personal_linkedin_and_email" && (
                <Panel title="Manual LinkedIn task" eyebrow="tier 1 only">
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type="text"
                      placeholder="Assignee email or uid"
                      value={linkedinAssignee}
                      onChange={(e) => setLinkedinAssignee(e.target.value)}
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={doAssignLinkedIn}
                      disabled={busy || selectedPlan.approvalStatus !== "approved"}
                      style={secondaryBtnStyle}
                    >
                      Assign
                    </button>
                    {(["sent", "replied", "skipped"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => doMarkLinkedInStatus(s)}
                        disabled={busy || !selectedPlan.manualLinkedInTaskAssignee}
                        style={secondaryBtnStyle}
                      >
                        Mark {s}
                      </button>
                    ))}
                  </div>
                </Panel>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}

const twoColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "320px 1fr",
  gap: 12,
}

const primaryBtnStyle: React.CSSProperties = {
  background: "#1a73e8",
  color: "white",
  border: "none",
  padding: "0.5rem 1rem",
  borderRadius: 4,
  fontWeight: 500,
  cursor: "pointer",
}

const secondaryBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #cbd5e1",
  color: "#1f2937",
  padding: "0.4rem 0.85rem",
  borderRadius: 4,
  fontSize: "0.85em",
  cursor: "pointer",
}

const dangerBtnStyle: React.CSSProperties = {
  background: "#dc2626",
  color: "white",
  border: "none",
  padding: "0.5rem 1rem",
  borderRadius: 4,
  fontWeight: 500,
  cursor: "pointer",
}

const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.85em",
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: "vertical",
}

const activeFilterBtn: React.CSSProperties = {
  background: "#1a73e8",
  color: "white",
  border: "none",
  padding: "0.4rem 0.85rem",
  borderRadius: 6,
  fontSize: "0.85em",
  cursor: "pointer",
}

const inactiveFilterBtn: React.CSSProperties = {
  background: "#fff",
  color: "#475569",
  border: "1px solid #cbd5e1",
  padding: "0.4rem 0.85rem",
  borderRadius: 6,
  fontSize: "0.85em",
  cursor: "pointer",
}

const activeRowBtn: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "#eff6ff",
  border: "2px solid #1a73e8",
  borderRadius: 4,
  padding: "0.5rem 0.75rem",
  cursor: "pointer",
}

const inactiveRowBtn: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 4,
  padding: "0.5rem 0.75rem",
  cursor: "pointer",
}
