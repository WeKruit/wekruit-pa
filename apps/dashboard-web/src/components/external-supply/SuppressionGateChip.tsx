/**
 * v2.0 External Supply V1 — Wave D — Suppression gate chip.
 * Reads the `SuppressionGateResult` and renders a green/red chip + a
 * `<details>` drawer listing every block reason for operator audit.
 */
import { useState } from "react"
import type { SuppressionGateResult } from "@pa/core-types"

export function SuppressionGateChip({
  result,
  inline,
}: {
  result: SuppressionGateResult
  inline?: boolean
}) {
  const [open, setOpen] = useState(false)
  const blocked = !result.allow
  const tone = blocked ? "bad" : "good"
  const label = blocked
    ? `Blocked · ${result.blockedReasons.length}`
    : "Allowed"

  if (inline) {
    return (
      <span title={blocked ? result.blockedReasons.join(", ") : "Allowed"} className={`status-badge ${tone}`}>
        {label}
      </span>
    )
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className={`status-badge ${tone}`}>{label}</span>
      {blocked && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            fontSize: "0.75em",
            background: "transparent",
            border: "1px solid #cbd5e1",
            borderRadius: 4,
            padding: "2px 6px",
            cursor: "pointer",
          }}
        >
          {open ? "Hide" : "Why?"}
        </button>
      )}
      {open && (
        <div
          style={{
            display: "inline-block",
            background: "#fff7ed",
            border: "1px solid #fb923c",
            borderRadius: 4,
            padding: "4px 8px",
            fontSize: "0.75em",
            color: "#7c2d12",
          }}
        >
          {result.blockedReasons.length === 0
            ? "(no reasons recorded)"
            : result.blockedReasons.join(", ")}
          {result.cooldownUntil
            ? ` · cooldown until ${result.cooldownUntil.slice(0, 19).replace("T", " ")}`
            : ""}
        </div>
      )}
    </span>
  )
}
