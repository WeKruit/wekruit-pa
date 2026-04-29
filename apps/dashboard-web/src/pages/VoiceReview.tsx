/**
 * Phase 32 Wave 2c — VoiceReview page (split out of Voice.tsx).
 *
 * Pure rating queue — focuses operator attention on ONE turn at a time
 * rather than rendering the full page-50 list. Top bar shows progress,
 * keyboard shortcut hint, and current session label. Legend toggles below.
 *
 * Keyboard shortcuts kept identical to old /voice:
 *   j / ArrowDown — next row
 *   k / ArrowUp   — prev row
 *   1..5          — set rating
 *   t             — focus tag picker
 *   c             — focus comment
 *   Enter         — save + jump to next unreviewed
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import {
  PriorTurnsChat,
  TagLegend,
  detectLang,
  ratingBorder,
  type LangFilter,
} from "../components/voice-shared.js"
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

const PAGE_SIZE = 50

type RowState = {
  rating: VoiceRating | null
  tags: VoiceReviewTag[]
  comment: string
  saveState: "idle" | "saving" | "saved" | "error"
  saveError: string | null
}

function makeInitialState(turn: AssistantTurn): RowState {
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

export function VoiceReview() {
  const [rows, setRows] = useState<AssistantTurn[]>([])
  const [rowState, setRowState] = useState<Record<string, RowState>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null])
  const [pageIndex, setPageIndex] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [focusIdx, setFocusIdx] = useState(0)
  const [langFilter, setLangFilter] = useState<LangFilter>("all")
  const [showLegend, setShowLegend] = useState(false)

  const commentRef = useRef<HTMLTextAreaElement | null>(null)
  const tagRef = useRef<HTMLButtonElement | null>(null)

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
      // Default focus to first unreviewed turn for fast queue progression.
      const firstUnreviewed = res.rows.findIndex((r) => !r.reviewed)
      setFocusIdx(firstUnreviewed >= 0 ? firstUnreviewed : 0)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(pageCursors[pageIndex] ?? null)
  }, [load, pageCursors, pageIndex])

  useEffect(() => {
    for (const [mid, st] of Object.entries(rowState)) {
      if (st.rating === null && st.tags.length === 0 && st.comment === "") continue
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

  const filteredRows = useMemo(() => {
    if (langFilter === "all") return rows
    return rows.filter((r) => detectLang(r.body ?? "") === langFilter)
  }, [rows, langFilter])

  const stats = useMemo(() => {
    const reviewed = filteredRows.filter((r) => r.reviewed).length
    return {
      total: filteredRows.length,
      reviewed,
      unreviewed: filteredRows.length - reviewed,
      filteredOut: rows.length - filteredRows.length,
    }
  }, [rows, filteredRows])

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
      const turn = filteredRows[idx]
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
        const nextIdx = filteredRows.findIndex(
          (r, i) => i > idx && !r.reviewed && r.messageId !== turn.messageId
        )
        if (nextIdx >= 0) {
          setFocusIdx(nextIdx)
        } else {
          setFocusIdx(Math.min(idx + 1, Math.max(0, filteredRows.length - 1)))
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
    [filteredRows, rowState]
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
      if (inText) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void handleSave(focusIdx)
        }
        return
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setFocusIdx((i) => Math.min(i + 1, Math.max(0, filteredRows.length - 1)))
        return
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setFocusIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (/^[1-5]$/.test(e.key)) {
        e.preventDefault()
        const turn = filteredRows[focusIdx]
        if (turn) setRating(turn.messageId, Number(e.key) as VoiceRating)
        return
      }
      if (e.key === "t") {
        e.preventDefault()
        tagRef.current?.focus()
        return
      }
      if (e.key === "c") {
        e.preventDefault()
        commentRef.current?.focus()
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
  }, [focusIdx, filteredRows, setRating, handleSave])

  const focusedTurn = filteredRows[focusIdx]
  const focusedState = focusedTurn ? rowState[focusedTurn.messageId] ?? makeInitialState(focusedTurn) : null

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Eval"
        title="Voice review"
        description="Rate one assistant turn at a time. Drafts auto-save. Keyboard: j/k navigate · 1-5 rate · t tags · c comment · Enter save+next."
        actions={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {(["all", "zh", "en", "mix"] as LangFilter[]).map((lf) => (
              <button
                key={lf}
                type="button"
                onClick={() => setLangFilter(lf)}
                style={{
                  fontSize: "0.85em",
                  fontWeight: langFilter === lf ? 700 : 400,
                  background: langFilter === lf ? "#0f172a" : "transparent",
                  color: langFilter === lf ? "#fff" : "inherit",
                  borderRadius: 999,
                  padding: "4px 10px",
                  border: "1px solid #cbd5e1",
                }}
              >
                {lf}
              </button>
            ))}
            <button type="button" onClick={() => void load(pageCursors[pageIndex] ?? null)}>
              Refresh
            </button>
          </div>
        }
      />

      <Panel title={`Progress: ${stats.reviewed}/${stats.total} reviewed today`}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: "0.85em", color: "#475569" }}>
            Page {pageIndex + 1}
            {focusedTurn ? (
              <> · session <code style={{ fontSize: "0.95em" }}>{focusedTurn.sessionId.slice(0, 8)}</code></>
            ) : null}
            {stats.filteredOut > 0 ? <> · {stats.filteredOut} filtered out</> : null}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
            >
              ← Prev page
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
              Next page →
            </button>
          </div>
        </div>
      </Panel>

      {loading ? (
        <LoadingState label="Loading assistant turns…" />
      ) : err ? (
        <ErrorState message={err} />
      ) : !focusedTurn || !focusedState ? (
        <EmptyState
          title="No assistant turns to review"
          body={
            rows.length === 0
              ? "pa-messages has no assistant role docs in this range."
              : `No turns match filter '${langFilter}' on this page.`
          }
        />
      ) : (
        <Panel title={`Turn ${focusIdx + 1} of ${filteredRows.length}`}>
          <FocusedReview
            turn={focusedTurn}
            state={focusedState}
            onRating={(r) => setRating(focusedTurn.messageId, r)}
            onToggleTag={(t) => toggleTag(focusedTurn.messageId, t)}
            onComment={(c) => setComment(focusedTurn.messageId, c)}
            onSave={() => void handleSave(focusIdx)}
            onPrev={() => setFocusIdx((i) => Math.max(0, i - 1))}
            onNext={() => setFocusIdx((i) => Math.min(i + 1, Math.max(0, filteredRows.length - 1)))}
            commentRef={commentRef}
            firstTagRef={tagRef}
          />
        </Panel>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" onClick={() => setShowLegend(!showLegend)} style={{ fontSize: "0.85em" }}>
          {showLegend ? "Hide rating legend" : "How to rate"}
        </button>
      </div>
      {showLegend ? <TagLegend /> : null}
    </div>
  )
}

function FocusedReview({
  turn,
  state,
  onRating,
  onToggleTag,
  onComment,
  onSave,
  onPrev,
  onNext,
  commentRef,
  firstTagRef,
}: {
  turn: AssistantTurn
  state: RowState
  onRating: (r: VoiceRating) => void
  onToggleTag: (t: VoiceReviewTag) => void
  onComment: (c: string) => void
  onSave: () => void
  onPrev: () => void
  onNext: () => void
  commentRef: React.RefObject<HTMLTextAreaElement | null>
  firstTagRef: React.RefObject<HTMLButtonElement | null>
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderLeft: `4px solid ${ratingBorder(state.rating)}`,
        borderRadius: 6,
        padding: "1rem 1.25rem",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.75em",
          color: "#64748b",
          marginBottom: 8,
        }}
      >
        <span>
          {turn.reviewed ? (
            <span style={{ color: "#16a34a", fontWeight: 600 }}>● Reviewed</span>
          ) : (
            <span style={{ color: "#94a3b8" }}>○ Unreviewed</span>
          )}{" "}
          · msg <code>{turn.messageId.slice(0, 8)}</code>
          {turn.createdAt ? <> · {turn.createdAt.slice(0, 19).replace("T", " ")}</> : null}
        </span>
        <span>session <code>{turn.sessionId.slice(0, 8)}</code></span>
      </div>

      <PriorTurnsChat turn={turn} />

      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {([1, 2, 3, 4, 5] as VoiceRating[]).map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onRating(n)}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            style={{
              padding: "4px 12px",
              fontSize: "1.1em",
              cursor: "pointer",
              background: state.rating != null && n <= state.rating ? "#fbbf24" : "transparent",
              border: "1px solid #cbd5e1",
              borderRadius: 4,
            }}
          >
            ★
          </button>
        ))}
        <span style={{ marginLeft: 8, fontSize: "0.85em", color: "#64748b", alignSelf: "center" }}>
          {state.rating ?? "—"}
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
        {VOICE_REVIEW_TAGS.map((tag, i) => {
          const active = state.tags.includes(tag)
          return (
            <button
              key={tag}
              ref={i === 0 ? firstTagRef : undefined}
              type="button"
              onClick={() => onToggleTag(tag)}
              style={{
                padding: "3px 10px",
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

      <textarea
        ref={commentRef}
        value={state.comment}
        onChange={(e) => onComment(e.target.value)}
        placeholder="Optional notes — what would the ideal turn have said?"
        rows={2}
        style={{
          width: "100%",
          fontSize: "0.85em",
          padding: "6px 8px",
          fontFamily: "inherit",
          marginBottom: 8,
        }}
      />

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" onClick={onPrev} style={{ fontSize: "0.85em" }}>
          ← Prev (k)
        </button>
        <button
          type="button"
          disabled={state.saveState === "saving"}
          onClick={onSave}
        >
          {state.saveState === "saving" ? "Saving…" : "Save (Enter)"}
        </button>
        <button type="button" onClick={onNext} style={{ fontSize: "0.85em" }}>
          Next (j) →
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
