/**
 * Phase 25 T2 — Voice review dashboard (P9-Voice).
 *
 * Lists pa_messages assistant turns newest-first, joined LEFT against
 * pa_voice_reviews so reviewer sees reviewed/unreviewed state per row.
 *
 * Keyboard UX (R1 mitigation — Adam target ≥50 turns/<30 min):
 *   j / ArrowDown — next row
 *   k / ArrowUp   — prev row
 *   1..5          — set rating on focused row
 *   t             — open tag picker (focus first chip)
 *   c             — focus comment input
 *   Enter         — save + jump to next unreviewed row
 *
 * Drafts persist in localStorage per messageId so a reload doesn't burn work.
 *
 * Visual signals:
 *   ≥4⭐ → green left border (fewShot candidate, surfaced for Phase 27)
 *   ≤2⭐ → orange left border (Phase 27 cron picks these up, ratingMax=2)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"
import {
  DEFAULT_AGENT_SNAPSHOT,
  VOICE_REVIEW_TAGS,
  clearDraft,
  listAssistantTurns,
  loadDraft,
  saveDraft,
  saveVoiceReview,
  type AssistantTurn,
  type ReviewDraft,
  type VoiceRating,
  type VoiceReviewTag,
} from "../lib/voice-reviews-api.js"
import {
  LOCAL_RUN_INSTRUCTIONS,
  diffRuns,
  fetchStaticEvalRun,
  listEvalRuns,
  makeDownloadUrl,
  type EvalRun,
  type RunDiff,
} from "../lib/voice-eval-api.js"
import { listFlags, type FeatureFlag } from "../lib/flags-api.js"

const PAGE_SIZE = 50

type RowState = {
  rating: VoiceRating | null
  tags: VoiceReviewTag[]
  comment: string
  /** "saving" while in flight, "saved" briefly after success, "error" on failure. */
  saveState: "idle" | "saving" | "saved" | "error"
  saveError: string | null
}

function makeInitialState(turn: AssistantTurn): RowState {
  // Existing review wins (rare — usually we rate fresh).
  if (turn.review) {
    return {
      rating: turn.review.rating,
      tags: [...turn.review.tags],
      comment: turn.review.comment,
      saveState: "idle",
      saveError: null,
    }
  }
  const draft = loadDraft(turn.messageId)
  if (draft) {
    return {
      rating: draft.rating,
      tags: [...draft.tags],
      comment: draft.comment,
      saveState: "idle",
      saveError: null,
    }
  }
  return { rating: null, tags: [], comment: "", saveState: "idle", saveError: null }
}

export function Voice() {
  const [rows, setRows] = useState<AssistantTurn[]>([])
  const [rowState, setRowState] = useState<Record<string, RowState>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null])
  const [pageIndex, setPageIndex] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [focusIdx, setFocusIdx] = useState(0)

  const rowRefs = useRef<Array<HTMLDivElement | null>>([])
  const commentRefs = useRef<Array<HTMLTextAreaElement | null>>([])
  const tagRefs = useRef<Array<HTMLButtonElement | null>>([])

  const load = useCallback(async (cursor: string | null) => {
    setLoading(true)
    setErr(null)
    try {
      const res = await listAssistantTurns({ cursor, limit: PAGE_SIZE })
      setRows(res.rows)
      setNextCursor(res.nextCursor)
      const next: Record<string, RowState> = {}
      for (const r of res.rows) {
        next[r.messageId] = makeInitialState(r)
      }
      setRowState(next)
      setFocusIdx(0)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(pageCursors[pageIndex] ?? null)
  }, [load, pageCursors, pageIndex])

  // Persist drafts on every state change (cheap; rows ≤ 50).
  useEffect(() => {
    for (const [mid, st] of Object.entries(rowState)) {
      // Don't persist when there's nothing to recover.
      if (st.rating === null && st.tags.length === 0 && st.comment === "") {
        continue
      }
      // Don't persist if the row is already saved server-side.
      const turn = rows.find((r) => r.messageId === mid)
      if (turn?.reviewed && st.saveState !== "saving") continue
      const draft: ReviewDraft = {
        rating: st.rating,
        tags: st.tags,
        comment: st.comment,
      }
      saveDraft(mid, draft)
    }
  }, [rowState, rows])

  // Auto-scroll focused row into view.
  useEffect(() => {
    const el = rowRefs.current[focusIdx]
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [focusIdx])

  const setRating = useCallback((messageId: string, rating: VoiceRating) => {
    setRowState((prev) => ({
      ...prev,
      [messageId]: {
        ...(prev[messageId] ?? { rating: null, tags: [], comment: "", saveState: "idle", saveError: null }),
        rating,
        saveState: "idle",
      },
    }))
  }, [])

  const toggleTag = useCallback((messageId: string, tag: VoiceReviewTag) => {
    setRowState((prev) => {
      const cur = prev[messageId] ?? { rating: null, tags: [], comment: "", saveState: "idle" as const, saveError: null }
      const has = cur.tags.includes(tag)
      const tags = has ? cur.tags.filter((t) => t !== tag) : [...cur.tags, tag]
      return { ...prev, [messageId]: { ...cur, tags, saveState: "idle" as const } }
    })
  }, [])

  const setComment = useCallback((messageId: string, comment: string) => {
    setRowState((prev) => {
      const cur = prev[messageId] ?? { rating: null, tags: [], comment: "", saveState: "idle" as const, saveError: null }
      return { ...prev, [messageId]: { ...cur, comment, saveState: "idle" as const } }
    })
  }, [])

  const handleSave = useCallback(
    async (idx: number) => {
      const turn = rows[idx]
      if (!turn) return
      const st = rowState[turn.messageId]
      if (!st || st.rating === null) {
        setRowState((p) => ({
          ...p,
          [turn.messageId]: {
            ...(p[turn.messageId] ?? { rating: null, tags: [], comment: "", saveState: "idle", saveError: null }),
            saveState: "error",
            saveError: "Rating required (press 1-5)",
          },
        }))
        return
      }
      setRowState((p) => ({
        ...p,
        [turn.messageId]: { ...st, saveState: "saving", saveError: null },
      }))
      try {
        await saveVoiceReview({
          messageId: turn.messageId,
          rating: st.rating,
          tags: st.tags,
          comment: st.comment,
          agentSnapshot: DEFAULT_AGENT_SNAPSHOT,
        })
        clearDraft(turn.messageId)
        // Mark turn as reviewed in local state so badge flips green.
        setRows((prev) =>
          prev.map((r) =>
            r.messageId === turn.messageId
              ? {
                  ...r,
                  reviewed: true,
                  review: {
                    messageId: turn.messageId,
                    rating: st.rating!,
                    tags: st.tags,
                    comment: st.comment,
                    reviewerId: "(you)",
                    agentSnapshot: DEFAULT_AGENT_SNAPSHOT,
                    createdAt: new Date().toISOString(),
                  },
                }
              : r
          )
        )
        setRowState((p) => ({
          ...p,
          [turn.messageId]: { ...st, saveState: "saved", saveError: null },
        }))
        // Jump to next unreviewed row.
        const nextIdx = rows.findIndex(
          (r, i) => i > idx && !r.reviewed && r.messageId !== turn.messageId
        )
        if (nextIdx >= 0) {
          setFocusIdx(nextIdx)
        } else {
          setFocusIdx(Math.min(idx + 1, rows.length - 1))
        }
      } catch (e) {
        setRowState((p) => ({
          ...p,
          [turn.messageId]: {
            ...st,
            saveState: "error",
            saveError: e instanceof Error ? e.message : String(e),
          },
        }))
      }
    },
    [rows, rowState]
  )

  // ---------- keyboard ----------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const inText =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      // In comment box: only Enter (with cmd/ctrl) saves; let raw keys pass through.
      if (inText) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void handleSave(focusIdx)
        }
        return
      }

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setFocusIdx((i) => Math.min(i + 1, Math.max(0, rows.length - 1)))
        return
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setFocusIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (/^[1-5]$/.test(e.key)) {
        e.preventDefault()
        const turn = rows[focusIdx]
        if (turn) setRating(turn.messageId, Number(e.key) as VoiceRating)
        return
      }
      if (e.key === "t") {
        e.preventDefault()
        tagRefs.current[focusIdx]?.focus()
        return
      }
      if (e.key === "c") {
        e.preventDefault()
        commentRefs.current[focusIdx]?.focus()
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        void handleSave(focusIdx)
        return
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [focusIdx, rows, setRating, handleSave])

  const stats = useMemo(() => {
    const reviewed = rows.filter((r) => r.reviewed).length
    return { total: rows.length, reviewed, unreviewed: rows.length - reviewed }
  }, [rows])

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Voice"
        title="Voice review dashboard"
        description={
          "Rate assistant turns 1-5⭐. Keyboard: j/k navigate, 1-5 rate, t tags, c comment, Enter save+next. Drafts auto-save per turn."
        }
        actions={
          <button type="button" onClick={() => void load(pageCursors[pageIndex] ?? null)}>
            Refresh
          </button>
        }
      />

      <Panel
        title={`Page ${pageIndex + 1} — ${stats.reviewed}/${stats.total} reviewed`}
        actions={
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
            >
              ← Prev
            </button>
            <button
              type="button"
              disabled={!nextCursor}
              onClick={() => {
                if (!nextCursor) return
                setPageCursors((cs) => {
                  const next = cs.slice(0, pageIndex + 1)
                  next.push(nextCursor)
                  return next
                })
                setPageIndex((i) => i + 1)
              }}
            >
              Next →
            </button>
          </div>
        }
      >
        {loading ? (
          <LoadingState label="Loading assistant turns…" />
        ) : err ? (
          <ErrorState message={err} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No assistant turns"
            body="pa_messages has no assistant role docs in this range."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {rows.map((turn, idx) => (
              <ReviewRow
                key={turn.messageId}
                turn={turn}
                state={rowState[turn.messageId] ?? makeInitialState(turn)}
                focused={idx === focusIdx}
                onFocus={() => setFocusIdx(idx)}
                onRating={(r) => setRating(turn.messageId, r)}
                onToggleTag={(t) => toggleTag(turn.messageId, t)}
                onComment={(c) => setComment(turn.messageId, c)}
                onSave={() => void handleSave(idx)}
                rowRef={(el) => {
                  rowRefs.current[idx] = el
                }}
                commentRef={(el) => {
                  commentRefs.current[idx] = el
                }}
                firstTagRef={(el) => {
                  tagRefs.current[idx] = el
                }}
              />
            ))}
          </div>
        )}
      </Panel>

      <EvalPanel />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Eval panel — Phase 25 T3
// ---------------------------------------------------------------------------

function EvalPanel() {
  const [autoRerun, setAutoRerun] = useState<boolean>(false)
  const [latest, setLatest] = useState<EvalRun | null>(null)
  const [baseline, setBaseline] = useState<EvalRun | null>(null)
  const [runs, setRuns] = useState<EvalRun[]>([])
  const [running, setRunning] = useState(false)
  const [showInstructions, setShowInstructions] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setErr(null)
    try {
      // Read flag from pa_feature_flags directly (mirrors flags-api pattern).
      try {
        const flags = (await listFlags()) as FeatureFlag[]
        const f = flags.find((x) => x.key === "voiceEvalAutoRerun")
        setAutoRerun(typeof f?.value === "boolean" ? f.value : false)
      } catch {
        // Flag absent — default false.
        setAutoRerun(false)
      }
      // Fetch baseline + latest static fixtures (dev path).
      const [b, l, fs] = await Promise.all([
        fetchStaticEvalRun("baseline.json"),
        fetchStaticEvalRun("latest.json"),
        listEvalRuns(20),
      ])
      setBaseline(b)
      setLatest(l ?? fs[0] ?? null)
      setRuns(fs)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  function handleManualRun() {
    setRunning(true)
    setShowInstructions(true)
    // No CF callable wired yet — we surface local-run instructions and let
    // Adam paste the result JSON path. After a refresh the static fixture
    // path will pick up the new file.
    setRunning(false)
  }

  const diff: RunDiff | null = useMemo(() => {
    if (!baseline || !latest) return null
    return diffRuns(baseline, latest)
  }, [baseline, latest])

  return (
    <Panel
      title="Eval — golden-50 vs baseline"
      eyebrow="Phase 25 T3"
      actions={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: "0.75em", color: "#64748b" }}>
            auto-rerun: {autoRerun ? "on" : "off"} (flag voiceEvalAutoRerun)
          </span>
          <button type="button" onClick={() => void loadAll()}>
            Refresh
          </button>
          <button type="button" disabled={running} onClick={handleManualRun}>
            {running ? "Running…" : "Run eval golden-50"}
          </button>
        </div>
      }
    >
      {err ? <ErrorState message={err} /> : null}

      {showInstructions ? (
        <div
          style={{
            background: "#fefce8",
            border: "1px solid #fde047",
            padding: "0.75rem 1rem",
            borderRadius: 6,
            marginBottom: 12,
          }}
        >
          <strong>Run the eval locally:</strong>
          <pre
            style={{
              fontFamily: "monospace",
              fontSize: "0.85em",
              background: "#fffef0",
              padding: "0.5rem",
              borderRadius: 4,
              overflow: "auto",
              margin: "0.5rem 0",
            }}
          >
            {LOCAL_RUN_INSTRUCTIONS}
          </pre>
          <button type="button" onClick={() => setShowInstructions(false)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <ScoreCard label="Baseline" run={baseline} />
        <ScoreCard label="Latest" run={latest} />
      </div>

      {diff ? (
        <DiffTable diff={diff} latest={latest!} />
      ) : (
        <EmptyState
          title="No diff available"
          body="Drop apps/dashboard-web/public/eval-results/baseline.json + latest.json (or upload to pa_voice_eval_runs) to render a diff."
        />
      )}

      {runs.length > 0 ? (
        <div style={{ marginTop: 12, fontSize: "0.85em", color: "#64748b" }}>
          {runs.length} run{runs.length === 1 ? "" : "s"} in pa_voice_eval_runs.
        </div>
      ) : null}
    </Panel>
  )
}

function ScoreCard({ label, run }: { label: string; run: EvalRun | null }) {
  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 6,
        padding: "0.75rem 1rem",
        background: "#ffffff",
      }}
    >
      <div style={{ fontSize: "0.75em", color: "#64748b", marginBottom: 4 }}>{label}</div>
      {run ? (
        <>
          <div style={{ fontSize: "1.5em", fontWeight: 600 }}>
            {(run.score * 100).toFixed(1)}%
          </div>
          <div style={{ fontSize: "0.8em", color: "#64748b" }}>
            {run.turns.length} turns · {run.ts ? run.ts.slice(0, 19).replace("T", " ") : "—"}
          </div>
          <div style={{ marginTop: 6 }}>
            <a href={makeDownloadUrl(run)} download={`${run.label}.json`} style={{ fontSize: "0.8em" }}>
              Download JSON
            </a>
          </div>
        </>
      ) : (
        <div style={{ fontSize: "0.85em", color: "#94a3b8" }}>(none)</div>
      )}
    </div>
  )
}

function DiffTable({ diff, latest }: { diff: RunDiff; latest: EvalRun }) {
  const sign = diff.scoreDelta >= 0 ? "+" : ""
  const color = diff.scoreDelta >= 0 ? "#16a34a" : "#dc2626"
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <strong>Score delta:</strong>{" "}
        <span style={{ color, fontWeight: 600 }}>
          {sign}
          {(diff.scoreDelta * 100).toFixed(1)}%
        </span>{" "}
        <span style={{ color: "#64748b", fontSize: "0.85em" }}>
          (top {diff.changed.length} changed turns shown){" "}
          <a href={makeDownloadUrl(latest)} download="latest-eval.json">
            full JSON
          </a>
        </span>
      </div>
      <table
        style={{
          width: "100%",
          fontSize: "0.85em",
          borderCollapse: "collapse",
        }}
      >
        <thead>
          <tr style={{ background: "#f8fafc", textAlign: "left" }}>
            <th style={{ padding: "4px 8px" }}>messageId</th>
            <th style={{ padding: "4px 8px" }}>baseline</th>
            <th style={{ padding: "4px 8px" }}>latest</th>
            <th style={{ padding: "4px 8px" }}>Δ</th>
          </tr>
        </thead>
        <tbody>
          {diff.changed.map((c) => (
            <tr key={c.messageId} style={{ borderTop: "1px solid #e2e8f0" }}>
              <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>
                {c.messageId.slice(0, 16)}
              </td>
              <td style={{ padding: "4px 8px" }}>{c.baselineRating ?? "—"}</td>
              <td style={{ padding: "4px 8px" }}>{c.currentRating ?? "—"}</td>
              <td
                style={{
                  padding: "4px 8px",
                  color: c.delta >= 0 ? "#16a34a" : "#dc2626",
                  fontWeight: 600,
                }}
              >
                {c.delta >= 0 ? "+" : ""}
                {c.delta}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function ratingBorder(rating: VoiceRating | null): string {
  if (rating == null) return "transparent"
  if (rating >= 4) return "#16a34a" // green
  if (rating <= 2) return "#f97316" // orange
  return "#94a3b8" // neutral
}

function ReviewRow({
  turn,
  state,
  focused,
  onFocus,
  onRating,
  onToggleTag,
  onComment,
  onSave,
  rowRef,
  commentRef,
  firstTagRef,
}: {
  turn: AssistantTurn
  state: RowState
  focused: boolean
  onFocus: () => void
  onRating: (r: VoiceRating) => void
  onToggleTag: (t: VoiceReviewTag) => void
  onComment: (c: string) => void
  onSave: () => void
  rowRef: (el: HTMLDivElement | null) => void
  commentRef: (el: HTMLTextAreaElement | null) => void
  firstTagRef: (el: HTMLButtonElement | null) => void
}) {
  return (
    <div
      ref={rowRef}
      onClick={onFocus}
      style={{
        background: focused ? "#f1f5f9" : "#ffffff",
        border: "1px solid #e2e8f0",
        borderLeft: `4px solid ${ratingBorder(state.rating)}`,
        borderRadius: 6,
        padding: "0.75rem 1rem",
        cursor: "pointer",
        outline: focused ? "2px solid #3b82f6" : "none",
        outlineOffset: -2,
      }}
    >
      {/* Header: status + ids */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.75em",
          color: "#64748b",
          marginBottom: 6,
        }}
      >
        <span>
          {turn.reviewed ? (
            <span style={{ color: "#16a34a", fontWeight: 600 }}>● Reviewed</span>
          ) : (
            <span style={{ color: "#94a3b8" }}>○ Unreviewed</span>
          )}{" "}
          · msg {turn.messageId.slice(0, 8)}
          {turn.createdAt ? ` · ${turn.createdAt.slice(0, 19).replace("T", " ")}` : ""}
        </span>
        <span>session {turn.sessionId.slice(0, 8)}</span>
      </div>

      {/* User context */}
      {turn.priorUserBody ? (
        <div
          style={{
            fontSize: "0.85em",
            color: "#475569",
            background: "#f8fafc",
            padding: "0.5rem 0.6rem",
            borderRadius: 4,
            marginBottom: 6,
            borderLeft: "3px solid #cbd5e1",
          }}
        >
          <span style={{ fontWeight: 600, color: "#64748b" }}>user · </span>
          {turn.priorUserBody}
        </div>
      ) : null}

      {/* Assistant turn body */}
      <div style={{ fontSize: "0.95em", marginBottom: 8, whiteSpace: "pre-wrap" }}>
        <span style={{ fontWeight: 600, color: "#0f172a" }}>assistant · </span>
        {turn.body}
      </div>

      {/* Rating stars */}
      <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        {([1, 2, 3, 4, 5] as VoiceRating[]).map((n) => (
          <button
            key={n}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRating(n)
            }}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            style={{
              padding: "2px 8px",
              fontSize: "1em",
              cursor: "pointer",
              background:
                state.rating != null && n <= state.rating ? "#fbbf24" : "transparent",
              border: "1px solid #cbd5e1",
              borderRadius: 3,
            }}
          >
            ★
          </button>
        ))}
        <span style={{ marginLeft: 8, fontSize: "0.85em", color: "#64748b" }}>
          {state.rating ?? "—"}
        </span>
      </div>

      {/* Tag chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
        {VOICE_REVIEW_TAGS.map((tag, i) => {
          const active = state.tags.includes(tag)
          return (
            <button
              key={tag}
              ref={i === 0 ? firstTagRef : undefined}
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onToggleTag(tag)
              }}
              style={{
                padding: "2px 8px",
                fontSize: "0.8em",
                cursor: "pointer",
                background: active ? "#3b82f6" : "#f1f5f9",
                color: active ? "#ffffff" : "#475569",
                border: "1px solid #cbd5e1",
                borderRadius: 999,
              }}
            >
              {tag}
            </button>
          )
        })}
      </div>

      {/* Comment */}
      <textarea
        ref={commentRef}
        value={state.comment}
        onChange={(e) => onComment(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        placeholder="Optional notes — what would the ideal turn have said?"
        rows={2}
        style={{
          width: "100%",
          fontSize: "0.85em",
          padding: "4px 6px",
          fontFamily: "inherit",
          marginBottom: 6,
        }}
      />

      {/* Save row */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          disabled={state.saveState === "saving"}
          onClick={(e) => {
            e.stopPropagation()
            onSave()
          }}
        >
          {state.saveState === "saving" ? "Saving…" : "Save (Enter)"}
        </button>
        {state.saveState === "saved" ? (
          <span style={{ fontSize: "0.8em", color: "#16a34a" }}>✓ saved</span>
        ) : null}
        {state.saveState === "error" && state.saveError ? (
          <span style={{ fontSize: "0.8em", color: "#dc2626" }}>{state.saveError}</span>
        ) : null}
      </div>
    </div>
  )
}
