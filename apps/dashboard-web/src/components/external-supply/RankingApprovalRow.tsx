/**
 * v2.0 External Supply V2 — Wave D dashboard UX — per-row approval +
 * override row for the agent-ranking review surface.
 *
 * Renders one `<tr>` for a single `AgentRankingResult` plus an inline modal
 * (`<dialog>` rendered as a fixed-position panel — no Radix dep) for the
 * override flow. Approve writes status=approved via callable. Override
 * collects (newTier, reason) and writes a correctionEvent through the
 * `overrideAgentTier` callable.
 *
 * Per lead resolution L-E2: no optimistic updates — parent refetches after
 * each mutation.
 */
import { useState } from "react"
import type { EvaluationTier } from "@pa/core-types"
import { AdminUserLink } from "../AdminEntityLink.js"
import type { AgentRankingResult } from "../../lib/external-supply-client.js"
import { EvaluationTierBadge } from "./EvaluationTierBadge.js"

const TIER_OPTIONS: EvaluationTier[] = [
  "tier_1_personal_linkedin_and_email",
  "tier_2_personal_email",
  "tier_3_general_email",
  "retain_only",
  "blocked",
]

const ACTION_LABEL: Record<string, string> = {
  outreach_now: "Outreach now",
  outreach_after_research: "After research",
  retain_warm: "Retain warm",
  do_not_contact: "Do not contact",
}

const STATUS_TONE: Record<AgentRankingResult["status"], string> = {
  proposed: "muted",
  approved: "good",
  overridden: "warn",
  ignored: "bad",
}

export function RankingApprovalRow({
  result,
  selected,
  onToggleSelect,
  onApprove,
  onOverride,
  busy,
}: {
  result: AgentRankingResult
  selected?: boolean
  onToggleSelect?: (resultId: string) => void
  onApprove: (resultId: string) => void
  onOverride: (resultId: string, newTier: EvaluationTier, reason: string) => void
  busy?: boolean
}) {
  const [showOverride, setShowOverride] = useState(false)
  const [overrideTier, setOverrideTier] = useState<EvaluationTier>(result.proposedAgentTier)
  const [reason, setReason] = useState("")
  const [reasonError, setReasonError] = useState<string | null>(null)

  function handleSubmitOverride() {
    const trimmed = reason.trim()
    if (trimmed.length < 4) {
      setReasonError("Reason must be at least 4 characters.")
      return
    }
    setReasonError(null)
    onOverride(result.resultId, overrideTier, trimmed)
    setShowOverride(false)
    setReason("")
  }

  const rationalePreview =
    result.agentRationale.length > 200
      ? `${result.agentRationale.slice(0, 199)}…`
      : result.agentRationale

  return (
    <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
      <td style={tdStyle}>
        {onToggleSelect ? (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect(result.resultId)}
            aria-label={`Select ${result.resultId}`}
          />
        ) : null}
      </td>
      <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.78em" }}>
        {result.candidateUserId ? (
          <AdminUserLink userId={result.candidateUserId}>{result.candidateUserId.slice(0, 8)}…</AdminUserLink>
        ) : (
          `${result.candidateRecordId.slice(0, 8)}…`
        )}
      </td>
      <td style={tdStyle}>
        <EvaluationTierBadge tier={result.deterministicTier} />
      </td>
      <td style={tdStyle}>
        <EvaluationTierBadge tier={result.proposedAgentTier} />
      </td>
      <td style={{ ...tdStyle, fontSize: "0.8em", maxWidth: 280 }} title={result.agentRationale}>
        {rationalePreview}
      </td>
      <td style={tdStyle}>
        {result.agentRisks.length > 0 ? (
          <span title={result.agentRisks.join("\n")}>{result.agentRisks.length}</span>
        ) : (
          "—"
        )}
      </td>
      <td style={tdStyle}>
        <span className="status-badge muted">
          {ACTION_LABEL[result.agentRecommendedAction] ?? result.agentRecommendedAction}
        </span>
      </td>
      <td style={tdStyle}>
        {result.ensembleVotes.length > 0 ? `${result.ensembleVotes.length} vote(s)` : "—"}
      </td>
      <td style={tdStyle}>
        <span className={`status-badge ${STATUS_TONE[result.status]}`}>{result.status}</span>
        {result.approvedTier && result.status !== "proposed" ? (
          <div style={{ marginTop: 4 }}>
            <EvaluationTierBadge tier={result.approvedTier} />
          </div>
        ) : null}
      </td>
      <td style={tdStyle}>
        <button
          type="button"
          disabled={busy || result.status === "approved"}
          onClick={() => onApprove(result.resultId)}
          style={approveBtnStyle}
        >
          Approve
        </button>
      </td>
      <td style={tdStyle}>
        <button
          type="button"
          disabled={busy}
          onClick={() => setShowOverride(true)}
          style={overrideBtnStyle}
        >
          Override…
        </button>
        {showOverride && (
          <div
            role="dialog"
            aria-label="Override tier"
            style={modalOverlayStyle}
            onClick={() => setShowOverride(false)}
          >
            <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: 0, fontSize: "1em" }}>Override agent tier</h3>
              <p style={{ margin: "4px 0 8px 0", fontSize: "0.8em", color: "#64748b" }}>
                Candidate{" "}
                {result.candidateUserId ? (
                  <AdminUserLink userId={result.candidateUserId}>{result.candidateUserId.slice(0, 8)}…</AdminUserLink>
                ) : (
                  `${result.candidateRecordId.slice(0, 8)}…`
                )}{" "}
                · current proposed{" "}
                <strong>{result.proposedAgentTier}</strong>
              </p>
              <label style={fieldStyle}>
                <span style={labelStyle}>New tier</span>
                <select
                  value={overrideTier}
                  onChange={(e) => setOverrideTier(e.target.value as EvaluationTier)}
                  style={selectStyle}
                >
                  {TIER_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label style={fieldStyle}>
                <span style={labelStyle}>Reason (min 4 chars)</span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  style={textareaStyle}
                  minLength={4}
                />
              </label>
              {reasonError && (
                <div className="notice notice-bad" style={{ fontSize: "0.8em" }}>
                  {reasonError}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => setShowOverride(false)}
                  style={cancelBtnStyle}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSubmitOverride}
                  disabled={busy}
                  style={confirmBtnStyle}
                >
                  Save override
                </button>
              </div>
            </div>
          </div>
        )}
      </td>
    </tr>
  )
}

const tdStyle: React.CSSProperties = { padding: "0.4rem 0.3rem", verticalAlign: "top" }

const approveBtnStyle: React.CSSProperties = {
  background: "#22c55e",
  color: "white",
  border: "none",
  padding: "0.35rem 0.7rem",
  borderRadius: 4,
  fontSize: "0.8em",
  cursor: "pointer",
}
const overrideBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#1f2937",
  border: "1px solid #cbd5e1",
  padding: "0.35rem 0.7rem",
  borderRadius: 4,
  fontSize: "0.8em",
  cursor: "pointer",
}
const cancelBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#1f2937",
  border: "1px solid #cbd5e1",
  padding: "0.4rem 0.85rem",
  borderRadius: 4,
  fontSize: "0.85em",
  cursor: "pointer",
}
const confirmBtnStyle: React.CSSProperties = {
  background: "#1a73e8",
  color: "white",
  border: "none",
  padding: "0.4rem 0.85rem",
  borderRadius: 4,
  fontSize: "0.85em",
  cursor: "pointer",
}
const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.55)",
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
}
const modalStyle: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 16,
  width: "min(420px, 90vw)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
}
const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 }
const labelStyle: React.CSSProperties = { fontSize: "0.8em", fontWeight: 600 }
const selectStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.85em",
}
const textareaStyle: React.CSSProperties = {
  padding: "0.45rem 0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.85em",
  fontFamily: "inherit",
  resize: "vertical",
}
