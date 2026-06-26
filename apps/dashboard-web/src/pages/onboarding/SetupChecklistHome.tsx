// Module A — Setup Checklist Home (persistent).
// When the admin closes the wizard mid-flow, the wizard collapses into this
// checklist: a completion ring + percent, the 7 milestones with
// done/active/blocked state, and a "Resume setup" CTA that deep-links back
// into the wizard at the next open step. Rendered by OnboardingWizard when
// setup is partially complete; also usable standalone.

import { useMemo, type CSSProperties } from "react"
import { Badge, PageHeader, Panel } from "../../components/ui.js"
import {
  WIZARD_STEPS,
  isSetupComplete,
  resolvedCount,
  stepStatus,
  type StepStatus,
  type WizardState,
} from "../../lib/onboarding-wizard-state.js"

const ITEM_BADGE: Record<StepStatus, { tone: "ok" | "warn" | "info" | "muted"; label: string }> = {
  done: { tone: "ok", label: "Done" },
  skipped: { tone: "muted", label: "Skipped" },
  active: { tone: "info", label: "Up next" },
  locked: { tone: "muted", label: "Blocked" },
}

export function SetupChecklistHome({
  state,
  onResume,
}: {
  state: WizardState
  onResume: (stepIndex: number) => void
}) {
  const total = WIZARD_STEPS.length
  const resolved = resolvedCount(state)
  const pct = Math.round((resolved / total) * 100)
  const complete = isSetupComplete(state)

  // The step to resume into = first unresolved step (else the active pointer).
  const nextStep = useMemo(() => {
    const idx = WIZARD_STEPS.findIndex((s) => !state.completion[s.key])
    return idx === -1 ? state.activeStep : idx
  }, [state])

  return (
    <div>
      <PageHeader
        eyebrow="Onboarding"
        title="Setup checklist"
        description="Your progress getting WeKruit live. Pick up where you left off — nothing is lost."
        actions={
          complete ? (
            <Badge tone="ok">You&apos;re live</Badge>
          ) : (
            <button type="button" style={primaryBtn} onClick={() => onResume(nextStep)}>
              Resume setup
            </button>
          )
        }
      />

      <Panel title="Completion" eyebrow={`${resolved} of ${total} steps resolved`}>
        <div style={ringRow}>
          <CompletionRing pct={pct} />
          <div style={ringText}>
            <div style={ringPct}>{pct}%</div>
            <div style={ringSub}>
              {complete
                ? "Setup complete — WeKruit is pointed at your pilot."
                : `${total - resolved} step${total - resolved === 1 ? "" : "s"} left to reach your first qualified candidate.`}
            </div>
            {!complete ? (
              <button type="button" style={resumeLink} onClick={() => onResume(nextStep)}>
                Resume at “{WIZARD_STEPS[nextStep].label}” →
              </button>
            ) : null}
          </div>
        </div>
      </Panel>

      <Panel title="Steps">
        <ul style={listWrap}>
          {WIZARD_STEPS.map((step, index) => {
            const status = stepStatus(state, index)
            const badge = ITEM_BADGE[status]
            const locked = status === "locked"
            return (
              <li key={step.key} style={itemRow}>
                <span style={{ ...itemMarker, ...markerTone(status) }}>
                  {status === "done" ? "✓" : status === "skipped" ? "–" : index + 1}
                </span>
                <span style={itemMain}>
                  <span style={itemLabel}>{step.label}</span>
                </span>
                <Badge tone={badge.tone}>{badge.label}</Badge>
                <button
                  type="button"
                  disabled={locked}
                  style={{ ...itemAction, ...(locked ? itemActionDisabled : null) }}
                  onClick={() => !locked && onResume(index)}
                >
                  {status === "done" || status === "skipped" ? "Review" : "Open"}
                </button>
              </li>
            )
          })}
        </ul>
      </Panel>
    </div>
  )
}

function CompletionRing({ pct }: { pct: number }) {
  const size = 96
  const stroke = 10
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c * (1 - pct / 100)
  return (
    <svg width={size} height={size} role="img" aria-label={`${pct}% complete`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--line, #e5e7eb)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={pct === 100 ? "#16a34a" : "#2563eb"}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  )
}

function markerTone(status: StepStatus): CSSProperties {
  if (status === "done") return { background: "#16a34a", color: "#fff", borderColor: "#16a34a" }
  if (status === "active") return { background: "var(--ink-1, #111827)", color: "#fff", borderColor: "var(--ink-1, #111827)" }
  return { background: "var(--surface, #fff)", color: "var(--ink-3, #6b7280)" }
}

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

const ringRow: CSSProperties = { display: "flex", alignItems: "center", gap: 24 }
const ringText: CSSProperties = { display: "flex", flexDirection: "column", gap: 4 }
const ringPct: CSSProperties = { fontSize: 28, fontWeight: 700, color: "var(--ink-1, #111827)" }
const ringSub: CSSProperties = { fontSize: 14, color: "var(--ink-3, #6b7280)", maxWidth: 420 }
const resumeLink: CSSProperties = {
  marginTop: 6,
  alignSelf: "flex-start",
  border: "none",
  background: "transparent",
  padding: 0,
  fontSize: 14,
  fontWeight: 600,
  color: "#2563eb",
  cursor: "pointer",
}

const listWrap: CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }
const itemRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 12px",
  border: "1px solid var(--line, #e5e7eb)",
  borderRadius: 8,
  background: "var(--surface, #fff)",
}
const itemMarker: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 26,
  flexShrink: 0,
  borderRadius: "50%",
  border: "1px solid var(--line, #e5e7eb)",
  fontSize: 12,
  fontWeight: 700,
}
const itemMain: CSSProperties = { flex: 1, minWidth: 0 }
const itemLabel: CSSProperties = { fontSize: 14, fontWeight: 600, color: "var(--ink-1, #111827)" }
const itemAction: CSSProperties = {
  padding: "6px 14px",
  fontSize: 13,
  fontWeight: 600,
  border: "1px solid var(--line, #e5e7eb)",
  borderRadius: 8,
  background: "var(--surface, #fff)",
  color: "var(--ink-2, #374151)",
  cursor: "pointer",
}
const itemActionDisabled: CSSProperties = { opacity: 0.5, cursor: "not-allowed" }
const primaryBtn: CSSProperties = {
  padding: "9px 18px",
  fontSize: 14,
  fontWeight: 600,
  border: "1px solid var(--ink-1, #111827)",
  borderRadius: 8,
  background: "var(--ink-1, #111827)",
  color: "#fff",
  cursor: "pointer",
}

export default SetupChecklistHome
