import * as React from "react"
import { useEffect, useMemo, useState, type CSSProperties } from "react"

import {
  CONVERSATION_SENTIMENT_CATEGORIES,
  CONVERSATION_SENTIMENT_CATEGORY_LABELS,
  CONVERSATION_SENTIMENTS,
  type ConversationFeedbackInput,
  type ConversationFeedbackResponse,
  type ConversationFeedbackRow,
  type ConversationSentiment,
  type ConversationSentimentCategory,
} from "@pa/core-types"

import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { loadConversationFeedback as defaultLoad } from "../lib/external-supply-client.js"

export const CONVERSATION_FEEDBACK_ROUTE = "/admin/conversation-feedback"

type Loader = (input: ConversationFeedbackInput) => Promise<ConversationFeedbackResponse>

const SENTIMENT_LABELS: Record<ConversationSentiment, string> = {
  very_negative: "Very negative",
  negative: "Negative",
  neutral: "Neutral",
  positive: "Positive",
  very_positive: "Very positive",
}

/**
 * /admin/conversation-feedback — negative-feedback review dashboard.
 *
 * Master-detail over pa-conversation-sentiment (served by
 * paAdminConversationFeedback, unhappy first). Left: a scannable list of
 * unhappy candidate↔Claire conversations (candidate, sentiment badge, category
 * chip, the candidate's own verbatim quote). Right: the full transcript preview
 * plus the diagnosed "what went wrong" and the concrete "how to improve" idea.
 *
 * Read-only / advisory — never mutates candidate state, never messages anyone.
 * Admin domain only (@wekruit.com).
 */
export default function ConversationFeedback({ load = defaultLoad }: { load?: Loader }) {
  const [unhappyOnly, setUnhappyOnly] = useState(true)
  const [category, setCategory] = useState<ConversationSentimentCategory | "">("")
  const [sentiment, setSentiment] = useState<ConversationSentiment | "">("")

  const [data, setData] = useState<ConversationFeedbackResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  function buildInput(): ConversationFeedbackInput {
    const input: ConversationFeedbackInput = { unhappyOnly }
    if (category) input.category = category
    if (sentiment) input.sentiment = sentiment
    return input
  }

  async function refresh(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const res = await load(buildInput())
      setData(res)
      // Keep the current selection if it survived the new filter, else select the first row.
      setSelectedId((prev) => {
        if (prev && res.rows.some((r) => r.userId === prev)) return prev
        return res.rows[0]?.userId ?? null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // Re-query whenever a filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unhappyOnly, category, sentiment])

  const rows = data?.rows ?? []
  const selected = useMemo(
    () => rows.find((r) => r.userId === selectedId) ?? null,
    [rows, selectedId],
  )

  const categoryChips = useMemo(() => {
    const counts = data?.byCategory ?? {}
    return CONVERSATION_SENTIMENT_CATEGORIES.map((c) => ({
      category: c,
      label: CONVERSATION_SENTIMENT_CATEGORY_LABELS[c],
      count: counts[c] ?? 0,
    })).filter((c) => c.count > 0 || c.category === category)
  }, [data, category])

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Eval / Candidate experience"
        title="Conversation feedback"
        description="Candidate↔Claire conversations classified by sentiment — unhappy first — with a transcript preview and a concrete how-to-improve note. Read-only; never messages a candidate."
        actions={
          <button type="button" onClick={() => void refresh()} disabled={loading} style={buttonStyle(loading, true)}>
            {loading ? "Loading" : "Refresh"}
          </button>
        }
      />

      <Panel title="Filters" eyebrow={CONVERSATION_FEEDBACK_ROUTE}>
        <div style={filtersStyle}>
          <label style={{ ...labelStyle, alignSelf: "end" }}>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={unhappyOnly}
                onChange={(event) => setUnhappyOnly(event.target.checked)}
              />
              Unhappy only
            </span>
          </label>
          <label style={labelStyle}>
            <span>Category</span>
            <select
              value={category}
              onChange={(event) => setCategory((event.target.value || "") as ConversationSentimentCategory | "")}
              style={inputStyle}
            >
              <option value="">All categories</option>
              {CONVERSATION_SENTIMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CONVERSATION_SENTIMENT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            <span>Sentiment</span>
            <select
              value={sentiment}
              onChange={(event) => setSentiment((event.target.value || "") as ConversationSentiment | "")}
              style={inputStyle}
            >
              <option value="">All sentiment</option>
              {CONVERSATION_SENTIMENTS.map((s) => (
                <option key={s} value={s}>
                  {SENTIMENT_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {categoryChips.length > 0 ? (
          <div style={chipStripStyle}>
            <button
              type="button"
              onClick={() => setCategory("")}
              style={chipStyle(category === "")}
            >
              All <strong>{rows.length}</strong>
            </button>
            {categoryChips.map((chip) => (
              <button
                key={chip.category}
                type="button"
                onClick={() => setCategory(chip.category === category ? "" : chip.category)}
                style={chipStyle(category === chip.category)}
              >
                {chip.label} <strong>{chip.count}</strong>
              </button>
            ))}
          </div>
        ) : null}
      </Panel>

      {error ? (
        <Panel title="Feedback error" eyebrow="callable failure">
          <ErrorState message={error} />
        </Panel>
      ) : null}

      {loading && !data ? (
        <Panel title="Loading">
          <LoadingState label="Loading conversation feedback..." />
        </Panel>
      ) : null}

      {data ? (
        rows.length === 0 ? (
          <Panel title="No conversations" eyebrow={`generated ${formatTimestamp(data.generatedAt)}`}>
            <EmptyState
              title={unhappyOnly ? "No unhappy conversations" : "No conversations"}
              body={
                unhappyOnly
                  ? "Nothing classified as negative for the current filters. Toggle off 'Unhappy only' or widen the filters to see the full set."
                  : "No classified conversations match the current filters. The daily scan populates this surface from recent candidate conversations."
              }
            />
          </Panel>
        ) : (
          <div style={masterDetailStyle}>
            <Panel title={`Conversations (${rows.length})`} eyebrow={`generated ${formatTimestamp(data.generatedAt)}`}>
              <div style={listStyle}>
                {rows.map((row) => (
                  <FeedbackListItem
                    key={row.userId}
                    row={row}
                    active={row.userId === selectedId}
                    onSelect={() => setSelectedId(row.userId)}
                  />
                ))}
              </div>
            </Panel>

            <Panel
              title={selected ? candidateLabel(selected) : "Detail"}
              eyebrow={selected ? `${SENTIMENT_LABELS[selected.sentiment]} · ${CONVERSATION_SENTIMENT_CATEGORY_LABELS[selected.category]}` : undefined}
            >
              {selected ? <FeedbackDetail row={selected} /> : <EmptyState title="Select a conversation" body="Pick a row on the left to see the transcript and the how-to-improve note." />}
            </Panel>
          </div>
        )
      ) : null}
    </div>
  )
}

function FeedbackListItem({
  row,
  active,
  onSelect,
}: {
  row: ConversationFeedbackRow
  active: boolean
  onSelect: () => void
}) {
  return (
    <button type="button" onClick={onSelect} style={listItemStyle(active)}>
      <div style={listItemHeaderStyle}>
        <strong style={{ fontSize: 14 }}>{candidateLabel(row)}</strong>
        <Badge tone={sentimentTone(row.sentiment)}>{SENTIMENT_LABELS[row.sentiment]}</Badge>
      </div>
      <div style={chipRowStyle}>
        <span style={categoryChipInlineStyle}>{CONVERSATION_SENTIMENT_CATEGORY_LABELS[row.category]}</span>
        {row.lastMessageAt ? <span style={mutedTinyStyle}>{formatTimestamp(row.lastMessageAt)}</span> : null}
      </div>
      {row.evidenceQuote ? <p style={quoteStyle}>&ldquo;{row.evidenceQuote}&rdquo;</p> : null}
    </button>
  )
}

function FeedbackDetail({ row }: { row: ConversationFeedbackRow }) {
  const transcript = row.transcript ?? []
  return (
    <div style={detailStackStyle}>
      <section style={diagnosisGridStyle}>
        {row.evidenceQuote ? (
          <div style={diagnosisCardStyle}>
            <span style={diagnosisLabelStyle}>Candidate said</span>
            <p style={quoteBlockStyle}>&ldquo;{row.evidenceQuote}&rdquo;</p>
          </div>
        ) : null}
        {row.whatWentWrong ? (
          <div style={diagnosisCardStyle}>
            <span style={diagnosisLabelStyle}>What went wrong</span>
            <p style={diagnosisTextStyle}>{row.whatWentWrong}</p>
          </div>
        ) : null}
        {row.fixIdea ? (
          <div style={{ ...diagnosisCardStyle, background: "#f0fdf4", borderColor: "#bbf7d0" }}>
            <span style={diagnosisLabelStyle}>How to improve</span>
            <p style={diagnosisTextStyle}>{row.fixIdea}</p>
          </div>
        ) : null}
      </section>

      <div style={metaRowStyle}>
        {typeof row.messageCount === "number" ? <span style={metaPillStyle}>{row.messageCount} messages</span> : null}
        {row.model ? <span style={metaPillStyle}>{row.model}</span> : null}
        {row.classifierVersion ? <span style={metaPillStyle}>classifier {row.classifierVersion}</span> : null}
        {row.classifiedAt ? <span style={metaPillStyle}>classified {formatTimestamp(row.classifiedAt)}</span> : null}
      </div>

      <div>
        <span style={diagnosisLabelStyle}>Transcript</span>
        {transcript.length === 0 ? (
          <p style={mutedStyle}>No transcript available for this candidate.</p>
        ) : (
          <div style={transcriptStyle}>
            {transcript.map((m, i) => (
              <div key={i} style={bubbleRowStyle(m.role)}>
                <div style={bubbleStyle(m.role)}>
                  <span style={bubbleWhoStyle}>{m.role === "assistant" ? "Claire" : "Candidate"}</span>
                  <span style={bubbleBodyStyle}>{m.body}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function candidateLabel(row: ConversationFeedbackRow): string {
  if (row.phone) return row.phone
  return row.userId
}

function sentimentTone(sentiment: ConversationSentiment): "ok" | "warn" | "info" | "muted" {
  if (sentiment === "very_negative" || sentiment === "negative") return "warn"
  if (sentiment === "positive" || sentiment === "very_positive") return "ok"
  return "muted"
}

function formatTimestamp(value?: string): string {
  if (!value) return "unknown"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 19)
  return date.toISOString().slice(0, 16).replace("T", " ")
}

const buttonStyle = (disabled: boolean, primary: boolean): CSSProperties => ({
  padding: "10px 14px",
  border: 0,
  borderRadius: 6,
  background: disabled ? "#94a3b8" : primary ? "#0f172a" : "#2563eb",
  color: "white",
  fontWeight: 700,
  cursor: disabled ? "not-allowed" : "pointer",
})
const filtersStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end" }
const labelStyle: CSSProperties = { display: "grid", gap: 6, fontSize: 13, color: "#475569" }
const inputStyle: CSSProperties = { padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, minWidth: 180 }
const mutedStyle: CSSProperties = { margin: "6px 0 0", color: "#64748b", fontSize: 13 }
const mutedTinyStyle: CSSProperties = { color: "#94a3b8", fontSize: 11 }

const chipStripStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }
const chipStyle = (active: boolean): CSSProperties => ({
  padding: "6px 12px",
  borderRadius: 999,
  border: `1px solid ${active ? "#0f172a" : "#cbd5e1"}`,
  background: active ? "#0f172a" : "#fff",
  color: active ? "#fff" : "#334155",
  fontSize: 13,
  cursor: "pointer",
})

const masterDetailStyle: CSSProperties = { display: "grid", gridTemplateColumns: "minmax(280px, 380px) 1fr", gap: 16, alignItems: "start" }
const listStyle: CSSProperties = { display: "grid", gap: 8, maxHeight: "70vh", overflowY: "auto" }
const listItemStyle = (active: boolean): CSSProperties => ({
  display: "grid",
  gap: 6,
  textAlign: "left",
  padding: 12,
  borderRadius: 8,
  border: `1px solid ${active ? "#2563eb" : "#e2e8f0"}`,
  background: active ? "#eff6ff" : "#fff",
  cursor: "pointer",
})
const listItemHeaderStyle: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }
const chipRowStyle: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }
const categoryChipInlineStyle: CSSProperties = { fontSize: 12, color: "#475569", background: "#f1f5f9", borderRadius: 6, padding: "2px 8px" }
const quoteStyle: CSSProperties = { margin: 0, fontSize: 13, color: "#475569", fontStyle: "italic", lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }

const detailStackStyle: CSSProperties = { display: "grid", gap: 18 }
const diagnosisGridStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }
const diagnosisCardStyle: CSSProperties = { display: "grid", gap: 6, border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, background: "#f8fafc" }
const diagnosisLabelStyle: CSSProperties = { fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, color: "#64748b" }
const diagnosisTextStyle: CSSProperties = { margin: 0, fontSize: 14, color: "#1e293b", lineHeight: 1.5 }
const quoteBlockStyle: CSSProperties = { margin: 0, fontSize: 14, color: "#1e293b", fontStyle: "italic", lineHeight: 1.5 }
const metaRowStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 }
const metaPillStyle: CSSProperties = { fontSize: 12, color: "#475569", background: "#f1f5f9", borderRadius: 6, padding: "4px 10px" }

const transcriptStyle: CSSProperties = { display: "grid", gap: 8, marginTop: 8, maxHeight: "60vh", overflowY: "auto", padding: 12, background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }
const bubbleRowStyle = (role: "user" | "assistant"): CSSProperties => ({ display: "flex", justifyContent: role === "assistant" ? "flex-start" : "flex-end" })
const bubbleStyle = (role: "user" | "assistant"): CSSProperties => ({
  display: "grid",
  gap: 2,
  maxWidth: "78%",
  padding: "8px 12px",
  borderRadius: 12,
  background: role === "assistant" ? "#fff" : "#2563eb",
  color: role === "assistant" ? "#1e293b" : "#fff",
  border: role === "assistant" ? "1px solid #e2e8f0" : "none",
})
const bubbleWhoStyle: CSSProperties = { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.7 }
const bubbleBodyStyle: CSSProperties = { fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap" }
