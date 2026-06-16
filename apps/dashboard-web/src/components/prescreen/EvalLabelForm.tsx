/**
 * Data-labeling RIGHT pane — the human label form for an AI evaluation attempt.
 *
 * This is the reusable annotation surface (a modern "prediction-as-pre-annotation"
 * labeler): the AI verdict pre-seeds the form so "agree" is one keystroke, and a
 * divergence (partial/disagree) opens corrected-verdict + error-category + rationale.
 *
 * It is DECOUPLED from prescreen specifics so P3 can drop it next to a recruiter
 * submission or an external-supply evaluation: callers pass the attemptId + the
 * AI's proposed outcome (kind/terminal) for pre-seed + agree-detection, optional
 * selectable evidence, and an onSaved callback.
 *
 * Hard rule: "Save label" calls `reviewEvaluationAttempt({ commitAndSend: false })`
 * — LABEL-ONLY. It records the human label + a correction event, NEVER commits a
 * terminal, NEVER messages the candidate. It works on ANY record (pending or
 * closed). The operational "Approve & send" path lives elsewhere (the drawer's
 * top block) and is untouched.
 */
import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import type { CSSProperties } from "react"
import type {
  EvaluationErrorCategory,
  EvaluationEvidenceRef,
  EvaluationLabelDecision,
  EvaluationQualityRating,
} from "@pa/core-types"
import {
  ERROR_CATEGORY_LABEL,
  ERROR_CATEGORY_OPTIONS,
  LABEL_DECISIONS,
  QUALITY_VALUES,
  buildCorrectedOutcome,
  labelDecisionToStatus,
  labelRequiresRationale,
  labelValidationError,
  prescreenTerminalToOutcomeKind,
} from "./EvalLabelForm.helpers.js"
import type { ReviewTerminal } from "./eval-label-types.js"
import {
  reviewEvaluationAttempt,
  type ReviewEvaluationAttemptResult,
} from "../../lib/external-supply-client.js"

export interface EvalLabelEvidenceOption {
  /** Stable id (transcript turn id, resume artifact id, etc.). */
  refId: string
  /** Where the evidence lives — maps to EvaluationEvidenceRef.source. */
  source: EvaluationEvidenceRef["source"]
  /** Short human label shown in the multiselect. */
  summary: string
  quote?: string
  path?: string
}

/** Imperative handle so the parent drawer can drive the form from its keydown handler. */
export interface EvalLabelFormHandle {
  /** Set the decision (does not save). */
  setDecision: (decision: EvaluationLabelDecision) => void
  /** Set quality rating 1-5 (does not save). */
  setQuality: (quality: EvaluationQualityRating) => void
  /** Focus the rationale textarea (used by the "D" hotkey). */
  focusRationale: () => void
  /** Save the current label (commitAndSend:false). Resolves to the result, or null when blocked/failed. */
  save: () => Promise<ReviewEvaluationAttemptResult | null>
  /** Force decision=agree then save+resolve — backs the "A" hotkey. */
  agreeAndSave: () => Promise<ReviewEvaluationAttemptResult | null>
  /** True while a save is in flight. */
  isBusy: () => boolean
}

export interface EvalLabelFormProps {
  /** The evaluation attempt being labeled. */
  attemptId: string
  /**
   * The AI's proposed outcome, used to (a) pre-seed the corrected-terminal select
   * and (b) detect "agree". For prescreen pass `aiProposedTerminal`; the coarse
   * `aiProposedOutcomeKind` is used as a fallback when no terminal exists.
   */
  aiProposedTerminal?: ReviewTerminal | null
  aiProposedOutcomeKind?: "pass" | "hold" | "reject" | "needs_more_info" | "practice_feedback"
  /** Selectable evidence (transcript turns / resume refs) the labeler can highlight. */
  evidenceOptions?: EvalLabelEvidenceOption[]
  /** Pre-select the decision segment (defaults to "agree"). */
  defaultDecision?: EvaluationLabelDecision
  /** Called after a successful label save with the callable result. */
  onSaved?: (result: ReviewEvaluationAttemptResult) => void
  /** Optional ref to drive the form imperatively (hotkeys live in the parent). */
  ref?: React.Ref<EvalLabelFormHandle>
}

function deriveSeedTerminal(
  aiProposedTerminal: ReviewTerminal | null | undefined,
  aiProposedOutcomeKind: EvalLabelFormProps["aiProposedOutcomeKind"],
): ReviewTerminal {
  if (aiProposedTerminal) return aiProposedTerminal
  if (aiProposedOutcomeKind === "pass") return "PASS"
  return "FAIL"
}

export const EvalLabelForm = forwardRef<EvalLabelFormHandle, EvalLabelFormProps>(
  function EvalLabelForm(
    {
      attemptId,
      aiProposedTerminal,
      aiProposedOutcomeKind,
      evidenceOptions,
      defaultDecision = "agree",
      onSaved,
    },
    ref,
  ) {
    const seedTerminal = useMemo(
      () => deriveSeedTerminal(aiProposedTerminal, aiProposedOutcomeKind),
      [aiProposedTerminal, aiProposedOutcomeKind],
    )

    const [decision, setDecision] = useState<EvaluationLabelDecision>(defaultDecision)
    const [correctedTerminal, setCorrectedTerminal] = useState<ReviewTerminal>(seedTerminal)
    const [errorCategories, setErrorCategories] = useState<Set<EvaluationErrorCategory>>(() => new Set())
    const [quality, setQuality] = useState<EvaluationQualityRating | null>(null)
    const [selectedEvidence, setSelectedEvidence] = useState<Set<string>>(() => new Set())
    const [rationale, setRationale] = useState("")
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState<string | null>(null)
    const [result, setResult] = useState<ReviewEvaluationAttemptResult | null>(null)
    const rationaleRef = useRef<HTMLTextAreaElement | null>(null)
    // Keep a live ref to the latest state so imperative save() (called from the
    // parent's keydown handler) never reads a stale closure.
    const stateRef = useRef({ decision, correctedTerminal, errorCategories, quality, selectedEvidence, rationale, busy })
    stateRef.current = { decision, correctedTerminal, errorCategories, quality, selectedEvidence, rationale, busy }

    const requiresRationale = labelRequiresRationale(decision)
    const validationError = labelValidationError({ decision, rationale })
    const submittable = validationError === null

    function toggleCategory(cat: EvaluationErrorCategory) {
      setErrorCategories((prev) => {
        const next = new Set(prev)
        if (next.has(cat)) next.delete(cat)
        else next.add(cat)
        return next
      })
    }

    function toggleEvidence(refId: string) {
      setSelectedEvidence((prev) => {
        const next = new Set(prev)
        if (next.has(refId)) next.delete(refId)
        else next.add(refId)
        return next
      })
    }

    async function saveWith(
      decisionOverride?: EvaluationLabelDecision,
    ): Promise<ReviewEvaluationAttemptResult | null> {
      const s = stateRef.current
      if (s.busy) return null
      const effectiveDecision = decisionOverride ?? s.decision
      const effectiveRationale = effectiveDecision === "agree" ? "" : s.rationale
      const validation = labelValidationError({ decision: effectiveDecision, rationale: effectiveRationale })
      if (validation) {
        setErr(validation)
        if (labelRequiresRationale(effectiveDecision)) rationaleRef.current?.focus()
        return null
      }
      setBusy(true)
      setErr(null)
      try {
        const status = labelDecisionToStatus(effectiveDecision)
        const correctedOutcome = buildCorrectedOutcome({
          decision: effectiveDecision,
          correctedTerminal: s.correctedTerminal,
        })
        const evidenceRefs: EvaluationEvidenceRef[] = (evidenceOptions ?? [])
          .filter((opt) => s.selectedEvidence.has(opt.refId))
          .map((opt) => ({
            refId: opt.refId,
            source: opt.source,
            summary: opt.summary,
            ...(opt.quote ? { quote: opt.quote } : {}),
            ...(opt.path ? { path: opt.path } : {}),
          }))
        const res = await reviewEvaluationAttempt({
          attemptId,
          status,
          commitAndSend: false,
          label: {
            decision: effectiveDecision,
            ...(correctedOutcome ? { correctedOutcome } : {}),
            errorCategories: [...s.errorCategories],
            ...(s.quality !== null ? { qualityRating: s.quality } : {}),
            ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
            ...(effectiveRationale.trim() ? { rationale: effectiveRationale.trim() } : {}),
          },
        })
        setResult(res)
        onSaved?.(res)
        return res
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        return null
      } finally {
        setBusy(false)
      }
    }

    useImperativeHandle(
      ref,
      (): EvalLabelFormHandle => ({
        setDecision: (d) => setDecision(d),
        setQuality: (q) => setQuality(q),
        focusRationale: () => rationaleRef.current?.focus(),
        save: () => saveWith(),
        agreeAndSave: () => {
          setDecision("agree")
          return saveWith("agree")
        },
        isBusy: () => stateRef.current.busy,
      }),
      // saveWith reads stateRef, evidenceOptions, attemptId — none captured stale.
      [attemptId, evidenceOptions],
    )

    return (
      <div style={formShellStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <strong style={{ fontSize: "1.02em", color: "#0f172a" }}>Label this AI evaluation</strong>
          <span style={{ fontSize: "0.8em", color: "#64748b" }}>
            label-only · never messages the candidate
          </span>
        </div>

        {/* Decision — segmented control */}
        <div style={fieldStyle}>
          <span style={fieldLabelStyle}>Your verdict on the AI</span>
          <div role="radiogroup" aria-label="Label decision" style={{ display: "flex", gap: 0 }}>
            {LABEL_DECISIONS.map((d, i) => {
              const active = decision === d.value
              return (
                <button
                  key={d.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setDecision(d.value)}
                  style={segmentStyle(active, i === 0 ? "left" : i === LABEL_DECISIONS.length - 1 ? "right" : "mid")}
                >
                  {d.label}
                  {d.hint ? <span style={{ opacity: 0.6, fontSize: "0.8em", marginLeft: 6 }}>{d.hint}</span> : null}
                </button>
              )
            })}
          </div>
        </div>

        {/* Corrected verdict — only meaningful when not "agree" */}
        {decision !== "agree" ? (
          <label style={fieldStyle}>
            <span style={fieldLabelStyle}>Corrected verdict</span>
            <select
              value={correctedTerminal}
              onChange={(e) => setCorrectedTerminal((e.target.value as ReviewTerminal) || "FAIL")}
              style={inputStyle}
            >
              <option value="PASS">PASS</option>
              <option value="FAIL">FAIL</option>
              <option value="HARD_STOP">HARD_STOP</option>
            </select>
            <span style={hintStyle}>
              AI proposed <strong>{seedTerminal}</strong> ({prescreenTerminalToOutcomeKind(seedTerminal)}). Your
              correction is recorded as the gold label.
            </span>
          </label>
        ) : null}

        {/* Error categories — closed vocab chips, only when diverging */}
        {decision !== "agree" ? (
          <div style={fieldStyle}>
            <span style={fieldLabelStyle}>What did the AI get wrong?</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {ERROR_CATEGORY_OPTIONS.map((cat) => {
                const active = errorCategories.has(cat)
                return (
                  <button
                    key={cat}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleCategory(cat)}
                    style={chipStyle(active)}
                  >
                    {ERROR_CATEGORY_LABEL[cat]}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}

        {/* Quality — 1..5 stars */}
        <div style={fieldStyle}>
          <span style={fieldLabelStyle}>AI evaluation quality (1-5)</span>
          <div role="radiogroup" aria-label="Quality rating" style={{ display: "flex", gap: 4 }}>
            {QUALITY_VALUES.map((q) => {
              const active = quality !== null && q <= quality
              return (
                <button
                  key={q}
                  type="button"
                  role="radio"
                  aria-checked={quality === q}
                  aria-label={`Quality ${q}`}
                  onClick={() => setQuality(q)}
                  style={starStyle(active)}
                >
                  ★
                </button>
              )
            })}
            {quality !== null ? (
              <button
                type="button"
                onClick={() => setQuality(null)}
                style={{ ...subtleBtnStyle, marginLeft: 6 }}
              >
                clear
              </button>
            ) : null}
          </div>
        </div>

        {/* Evidence multiselect — optional */}
        {evidenceOptions && evidenceOptions.length > 0 ? (
          <div style={fieldStyle}>
            <span style={fieldLabelStyle}>Highlight supporting evidence (optional)</span>
            <div style={{ display: "grid", gap: 4, maxHeight: 180, overflowY: "auto" }}>
              {evidenceOptions.map((opt) => (
                <label key={opt.refId} style={evidenceRowStyle}>
                  <input
                    type="checkbox"
                    checked={selectedEvidence.has(opt.refId)}
                    onChange={() => toggleEvidence(opt.refId)}
                  />
                  <span style={{ fontSize: "0.85em", color: "#334155", overflowWrap: "anywhere" }}>
                    <span style={{ color: "#94a3b8", fontSize: "0.9em" }}>[{opt.source}]</span> {opt.summary}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {/* Rationale — required when diverging */}
        <label style={fieldStyle}>
          <span style={fieldLabelStyle}>
            Rationale{requiresRationale ? <span style={{ color: "#b91c1c" }}> *</span> : " (optional on agree)"}
          </span>
          <textarea
            ref={rationaleRef}
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={4}
            placeholder={
              requiresRationale
                ? "Required — explain why the AI verdict is wrong."
                : "Optional note about why you agree."
            }
            style={textareaStyle}
          />
        </label>

        {err ? <div className="notice notice-bad" style={{ fontSize: "0.85em" }}>{err}</div> : null}
        {result ? (
          <div style={{ fontSize: "0.82em", color: "#15803d" }}>
            Label saved{result.labelOnly ? " (label-only — no candidate message)" : ""}
            {result.commitSkippedNotPending ? " · commit skipped (no longer pending)" : ""}.
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => void saveWith()}
            disabled={busy || !submittable}
            style={primaryBtnStyle}
            title="Record this label (does not message the candidate)"
          >
            {busy ? "Saving…" : "Save label"}
            <span style={{ opacity: 0.6, fontSize: "0.8em", marginLeft: 6 }}>S</span>
          </button>
          {decision !== "agree" && !submittable ? (
            <span style={{ fontSize: "0.8em", color: "#b45309" }}>{validationError}</span>
          ) : null}
        </div>
      </div>
    )
  },
)

const formShellStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  background: "#fff",
  padding: "1rem 1.1rem",
  display: "grid",
  gap: 14,
}

const fieldStyle: CSSProperties = { display: "grid", gap: 6 }

const fieldLabelStyle: CSSProperties = {
  fontSize: "0.85em",
  fontWeight: 600,
  color: "#334155",
}

const hintStyle: CSSProperties = { fontSize: "0.78em", color: "#64748b" }

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.9em",
  boxSizing: "border-box",
}

const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "0.6rem 0.7rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.95em",
  lineHeight: 1.5,
  boxSizing: "border-box",
  resize: "vertical",
  fontFamily: "inherit",
}

function segmentStyle(active: boolean, side: "left" | "mid" | "right"): CSSProperties {
  return {
    padding: "0.4rem 0.9rem",
    fontSize: "0.88em",
    fontWeight: 600,
    border: "1px solid #cbd5e1",
    borderRadius: side === "left" ? "6px 0 0 6px" : side === "right" ? "0 6px 6px 0" : 0,
    marginLeft: side === "left" ? 0 : -1,
    background: active ? "#1e293b" : "transparent",
    color: active ? "#fff" : "#334155",
    cursor: "pointer",
  }
}

function chipStyle(active: boolean): CSSProperties {
  return {
    padding: "0.3rem 0.7rem",
    fontSize: "0.82em",
    border: `1px solid ${active ? "#1e293b" : "#cbd5e1"}`,
    borderRadius: 999,
    background: active ? "#1e293b" : "#fff",
    color: active ? "#fff" : "#475569",
    cursor: "pointer",
  }
}

function starStyle(active: boolean): CSSProperties {
  return {
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: "1.3em",
    lineHeight: 1,
    padding: "0 2px",
    color: active ? "#f59e0b" : "#cbd5e1",
  }
}

const evidenceRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  padding: "0.25rem 0.4rem",
  border: "1px solid #f1f5f9",
  borderRadius: 6,
}

const primaryBtnStyle: CSSProperties = {
  padding: "0.5rem 1rem",
  background: "#1e293b",
  color: "#fff",
  border: "1px solid #1e293b",
  borderRadius: 6,
  fontSize: "0.92em",
  fontWeight: 600,
  cursor: "pointer",
}

const subtleBtnStyle: CSSProperties = {
  padding: "0.25rem 0.6rem",
  background: "transparent",
  color: "#64748b",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.8em",
  cursor: "pointer",
}
