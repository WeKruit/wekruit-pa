/**
 * v2.0 External Supply V1 — Wave D — Masked email/phone renderer with an
 * audited reveal toggle.
 *
 * Default render is a redacted form (e.g. `a***@gmail.com`). Operators can
 * click "Reveal" to unmask in V1 — the reveal logs to the browser console
 * (full audit-via-correction-event is intentionally deferred).
 *
 * Per PLAN §14 the raw `rawPayload` is preserved server-side but never
 * rendered without going through this component.
 */
import { useState } from "react"
import { maskEmail, maskPhone } from "./badges.helpers.js"

export type RedactedKind = "email" | "phone" | "generic"

export function RedactedField({
  value,
  kind = "generic",
  context,
}: {
  value: string | undefined | null
  kind?: RedactedKind
  /** For audit hint — e.g. recordId so a console reveal is identifiable. */
  context?: string
}) {
  const [revealed, setRevealed] = useState(false)

  if (!value) {
    return <span style={{ color: "#94a3b8" }}>—</span>
  }

  const masked =
    kind === "email"
      ? maskEmail(value)
      : kind === "phone"
        ? maskPhone(value)
        : value.length > 8
          ? `${value.slice(0, 2)}***${value.slice(-2)}`
          : "***"

  function handleReveal() {
    if (!revealed) {
      // V1 audit: mark the reveal in the console so an operator action is
      // traceable in browser DevTools. A future iteration will push this
      // through a correction event.

      console.info("[external-supply] pii reveal", { kind, context })
    }
    setRevealed((v) => !v)
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
        {revealed ? value : masked}
      </span>
      <button
        type="button"
        onClick={handleReveal}
        style={{
          fontSize: "0.7em",
          background: "transparent",
          border: "1px solid #cbd5e1",
          borderRadius: 4,
          padding: "1px 6px",
          cursor: "pointer",
          color: "#64748b",
        }}
        title="Reveal masked value (logged to console)"
      >
        {revealed ? "hide" : "reveal"}
      </button>
    </span>
  )
}
