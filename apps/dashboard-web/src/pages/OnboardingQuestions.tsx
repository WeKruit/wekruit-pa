/**
 * iter34 P3+ — /admin/onboarding-questions page.
 *
 * Adam directive 2026-05-05: "你现在把我们所有的这个 deterministic question
 * list 以及对应的所有信息都放在 dashboard 我可以直接看了吗？我先确认一下"
 *
 * Read-first surface for the Q-as-class pipeline. Lists all 10 questions
 * from `pa-onboarding-questions` with order, enabled state, prompt
 * (zh+en), judgeKind, rephraserKind, variants count, maxAttempts,
 * haltMessage, llmStep, version. Click row → expand to see full prompt
 * + every variant verbatim.
 *
 * Edit support is deliberately scoped OUT of v1 — this commit ships
 * visibility ("我先确认一下"). Edit dialog mirrors Playbooks.tsx and
 * lands when Adam confirms the read view is correct.
 */
import { useEffect, useMemo, useState } from "react"
import {
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
} from "../components/ui.js"
import {
  listAllOnboardingQuestions,
  type OnboardingQuestionDoc,
} from "../lib/onboarding-questions-api.js"

function rowSummary(q: OnboardingQuestionDoc): string {
  const parts: string[] = []
  parts.push(`order=${q.order}`)
  parts.push(`judge=${q.judgeKind}`)
  if (q.llmStep) parts.push(`step=${q.llmStep}`)
  parts.push(`rephraser=${q.rephraserKind}`)
  parts.push(`variants=${q.variants.length}`)
  parts.push(`maxAttempts=${q.maxAttempts}`)
  parts.push(`v${q.version}`)
  return parts.join(" · ")
}

function previewPrompt(q: OnboardingQuestionDoc): string {
  const zh = q.prompt.zh.replace(/\s+/g, " ").trim()
  if (zh.length <= 60) return zh
  return `${zh.slice(0, 60)}…`
}

export function OnboardingQuestions() {
  const [docs, setDocs] = useState<OnboardingQuestionDoc[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listAllOnboardingQuestions()
      .then((rows) => {
        if (!cancelled) setDocs(rows)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const stats = useMemo(() => {
    if (!docs) return null
    const enabled = docs.filter((d) => d.enabled).length
    const llm = docs.filter((d) => d.judgeKind === "llm-relevance").length
    return { total: docs.length, enabled, llm }
  }, [docs])

  return (
    <div>
      <PageHeader
        title="Onboarding Questions (Q-as-class)"
        description="Pipeline question registry. Each Q = prompt + judge + rephraser + maxAttempts. iter34 P3 — Adam directive 每一个问题抽象成一个 class."
      />

      {stats && (
        <Panel title="Summary">
          <p style={{ margin: 0, color: "#6b7280" }}>
            {stats.enabled}/{stats.total} enabled · {stats.llm} LLM-judged
          </p>
        </Panel>
      )}

      {error && <ErrorState message={error} />}
      {!error && !docs && <LoadingState />}
      {docs && docs.length === 0 && (
        <Panel title="Empty">
          <p style={{ margin: 0, color: "#6b7280" }}>
            No questions seeded. Run apps/functions/scripts/seed-onboarding-questions.mjs.
          </p>
        </Panel>
      )}

      {docs && docs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {docs.map((q) => {
            const expanded = expandedId === q.id
            return (
              <Panel key={q.id} title={`#${q.order} · ${q.id}`}>
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    cursor: "pointer",
                    marginBottom: 8,
                  }}
                  onClick={() => setExpandedId(expanded ? null : q.id)}
                >
                  <StatusBadge value={q.enabled ? "active" : "disabled"} />
                  <span style={{ color: "#6b7280", fontSize: 12 }}>
                    {rowSummary(q)}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      color: "#6b7280",
                      fontSize: 12,
                      fontStyle: "italic",
                    }}
                  >
                    {expanded ? "▲ collapse" : "▼ expand"}
                  </span>
                </div>
                <div style={{ color: "#374151", fontSize: 13, marginBottom: 8 }}>
                  {previewPrompt(q)}
                </div>
                {expanded && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <Field label="Prompt (zh)" mono>
                      {q.prompt.zh}
                    </Field>
                    <Field label="Prompt (en)" mono>
                      {q.prompt.en}
                    </Field>
                    <Field label="Judge">
                      <span style={{ fontFamily: "monospace" }}>{q.judgeKind}</span>
                      {q.llmStep && (
                        <span style={{ color: "#6b7280", marginLeft: 8 }}>
                          → extractAnswerIntent({q.llmStep})
                        </span>
                      )}
                    </Field>
                    <Field label="Rephraser">
                      <span style={{ fontFamily: "monospace" }}>{q.rephraserKind}</span>
                    </Field>
                    <Field label={`Variants (${q.variants.length})`}>
                      {q.variants.length === 0 ? (
                        <span style={{ color: "#9ca3af" }}>(none)</span>
                      ) : (
                        <ol style={{ margin: 0, paddingLeft: 20 }}>
                          {q.variants.map((v, i) => (
                            <li key={i} style={{ marginBottom: 8 }}>
                              <div style={{ fontFamily: "monospace", fontSize: 13 }}>
                                <span style={{ color: "#6b7280" }}>zh:</span> {v.zh}
                              </div>
                              <div style={{ fontFamily: "monospace", fontSize: 13 }}>
                                <span style={{ color: "#6b7280" }}>en:</span> {v.en}
                              </div>
                            </li>
                          ))}
                        </ol>
                      )}
                    </Field>
                    <Field label="Max attempts">{q.maxAttempts}</Field>
                    {q.haltMessage && (
                      <>
                        <Field label="Halt (zh)" mono>
                          {q.haltMessage.zh}
                        </Field>
                        <Field label="Halt (en)" mono>
                          {q.haltMessage.en}
                        </Field>
                      </>
                    )}
                    <Field label="Version">{q.version}</Field>
                    <Field label="Updated">
                      <span style={{ fontSize: 12, color: "#6b7280" }}>
                        {q.updatedAt || "(never)"} by {q.updatedBy || "(seed)"} —{" "}
                        {q.reason || "(no reason)"}
                      </span>
                    </Field>
                  </div>
                )}
              </Panel>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  children,
  mono,
}: {
  label: string
  children: React.ReactNode
  mono?: boolean
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 12 }}>
      <div style={{ color: "#6b7280", fontSize: 13, fontWeight: 500 }}>{label}</div>
      <div
        style={{
          fontFamily: mono ? "monospace" : undefined,
          fontSize: 13,
          whiteSpace: "pre-wrap",
        }}
      >
        {children}
      </div>
    </div>
  )
}
