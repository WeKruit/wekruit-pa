// Module A — Onboarding Wizard shell (FIRST slice).
// A VerticalStepper over the 7 onboarding milestones with per-step
// locked/active/done/skipped state, the active step rendered on the right,
// and progress persisted to localStorage (resumable). Only Step 0 (Welcome)
// has real content this slice; the remaining steps render a labeled
// "coming soon" placeholder with a Skip-for-now control so the flow is
// navigable end-to-end. Server-state callable is a later slice.

import { useCallback, useState, type CSSProperties } from "react"
import { useNavigate } from "react-router-dom"
import { Badge, PageHeader, Panel } from "../../components/ui.js"
import {
  DEFAULT_SUCCESS_METRIC,
  SUCCESS_METRICS,
  WIZARD_STEPS,
  isSetupComplete,
  isSetupStarted,
  loadWizardState,
  resolvedCount,
  saveWizardState,
  stepStatus,
  type StepStatus,
  type SuccessMetric,
  type WizardState,
} from "../../lib/onboarding-wizard-state.js"
import { SetupChecklistHome } from "./SetupChecklistHome.js"

const STATUS_BADGE: Record<StepStatus, { tone: "ok" | "warn" | "info" | "muted"; label: string }> = {
  done: { tone: "ok", label: "Done" },
  skipped: { tone: "muted", label: "Skipped" },
  active: { tone: "info", label: "In progress" },
  locked: { tone: "muted", label: "Locked" },
}

export function OnboardingWizard() {
  const [state, setState] = useState<WizardState>(() => loadWizardState())
  // When the admin lands fresh on a partially-complete setup, show the
  // persistent checklist home instead of dropping them mid-wizard. They open
  // the wizard explicitly via "Resume setup".
  const [view, setView] = useState<"home" | "wizard">(() => {
    const s = loadWizardState()
    return isSetupStarted(s) && !isSetupComplete(s) ? "home" : "wizard"
  })

  const update = useCallback((next: WizardState) => {
    setState(saveWizardState(next))
  }, [])

  const goToStep = useCallback(
    (index: number) => {
      update({ ...state, activeStep: index })
      setView("wizard")
    },
    [state, update],
  )

  const setStepResult = useCallback(
    (index: number, result: "done" | "skipped") => {
      const key = WIZARD_STEPS[index].key
      const completion = { ...state.completion, [key]: result }
      const nextIndex = Math.min(index + 1, WIZARD_STEPS.length - 1)
      update({ ...state, completion, activeStep: nextIndex })
    },
    [state, update],
  )

  const setSuccessMetric = useCallback(
    (metric: SuccessMetric) => update({ ...state, successMetric: metric }),
    [state, update],
  )

  if (view === "home") {
    return <SetupChecklistHome state={state} onResume={(i) => goToStep(i)} />
  }

  const activeIndex = state.activeStep
  const activeStepDef = WIZARD_STEPS[activeIndex]
  const resolved = resolvedCount(state)

  return (
    <div>
      <PageHeader
        eyebrow="Onboarding"
        title="Get live with WeKruit"
        description="~15 min of your time; ATS + security run in the background. Skip or save & exit anytime — your progress is kept."
        actions={
          <div style={headerActions}>
            <span style={progressHint}>
              {resolved} / {WIZARD_STEPS.length} steps resolved
            </span>
            {isSetupStarted(state) ? (
              <button type="button" style={ghostBtn} onClick={() => setView("home")}>
                Save &amp; exit
              </button>
            ) : null}
          </div>
        }
      />

      <div style={wizardGrid}>
        <VerticalStepper
          state={state}
          activeIndex={activeIndex}
          onSelect={(i) => goToStep(i)}
        />

        <div>
          <Panel
            title={activeStepDef.label}
            eyebrow={`Step ${activeIndex + 1} of ${WIZARD_STEPS.length}`}
            actions={<Badge tone={STATUS_BADGE[stepStatus(state, activeIndex)].tone}>{STATUS_BADGE[stepStatus(state, activeIndex)].label}</Badge>}
          >
            {activeIndex === 0 ? (
              <WelcomeStep
                successMetric={state.successMetric}
                onPickMetric={setSuccessMetric}
                onContinue={() => setStepResult(0, "done")}
              />
            ) : (
              <ComingSoonStep
                label={activeStepDef.label}
                onSkip={() => setStepResult(activeIndex, "skipped")}
                onPrev={activeIndex > 0 ? () => goToStep(activeIndex - 1) : undefined}
              />
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// VerticalStepper
// ---------------------------------------------------------------------------

function VerticalStepper({
  state,
  activeIndex,
  onSelect,
}: {
  state: WizardState
  activeIndex: number
  onSelect: (index: number) => void
}) {
  return (
    <nav aria-label="Onboarding steps" style={stepperWrap}>
      {WIZARD_STEPS.map((step, index) => {
        const status = stepStatus(state, index)
        const isActive = index === activeIndex
        const locked = status === "locked"
        return (
          <button
            key={step.key}
            type="button"
            disabled={locked}
            onClick={() => !locked && onSelect(index)}
            aria-current={isActive ? "step" : undefined}
            style={{
              ...stepRow,
              ...(isActive ? stepRowActive : null),
              ...(locked ? stepRowLocked : null),
            }}
          >
            <span style={{ ...stepMarker, ...markerTone(status, isActive) }}>
              {status === "done" ? "✓" : status === "skipped" ? "–" : index + 1}
            </span>
            <span style={stepText}>
              <span style={stepLabel}>{step.label}</span>
              <span style={stepStatusText}>{STATUS_BADGE[status].label}</span>
            </span>
          </button>
        )
      })}
    </nav>
  )
}

function markerTone(status: StepStatus, isActive: boolean): CSSProperties {
  if (status === "done") return { background: "#16a34a", color: "#fff", borderColor: "#16a34a" }
  if (status === "skipped") return { background: "var(--surface, #fff)", color: "var(--ink-3, #6b7280)" }
  if (isActive || status === "active")
    return { background: "var(--ink-1, #111827)", color: "#fff", borderColor: "var(--ink-1, #111827)" }
  return { background: "var(--surface, #fff)", color: "var(--ink-3, #6b7280)" }
}

// ---------------------------------------------------------------------------
// Step 0 — Welcome / Value
// ---------------------------------------------------------------------------

const YOU_DO = [
  "Point WeKruit at one real role",
  "Sign off on the screening rubric",
  "Approve the first outreach",
]
const WEKRUIT_DOES = [
  "Enrich the job + your candidate pool",
  "Match, rediscover & score candidates",
  "Run the prescreen and explain every call",
]

function WelcomeStep({
  successMetric,
  onPickMetric,
  onContinue,
}: {
  successMetric: SuccessMetric
  onPickMetric: (m: SuccessMetric) => void
  onContinue: () => void
}) {
  return (
    <div style={stepBody}>
      <div style={hero}>
        <p style={heroEyebrow}>Your AI recruiter is ready</p>
        <h3 style={heroTitle}>Let&apos;s point it at a real role.</h3>
        <p style={heroSub}>
          A managed easy-button: you do the green steps, WeKruit does the work. We&apos;ll measure
          everything against one number you choose below.
        </p>
      </div>

      <div style={legendGrid}>
        <div style={legendCol}>
          <div style={{ ...legendHead, color: "#15803d" }}>You do</div>
          <ul style={legendList}>
            {YOU_DO.map((t) => (
              <li key={t} style={legendItem}>
                <span style={{ ...dot, background: "#16a34a" }} />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <div style={legendCol}>
          <div style={{ ...legendHead, color: "#2563eb" }}>WeKruit does</div>
          <ul style={legendList}>
            {WEKRUIT_DOES.map((t) => (
              <li key={t} style={legendItem}>
                <span style={{ ...dot, background: "#2563eb" }} />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <SuccessMetricPicker value={successMetric} onChange={onPickMetric} />

      <div style={stepActions}>
        <button type="button" style={primaryBtn} onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  )
}

function SuccessMetricPicker({
  value,
  onChange,
}: {
  value: SuccessMetric
  onChange: (m: SuccessMetric) => void
}) {
  return (
    <fieldset style={pickerWrap}>
      <legend style={pickerLegend}>What does success look like for your pilot?</legend>
      <div style={pickerOptions}>
        {SUCCESS_METRICS.map((m) => {
          const active = m.value === value
          const isDefault = m.value === DEFAULT_SUCCESS_METRIC
          return (
            <label key={m.value} style={{ ...metricOption, ...(active ? metricOptionActive : null) }}>
              <input
                type="radio"
                name="success-metric"
                value={m.value}
                checked={active}
                onChange={() => onChange(m.value)}
                style={radioInput}
              />
              <span style={metricText}>
                <span style={metricLabel}>
                  {m.label}
                  {isDefault ? <span style={defaultTag}>default</span> : null}
                </span>
                <span style={metricHelp}>{m.help}</span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

// ---------------------------------------------------------------------------
// Generic "coming soon" placeholder step (Steps 1–6 this slice)
// ---------------------------------------------------------------------------

function ComingSoonStep({
  label,
  onSkip,
  onPrev,
}: {
  label: string
  onSkip: () => void
  onPrev?: () => void
}) {
  return (
    <div style={stepBody}>
      <div style={comingSoon}>
        <strong style={comingSoonTitle}>{label} — coming soon</strong>
        <p style={comingSoonBody}>
          This step is part of the onboarding flow but isn&apos;t wired up yet in this build. You can
          skip it for now and come back later — your progress is saved.
        </p>
      </div>
      <div style={stepActions}>
        {onPrev ? (
          <button type="button" style={ghostBtn} onClick={onPrev}>
            Back
          </button>
        ) : null}
        <button type="button" style={primaryBtn} onClick={onSkip}>
          Skip for now
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline styles (neutral token palette, matching the dashboard)
// ---------------------------------------------------------------------------

const headerActions: CSSProperties = { display: "flex", alignItems: "center", gap: 12 }
const progressHint: CSSProperties = { fontSize: 13, color: "var(--ink-3, #6b7280)" }

const wizardGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 280px) 1fr",
  gap: 20,
  alignItems: "start",
}

const stepperWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  border: "1px solid var(--line, #e5e7eb)",
  borderRadius: 12,
  padding: 8,
  background: "var(--surface, #fff)",
}
const stepRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  textAlign: "left",
  padding: "10px 12px",
  border: "none",
  borderRadius: 8,
  background: "transparent",
  cursor: "pointer",
}
const stepRowActive: CSSProperties = { background: "var(--hover, #f3f4f6)" }
const stepRowLocked: CSSProperties = { cursor: "not-allowed", opacity: 0.55 }
const stepMarker: CSSProperties = {
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
const stepText: CSSProperties = { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }
const stepLabel: CSSProperties = { fontSize: 14, fontWeight: 600, color: "var(--ink-1, #111827)" }
const stepStatusText: CSSProperties = { fontSize: 11, color: "var(--ink-3, #6b7280)" }

const stepBody: CSSProperties = { display: "flex", flexDirection: "column", gap: 20 }

const hero: CSSProperties = {
  border: "1px solid var(--line, #e5e7eb)",
  borderRadius: 12,
  padding: "18px 20px",
  background: "var(--hover, #f9fafb)",
}
const heroEyebrow: CSSProperties = {
  margin: 0,
  fontSize: 11,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  fontWeight: 600,
  color: "#2563eb",
}
const heroTitle: CSSProperties = { margin: "6px 0 8px", fontSize: 22, color: "var(--ink-1, #111827)" }
const heroSub: CSSProperties = { margin: 0, fontSize: 14, color: "var(--ink-2, #374151)", maxWidth: 560 }

const legendGrid: CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }
const legendCol: CSSProperties = {
  border: "1px solid var(--line, #e5e7eb)",
  borderRadius: 10,
  padding: "14px 16px",
  background: "var(--surface, #fff)",
}
const legendHead: CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  fontWeight: 700,
  marginBottom: 10,
}
const legendList: CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }
const legendItem: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  fontSize: 14,
  color: "var(--ink-2, #374151)",
}
const dot: CSSProperties = { width: 8, height: 8, borderRadius: "50%", marginTop: 6, flexShrink: 0 }

const pickerWrap: CSSProperties = {
  border: "1px solid var(--line, #e5e7eb)",
  borderRadius: 10,
  padding: "14px 16px",
  margin: 0,
  background: "var(--surface, #fff)",
}
const pickerLegend: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: "var(--ink-1, #111827)",
  padding: "0 4px",
}
const pickerOptions: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }
const metricOption: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "10px 12px",
  border: "1px solid var(--line, #e5e7eb)",
  borderRadius: 8,
  cursor: "pointer",
}
const metricOptionActive: CSSProperties = {
  borderColor: "var(--ink-1, #111827)",
  background: "var(--hover, #f9fafb)",
}
const radioInput: CSSProperties = { marginTop: 3 }
const metricText: CSSProperties = { display: "flex", flexDirection: "column", gap: 2 }
const metricLabel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
  fontWeight: 600,
  color: "var(--ink-1, #111827)",
}
const metricHelp: CSSProperties = { fontSize: 13, color: "var(--ink-3, #6b7280)" }
const defaultTag: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#2563eb",
  background: "#eff6ff",
  borderRadius: 4,
  padding: "1px 6px",
}

const comingSoon: CSSProperties = {
  border: "1px dashed var(--line, #d1d5db)",
  borderRadius: 12,
  padding: "24px 20px",
  textAlign: "center",
  background: "var(--hover, #f9fafb)",
}
const comingSoonTitle: CSSProperties = { display: "block", fontSize: 16, color: "var(--ink-1, #111827)" }
const comingSoonBody: CSSProperties = {
  margin: "8px auto 0",
  fontSize: 14,
  color: "var(--ink-3, #6b7280)",
  maxWidth: 460,
}

const stepActions: CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 10 }
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
const ghostBtn: CSSProperties = {
  padding: "9px 16px",
  fontSize: 14,
  fontWeight: 600,
  border: "1px solid var(--line, #e5e7eb)",
  borderRadius: 8,
  background: "var(--surface, #fff)",
  color: "var(--ink-2, #374151)",
  cursor: "pointer",
}

export default OnboardingWizard
