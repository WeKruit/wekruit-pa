/**
 * v2.0 External Supply V1 — Wave D — Editor for the 7 copy fields on an
 * `OutreachPlan`. Tracks dirty state and submits a diff via `onSave`.
 *
 * Per backend signature (`approveOutreachPlan({ planId, edits })`), this
 * component just collects the edits — the parent decides whether to call
 * approve or save-as-draft.
 */
import { useEffect, useState } from "react"
import type { OutreachPlan } from "@pa/core-types"
import type { OutreachCopyEdits } from "../../lib/external-supply-client.js"

const FIELDS: Array<{ key: keyof OutreachCopyEdits; label: string; rows: number }> = [
  { key: "personalizedHook", label: "Personalized hook", rows: 2 },
  { key: "whyThisRole", label: "Why this role", rows: 2 },
  { key: "whyCompany", label: "Why this company", rows: 2 },
  { key: "candidateSpecificSignal", label: "Candidate-specific signal", rows: 2 },
  { key: "emailSubject", label: "Email subject", rows: 1 },
  { key: "emailBody", label: "Email body", rows: 8 },
  { key: "linkedinMessage", label: "LinkedIn message", rows: 4 },
]

export function OutreachCopyEditor({
  plan,
  onSave,
  busy,
}: {
  plan: OutreachPlan
  onSave: (edits: OutreachCopyEdits) => void | Promise<void>
  busy?: boolean
}) {
  const [draft, setDraft] = useState<OutreachCopyEdits>(() => initialDraft(plan))
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setDraft(initialDraft(plan))
    setDirty(false)
  }, [plan.planId])

  function update(key: keyof OutreachCopyEdits, value: string) {
    setDraft((d) => ({ ...d, [key]: value }))
    setDirty(true)
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave(diffEdits(plan, draft))
      }}
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
    >
      {FIELDS.map((f) => (
        <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.8em", fontWeight: 600 }}>{f.label}</span>
          {f.rows === 1 ? (
            <input
              type="text"
              value={draft[f.key] ?? ""}
              onChange={(e) => update(f.key, e.target.value)}
              style={inputStyle}
              maxLength={998}
            />
          ) : (
            <textarea
              value={draft[f.key] ?? ""}
              onChange={(e) => update(f.key, e.target.value)}
              rows={f.rows}
              style={textareaStyle}
            />
          )}
        </label>
      ))}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="submit" disabled={busy || !dirty} style={primaryBtnStyle}>
          {busy ? "Saving…" : dirty ? "Save edits" : "No changes"}
        </button>
      </div>
    </form>
  )
}

function initialDraft(plan: OutreachPlan): OutreachCopyEdits {
  return {
    personalizedHook: plan.personalizedHook,
    whyThisRole: plan.whyThisRole,
    whyCompany: plan.whyCompany,
    candidateSpecificSignal: plan.candidateSpecificSignal,
    emailSubject: plan.emailSubject,
    emailBody: plan.emailBody,
    linkedinMessage: plan.linkedinMessage,
  }
}

function diffEdits(plan: OutreachPlan, draft: OutreachCopyEdits): OutreachCopyEdits {
  const out: OutreachCopyEdits = {}
  for (const f of FIELDS) {
    const before = plan[f.key]
    const after = draft[f.key]
    const beforeNorm = typeof before === "string" ? before : ""
    const afterNorm = typeof after === "string" ? after : ""
    if (beforeNorm !== afterNorm) {
      out[f.key] = afterNorm
    }
  }
  return out
}

const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.85em",
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  resize: "vertical",
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
