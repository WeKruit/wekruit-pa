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
 *
 * v1.6 Phase 59 (DASH-04) — Adds "Per-user tags" panel below questions.
 * Lists recent pa-users (limit 100) with a "View Tags" button per user
 * that opens a modal showing `pa-users/{userId}.tags` JSON. Lets ops
 * confirm pa-resume-parser v2 + chat-answer hooks wrote canonical tags
 * correctly (D8 single source of truth). Additive only — does not
 * modify the existing questions read view.
 */
import { useEffect, useMemo, useState } from "react"
import { collection, doc, getDoc, getDocs, limit, query } from "firebase/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StatusBadge,
} from "../components/ui.js"
import { db } from "../lib/firebase.js"
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

// v1.6 Phase 59 (DASH-04) — per-user tag view types + helpers.
interface UserRow {
  id: string
  phoneE164?: string
  createdAt?: string
  onboardingStatus?: string
}

interface UserTags {
  /** D8 — `pa-users.tags` is the single source of truth (CV + chat hooks). */
  [axis: string]: unknown
}

export function OnboardingQuestions() {
  const [docs, setDocs] = useState<OnboardingQuestionDoc[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // v1.6 Phase 59 (DASH-04) — per-user tags view.
  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [usersErr, setUsersErr] = useState<string | null>(null)
  const [viewingUser, setViewingUser] = useState<string | null>(null)
  const [viewingTags, setViewingTags] = useState<UserTags | null>(null)
  const [viewingMeta, setViewingMeta] = useState<{
    lastCvUpdate?: string
    lastChatUpdate?: string
    sources?: unknown
  } | null>(null)
  const [modalErr, setModalErr] = useState<string | null>(null)
  const [modalLoading, setModalLoading] = useState(false)

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

  // Load recent users for the "View Tags" picker.
  useEffect(() => {
    let cancelled = false
    const q = query(collection(db(), PA_COLLECTIONS.users), limit(100))
    getDocs(q)
      .then((snap) => {
        if (cancelled) return
        const rows: UserRow[] = snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            phoneE164:
              typeof data.phoneE164 === "string" ? data.phoneE164 : undefined,
            createdAt:
              typeof data.createdAt === "string" ? data.createdAt : undefined,
            onboardingStatus:
              typeof data.onboardingStatus === "string"
                ? data.onboardingStatus
                : undefined,
          }
        })
        rows.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
        setUsers(rows)
      })
      .catch((e) => {
        if (!cancelled) setUsersErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function loadUserTags(userId: string) {
    setViewingUser(userId)
    setViewingTags(null)
    setViewingMeta(null)
    setModalErr(null)
    setModalLoading(true)
    try {
      const d = await getDoc(doc(db(), PA_COLLECTIONS.users, userId))
      if (!d.exists()) {
        setModalErr("User document not found")
        return
      }
      const data = d.data() as Record<string, unknown>
      setViewingTags((data.tags as UserTags) ?? {})
      setViewingMeta({
        lastCvUpdate:
          typeof data.lastCvUpdateAt === "string" ? data.lastCvUpdateAt : undefined,
        lastChatUpdate:
          typeof data.lastChatTagUpdateAt === "string"
            ? data.lastChatTagUpdateAt
            : undefined,
        sources: data.tagSources,
      })
    } catch (e) {
      setModalErr(e instanceof Error ? e.message : String(e))
    } finally {
      setModalLoading(false)
    }
  }

  function closeModal() {
    setViewingUser(null)
    setViewingTags(null)
    setViewingMeta(null)
    setModalErr(null)
  }

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
            No questions seeded.
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

      {/* v1.6 Phase 59 (DASH-04) — per-user pa-users.tags view. Lets ops
          confirm cv-ingest + chat-answer hooks landed canonical tags. */}
      <Panel
        title="Per-user tags (v1.6 Phase 59)"
        eyebrow={`pa-users · ${users?.length ?? "—"} recent · D8 single source`}
      >
        {usersErr ? (
          <ErrorState message={usersErr} />
        ) : users === null ? (
          <LoadingState label="Loading users…" />
        ) : users.length === 0 ? (
          <p style={{ margin: 0, color: "#6b7280" }}>No pa-users docs.</p>
        ) : (
          <div style={{ maxHeight: 320, overflow: "auto" }}>
            <table style={{ width: "100%", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                  <th style={{ padding: "0.4rem 0" }}>User ID</th>
                  <th style={{ padding: "0.4rem 0" }}>Phone</th>
                  <th style={{ padding: "0.4rem 0" }}>Onboarding</th>
                  <th style={{ padding: "0.4rem 0" }}>Created</th>
                  <th style={{ padding: "0.4rem 0" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "0.4rem 0", fontFamily: "monospace", fontSize: 12 }}>
                      {u.id}
                    </td>
                    <td style={{ padding: "0.4rem 0", fontSize: 12 }}>
                      {u.phoneE164 ?? "—"}
                    </td>
                    <td style={{ padding: "0.4rem 0", fontSize: 12 }}>
                      <StatusBadge value={u.onboardingStatus} />
                    </td>
                    <td style={{ padding: "0.4rem 0", fontSize: 12 }}>
                      {u.createdAt ? u.createdAt.slice(0, 19).replace("T", " ") : "—"}
                    </td>
                    <td style={{ padding: "0.4rem 0" }}>
                      <button
                        type="button"
                        onClick={() => void loadUserTags(u.id)}
                        style={{
                          fontSize: 12,
                          color: "#1a73e8",
                          background: "transparent",
                          border: "1px solid #cbd5e1",
                          padding: "2px 8px",
                          borderRadius: 4,
                          cursor: "pointer",
                        }}
                      >
                        View Tags
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* User tags modal */}
      {viewingUser && (
        <div
          onClick={closeModal}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              padding: "1.25rem",
              borderRadius: 8,
              maxWidth: "min(720px, 90vw)",
              width: "100%",
              maxHeight: "85vh",
              overflow: "auto",
              boxShadow: "0 12px 32px rgba(0,0,0,0.2)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "0.75rem",
              }}
            >
              <div>
                <p className="eyebrow" style={{ margin: 0 }}>
                  pa-users.tags · D8 single source
                </p>
                <h2 style={{ margin: "2px 0 0 0", fontSize: "1.1em" }}>
                  Tags: {viewingUser}
                </h2>
              </div>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                style={{ fontSize: "1.4em", background: "transparent", border: "none", cursor: "pointer" }}
              >
                ×
              </button>
            </div>

            {modalLoading ? (
              <LoadingState label="Loading user tags…" />
            ) : modalErr ? (
              <ErrorState message={modalErr} />
            ) : (
              <>
                {viewingMeta && (viewingMeta.lastCvUpdate || viewingMeta.lastChatUpdate) ? (
                  <div style={{ fontSize: 12, color: "#475569", marginBottom: 8 }}>
                    {viewingMeta.lastCvUpdate ? (
                      <div>
                        Last CV update:{" "}
                        <code>{viewingMeta.lastCvUpdate}</code>
                      </div>
                    ) : null}
                    {viewingMeta.lastChatUpdate ? (
                      <div>
                        Last chat update:{" "}
                        <code>{viewingMeta.lastChatUpdate}</code>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <pre
                  style={{
                    background: "#f8fafc",
                    padding: "0.75rem",
                    borderRadius: 4,
                    fontSize: 12,
                    overflow: "auto",
                    maxHeight: "60vh",
                    margin: 0,
                  }}
                >
                  {viewingTags
                    ? JSON.stringify(viewingTags, null, 2)
                    : "(no tags written yet)"}
                </pre>
              </>
            )}
          </div>
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
