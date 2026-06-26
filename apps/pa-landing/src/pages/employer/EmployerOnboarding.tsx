/**
 * EmployerOnboarding — /employer/onboarding "Get live with WeKruit" wizard.
 *
 * Module A of the AI-headhunter enterprise onboarding (the managed
 * "hire, don't configure" easy-button). This is the CUSTOMER-FACING port of
 * the admin-harness wizard (apps/dashboard-web/src/pages/onboarding): it reuses
 * the same 7-step state machine, success-metric vocab, and resumable
 * localStorage state (../lib/employer-onboarding-state.js) but re-skins the UI
 * in pa-landing's warm wk- design system (cream background, Newsreader serif
 * headlines, peach/terracotta accents, pill buttons, halo-hero gradient) so it
 * looks like wekruit.com — NOT the admin console.
 *
 * This first slice ships Step 0 (Welcome/Value with the You-do / WeKruit-does
 * legend + success-metric picker) plus branded "coming soon" panels for Steps
 * 1–6 with Skip-for-now + Back, all navigable end-to-end via a numbered
 * vertical stepper. Server-state callable is a later slice.
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { Link } from "react-router-dom"
import {
  employerIntakeJob,
  employerCreatePilotReq,
  employerMatchPilotReq,
  employerInviteTeam,
  employerConnectRequest,
  employerAtsImportReqs,
  type EmployerIntakeJobOutput,
  type EmployerMatchPilotReqOutput,
  type EmployerInviteRole,
  type EmployerInviteTeamOutput,
  type EmployerConnectKind,
  type AtsOpenReq,
} from "../../lib/onboarding-api.js"
import {
  DEFAULT_SUCCESS_METRIC,
  SUCCESS_METRICS,
  WIZARD_STEPS,
  loadWizardState,
  resolvedCount,
  saveWizardState,
  stepStatus,
  type StepStatus,
  type SuccessMetric,
  type WizardState,
} from "../../lib/employer-onboarding-state.js"
import "../../styles/wekruit-tokens.css"

const STATUS_LABEL: Record<StepStatus, string> = {
  done: "Done",
  skipped: "Skipped",
  active: "In progress",
  locked: "Locked",
}

export default function EmployerOnboarding() {
  const [state, setState] = useState<WizardState>(() => loadWizardState())

  const update = useCallback((next: WizardState) => {
    setState(saveWizardState(next))
  }, [])

  const goToStep = useCallback(
    (index: number) => {
      update({ ...state, activeStep: index })
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

  // Step 6 sign-off — persist the pilot-req id + title and advance to Launch.
  const recordPilotReq = useCallback(
    (reqId: string, reqTitle: string) => {
      const index = WIZARD_STEPS.findIndex((s) => s.key === "calibrate_req")
      const key = WIZARD_STEPS[index].key
      const completion = { ...state.completion, [key]: "done" as const }
      const nextIndex = Math.min(index + 1, WIZARD_STEPS.length - 1)
      update({
        ...state,
        completion,
        activeStep: nextIndex,
        pilotReqId: reqId,
        pilotReqTitle: reqTitle,
      })
    },
    [state, update],
  )

  const activeIndex = state.activeStep
  const activeStepDef = WIZARD_STEPS[activeIndex]
  const resolved = resolvedCount(state)

  return (
    <main style={{ background: "var(--cream)", minHeight: "100vh" }}>
      <Header />
      <section
        style={{
          paddingTop: "clamp(36px, 7vw, 56px)",
          paddingBottom: 28,
          background: "var(--halo-hero, var(--cream))",
        }}
      >
        <div className="container-narrow" style={{ maxWidth: 760 }}>
          <span className="eyebrow" style={{ color: "var(--live)" }}>
            Get live with WeKruit
          </span>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 400,
              fontSize: "clamp(36px, 8vw, 48px)",
              lineHeight: 1.06,
              letterSpacing: "-0.01em",
              color: "var(--ink)",
              margin: "14px 0 0",
            }}
          >
            Your AI recruiter is ready —{" "}
            <em className="accent" style={{ fontStyle: "italic" }}>
              point it at a real role.
            </em>
          </h1>
          <p
            style={{
              fontSize: "var(--fs-lead)",
              color: "var(--ink-2)",
              lineHeight: 1.55,
              margin: "16px 0 0",
              maxWidth: 600,
            }}
          >
            A managed easy-button. ~15 minutes of your time; the ATS sync and
            security run in the background. Skip or save any step — your progress
            is kept.
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginTop: 22,
              flexWrap: "wrap",
            }}
          >
            <ProgressPill resolved={resolved} total={WIZARD_STEPS.length} />
          </div>
        </div>
      </section>

      <section style={{ paddingTop: 8, paddingBottom: 96 }}>
        <div className="container-narrow" style={{ maxWidth: 980 }}>
          <div style={wizardGrid}>
            <VerticalStepper
              state={state}
              activeIndex={activeIndex}
              onSelect={goToStep}
            />

            <div style={panel}>
              <div style={panelHead}>
                <span style={panelEyebrow}>
                  Step {activeIndex + 1} of {WIZARD_STEPS.length}
                </span>
                <StatusBadge status={stepStatus(state, activeIndex)} />
              </div>
              <h2 style={panelTitle}>{activeStepDef.label}</h2>

              {activeIndex === 0 ? (
                <WelcomeStep
                  successMetric={state.successMetric}
                  onPickMetric={setSuccessMetric}
                  onContinue={() => setStepResult(0, "done")}
                />
              ) : activeStepDef.key === "calibrate_req" ? (
                <CalibrateStep
                  successMetric={state.successMetric}
                  onSignedOff={recordPilotReq}
                  onSkip={() => setStepResult(activeIndex, "skipped")}
                  onPrev={activeIndex > 0 ? () => goToStep(activeIndex - 1) : undefined}
                />
              ) : activeStepDef.key === "invite_team" ? (
                <InviteTeamStep
                  onDone={() => setStepResult(activeIndex, "done")}
                  onSkip={() => setStepResult(activeIndex, "skipped")}
                  onPrev={activeIndex > 0 ? () => goToStep(activeIndex - 1) : undefined}
                />
              ) : activeStepDef.key === "connect_slack" ? (
                <ConnectSlackStep
                  onDone={() => setStepResult(activeIndex, "done")}
                  onSkip={() => setStepResult(activeIndex, "skipped")}
                  onPrev={activeIndex > 0 ? () => goToStep(activeIndex - 1) : undefined}
                />
              ) : activeStepDef.key === "connect_ats" ? (
                <ConnectAtsStep
                  onDone={() => setStepResult(activeIndex, "done")}
                  onSkip={() => setStepResult(activeIndex, "skipped")}
                  onPrev={activeIndex > 0 ? () => goToStep(activeIndex - 1) : undefined}
                />
              ) : activeStepDef.key === "import_pool" ? (
                <ImportPoolStep
                  onDone={() => setStepResult(activeIndex, "done")}
                  onSkip={() => setStepResult(activeIndex, "skipped")}
                  onPrev={activeIndex > 0 ? () => goToStep(activeIndex - 1) : undefined}
                />
              ) : activeStepDef.key === "launch" ? (
                <LaunchStep
                  pilotReqId={state.pilotReqId}
                  pilotReqTitle={state.pilotReqTitle}
                  onPrev={activeIndex > 0 ? () => goToStep(activeIndex - 1) : undefined}
                />
              ) : (
                <ComingSoonStep
                  label={activeStepDef.label}
                  onSkip={() => setStepResult(activeIndex, "skipped")}
                  onPrev={activeIndex > 0 ? () => goToStep(activeIndex - 1) : undefined}
                />
              )}
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  )
}

// ---------------------------------------------------------------------------
// Progress pill
// ---------------------------------------------------------------------------

function ProgressPill({ resolved, total }: { resolved: number; total: number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        letterSpacing: "0.04em",
        color: "var(--ink-2)",
        background: "var(--cream-3)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-pill)",
        padding: "6px 14px",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: resolved >= total ? "var(--success, #16794a)" : "var(--live)",
        }}
      />
      {resolved} / {total} steps resolved
    </span>
  )
}

// ---------------------------------------------------------------------------
// Vertical numbered stepper
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
            <span style={stepTextWrap}>
              <span style={stepLabel}>{step.label}</span>
              <span style={stepStatusText}>{STATUS_LABEL[status]}</span>
            </span>
          </button>
        )
      })}
    </nav>
  )
}

function markerTone(status: StepStatus, isActive: boolean): CSSProperties {
  if (status === "done")
    return { background: "var(--live)", color: "var(--cream-3)", borderColor: "var(--live)" }
  if (status === "skipped")
    return { background: "var(--cream-3)", color: "var(--ink-3)", borderColor: "var(--border)" }
  if (isActive || status === "active")
    return { background: "var(--ink)", color: "var(--cream-3)", borderColor: "var(--ink)" }
  return { background: "var(--cream-3)", color: "var(--ink-4)", borderColor: "var(--border)" }
}

function StatusBadge({ status }: { status: StepStatus }) {
  const tone: CSSProperties =
    status === "done"
      ? { color: "var(--live)", background: "var(--live-soft)", borderColor: "var(--live-border)" }
      : status === "active"
      ? { color: "var(--ink-2)", background: "var(--peach-50)", borderColor: "var(--peach-200)" }
      : { color: "var(--ink-3)", background: "var(--cream-3)", borderColor: "var(--border)" }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        padding: "4px 10px",
        borderRadius: "var(--r-pill)",
        border: "1px solid",
        ...tone,
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  )
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
      <p style={stepLede}>
        You do the warm-toned steps; WeKruit does the work — enrichment,
        matching, calibration, and scoring. We&apos;ll measure everything against
        one number you choose below.
      </p>

      <div style={legendGrid}>
        <div style={legendCol}>
          <div style={{ ...legendHead, color: "var(--ink)" }}>
            <span aria-hidden style={{ ...legendDotLg, background: "var(--ink)" }} />
            You do
          </div>
          <ul style={legendList}>
            {YOU_DO.map((t) => (
              <li key={t} style={legendItem}>
                <span style={{ ...dot, background: "var(--ink)" }} />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <div style={legendCol}>
          <div style={{ ...legendHead, color: "var(--live)" }}>
            <span aria-hidden style={{ ...legendDotLg, background: "var(--live)" }} />
            WeKruit does
          </div>
          <ul style={legendList}>
            {WEKRUIT_DOES.map((t) => (
              <li key={t} style={legendItem}>
                <span style={{ ...dot, background: "var(--live)" }} />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <SuccessMetricPicker value={successMetric} onChange={onPickMetric} />

      <div style={stepActions}>
        <button
          type="button"
          className="btn btn--primary"
          style={{ textDecoration: "none" }}
          onClick={onContinue}
        >
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
            <label
              key={m.value}
              style={{ ...metricOption, ...(active ? metricOptionActive : null) }}
            >
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
// Step 5 — Calibrate Pilot Req (REAL: enrich one role via the production
// 3-tier LLM job enricher → canonical tags + prescreen draft + clarifiers)
// ---------------------------------------------------------------------------

function prettyToken(token: string): string {
  return token
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function CalibrateStep({
  successMetric,
  onSignedOff,
  onSkip,
  onPrev,
}: {
  successMetric: SuccessMetric
  onSignedOff: (reqId: string, reqTitle: string) => void
  onSkip: () => void
  onPrev?: () => void
}) {
  const [title, setTitle] = useState("")
  const [companyName, setCompanyName] = useState("")
  const [locationRaw, setLocationRaw] = useState("")
  const [jobDescription, setJobDescription] = useState("")
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle")
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<EmployerIntakeJobOutput | null>(null)
  const [signOffStatus, setSignOffStatus] = useState<"idle" | "saving" | "error">("idle")
  const [signOffError, setSignOffError] = useState<string | null>(null)

  const canEnrich = title.trim().length > 0 && jobDescription.trim().length > 0

  const onEnrich = useCallback(async () => {
    if (!canEnrich || status === "loading") return
    setStatus("loading")
    setError(null)
    try {
      const out = await employerIntakeJob({
        title: title.trim(),
        jobDescription: jobDescription.trim(),
        companyName: companyName.trim() || undefined,
        locationRaw: locationRaw.trim() || undefined,
      })
      setResult(out)
      setStatus("done")
    } catch (err) {
      setStatus("error")
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't reach the enricher. Try again in a moment.",
      )
    }
  }, [canEnrich, status, title, jobDescription, companyName, locationRaw])

  const tags = result?.enrichedTags
  const skillChips = (tags?.skills ?? []).map((s) => s.name).filter(Boolean)
  const overall = result?.confidence?.overall

  const onSignOff = useCallback(async () => {
    if (status !== "done" || !result || signOffStatus === "saving") return
    setSignOffStatus("saving")
    setSignOffError(null)
    try {
      const out = await employerCreatePilotReq({
        title: title.trim(),
        jobDescription: jobDescription.trim(),
        companyName: companyName.trim() || undefined,
        locationRaw: locationRaw.trim() || undefined,
        enrichedTags: result.enrichedTags,
        hardFilters: result.hardFilters,
        prescreenQuestions: result.prescreenQuestions,
        successMetric,
      })
      onSignedOff(out.reqId, title.trim())
    } catch (err) {
      setSignOffStatus("error")
      setSignOffError(
        err instanceof Error
          ? err.message
          : "Couldn't save your pilot role. Try again in a moment.",
      )
    }
  }, [
    status,
    result,
    signOffStatus,
    title,
    jobDescription,
    companyName,
    locationRaw,
    successMetric,
    onSignedOff,
  ])

  return (
    <div style={stepBody}>
      <p style={stepLede}>
        Pick one real role. Claire enriches it into canonical tags, drafts the
        screening rubric, and asks 1–3 clarifying questions. You calibrate —
        you don&apos;t configure.
      </p>

      <div style={calForm}>
        <label style={calField}>
          <span style={calLabel}>Role title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Senior Frontend Engineer"
            style={calInput}
          />
        </label>

        <div style={calRow}>
          <label style={calField}>
            <span style={calLabel}>
              Company <span style={calOptional}>(optional)</span>
            </span>
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="e.g. Acme"
              style={calInput}
            />
          </label>
          <label style={calField}>
            <span style={calLabel}>
              Location <span style={calOptional}>(optional)</span>
            </span>
            <input
              type="text"
              value={locationRaw}
              onChange={(e) => setLocationRaw(e.target.value)}
              placeholder="e.g. NYC or Remote (US)"
              style={calInput}
            />
          </label>
        </div>

        <label style={calField}>
          <span style={calLabel}>Job description / role brief</span>
          <textarea
            value={jobDescription}
            onChange={(e) => setJobDescription(e.target.value)}
            placeholder="Paste the JD or describe the role — scope, must-haves, seniority, location, comp…"
            rows={8}
            style={calTextarea}
          />
        </label>

        <div style={calActionsRow}>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canEnrich || status === "loading"}
            onClick={onEnrich}
            style={{
              textDecoration: "none",
              opacity: !canEnrich || status === "loading" ? 0.55 : 1,
              cursor: !canEnrich || status === "loading" ? "not-allowed" : "pointer",
            }}
          >
            {status === "loading" ? "Enriching…" : "Enrich & calibrate"}
          </button>
          {status === "loading" ? (
            <span style={calHint}>Running the job enricher — this can take ~10–20s.</span>
          ) : null}
        </div>
      </div>

      {status === "error" && error ? (
        <div style={calErrorBox} role="alert">
          <strong style={{ display: "block", marginBottom: 4 }}>Enrichment failed</strong>
          {error}
        </div>
      ) : null}

      {status === "done" && result ? (
        <div style={calResultWrap}>
          {/* Confidence + approval */}
          <div style={calResultHead}>
            <span style={calResultEyebrow}>Calibration result</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {typeof overall === "number" ? (
                <span style={calBadge}>Confidence {Math.round(overall * 100)}%</span>
              ) : null}
              <span
                style={{
                  ...calBadge,
                  ...(result.approvalReady ? calBadgeGood : calBadgeWarn),
                }}
              >
                {result.approvalReady ? "Ready to sign off" : "Needs your input"}
              </span>
            </div>
          </div>

          {/* Canonical tags */}
          <CalTagGroup label="Role function" tokens={tags?.roleFunction} />
          <CalTagGroup label="Seniority" tokens={tags?.seniorityLevel ? [tags.seniorityLevel] : []} />
          <CalTagGroup label="Job type" tokens={tags?.jobType ? [tags.jobType] : []} />
          <CalTagGroup label="Industry" tokens={tags?.industrySector} />
          <CalTagGroup label="Location" tokens={tags?.locationBuckets} />
          <CalTagGroup label="Skills" tokens={skillChips} raw />
          <CalTagGroup label="Relevant tags" tokens={tags?.relevantTags} raw />

          {/* Prescreen questions */}
          {result.prescreenQuestions && result.prescreenQuestions.length > 0 ? (
            <div style={calSection}>
              <span style={calSectionLabel}>Drafted screening questions</span>
              <ol style={calQList}>
                {result.prescreenQuestions.map((q) => (
                  <li key={q.id} style={calQItem}>
                    {q.prompt}
                    {q.required ? <span style={calReqTag}>required</span> : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {/* Clarifying questions */}
          {result.clarifyingQuestions && result.clarifyingQuestions.length > 0 ? (
            <div style={calSection}>
              <span style={calSectionLabel}>Claire needs you to clarify</span>
              <ul style={calClarifyList}>
                {result.clarifyingQuestions.map((q, i) => (
                  <li key={i} style={calClarifyItem}>
                    {q}
                  </li>
                ))}
              </ul>
              <p style={calClarifyHint}>
                Fold the answers into the role brief above and re-run to tighten
                the calibration.
              </p>
            </div>
          ) : null}

          <p style={calScopeNote}>
            Review the tags and screening draft above. When you sign off,
            WeKruit saves this as a real, matchable pilot req — then matches it
            against the candidate pool. No candidates are contacted at this step.
          </p>
        </div>
      ) : null}

      {signOffStatus === "error" && signOffError ? (
        <div style={calErrorBox} role="alert">
          <strong style={{ display: "block", marginBottom: 4 }}>Couldn&apos;t save</strong>
          {signOffError}
        </div>
      ) : null}

      <div style={stepActions}>
        {onPrev ? (
          <button type="button" className="btn btn--ghost" onClick={onPrev}>
            ← Back
          </button>
        ) : (
          <span />
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" className="btn btn--secondary" onClick={onSkip}>
            Skip for now
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={status !== "done" || signOffStatus === "saving"}
            onClick={onSignOff}
            style={{
              textDecoration: "none",
              opacity: status !== "done" || signOffStatus === "saving" ? 0.55 : 1,
              cursor:
                status !== "done" || signOffStatus === "saving"
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            {signOffStatus === "saving" ? "Saving…" : "Looks right — sign off"}
          </button>
        </div>
      </div>
    </div>
  )
}

function CalTagGroup({
  label,
  tokens,
  raw,
}: {
  label: string
  tokens?: string[]
  raw?: boolean
}) {
  const items = (tokens ?? []).filter(Boolean)
  if (items.length === 0) return null
  return (
    <div style={calSection}>
      <span style={calSectionLabel}>{label}</span>
      <div style={calChipWrap}>
        {items.map((t) => (
          <span key={t} style={calChip}>
            {raw ? t : prettyToken(t)}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 7 — Launch (REAL: confirms the signed-off pilot req is saved + honest
// next step). Renders only after the pilot req persisted at Step 6 sign-off.
// ---------------------------------------------------------------------------

function LaunchStep({
  pilotReqId,
  pilotReqTitle,
  onPrev,
}: {
  pilotReqId?: string
  pilotReqTitle?: string
  onPrev?: () => void
}) {
  // Consent-safe pool-match COUNT for the saved pilot req. Counts only — no
  // candidate names/PII ever cross the public callable boundary.
  const [matchStatus, setMatchStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  )
  const [matchCounts, setMatchCounts] = useState<EmployerMatchPilotReqOutput | null>(null)

  useEffect(() => {
    if (!pilotReqId) return
    let cancelled = false
    setMatchStatus("loading")
    setMatchCounts(null)
    employerMatchPilotReq({ reqId: pilotReqId })
      .then((counts) => {
        if (cancelled) return
        setMatchCounts(counts)
        setMatchStatus("done")
      })
      .catch(() => {
        if (cancelled) return
        setMatchStatus("error")
      })
    return () => {
      cancelled = true
    }
  }, [pilotReqId])

  // Defensive: if a user lands here without signing off (e.g. skipped Step 6),
  // point them back rather than implying something was saved.
  if (!pilotReqId) {
    return (
      <div style={stepBody}>
        <p style={stepLede}>
          Sign off on a calibrated pilot req in the previous step and it&apos;ll
          be saved here — ready for WeKruit to match against the candidate pool.
        </p>
        <div style={comingSoon}>
          <span style={comingSoonKicker}>Nothing saved yet</span>
          <strong style={comingSoonTitle}>No pilot req on file</strong>
          <p style={comingSoonBody}>
            Head back to <em>Calibrate Pilot Req</em>, enrich one real role, and
            press <em>Looks right — sign off</em> to save it.
          </p>
        </div>
        <div style={stepActions}>
          {onPrev ? (
            <button type="button" className="btn btn--ghost" onClick={onPrev}>
              ← Back
            </button>
          ) : (
            <span />
          )}
          <span />
        </div>
      </div>
    )
  }

  return (
    <div style={stepBody}>
      <p style={stepLede}>
        Your pilot role is live in WeKruit. Here&apos;s exactly what happens
        next — no surprises.
      </p>

      <div style={launchCard}>
        <span style={launchCheck} aria-hidden>
          ✅
        </span>
        <div style={launchCardBody}>
          <strong style={launchCardTitle}>
            Your pilot role
            {pilotReqTitle ? (
              <>
                {" "}
                <em style={{ fontStyle: "italic" }}>{pilotReqTitle}</em>
              </>
            ) : null}{" "}
            is saved
          </strong>
          <div style={launchReqIdRow}>
            <span style={launchReqIdLabel}>Req ID</span>
            <code style={launchReqId}>{pilotReqId}</code>
          </div>
        </div>
      </div>

      <div style={launchNextWrap}>
        <span style={calSectionLabel}>What happens next</span>
        {matchStatus === "loading" ? (
          <p style={launchNextBody}>
            Scanning your retained candidate pool for this role…
          </p>
        ) : matchStatus === "done" && matchCounts ? (
          <p style={launchNextBody}>
            We scanned your retained pool: <strong>{matchCounts.roleRelevantLoaded}</strong>{" "}
            role-relevant {matchCounts.roleRelevantLoaded === 1 ? "candidate" : "candidates"},{" "}
            <strong>{matchCounts.potentialFits}</strong> look like potential fits.
            {matchCounts.scoringPending
              ? " (scoring refines as Claire ranks them.)"
              : ""}{" "}
            Claire screens them next — you&apos;ll only ever see candidates who
            pass screening and consent. No one is contacted without your approval.
          </p>
        ) : (
          // Loading-failed or idle fallback: keep the original honest copy.
          <p style={launchNextBody}>
            The role is saved as a matchable pilot req. WeKruit will match it
            against the candidate pool next — scoring and ranking candidates by
            fit. Nobody has been contacted yet: reaching out to candidates is a
            separate step you&apos;ll approve. You can close this page; your
            progress is saved.
          </p>
        )}
      </div>

      <div style={stepActions}>
        {onPrev ? (
          <button type="button" className="btn btn--ghost" onClick={onPrev}>
            ← Back
          </button>
        ) : (
          <span />
        )}
        <Link
          to="/employers"
          className="btn btn--primary"
          style={{ textDecoration: "none" }}
        >
          Done
        </Link>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 4 — Invite Team (REAL: send invite emails via Mailgun + record invites)
// ---------------------------------------------------------------------------

const INVITE_ROLE_OPTIONS: Array<{ value: EmployerInviteRole; label: string }> = [
  { value: "recruiter", label: "Recruiter" },
  { value: "hiring_manager", label: "Hiring Manager" },
  { value: "admin", label: "Admin" },
  { value: "reviewer", label: "Reviewer" },
]

type InviteRow = { email: string; role: EmployerInviteRole }

function emptyRow(): InviteRow {
  return { email: "", role: "recruiter" }
}

const BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function InviteTeamStep({
  onDone,
  onSkip,
  onPrev,
}: {
  onDone: () => void
  onSkip: () => void
  onPrev?: () => void
}) {
  const [orgName, setOrgName] = useState("")
  const [inviterEmail, setInviterEmail] = useState("")
  const [rows, setRows] = useState<InviteRow[]>(() => [emptyRow(), emptyRow()])
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle")
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<EmployerInviteTeamOutput | null>(null)

  const filledRows = rows.filter((r) => r.email.trim().length > 0)
  const hasAnyValid = filledRows.some((r) => BASIC_EMAIL_RE.test(r.email.trim().toLowerCase()))

  const setRow = useCallback((index: number, patch: Partial<InviteRow>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }, [])

  const addRow = useCallback(() => {
    setRows((prev) => (prev.length >= 25 ? prev : [...prev, emptyRow()]))
  }, [])

  const removeRow = useCallback((index: number) => {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)))
  }, [])

  const onSend = useCallback(async () => {
    if (!hasAnyValid || status === "sending") return
    setStatus("sending")
    setError(null)
    try {
      const invites = filledRows.map((r) => ({
        email: r.email.trim().toLowerCase(),
        role: r.role,
      }))
      const out = await employerInviteTeam({
        invites,
        orgName: orgName.trim() || undefined,
        inviterEmail: inviterEmail.trim() || undefined,
      })
      setResult(out)
      setStatus("done")
    } catch (err) {
      setStatus("error")
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't send invites. Try again in a moment.",
      )
    }
  }, [hasAnyValid, status, filledRows, orgName, inviterEmail])

  return (
    <div style={stepBody}>
      <p style={stepLede}>
        Bring recruiters and hiring managers in. We&apos;ll email each person an
        invite now — optional, so you can pilot solo and add the team later.
      </p>

      <div style={calForm}>
        <div style={calRow}>
          <label style={calField}>
            <span style={calLabel}>
              Company / team name <span style={calOptional}>(optional)</span>
            </span>
            <input
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="e.g. Acme"
              style={calInput}
            />
          </label>
          <label style={calField}>
            <span style={calLabel}>
              Your email <span style={calOptional}>(optional)</span>
            </span>
            <input
              type="email"
              value={inviterEmail}
              onChange={(e) => setInviterEmail(e.target.value)}
              placeholder="you@company.com"
              style={calInput}
            />
          </label>
        </div>

        <div style={calField}>
          <span style={calLabel}>Teammates</span>
          <div style={inviteRowsWrap}>
            {rows.map((row, i) => {
              const trimmed = row.email.trim().toLowerCase()
              const invalid = trimmed.length > 0 && !BASIC_EMAIL_RE.test(trimmed)
              return (
                <div key={i} style={inviteRow}>
                  <input
                    type="email"
                    value={row.email}
                    onChange={(e) => setRow(i, { email: e.target.value })}
                    placeholder="teammate@company.com"
                    aria-label={`Teammate email ${i + 1}`}
                    style={{
                      ...calInput,
                      ...inviteEmailInput,
                      ...(invalid ? inviteInputInvalid : null),
                    }}
                  />
                  <select
                    value={row.role}
                    onChange={(e) =>
                      setRow(i, { role: e.target.value as EmployerInviteRole })
                    }
                    aria-label={`Teammate role ${i + 1}`}
                    style={{ ...calInput, ...inviteRoleSelect }}
                  >
                    {INVITE_ROLE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    disabled={rows.length <= 1}
                    aria-label={`Remove teammate ${i + 1}`}
                    style={{
                      ...inviteRemoveBtn,
                      opacity: rows.length <= 1 ? 0.35 : 1,
                      cursor: rows.length <= 1 ? "not-allowed" : "pointer",
                    }}
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
          <button
            type="button"
            onClick={addRow}
            disabled={rows.length >= 25}
            style={{
              ...inviteAddBtn,
              opacity: rows.length >= 25 ? 0.45 : 1,
              cursor: rows.length >= 25 ? "not-allowed" : "pointer",
            }}
          >
            + Add another
          </button>
        </div>

        <div style={calActionsRow}>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!hasAnyValid || status === "sending"}
            onClick={onSend}
            style={{
              textDecoration: "none",
              opacity: !hasAnyValid || status === "sending" ? 0.55 : 1,
              cursor: !hasAnyValid || status === "sending" ? "not-allowed" : "pointer",
            }}
          >
            {status === "sending" ? "Sending invites…" : "Send invites"}
          </button>
          {status === "sending" ? (
            <span style={calHint}>Emailing your team…</span>
          ) : null}
        </div>
      </div>

      {status === "error" && error ? (
        <div style={calErrorBox} role="alert">
          <strong style={{ display: "block", marginBottom: 4 }}>Couldn&apos;t send</strong>
          {error}
        </div>
      ) : null}

      {status === "done" && result ? (
        <div style={calResultWrap}>
          <div style={calResultHead}>
            <span style={calResultEyebrow}>Invites</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span style={{ ...calBadge, ...calBadgeGood }}>
                {result.sent} sent
              </span>
              {result.failed.length > 0 ? (
                <span style={{ ...calBadge, ...calBadgeWarn }}>
                  {result.failed.length} skipped
                </span>
              ) : null}
            </div>
          </div>

          {result.invited.length > 0 ? (
            <div style={calSection}>
              <span style={calSectionLabel}>Sent</span>
              <div style={inviteTableWrap}>
                {result.invited.map((inv) => (
                  <div key={inv.email} style={inviteResultRow}>
                    <span style={inviteResultEmail}>{inv.email}</span>
                    <span style={inviteRolePill}>{prettyToken(inv.role)}</span>
                    <span style={inviteSentTag}>✓ sent</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {result.failed.length > 0 ? (
            <div style={calSection}>
              <span style={calSectionLabel}>Skipped</span>
              <div style={inviteTableWrap}>
                {result.failed.map((f, i) => (
                  <div key={`${f.email}-${i}`} style={inviteResultRow}>
                    <span style={inviteResultEmail}>{f.email || "(no email)"}</span>
                    <span style={inviteFailReason}>{f.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <p style={calScopeNote}>
            Teammates get an email now; full role-based access (teammate login +
            permissions) lands soon. Nothing else is needed from you here.
          </p>
        </div>
      ) : null}

      <div style={stepActions}>
        {onPrev ? (
          <button type="button" className="btn btn--ghost" onClick={onPrev}>
            ← Back
          </button>
        ) : (
          <span />
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" className="btn btn--secondary" onClick={onSkip}>
            Skip for now
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={status !== "done"}
            onClick={onDone}
            style={{
              textDecoration: "none",
              opacity: status !== "done" ? 0.55 : 1,
              cursor: status !== "done" ? "not-allowed" : "pointer",
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Steps 1–3 — Connect Slack / Connect ATS / Import Pool (REAL: record a managed
// -setup request via paEmployerConnectRequest + email ops). These are NOT live
// self-serve integrations — they REQUEST managed setup. Our team connects it in
// the background; the honest "runs in the background" posture is what ships.
// ---------------------------------------------------------------------------

// Kombo-supported ATS list (planning docs name Greenhouse/Ashby/Lever/Workday/
// SmartRecruiters/iCIMS/Oracle) + common cohort ATS + escapes. MVP only RECORDS
// the provider + emails ops, so the exact list is non-load-bearing.
const ATS_PROVIDER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "ashby", label: "Ashby" },
  { value: "greenhouse", label: "Greenhouse" },
  { value: "lever", label: "Lever" },
  { value: "workday", label: "Workday" },
  { value: "workable", label: "Workable" },
  { value: "smartrecruiters", label: "SmartRecruiters" },
  { value: "icims", label: "iCIMS" },
  { value: "oracle", label: "Oracle" },
  { value: "bamboohr", label: "BambooHR" },
  { value: "recruitee", label: "Recruitee" },
  { value: "teamtailor", label: "Teamtailor" },
  { value: "other", label: "Other / not listed" },
  { value: "none", label: "No ATS — pool-only pilot" },
]

const POOL_SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "their_ats", label: "Export from our ATS" },
  { value: "csv", label: "CSV / spreadsheet" },
  { value: "pdf", label: "Resume PDFs" },
  { value: "linkedin", label: "LinkedIn export" },
  { value: "other", label: "Other / not listed" },
]

/**
 * Shared "request managed setup" step. Renders a small form (optional provider
 * <select>, free-text details, your email), posts to paEmployerConnectRequest,
 * and shows an honest confirmation ("Requested — our team will connect your
 * <provider> in the background"). Continue unlocks only after a successful POST.
 */
function ConnectRequestStep({
  kind,
  lede,
  providerLabel,
  providerOptions,
  detailsLabel,
  detailsPlaceholder,
  submitLabel,
  noun,
  extra,
  onDone,
  onSkip,
  onPrev,
}: {
  kind: EmployerConnectKind
  lede: string
  providerLabel?: string
  providerOptions?: Array<{ value: string; label: string }>
  detailsLabel: string
  detailsPlaceholder: string
  submitLabel: string
  noun: string
  /** ATS-only self-serve affordance rendered inside the form card, above the provider select. */
  extra?: ReactNode
  onDone: () => void
  onSkip: () => void
  onPrev?: () => void
}) {
  const [provider, setProvider] = useState(() =>
    providerOptions && providerOptions.length > 0 ? providerOptions[0].value : "",
  )
  const [details, setDetails] = useState("")
  const [orgName, setOrgName] = useState("")
  const [requesterEmail, setRequesterEmail] = useState("")
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle")
  const [error, setError] = useState<string | null>(null)

  const providerLabelText =
    providerOptions?.find((o) => o.value === provider)?.label ?? provider

  const onSend = useCallback(async () => {
    if (status === "sending") return
    setStatus("sending")
    setError(null)
    try {
      await employerConnectRequest({
        kind,
        provider: provider || undefined,
        details: details.trim() || undefined,
        orgName: orgName.trim() || undefined,
        requesterEmail: requesterEmail.trim() || undefined,
      })
      setStatus("done")
    } catch (err) {
      setStatus("error")
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't send your request. Try again in a moment.",
      )
    }
  }, [status, kind, provider, details, orgName, requesterEmail])

  // Pool-only pilot escape: ATS "none" maps to Skip (the UX doc's "No ATS? Skip").
  const isPoolOnlyEscape = kind === "ats" && provider === "none"

  return (
    <div style={stepBody}>
      <p style={stepLede}>{lede}</p>

      <div style={calForm}>
        {extra}
        {providerOptions && providerOptions.length > 0 ? (
          <div style={calRow}>
            <label style={calField}>
              <span style={calLabel}>{providerLabel ?? "Provider"}</span>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                style={{ ...calInput, cursor: "pointer" }}
              >
                {providerOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={calField}>
              <span style={calLabel}>
                Company / team name <span style={calOptional}>(optional)</span>
              </span>
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="e.g. Acme"
                style={calInput}
              />
            </label>
          </div>
        ) : (
          <div style={calField}>
            <span style={calLabel}>
              Company / team name <span style={calOptional}>(optional)</span>
            </span>
            <input
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="e.g. Acme"
              style={calInput}
            />
          </div>
        )}

        <div style={calField}>
          <span style={calLabel}>
            {detailsLabel} <span style={calOptional}>(optional)</span>
          </span>
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder={detailsPlaceholder}
            style={{ ...calTextarea, minHeight: 96 }}
          />
        </div>

        <div style={calField}>
          <span style={calLabel}>
            Your email <span style={calOptional}>(optional)</span>
          </span>
          <input
            type="email"
            value={requesterEmail}
            onChange={(e) => setRequesterEmail(e.target.value)}
            placeholder="you@company.com"
            style={calInput}
          />
        </div>

        {isPoolOnlyEscape ? (
          <p style={calScopeNote}>
            No ATS? No problem — skip this step and run a pool-only pilot. You can
            import a candidate pool any time.
          </p>
        ) : null}

        <div style={calActionsRow}>
          <button
            type="button"
            className="btn btn--primary"
            disabled={status === "sending" || status === "done"}
            onClick={onSend}
            style={{
              textDecoration: "none",
              opacity: status === "sending" || status === "done" ? 0.55 : 1,
              cursor: status === "sending" || status === "done" ? "not-allowed" : "pointer",
            }}
          >
            {status === "sending"
              ? "Sending request…"
              : status === "done"
                ? "Requested ✓"
                : submitLabel}
          </button>
          {status === "sending" ? (
            <span style={calHint}>Sending your request…</span>
          ) : null}
        </div>
      </div>

      {status === "error" && error ? (
        <div style={calErrorBox} role="alert">
          <strong style={{ display: "block", marginBottom: 4 }}>Couldn&apos;t send</strong>
          {error}
        </div>
      ) : null}

      {status === "done" ? (
        <div style={calResultWrap}>
          <div style={calResultHead}>
            <span style={calResultEyebrow}>Request</span>
            <span style={{ ...calBadge, ...calBadgeGood }}>Request received</span>
          </div>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: "var(--ink)" }}>
            Requested — our team will connect your{" "}
            <strong>
              {providerLabelText && provider && provider !== "none"
                ? `${providerLabelText} ${noun}`
                : noun}
            </strong>{" "}
            in the background. Nothing else is needed from you.
          </p>
          <p style={calScopeNote}>
            This is a managed setup — we do the connection for you and ping you
            when it&apos;s live. It is not a self-serve integration you configure
            here.
          </p>
        </div>
      ) : null}

      <div style={stepActions}>
        {onPrev ? (
          <button type="button" className="btn btn--ghost" onClick={onPrev}>
            ← Back
          </button>
        ) : (
          <span />
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" className="btn btn--secondary" onClick={onSkip}>
            Skip for now
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={status !== "done"}
            onClick={onDone}
            style={{
              textDecoration: "none",
              opacity: status !== "done" ? 0.55 : 1,
              cursor: status !== "done" ? "not-allowed" : "pointer",
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

function ConnectSlackStep(props: { onDone: () => void; onSkip: () => void; onPrev?: () => void }) {
  return (
    <ConnectRequestStep
      kind="slack"
      noun="Slack workspace"
      lede="Add WeKruit to Slack and Claire moves into your hiring channel — your first qualified candidates land where the team already works. Tell us your workspace and we'll set it up for you."
      detailsLabel="Workspace + channel"
      detailsPlaceholder="e.g. acme.slack.com — #hiring channel (or Microsoft Teams)"
      submitLabel="Request setup"
      {...props}
    />
  )
}

/**
 * AtsBoardImport — REAL self-serve read-back of a PUBLIC ATS board.
 *
 * Paste a Greenhouse / Lever / Ashby public board URL → we fetch + normalize
 * the open reqs live (read-only, no ATS connection, no candidates). Sits ABOVE
 * the managed-connect request form: the fast self-serve path on top, the
 * managed setup below. Mirrors CalibrateStep's fetch-state pattern.
 */
function AtsBoardImport() {
  const [boardUrl, setBoardUrl] = useState("")
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle")
  const [error, setError] = useState<string | null>(null)
  const [reqs, setReqs] = useState<AtsOpenReq[]>([])
  const [count, setCount] = useState(0)
  const [provider, setProvider] = useState<string | null>(null)
  const [org, setOrg] = useState<string | null>(null)
  // Per-req "Use this req" state: index → created pilot reqId, or "error".
  const [addedReqs, setAddedReqs] = useState<Record<number, string>>({})
  const [addingReq, setAddingReq] = useState<number | null>(null)

  const canPull = boardUrl.trim().length > 0 && status !== "loading"

  // Turn a pulled (read-only) req into a REAL matchable pilot req — reuses the
  // same dual-write pipeline as Calibrate sign-off, so an ATS req the employer
  // already posted becomes immediately retrievable by the matcher. Closes the
  // "pulled reqs are an inert preview" gap.
  const onUseReq = useCallback(
    async (r: AtsOpenReq, i: number) => {
      if (addingReq !== null || addedReqs[i]) return
      setAddingReq(i)
      try {
        const out = await employerCreatePilotReq({
          title: r.title,
          jobDescription: [
            `Imported from ${provider ?? "ATS"} public job board.`,
            `Source: ${r.url}`,
            r.location ? `Location: ${r.location}` : "",
            r.department ? `Department: ${r.department}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          companyName: org ?? undefined,
          locationRaw: r.location || undefined,
        })
        setAddedReqs((m) => ({ ...m, [i]: out.reqId }))
      } catch {
        setAddedReqs((m) => ({ ...m, [i]: "error" }))
      } finally {
        setAddingReq(null)
      }
    },
    [addingReq, addedReqs, provider, org],
  )

  const onPull = useCallback(async () => {
    if (!canPull) return
    setStatus("loading")
    setError(null)
    try {
      const out = await employerAtsImportReqs({ board: boardUrl.trim() })
      if (!out.ok) {
        setStatus("error")
        setError(
          out.error === "unrecognized_board"
            ? "Unrecognized board — paste a Greenhouse, Lever, or Ashby public board URL."
            : out.error === "board_not_found"
              ? "We couldn't find that board. Double-check the org/token in your URL."
              : "Couldn't reach that board. Check the URL and try again.",
        )
        return
      }
      setReqs(out.reqs ?? [])
      setCount(out.count ?? (out.reqs ?? []).length)
      setProvider(out.provider ?? null)
      setOrg(out.org ?? null)
      setAddedReqs({})
      setStatus("done")
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : "Couldn't reach that board. Check the URL.")
    }
  }, [canPull, boardUrl])

  return (
    <div style={atsImportWrap}>
      <div style={calField}>
        <span style={calLabel}>
          Your public job board URL{" "}
          <span style={calOptional}>(Greenhouse / Lever / Ashby)</span>
        </span>
        <div style={atsImportRow}>
          <input
            type="url"
            value={boardUrl}
            onChange={(e) => setBoardUrl(e.target.value)}
            placeholder="e.g. boards.greenhouse.io/acme or jobs.lever.co/acme"
            style={{ ...calInput, flex: "1 1 240px", minWidth: 0 }}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canPull}
            onClick={onPull}
            style={{
              textDecoration: "none",
              opacity: !canPull ? 0.55 : 1,
              cursor: !canPull ? "not-allowed" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {status === "loading" ? "Pulling…" : "Pull my open reqs"}
          </button>
        </div>
        {status === "loading" ? (
          <span style={calHint}>Reading your public board…</span>
        ) : null}
      </div>

      {status === "error" && error ? (
        <div style={calErrorBox} role="alert">
          <strong style={{ display: "block", marginBottom: 4 }}>Couldn&apos;t pull reqs</strong>
          {error}
        </div>
      ) : null}

      {status === "done" ? (
        <div style={calResultWrap}>
          <div style={calResultHead}>
            <span style={calResultEyebrow}>Open reqs</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span style={{ ...calBadge, ...calBadgeGood }}>{count} found</span>
              {provider ? <span style={calBadge}>{provider}</span> : null}
            </div>
          </div>

          {reqs.length > 0 ? (
            <div style={atsReqScroll}>
              <div style={inviteTableWrap}>
                {reqs.map((r, i) => (
                  <div key={`${r.url}-${i}`} style={inviteResultRow}>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ ...inviteResultEmail, color: "var(--live)", textDecoration: "none" }}
                    >
                      {r.title}
                    </a>
                    {r.location ? <span style={calChip}>{r.location}</span> : null}
                    {r.department ? <span style={inviteRolePill}>{r.department}</span> : null}
                    {r.jobType ? <span style={inviteRolePill}>{r.jobType}</span> : null}
                    <span style={{ marginLeft: "auto" }}>
                      {addedReqs[i] === "error" ? (
                        <span style={{ ...calChip, color: "var(--err, #b3261e)" }}>couldn&apos;t add</span>
                      ) : addedReqs[i] ? (
                        <span style={{ ...calBadge, ...calBadgeGood }}>✓ pilot req added</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onUseReq(r, i)}
                          disabled={addingReq !== null}
                          style={{
                            ...inviteRolePill,
                            cursor: addingReq !== null ? "not-allowed" : "pointer",
                            opacity: addingReq !== null && addingReq !== i ? 0.5 : 1,
                            border: "1px solid var(--live)",
                            color: "var(--live)",
                            background: "transparent",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {addingReq === i ? "Adding…" : "Use this req →"}
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: 14, color: "var(--ink-2)" }}>
              No open reqs found on that board right now.
            </p>
          )}

          <p style={calScopeNote}>
            Live read of your PUBLIC board. Hit <strong>Use this req</strong> to
            turn one into a matchable WeKruit pilot role (Claire scores it against
            your pool right away). Pulling reqs doesn&apos;t connect your ATS —
            syncing private candidates needs the secure connection our team sets
            up below.
          </p>
        </div>
      ) : null}

      <div style={atsImportDivider} />
    </div>
  )
}

function ConnectAtsStep(props: { onDone: () => void; onSkip: () => void; onPrev?: () => void }) {
  return (
    <ConnectRequestStep
      kind="ats"
      noun="ATS"
      lede="Authorize your ATS once and we read back your open reqs and candidate pool. Pick your ATS and we'll connect it for you in the background. No ATS? Choose pool-only and skip."
      providerLabel="Your ATS"
      providerOptions={ATS_PROVIDER_OPTIONS}
      detailsLabel="Anything we should know"
      detailsPlaceholder="e.g. admin contact for the integration, sandbox vs prod, multiple instances…"
      submitLabel="Request connection"
      extra={<AtsBoardImport />}
      {...props}
    />
  )
}

function ImportPoolStep(props: { onDone: () => void; onSkip: () => void; onPrev?: () => void }) {
  return (
    <ConnectRequestStep
      kind="pool"
      noun="candidate pool"
      lede="Your past applicants and silver-medalists become a Day-1 asset — re-screenable against every open role. Tell us where the pool lives and we'll import it for you."
      providerLabel="Pool source"
      providerOptions={POOL_SOURCE_OPTIONS}
      detailsLabel="How to access the pool"
      detailsPlaceholder="e.g. ~2k past applicants in Greenhouse, or a CSV we can share…"
      submitLabel="Request import"
      {...props}
    />
  )
}

// ---------------------------------------------------------------------------
// Generic branded "coming soon" placeholder step (remaining unwired steps)
// ---------------------------------------------------------------------------

const STEP_BLURB: Partial<Record<string, string>> = {
  "Connect Slack":
    "Add WeKruit to Slack and Claire moves into your hiring channel — your first qualified candidates land where the team already works.",
  "Connect ATS":
    "Authorize your ATS once and we read back your open reqs and candidate pool. No ATS? Skip to a pool-only pilot.",
  "Import Pool":
    "Your past applicants and silver-medalists become a Day-1 asset — re-screenable against every open role.",
  "Invite Team":
    "Bring recruiters and hiring managers in via Slack, with least-privilege roles. Optional — pilot solo if you like.",
  "Calibrate Pilot Req":
    "Pick one real role; Claire drafts the screening rubric and asks 1–3 clarifying questions. You sign off — calibrate, don't configure.",
  Launch:
    "One button sends WeKruit to work. The first matched and rediscovered candidates stream in with why-matched explanations.",
}

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
      <p style={stepLede}>{STEP_BLURB[label]}</p>
      <div style={comingSoon}>
        <span style={comingSoonKicker}>On the way</span>
        <strong style={comingSoonTitle}>{label}</strong>
        <p style={comingSoonBody}>
          This step is part of the onboarding flow but isn&apos;t wired up yet in
          this build. Skip it for now and come back any time — your progress is
          saved.
        </p>
      </div>
      <div style={stepActions}>
        {onPrev ? (
          <button type="button" className="btn btn--ghost" onClick={onPrev}>
            ← Back
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="btn btn--secondary" onClick={onSkip}>
          Skip for now
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header / Footer (employer-flavored, mirrors EmployerSignup)
// ---------------------------------------------------------------------------

function Header() {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "rgba(245,237,227,.82)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        className="container"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 72,
          maxWidth: 1280,
          marginInline: "auto",
          paddingInline: 24,
        }}
      >
        <Link
          to="/employers"
          style={{
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "baseline",
            gap: 8,
            color: "var(--ink)",
          }}
        >
          <span style={{ fontFamily: "var(--font-serif)", fontSize: 22, letterSpacing: 0, fontWeight: 500 }}>
            WeKruit
          </span>
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 4,
              height: 4,
              borderRadius: 999,
              background: "var(--peach-300)",
              alignSelf: "center",
            }}
          />
          <em
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 20,
              fontStyle: "italic",
              fontWeight: 400,
              color: "var(--ink-2)",
            }}
          >
            Employers
          </em>
        </Link>
        <Link to="/employers" className="btn btn--ghost btn--sm" style={{ textDecoration: "none" }}>
          ← Employer overview
        </Link>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer style={{ borderTop: "1px solid var(--border)" }}>
      <div
        className="container"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "32px 24px",
          gap: 24,
          flexWrap: "wrap",
          maxWidth: 1280,
          marginInline: "auto",
        }}
      >
        <span className="caption" style={{ color: "var(--ink-3)" }}>
          Hire, don&apos;t configure. Claire does the work; you sign off.
        </span>
        <a className="caption" style={{ color: "var(--ink-3)" }} href="mailto:hello@wekruit.com">
          hello@wekruit.com
        </a>
      </div>
    </footer>
  )
}

// ---------------------------------------------------------------------------
// Inline styles (warm wk- token palette — customer-facing, NOT the admin kit)
// ---------------------------------------------------------------------------

const wizardGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 280px) 1fr",
  gap: 24,
  alignItems: "start",
}

const stepperWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  border: "1px solid var(--border)",
  borderRadius: "var(--r-lg)",
  padding: 10,
  background: "var(--cream-3)",
  boxShadow: "var(--shadow-sm)",
  position: "sticky",
  top: 92,
}
const stepRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  textAlign: "left",
  padding: "11px 12px",
  border: "1px solid transparent",
  borderRadius: "var(--r-md)",
  background: "transparent",
  cursor: "pointer",
  font: "inherit",
  transition: "background var(--dur-fast) var(--ease)",
}
const stepRowActive: CSSProperties = {
  background: "var(--peach-50)",
  borderColor: "var(--peach-200)",
}
const stepRowLocked: CSSProperties = { cursor: "not-allowed", opacity: 0.5 }
const stepMarker: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  flexShrink: 0,
  borderRadius: "50%",
  border: "1px solid var(--border)",
  fontSize: 13,
  fontWeight: 700,
  fontFamily: "var(--font-mono)",
}
const stepTextWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }
const stepLabel: CSSProperties = { fontSize: 14, fontWeight: 600, color: "var(--ink)" }
const stepStatusText: CSSProperties = { fontSize: 11, color: "var(--ink-3)" }

const panel: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--r-lg)",
  background: "var(--cream-3)",
  boxShadow: "var(--shadow-md)",
  padding: "clamp(20px, 4vw, 32px)",
}
const panelHead: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
}
const panelEyebrow: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
}
const panelTitle: CSSProperties = {
  fontFamily: "var(--font-serif)",
  fontWeight: 400,
  fontSize: "clamp(24px, 4vw, 30px)",
  color: "var(--ink)",
  margin: "10px 0 0",
}

const stepBody: CSSProperties = { display: "flex", flexDirection: "column", gap: 22, marginTop: 18 }
const stepLede: CSSProperties = {
  margin: 0,
  fontSize: "var(--fs-body)",
  lineHeight: 1.55,
  color: "var(--ink-2)",
  maxWidth: 600,
}

const legendGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 16,
}
const legendCol: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--r-md)",
  padding: "16px 18px",
  background: "var(--cream)",
}
const legendHead: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontWeight: 700,
  marginBottom: 12,
}
const legendDotLg: CSSProperties = { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 }
const legendList: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 11,
}
const legendItem: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  fontSize: 14,
  lineHeight: 1.45,
  color: "var(--ink-2)",
}
const dot: CSSProperties = { width: 7, height: 7, borderRadius: "50%", marginTop: 7, flexShrink: 0 }

const pickerWrap: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--r-md)",
  padding: "16px 18px",
  margin: 0,
  background: "var(--cream)",
}
const pickerLegend: CSSProperties = {
  fontFamily: "var(--font-serif)",
  fontSize: 18,
  fontWeight: 400,
  color: "var(--ink)",
  padding: "0 4px",
}
const pickerOptions: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }
const metricOption: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "12px 14px",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-md)",
  background: "var(--cream-3)",
  cursor: "pointer",
  transition: "border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease)",
}
const metricOptionActive: CSSProperties = {
  borderColor: "var(--live-border)",
  background: "var(--live-soft)",
}
const radioInput: CSSProperties = { marginTop: 3, accentColor: "var(--live)" }
const metricText: CSSProperties = { display: "flex", flexDirection: "column", gap: 3 }
const metricLabel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
  fontWeight: 600,
  color: "var(--ink)",
}
const metricHelp: CSSProperties = { fontSize: 13, lineHeight: 1.4, color: "var(--ink-3)" }
const defaultTag: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--live)",
  background: "var(--live-soft)",
  border: "1px solid var(--live-border)",
  borderRadius: "var(--r-pill)",
  padding: "1px 8px",
}

const comingSoon: CSSProperties = {
  border: "1px dashed var(--border-strong)",
  borderRadius: "var(--r-lg)",
  padding: "28px 22px",
  textAlign: "center",
  background: "var(--cream)",
}
const comingSoonKicker: CSSProperties = {
  display: "inline-block",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  marginBottom: 8,
}
const comingSoonTitle: CSSProperties = {
  display: "block",
  fontFamily: "var(--font-serif)",
  fontWeight: 400,
  fontSize: 22,
  color: "var(--ink)",
}
const comingSoonBody: CSSProperties = {
  margin: "10px auto 0",
  fontSize: 14,
  lineHeight: 1.5,
  color: "var(--ink-3)",
  maxWidth: 460,
}

const stepActions: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
}

// ---- Calibrate Pilot Req (Step 5) ----------------------------------------

const calForm: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  border: "1px solid var(--border)",
  borderRadius: "var(--r-lg)",
  padding: "20px 20px 22px",
  background: "var(--cream)",
}
const calRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 14,
}
const calField: CSSProperties = { display: "flex", flexDirection: "column", gap: 6 }
const calLabel: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--ink)",
  letterSpacing: "0.01em",
}
const calOptional: CSSProperties = { fontWeight: 400, color: "var(--ink-3)" }
const calInput: CSSProperties = {
  font: "inherit",
  fontSize: 14,
  color: "var(--ink)",
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-md)",
  background: "var(--cream-3)",
  outline: "none",
}
const calTextarea: CSSProperties = {
  ...calInput,
  lineHeight: 1.5,
  resize: "vertical",
  minHeight: 140,
}
const calActionsRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
}
const calHint: CSSProperties = { fontSize: 13, color: "var(--ink-3)" }

const calErrorBox: CSSProperties = {
  border: "1px solid var(--danger-border, #e7b4ad)",
  background: "var(--danger-soft, #fbeae6)",
  color: "var(--danger, #a33a28)",
  borderRadius: "var(--r-md)",
  padding: "12px 14px",
  fontSize: 14,
  lineHeight: 1.45,
}

const calResultWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 18,
  border: "1px solid var(--border)",
  borderRadius: "var(--r-lg)",
  padding: "20px 20px 22px",
  background: "var(--cream-3)",
  boxShadow: "var(--shadow-sm)",
}
const calResultHead: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
}
const calResultEyebrow: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
}
const calBadge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  padding: "4px 10px",
  borderRadius: "var(--r-pill)",
  border: "1px solid var(--border)",
  background: "var(--cream)",
  color: "var(--ink-2)",
}
const calBadgeGood: CSSProperties = {
  color: "var(--live)",
  background: "var(--live-soft)",
  borderColor: "var(--live-border)",
}
const calBadgeWarn: CSSProperties = {
  color: "var(--ink-2)",
  background: "var(--peach-50)",
  borderColor: "var(--peach-200)",
}

const calSection: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 }
const calSectionLabel: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
}
const calChipWrap: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 }
const calChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--ink)",
  background: "var(--peach-50)",
  border: "1px solid var(--peach-200)",
  borderRadius: "var(--r-pill)",
  padding: "4px 12px",
}
const calQList: CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  display: "flex",
  flexDirection: "column",
  gap: 8,
}
const calQItem: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.45,
  color: "var(--ink-2)",
}
const calReqTag: CSSProperties = {
  marginLeft: 8,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "var(--live)",
  background: "var(--live-soft)",
  border: "1px solid var(--live-border)",
  borderRadius: "var(--r-pill)",
  padding: "1px 7px",
  verticalAlign: "middle",
}
const calClarifyList: CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  display: "flex",
  flexDirection: "column",
  gap: 8,
}
const calClarifyItem: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.45,
  color: "var(--ink)",
}
const calClarifyHint: CSSProperties = {
  margin: "2px 0 0",
  fontSize: 13,
  color: "var(--ink-3)",
}
const calScopeNote: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--ink-3)",
  borderTop: "1px solid var(--border)",
  paddingTop: 14,
}

// ---- ATS public-board self-serve read-back (Connect ATS step) -------------

const atsImportWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
}
const atsImportRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
}
const atsReqScroll: CSSProperties = {
  maxHeight: 320,
  overflowY: "auto",
  paddingRight: 4,
}
const atsImportDivider: CSSProperties = {
  borderTop: "1px solid var(--border)",
  margin: "2px 0 0",
}

// ---- Invite Team (Step 4) -------------------------------------------------

const inviteRowsWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
}
const inviteRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
}
const inviteEmailInput: CSSProperties = { flex: "1 1 auto", minWidth: 0 }
const inviteInputInvalid: CSSProperties = {
  borderColor: "var(--danger-border, #e7b4ad)",
  background: "var(--danger-soft, #fbeae6)",
}
const inviteRoleSelect: CSSProperties = {
  flex: "0 0 auto",
  width: 158,
  cursor: "pointer",
}
const inviteRemoveBtn: CSSProperties = {
  flex: "0 0 auto",
  width: 34,
  height: 34,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 20,
  lineHeight: 1,
  color: "var(--ink-3)",
  background: "var(--cream-3)",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-md)",
}
const inviteAddBtn: CSSProperties = {
  alignSelf: "flex-start",
  marginTop: 4,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--ink-2)",
  background: "transparent",
  border: "1px dashed var(--border)",
  borderRadius: "var(--r-pill)",
  padding: "6px 14px",
}
const inviteTableWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
}
const inviteResultRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
  fontSize: 14,
  color: "var(--ink-2)",
  padding: "6px 0",
  borderBottom: "1px solid var(--border)",
}
const inviteResultEmail: CSSProperties = {
  flex: "1 1 180px",
  minWidth: 0,
  color: "var(--ink)",
  wordBreak: "break-all",
}
const inviteRolePill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--ink)",
  background: "var(--peach-50)",
  border: "1px solid var(--peach-200)",
  borderRadius: "var(--r-pill)",
  padding: "2px 10px",
}
const inviteSentTag: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--live)",
  background: "var(--live-soft)",
  border: "1px solid var(--live-border)",
  borderRadius: "var(--r-pill)",
  padding: "2px 9px",
}
const inviteFailReason: CSSProperties = {
  fontSize: 12,
  color: "var(--danger, #a33a28)",
}

// ---- Launch (Step 7) ------------------------------------------------------

const launchCard: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 14,
  border: "1px solid var(--live-border)",
  background: "var(--live-soft)",
  borderRadius: "var(--r-lg)",
  padding: "20px 20px 22px",
}
const launchCheck: CSSProperties = { fontSize: 24, lineHeight: 1, flexShrink: 0 }
const launchCardBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minWidth: 0,
}
const launchCardTitle: CSSProperties = {
  fontFamily: "var(--font-serif)",
  fontWeight: 400,
  fontSize: 20,
  color: "var(--ink)",
  lineHeight: 1.25,
}
const launchReqIdRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
}
const launchReqIdLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
}
const launchReqId: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--ink)",
  background: "var(--cream-3)",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-md)",
  padding: "4px 10px",
  wordBreak: "break-all",
}
const launchNextWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  border: "1px solid var(--border)",
  borderRadius: "var(--r-md)",
  padding: "16px 18px",
  background: "var(--cream)",
}
const launchNextBody: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.55,
  color: "var(--ink-2)",
}
