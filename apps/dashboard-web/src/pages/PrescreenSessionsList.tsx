/**
 * Human review queue for pa-prescreen-sessions.
 *
 * Important semantics:
 * - `terminal` is Claire's proposed terminal recommendation.
 * - `terminalActionPendingReview=true` means no final employment-impacting
 *   action has been committed; only the neutral review-pending ack is allowed.
 */
import { useEffect, useMemo, useState } from "react"
import type { CSSProperties, ReactNode } from "react"
import { Link } from "react-router-dom"
import { collection, doc, getDoc, getDocs, limit, orderBy, query } from "firebase/firestore"
import {
  classifyCandidateProfile,
  deriveCandidateSource,
  type CandidateListUserDoc,
  type EvaluationAttempt,
} from "@pa/core-types"
import { PrescreenReviewToolbar, StrictReviewBadge } from "../components/prescreen/PrescreenReviewControls.js"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import { db } from "../lib/firebase.js"
import {
  classifyPrescreenReviewRow,
  filterAndSortPrescreenRows,
  summarizePrescreenReviewRows,
  type PrescreenReviewQuestion,
  type StrictReviewBucket,
  type StrictReviewSort,
} from "../lib/prescreen-review-ranking.js"
import {
  draftPrescreenReviewMessages,
  reviewEvaluationAttempt,
  type DraftPrescreenReviewMessage,
} from "../lib/external-supply-client.js"

type ReviewTerminal = "PASS" | "FAIL" | "HARD_STOP"

type Row = {
  id: string
  userId: string
  jobId: string
  score: number
  scoreMax: number
  threshold: number
  terminal: string | null
  terminalReason?: string
  terminalActionPendingReview?: boolean
  evaluationAttemptId?: string
  e164?: string
  testMode?: boolean
  isDemo?: boolean
  demoSourcePool?: string
  questions?: Record<string, PrescreenReviewQuestion>
  review?: {
    status?: string
    evaluationAttemptId?: string
    proposedTerminal?: string
    finalTerminal?: string
    pendingAckOutboundId?: string
    decisionOutboundId?: string
  }
  createdAt: string
  updatedAt: string
}

type PerKeyword = {
  keyword: string
  match: number
  confidence: number
  evidence: string
  reasoning: string
}

type PrescreenTurn = {
  id: string
  qId: string
  reply: string
  scored?: {
    perKeyword?: PerKeyword[]
    aggregate?: { s?: number; c?: number; summary?: string }
    abortHint?: { kind: string; reason: string }
  }
  action?: { kind: string; reason?: string; terminal?: string }
  ts: string
}

type SessionDoc = Row & {
  sessionId: string
  qOrder?: string[]
  questions?: Record<
    string,
    PrescreenReviewQuestion & {
      qId: string
      type: "MUST_HAVE" | "PROBING" | "GOOD_TO_HAVE"
      weight: number
      clarifyRounds?: number
      terminalCause?: string
    }
  >
}

type ReviewDetail = {
  session: SessionDoc
  attempt: EvaluationAttempt | null
  turns: PrescreenTurn[]
}

type BulkDraftItem = {
  sessionId: string
  row: Row
  attemptId?: string
  terminal: ReviewTerminal
  message: string
  evidenceSummary?: string
  error?: string
  status?: "drafted" | "queued"
}

function terminalTone(t: string | null | undefined): "ok" | "warn" | "info" | "muted" {
  if (t === "PASS") return "ok"
  if (t === null || t === undefined) return "info"
  if (t === "FAIL" || t === "HARD_STOP") return "warn"
  return "muted"
}

function cleanReviewTerminal(value: unknown): ReviewTerminal | null {
  return value === "PASS" || value === "FAIL" || value === "HARD_STOP" ? value : null
}

function finalOutcomeKind(terminal: ReviewTerminal): "pass" | "reject" {
  return terminal === "PASS" ? "pass" : "reject"
}

function reviewLabel(row: Row): string {
  if (row.terminalActionPendingReview) return "Pending HITL"
  if (row.review?.finalTerminal) return `Committed ${row.review.finalTerminal}`
  if (row.review?.status) return `Review ${row.review.status}`
  return "No review"
}

function isRealPrescreenCandidate(row: Row, rawUserDoc: Record<string, unknown> | null): boolean {
  const candidateDoc = buildCandidateClassifierDoc(row, rawUserDoc)
  const source = deriveCandidateSource(candidateDoc)
  return classifyCandidateProfile(source, candidateDoc) === "candidate_account"
}

function buildCandidateClassifierDoc(row: Row, rawUserDoc: Record<string, unknown> | null): CandidateListUserDoc {
  const userDoc = rawUserDoc ?? {}
  return {
    id: firstString(row.userId) ?? row.userId,
    phoneE164: firstString(
      userDoc.phoneE164,
      userDoc.e164,
      nestedString(userDoc.identity, "phoneE164"),
      nestedString(userDoc.identity, "e164"),
      nestedString(userDoc.contact, "phoneE164"),
      nestedString(userDoc.contact, "e164"),
      row.e164,
    ),
    email: firstString(userDoc.email, nestedString(userDoc.identity, "email"), nestedString(userDoc.contact, "email")),
    linkedinUrl: firstString(
      userDoc.linkedinUrl,
      userDoc.linkedInUrl,
      userDoc.linkedinURL,
      nestedString(userDoc.identity, "linkedinUrl"),
      nestedString(userDoc.contact, "linkedinUrl"),
    ),
    signupSource: firstString(userDoc.signupSource),
    source: firstString(userDoc.source),
    candidateLifecycleState: firstString(userDoc.candidateLifecycleState),
    onboardingStatus: firstString(userDoc.onboardingStatus),
    latestResumeArtifactId: firstString(userDoc.latestResumeArtifactId),
    piiConsentAt: firstString(userDoc.piiConsentAt),
    mem0UserId: firstString(userDoc.mem0UserId),
    testMode: userDoc.testMode === true || row.testMode === true,
    isDemo: userDoc.isDemo === true || row.isDemo === true,
    demoSourcePool: firstString(userDoc.demoSourcePool, row.demoSourcePool),
  }
}

async function loadUserDocsById(userIds: string[]): Promise<Map<string, Record<string, unknown> | null>> {
  const uniqueIds = [...new Set(userIds.filter((id) => typeof id === "string" && id.trim()))]
  const pairs = await Promise.all(uniqueIds.map(async (userId) => {
    const snap = await getDoc(doc(db(), "pa-users", userId))
    return [userId, snap.exists() ? snap.data() as Record<string, unknown> : null] as const
  }))
  return new Map(pairs)
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  return firstString(record[key])
}

async function loadReviewDetail(sessionId: string): Promise<ReviewDetail> {
  const sessSnap = await getDoc(doc(db(), "pa-prescreen-sessions", sessionId))
  if (!sessSnap.exists()) throw new Error(`session ${sessionId} not found`)
  const session = { ...(sessSnap.data() as SessionDoc), sessionId, id: sessionId }
  const attemptId = session.evaluationAttemptId ?? session.review?.evaluationAttemptId
  let attempt: EvaluationAttempt | null = null
  if (attemptId) {
    const attemptSnap = await getDoc(doc(db(), "pa-evaluation-attempts", attemptId))
    if (attemptSnap.exists()) attempt = attemptSnap.data() as EvaluationAttempt
  }
  const turnsSnap = await getDocs(
    query(collection(db(), "pa-prescreen-sessions", sessionId, "turns"), orderBy("ts", "asc")),
  )
  const turns = turnsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PrescreenTurn, "id">) }))
  return { session, attempt, turns }
}

function buildLocalDraftMessage(terminal: ReviewTerminal, detail: ReviewDetail): string {
  const summary = firstEvidenceSummary(detail)
  if (terminal === "PASS") {
    return summary
      ? `Thanks for completing the WeKruit screen. We reviewed your answers, and your ${summary} looks relevant for this role. We will follow up with the next step.`
      : "Thanks for completing the WeKruit screen. We reviewed your answers and would like to move you forward for the next step."
  }
  return summary
    ? `Thanks for completing the WeKruit screen. We reviewed it, and this specific role does not look like the right next step because ${summary}. We will keep you in mind for roles that match your background more closely.`
    : "Thanks for completing the WeKruit screen. We reviewed it, and this specific role does not look like the right next step. We will keep you in mind for roles that match your background more closely."
}

function firstEvidenceSummary(detail: ReviewDetail): string | null {
  const dim = detail.attempt?.dimensions?.find((d) => d.rationale?.trim())
  if (dim?.rationale) return dim.rationale.trim().replace(/\.$/, "").slice(0, 180)
  const scored = detail.turns.find((t) => t.scored?.aggregate?.summary?.trim())
  if (scored?.scored?.aggregate?.summary) {
    return scored.scored.aggregate.summary.trim().replace(/\.$/, "").slice(0, 180)
  }
  if (detail.session.terminalReason) return detail.session.terminalReason.replace(/^ratio=[^ ]+\s*/i, "").slice(0, 180)
  return null
}

export default function PrescreenSessionsList() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drawerSessionId, setDrawerSessionId] = useState<string | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [bucketFilter, setBucketFilter] = useState<StrictReviewBucket>("all")
  const [sortMode, setSortMode] = useState<StrictReviewSort>("strict_priority")
  const [search, setSearch] = useState("")

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const q = query(
          collection(db(), "pa-prescreen-sessions"),
          orderBy("createdAt", "desc"),
          limit(75),
        )
        const snap = await getDocs(q)
        if (cancelled) return
        const loadedRows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Row, "id">) }))
        const userDocs = await loadUserDocsById(loadedRows.map((row) => row.userId))
        if (cancelled) return
        const realRows = loadedRows.filter((row) => isRealPrescreenCandidate(row, userDocs.get(row.userId) ?? null))
        const pendingRows = realRows.filter((row) => row.terminalActionPendingReview === true)
        const otherRows = realRows.filter((row) => row.terminalActionPendingReview !== true)
        setRows([...pendingRows, ...otherRows])
        setSelected((prev) => {
          const pendingIds = new Set(pendingRows.map((r) => r.id))
          return new Set(Array.from(prev).filter((id) => pendingIds.has(id)))
        })
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const pendingRows = useMemo(() => rows.filter((r) => r.terminalActionPendingReview === true), [rows])
  const pendingSummary = useMemo(() => summarizePrescreenReviewRows(pendingRows), [pendingRows])
  const visibleRows = useMemo(
    () => filterAndSortPrescreenRows(pendingRows, { bucket: bucketFilter, sort: sortMode, search }),
    [bucketFilter, pendingRows, search, sortMode],
  )
  const selectedPendingRows = useMemo(
    () => pendingRows.filter((r) => selected.has(r.id)),
    [pendingRows, selected],
  )
  const allPendingSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id))
  const somePendingSelected = !allPendingSelected && visibleRows.some((r) => selected.has(r.id))

  function toggleSelected(sessionId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  function refresh() {
    setReloadKey((key) => key + 1)
  }

  function selectLikelyRejects() {
    const likelyRejectIds = pendingRows
      .filter((row) => classifyPrescreenReviewRow(row).bucket === "batch_reject")
      .map((row) => row.id)
    setSelected(new Set(likelyRejectIds))
  }

  if (loading) return <LoadingState label="Loading sessions..." />
  if (err) return <ErrorState message={err} />

  return (
    <div>
      <PageHeader
        title="Prescreen Review Queue"
        description="AI proposed terminal is not a final candidate decision. Pending HITL rows require an operator-approved final message before any accept/reject outbound is queued."
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "#64748b", fontSize: "0.85em" }}>{selected.size} selected</span>
            <button
              type="button"
              disabled={selectedPendingRows.length === 0}
              onClick={() => setBulkOpen(true)}
            >
              Bulk reject with LLM drafts
            </button>
            <button type="button" onClick={refresh}>Refresh</button>
          </div>
        }
      />
      <Panel title={`${pendingRows.length} pending review(s)`} eyebrow={`${rows.length} real recent sessions`}>
        {pendingRows.length > 0 ? (
          <PrescreenReviewToolbar
            bucket={bucketFilter}
            sort={sortMode}
            search={search}
            summary={pendingSummary}
            visibleCount={visibleRows.length}
            selectedCount={selected.size}
            onBucketChange={setBucketFilter}
            onSortChange={setSortMode}
            onSearchChange={setSearch}
            onSelectLikelyRejects={selectLikelyRejects}
          />
        ) : null}
        {rows.length === 0 && (
          <p style={{ opacity: 0.7, fontSize: "0.9em" }}>
            No sessions yet. Trigger one: SMS{" "}
            <code>WeKruit_&lt;jobId&gt;_&lt;userId&gt;_Job</code> to the Sendblue number.
            See <Link to="/admin/job-prescreen">job prescreen config</Link> for jobIds.
          </p>
        )}
        {rows.length > 0 && visibleRows.length === 0 ? (
          <p style={{ opacity: 0.7, fontSize: "0.9em" }}>
            No pending review sessions match the current filter.
          </p>
        ) : null}
        {visibleRows.length > 0 && (
          <table style={{ width: "100%", fontSize: "0.85em", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(0,0,0,0.15)" }}>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>
                  <input
                    type="checkbox"
                    aria-label="Select all pending review sessions"
                    checked={allPendingSelected}
                    ref={(node) => {
                      if (node) node.indeterminate = somePendingSelected
                    }}
                    onChange={(e) => {
                      setSelected(e.target.checked ? new Set(visibleRows.map((r) => r.id)) : new Set())
                    }}
                  />
                </th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Created</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>AI proposed</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Strict recommendation</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Human decision</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Score</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Job</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>User</th>
                <th style={{ textAlign: "left", padding: "0.35rem" }}>Review</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => {
                const ratio = r.scoreMax === 0 ? 0 : r.score / r.scoreMax
                const pending = r.terminalActionPendingReview === true
                const classification = classifyPrescreenReviewRow(r)
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
                    <td style={{ padding: "0.35rem" }}>
                      {pending ? (
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.id}`}
                          checked={selected.has(r.id)}
                          onChange={() => toggleSelected(r.id)}
                        />
                      ) : null}
                    </td>
                    <td style={{ padding: "0.35rem", fontFamily: "monospace", fontSize: "0.85em" }}>
                      {r.createdAt?.slice(0, 16)}
                    </td>
                    <td style={{ padding: "0.35rem" }}>
                      <Badge tone={terminalTone(r.terminal)}>{r.terminal ? `AI ${r.terminal}` : "IN_PROGRESS"}</Badge>
                    </td>
                    <td style={{ padding: "0.35rem" }}>
                      <div style={{ display: "grid", gap: 4 }}>
                        <StrictReviewBadge classification={classification} />
                        <span style={{ color: "#64748b", fontSize: "0.78em" }}>
                          {classification.reasons[0]}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: "0.35rem" }}>
                      <Badge tone={pending ? "warn" : r.review?.finalTerminal ? terminalTone(r.review.finalTerminal) : "muted"}>
                        {reviewLabel(r)}
                      </Badge>
                    </td>
                    <td style={{ padding: "0.35rem" }}>
                      {r.score?.toFixed(2)}/{r.scoreMax?.toFixed(2)} ({(ratio * 100).toFixed(0)}%)
                    </td>
                    <td style={{ padding: "0.35rem", fontSize: "0.85em" }}>{r.jobId}</td>
                    <td style={{ padding: "0.35rem", fontFamily: "monospace", fontSize: "0.75em" }}>
                      {r.userId?.slice(0, 8)}...
                    </td>
                    <td style={{ padding: "0.35rem" }}>
                      <button type="button" onClick={() => setDrawerSessionId(r.id)}>
                        Quick review
                      </button>{" "}
                      <Link to={`/admin/prescreen-sessions/${r.id}`}>detail</Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {drawerSessionId ? (
        <PrescreenReviewDrawer
          sessionId={drawerSessionId}
          onClose={() => setDrawerSessionId(null)}
          onReviewed={() => {
            setDrawerSessionId(null)
            refresh()
          }}
        />
      ) : null}
      {bulkOpen ? (
        <BulkRejectDrawer
          rows={selectedPendingRows}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false)
            setSelected(new Set())
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function PrescreenReviewDrawer({
  sessionId,
  onClose,
  onReviewed,
}: {
  sessionId: string
  onClose: () => void
  onReviewed: () => void
}) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selectedTerminal, setSelectedTerminal] = useState<ReviewTerminal>("PASS")
  const [candidateMessageBody, setCandidateMessageBody] = useState("")
  const [busy, setBusy] = useState(false)
  const [draftBusy, setDraftBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const loaded = await loadReviewDetail(sessionId)
        if (cancelled) return
        setDetail(loaded)
        const strictRecommendation = classifyPrescreenReviewRow(loaded.session).recommendation
        const proposed = cleanReviewTerminal(strictRecommendation) ??
          cleanReviewTerminal(loaded.attempt?.proposedOutcome?.prescreenTerminal) ??
          cleanReviewTerminal(loaded.session.terminal) ??
          "FAIL"
        setSelectedTerminal(proposed)
        setCandidateMessageBody("")
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  async function draftWithLlm() {
    if (!detail) return
    setDraftBusy(true)
    setErr(null)
    try {
      const result = await draftPrescreenReviewMessages({
        sessionIds: [detail.session.sessionId],
        terminal: selectedTerminal,
      })
      const draft = result.drafts[0]
      if (draft?.candidateMessageBody) setCandidateMessageBody(draft.candidateMessageBody)
    } catch (e) {
      if (!candidateMessageBody.trim()) setCandidateMessageBody(buildLocalDraftMessage(selectedTerminal, detail))
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setDraftBusy(false)
    }
  }

  async function approve() {
    if (!detail?.attempt?.attemptId) return
    const body = candidateMessageBody.trim()
    if (!body) {
      setErr("Final candidate message is required.")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const attemptTerminal = cleanReviewTerminal(detail.attempt.proposedOutcome?.prescreenTerminal)
      const status = attemptTerminal === selectedTerminal ? "approved" : "overridden"
      await reviewEvaluationAttempt({
        attemptId: detail.attempt.attemptId,
        status,
        finalOutcome: {
          kind: finalOutcomeKind(selectedTerminal),
          prescreenTerminal: selectedTerminal,
        },
        candidateMessageBody: body,
        ...(status === "overridden" ? { correctionReason: "operator_changed_prescreen_terminal" } : {}),
      })
      onReviewed()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SideDrawer title="Prescreen quick review" subtitle={sessionId} onClose={onClose}>
      {loading ? <LoadingState label="Loading review..." /> : null}
      {err ? <div className="notice notice-bad" style={{ fontSize: "0.85em" }}>{err}</div> : null}
      {detail ? (
        <div style={{ display: "grid", gap: 14 }}>
          <ReviewSummary detail={detail} />
          <TranscriptPreview turns={detail.turns} />
          {detail.session.terminalActionPendingReview ? (
            <div style={{ display: "grid", gap: 8 }}>
              <label style={labelStyle}>
                Final outcome
                <select
                  value={selectedTerminal}
                  onChange={(e) => setSelectedTerminal(cleanReviewTerminal(e.target.value) ?? "FAIL")}
                  style={inputStyle}
                >
                  <option value="PASS">PASS</option>
                  <option value="FAIL">FAIL</option>
                  <option value="HARD_STOP">HARD_STOP</option>
                </select>
              </label>
              <label style={labelStyle}>
                Final candidate message
                <textarea
                  value={candidateMessageBody}
                  onChange={(e) => setCandidateMessageBody(e.target.value)}
                  rows={7}
                  placeholder="Write the exact iMessage WeKruit should send after approval."
                  style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
                />
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" onClick={() => void draftWithLlm()} disabled={draftBusy}>
                  {draftBusy ? "Drafting..." : "Draft with LLM"}
                </button>
                <button
                  type="button"
                  onClick={() => setCandidateMessageBody(buildLocalDraftMessage(selectedTerminal, detail))}
                >
                  Use evidence draft
                </button>
                <button
                  type="button"
                  onClick={() => void approve()}
                  disabled={busy || !candidateMessageBody.trim()}
                >
                  {busy ? "Queuing..." : "Approve and queue iMessage"}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: "0.9em", color: "#334155" }}>
              Review already committed. Final outbound:{" "}
              <code>{detail.session.review?.decisionOutboundId ?? "not recorded"}</code>
            </div>
          )}
        </div>
      ) : null}
    </SideDrawer>
  )
}

function BulkRejectDrawer({
  rows,
  onClose,
  onDone,
}: {
  rows: Row[]
  onClose: () => void
  onDone: () => void
}) {
  const [items, setItems] = useState<BulkDraftItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const sessionIds = rows.map((r) => r.id)
        const drafts = await draftPrescreenReviewMessages({ sessionIds, terminal: "FAIL" })
        if (cancelled) return
        const bySession = new Map<string, DraftPrescreenReviewMessage>(
          drafts.drafts.map((draft) => [draft.sessionId, draft]),
        )
        setItems(rows.map((row) => {
          const draft = bySession.get(row.id)
          return {
            sessionId: row.id,
            row,
            attemptId: draft?.attemptId ?? row.evaluationAttemptId ?? row.review?.evaluationAttemptId,
            terminal: row.terminal === "HARD_STOP" ? "HARD_STOP" : "FAIL",
            message: draft?.candidateMessageBody ?? "",
            evidenceSummary: draft?.evidenceSummary,
            status: draft ? "drafted" : undefined,
            error: draft ? undefined : "No draft returned.",
          }
        }))
      } catch (e) {
        if (cancelled) return
        setErr(e instanceof Error ? e.message : String(e))
        setItems(rows.map((row) => ({
          sessionId: row.id,
          row,
          attemptId: row.evaluationAttemptId ?? row.review?.evaluationAttemptId,
          terminal: row.terminal === "HARD_STOP" ? "HARD_STOP" : "FAIL",
          message: "",
          error: "LLM draft failed; open row review or paste a final message before approval.",
        })))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [rows])

  function updateItem(sessionId: string, patch: Partial<BulkDraftItem>) {
    setItems((prev) => prev.map((item) => item.sessionId === sessionId ? { ...item, ...patch } : item))
  }

  async function approveAll() {
    const ready = items.filter((item) => item.attemptId && item.message.trim())
    if (ready.length === 0) {
      setErr("No selected session has both an attempt id and a final message.")
      return
    }
    setBusy(true)
    setErr(null)
    let failed = 0
    for (const item of ready) {
      try {
        await reviewEvaluationAttempt({
          attemptId: item.attemptId!,
          status: item.row.terminal === item.terminal ? "approved" : "overridden",
          finalOutcome: {
            kind: finalOutcomeKind(item.terminal),
            prescreenTerminal: item.terminal,
          },
          candidateMessageBody: item.message.trim(),
          ...(item.row.terminal === item.terminal ? {} : { correctionReason: "bulk_prescreen_reject_override" }),
        })
        updateItem(item.sessionId, { status: "queued", error: undefined })
      } catch (e) {
        failed += 1
        updateItem(item.sessionId, { error: e instanceof Error ? e.message : String(e) })
      }
    }
    setBusy(false)
    if (failed === 0) onDone()
    else setErr(`Bulk reject completed with ${failed} failure(s). Fix the failed rows or close and refresh.`)
  }

  return (
    <SideDrawer title="Bulk reject review" subtitle={`${rows.length} selected pending session(s)`} onClose={onClose} wide>
      {loading ? <LoadingState label="Drafting candidate messages..." /> : null}
      {err ? <div className="notice notice-bad" style={{ fontSize: "0.85em" }}>{err}</div> : null}
      <div style={{ display: "grid", gap: 12 }}>
        {items.map((item) => (
          <div key={item.sessionId} style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "monospace", fontSize: "0.8em" }}>{item.sessionId}</div>
                <div style={{ color: "#64748b", fontSize: "0.82em" }}>
                  {item.row.jobId} · user {item.row.userId?.slice(0, 8)}... · AI proposed {item.row.terminal ?? "IN_PROGRESS"}
                </div>
              </div>
              <Badge tone={item.status === "queued" ? "ok" : item.error ? "warn" : "info"}>
                {item.status === "queued" ? "queued" : item.error ? "needs edit" : "draft"}
              </Badge>
            </div>
            {item.evidenceSummary ? (
              <div style={{ color: "#334155", fontSize: "0.84em" }}>{item.evidenceSummary}</div>
            ) : null}
            <label style={labelStyle}>
              Final outcome
              <select
                value={item.terminal}
                onChange={(e) => updateItem(item.sessionId, { terminal: cleanReviewTerminal(e.target.value) ?? "FAIL" })}
                style={inputStyle}
              >
                <option value="FAIL">FAIL</option>
                <option value="HARD_STOP">HARD_STOP</option>
              </select>
            </label>
            <label style={labelStyle}>
              Candidate message
              <textarea
                value={item.message}
                onChange={(e) => updateItem(item.sessionId, { message: e.target.value })}
                rows={5}
                style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
              />
            </label>
            {item.error ? <div style={{ color: "#b91c1c", fontSize: "0.82em" }}>{item.error}</div> : null}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button type="button" onClick={() => void approveAll()} disabled={busy || loading}>
          {busy ? "Queuing..." : `Approve rejects and queue ${items.filter((i) => i.message.trim()).length} iMessage(s)`}
        </button>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </SideDrawer>
  )
}

function ReviewSummary({ detail }: { detail: ReviewDetail }) {
  const ratio = detail.session.scoreMax === 0 ? 0 : detail.session.score / detail.session.scoreMax
  const classification = classifyPrescreenReviewRow(detail.session)
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <Badge tone={terminalTone(detail.session.terminal)}>
          AI proposed {detail.session.terminal ?? "IN_PROGRESS"}
        </Badge>
        <StrictReviewBadge classification={classification} />
        <Badge tone={detail.session.terminalActionPendingReview ? "warn" : "muted"}>
          {reviewLabel(detail.session)}
        </Badge>
        <Badge tone="info">
          {detail.session.score?.toFixed(2)}/{detail.session.scoreMax?.toFixed(2)} ({(ratio * 100).toFixed(0)}%)
        </Badge>
      </div>
      <DrawerKV label="Job" value={detail.session.jobId} />
      <DrawerKV label="User" value={detail.session.userId} />
      <DrawerKV label="Attempt" value={detail.attempt?.attemptId ?? "missing"} />
      <DrawerKV label="Pending ack" value={detail.session.review?.pendingAckOutboundId ?? "not recorded"} />
      <div style={{ color: "#334155", fontSize: "0.86em", marginTop: 4 }}>
        <strong>Strict reasons:</strong> {classification.reasons.join("; ")}
      </div>
      {detail.attempt?.explanation ? (
        <div style={{ color: "#334155", fontSize: "0.88em", marginTop: 8 }}>{detail.attempt.explanation}</div>
      ) : null}
    </div>
  )
}

function TranscriptPreview({ turns }: { turns: PrescreenTurn[] }) {
  return (
    <div style={cardStyle}>
      <h3 style={{ margin: "0 0 8px", fontSize: "1em" }}>Transcript</h3>
      {turns.length === 0 ? <div style={{ color: "#64748b" }}>No candidate replies recorded.</div> : null}
      <div style={{ display: "grid", gap: 8 }}>
        {turns.slice(0, 8).map((turn) => (
          <div key={turn.id} style={{ borderTop: "1px solid rgba(0,0,0,0.08)", paddingTop: 8 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <Badge tone="info">{turn.qId}</Badge>
              {turn.action?.kind ? <Badge tone={turn.action.kind === "terminal" ? "warn" : "muted"}>{turn.action.kind}</Badge> : null}
              <span style={{ color: "#64748b", fontSize: "0.78em" }}>{turn.ts}</span>
            </div>
            <div style={{ marginTop: 4, overflowWrap: "anywhere" }}>{turn.reply}</div>
            {turn.scored?.aggregate?.summary ? (
              <div style={{ color: "#334155", fontSize: "0.84em", marginTop: 4 }}>
                {turn.scored.aggregate.summary}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function DrawerKV({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "90px minmax(0, 1fr)", gap: 8, fontSize: "0.85em" }}>
      <span style={{ color: "#64748b" }}>{label}</span>
      <code style={{ overflowWrap: "anywhere" }}>{value}</code>
    </div>
  )
}

function SideDrawer({
  title,
  subtitle,
  onClose,
  children,
  wide,
}: {
  title: string
  subtitle: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(45, 26, 10, 0.25)", zIndex: 100 }}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label={title}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          height: "100vh",
          width: wide ? "min(760px, 96vw)" : "min(560px, 96vw)",
          background: "var(--cream-3, #fff)",
          borderLeft: "1px solid var(--border, #e2e8f0)",
          boxShadow: "-12px 0 32px rgba(15, 23, 42, 0.18)",
          padding: 24,
          overflowY: "auto",
          zIndex: 110,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <p className="eyebrow" style={{ margin: 0 }}>Human review</p>
            <h2 style={{ margin: "2px 0 0", fontSize: "1.2em" }}>{title}</h2>
            <div style={{ color: "#64748b", fontFamily: "monospace", fontSize: "0.8em", overflowWrap: "anywhere" }}>
              {subtitle}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close drawer" style={{ fontSize: "1.1em" }}>
            x
          </button>
        </div>
        {children}
      </aside>
    </>
  )
}

const labelStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  fontSize: "0.88em",
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  fontSize: "0.9em",
  boxSizing: "border-box",
}

const cardStyle: CSSProperties = {
  border: "1px solid rgba(0,0,0,0.1)",
  borderRadius: 6,
  padding: 12,
  background: "#fff",
  display: "grid",
  gap: 8,
}
