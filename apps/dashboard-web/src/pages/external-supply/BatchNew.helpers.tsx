/**
 * v2.0 External Supply V2 — Wave D dashboard UX — pure helpers + smaller
 * subcomponents for the BatchNew wizard. Extracted here so the test runner
 * can render these without pulling in `lib/firebase.ts` (which references
 * `import.meta.env.VITE_*` and crashes under Node's `--test` loader).
 *
 * `BatchNew.tsx` re-imports `StepIndicator` from this module.
 */
import type { ReactNode } from "react"

export type BatchNewStep = "pick" | "previewing" | "committing" | "done" | "error"

export function StepIndicator({ step }: { step: BatchNewStep }): ReactNode {
  const steps: Array<{ key: BatchNewStep; label: string }> = [
    { key: "pick", label: "1. Pick" },
    { key: "previewing", label: "2. Preview" },
    { key: "committing", label: "3. Commit" },
  ]
  const activeIdx = steps.findIndex((s) => s.key === step)
  return (
    <div style={stepIndicatorStyle}>
      {steps.map((s, i) => {
        const active = i === activeIdx
        const done = i < activeIdx || step === "done"
        return (
          <div
            key={s.key}
            style={{
              ...stepChipStyle,
              ...(active ? stepChipActiveStyle : {}),
              ...(done ? stepChipDoneStyle : {}),
            }}
          >
            {s.label}
          </div>
        )
      })}
      {step === "error" && (
        <div style={{ ...stepChipStyle, ...stepChipErrorStyle }}>error</div>
      )}
    </div>
  )
}

const stepIndicatorStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
}
const stepChipStyle: React.CSSProperties = {
  padding: "0.25rem 0.7rem",
  borderRadius: 999,
  fontSize: "0.78em",
  border: "1px solid #e2e8f0",
  background: "#f8fafc",
  color: "#475569",
}
const stepChipActiveStyle: React.CSSProperties = {
  borderColor: "#1a73e8",
  background: "#eff6ff",
  color: "#1a73e8",
  fontWeight: 600,
}
const stepChipDoneStyle: React.CSSProperties = {
  borderColor: "#22c55e",
  background: "#dcfce7",
  color: "#166534",
}
const stepChipErrorStyle: React.CSSProperties = {
  borderColor: "#dc2626",
  background: "#fee2e2",
  color: "#991b1b",
}
