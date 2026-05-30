/**
 * v1.8 Phase 79 — Pre-screen session detail page.
 *
 * Renders pa-prescreen-sessions/{sessionId} + its turns/ subcollection:
 *   - Header: jobId, userId, terminal state badge, score / scoreMax ratio
 *   - Per-Q timeline with expandable explanation cells (perKeyword[])
 *   - Terminal reason (server-only field — never shown to candidate)
 *
 * Read-only — writes go through Cloud Function paths. Firestore rules
 * (config/firebase/firestore.rules:pa-prescreen-sessions) enforce
 * operator-only read; candidates blocked.
 */
import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import { collection, doc, getDoc, getDocs, orderBy, query } from "firebase/firestore"
import { AdminJobLink, AdminPrescreenSessionLink, AdminUserLink } from "../components/AdminEntityLink.js"
import { ErrorState, LoadingState, PageHeader, Panel, Badge } from "../components/ui.js"
import { db } from "../lib/firebase.js"
import { reviewEvaluationAttempt } from "../lib/external-supply-client.js"
import type { EvaluationAttempt } from "@pa/core-types"

type PerKeyword = {
  keyword: string
  match: number
  confidence: number
  evidence: string
  reasoning: string
}

type ScoredAggregate = {
  s: number
  c: number
  summary: string
}

type PrescreenTurn = {
  id: string
  qId: string
  reply: string
  scored?: {
    perKeyword: PerKeyword[]
    aggregate: ScoredAggregate
    abortHint?: { kind: string; reason: string }
  }
  action?: { kind: string; reason?: string }
  ts: string
}

type SessionDoc = {
  sessionId: string
  userId: string
  jobId: string
  score: number
  scoreMax: number
  threshold: number
  terminal: string | null
  terminalReason?: string
  evaluationAttemptId?: string
  terminalActionPendingReview?: boolean
  review?: {
    status?: string
    evaluationAttemptId?: string
    proposedTerminal?: string
    finalTerminal?: string
    pendingAckOutboundId?: string
    decisionOutboundId?: string
    pendingAt?: string
    reviewedAt?: string
    candidateDecision?: {
      candidateMessageBody?: string
      decisionReason?: string
      recommendedActions?: string[]
      finalTerminal?: ReviewTerminal
      reviewedAt?: string
      decisionOutboundId?: string
    }
  }
  qOrder: string[]
  questions: Record<
    string,
    {
      qId: string
      type: "MUST_HAVE" | "PROBING" | "GOOD_TO_HAVE"
      weight: number
      finalS?: number
      finalC?: number
      clarifyRounds: number
      terminalCause?: string
    }
  >
  createdAt: string
  updatedAt: string
}

function terminalTone(t: string | null): "ok" | "warn" | "info" {
  if (t === "PASS") return "ok"
  if (t === "PAUSE") return "info"
  if (t === null) return "info"
  return "warn"
}

type ReviewTerminal = "PASS" | "FAIL" | "HARD_STOP"

function cleanReviewTerminal(value: unknown): ReviewTerminal | null {
  return value === "PASS" || value === "FAIL" || value === "HARD_STOP" ? value : null
}

function finalOutcomeKind(terminal: ReviewTerminal): "pass" | "reject" {
  return terminal === "PASS" ? "pass" : "reject"
}

function parseRecommendedActions(value: string): string[] {
  return value
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 5)
}

function defaultRecommendedActions(terminal: ReviewTerminal): string {
  if (terminal === "PASS") {
    return ["Watch for the next WeKruit message.", "Keep your profile details current."].join("\n")
  }
  return [
    "Keep your WeKruit profile active for stronger matches.",
    "Add a concrete example that shows the target experience.",
  ].join("\n")
}

export default function PrescreenSession() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [session, setSession] = useState<SessionDoc | null>(null)
  const [attempt, setAttempt] = useState<EvaluationAttempt | null>(null)
  const [turns, setTurns] = useState<PrescreenTurn[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selectedTerminal, setSelectedTerminal] = useState<ReviewTerminal>("PASS")
  const [candidateMessageBody, setCandidateMessageBody] = useState("")
  const [decisionReason, setDecisionReason] = useState("")
  const [recommendedActionsText, setRecommendedActionsText] = useState("")
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewSaved, setReviewSaved] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (!sessionId) {
      setErr("missing sessionId in route")
      setLoading(false)
      return () => {}
    }
    void (async () => {
      try {
        setLoading(true)
        const sessSnap = await getDoc(doc(db(), "pa-prescreen-sessions", sessionId))
        if (cancelled) return
        if (!sessSnap.exists()) {
          setErr(`session ${sessionId} not found`)
          return
        }
        const sessionData = { ...(sessSnap.data() as SessionDoc), sessionId }
        setSession(sessionData)
        setCandidateMessageBody(sessionData.review?.candidateDecision?.candidateMessageBody ?? "")
        setDecisionReason(sessionData.review?.candidateDecision?.decisionReason ?? "")
        const attemptId = sessionData.evaluationAttemptId ?? sessionData.review?.evaluationAttemptId
        if (attemptId) {
          const attemptSnap = await getDoc(doc(db(), "pa-evaluation-attempts", attemptId))
          if (cancelled) return
          if (attemptSnap.exists()) {
            const attemptData = attemptSnap.data() as EvaluationAttempt
            setAttempt(attemptData)
            const proposedTerminal = cleanReviewTerminal(attemptData.proposedOutcome?.prescreenTerminal)
            const terminal = proposedTerminal ?? cleanReviewTerminal(sessionData.terminal) ?? "PASS"
            setSelectedTerminal(terminal)
            setRecommendedActionsText((sessionData.review?.candidateDecision?.recommendedActions ?? []).join("\n") || defaultRecommendedActions(terminal))
          } else {
            setAttempt(null)
          }
        } else {
          setAttempt(null)
          const terminal = cleanReviewTerminal(sessionData.terminal) ?? "PASS"
          setSelectedTerminal(terminal)
          setRecommendedActionsText((sessionData.review?.candidateDecision?.recommendedActions ?? []).join("\n") || defaultRecommendedActions(terminal))
        }
        const turnsSnap = await getDocs(
          query(
            collection(db(), "pa-prescreen-sessions", sessionId, "turns"),
            orderBy("ts", "asc")
          )
        )
        if (cancelled) return
        setTurns(turnsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PrescreenTurn, "id">) })))
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, reloadKey])

  if (loading) return <LoadingState label="Loading session..." />
  if (err) return <ErrorState message={err} />
  if (!session) return <ErrorState message="no session" />

  const ratio = session.scoreMax === 0 ? 0 : session.score / session.scoreMax
  const pendingReview = session.terminalActionPendingReview === true
  const attemptTerminal = cleanReviewTerminal(attempt?.proposedOutcome?.prescreenTerminal)
  const canApproveReview = Boolean(
    pendingReview &&
      attempt?.attemptId &&
      selectedTerminal &&
      candidateMessageBody.trim().length > 0 &&
      decisionReason.trim().length > 0 &&
      parseRecommendedActions(recommendedActionsText).length > 0
  )

  async function approveReview() {
    if (!attempt?.attemptId || !pendingReview) return
    const body = candidateMessageBody.trim()
    if (!body) {
      setReviewError("Final candidate message is required.")
      return
    }
    const reason = decisionReason.trim()
    const recommendedActions = parseRecommendedActions(recommendedActionsText)
    if (!reason || recommendedActions.length === 0) {
      setReviewError("Decision reason and at least one recommended action are required.")
      return
    }
    setReviewBusy(true)
    setReviewError(null)
    setReviewSaved(null)
    try {
      const status = attemptTerminal === selectedTerminal ? "approved" : "overridden"
      const result = await reviewEvaluationAttempt({
        attemptId: attempt.attemptId,
        status,
        finalOutcome: {
          kind: finalOutcomeKind(selectedTerminal),
          prescreenTerminal: selectedTerminal,
        },
        candidateMessageBody: body,
        decisionReason: reason,
        recommendedActions,
        ...(status === "overridden" ? { correctionReason: "operator_changed_prescreen_terminal" } : {}),
      })
      setReviewSaved(result.candidateOutboundId ? `Queued outbound ${result.candidateOutboundId}` : "Review approved.")
      setReloadKey((key) => key + 1)
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : String(e))
    } finally {
      setReviewBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        title={`Pre-screen Session: ${session.sessionId}`}
        description={`Job ${session.jobId} • User ${session.userId} • Created ${session.createdAt}`}
      />

      <Panel title="Summary">
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          <Badge tone={terminalTone(session.terminal)}>
            Claire {session.terminal ?? "IN_PROGRESS"}
          </Badge>
          {pendingReview && <Badge tone="warn">Review pending</Badge>}
          {session.review?.status && !pendingReview && <Badge tone="info">Review {session.review.status}</Badge>}
          <Badge tone="info">
            score = {session.score.toFixed(2)} / {session.scoreMax.toFixed(2)} (ratio {(ratio * 100).toFixed(1)}%)
          </Badge>
          <Badge tone="info">threshold = {(session.threshold * 100).toFixed(0)}%</Badge>
        </div>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem", fontSize: "0.9em" }}>
          <AdminPrescreenSessionLink sessionId={session.sessionId}>Session {session.sessionId}</AdminPrescreenSessionLink>
          <AdminJobLink jobId={session.jobId}>Job {session.jobId}</AdminJobLink>
          <AdminUserLink userId={session.userId}>Candidate {session.userId}</AdminUserLink>
        </div>
        {session.terminalReason && (
          <div
            style={{
              padding: "0.5rem",
              background: "rgba(0,0,0,0.05)",
              borderRadius: 4,
              fontSize: "0.85em",
              fontFamily: "monospace",
            }}
          >
            <strong>Terminal reason (server-only, NOT shown to candidate):</strong>
            <br />
            {session.terminalReason}
          </div>
        )}
      </Panel>

      <Panel title="Human Review">
        {!session.evaluationAttemptId && !session.review?.evaluationAttemptId ? (
          <div style={{ color: "#64748b", fontSize: "0.9em" }}>No evaluation attempt is linked to this session.</div>
        ) : (
          <div style={{ display: "grid", gap: "0.75rem" }}>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
              <Badge tone={pendingReview ? "warn" : "info"}>
                {pendingReview ? "Review pending" : `Review ${session.review?.status ?? "recorded"}`}
              </Badge>
              {attempt?.attemptId && <Badge tone="info">{attempt.attemptId}</Badge>}
              {attemptTerminal && <Badge tone={terminalTone(attemptTerminal)}>Proposed {attemptTerminal}</Badge>}
            </div>
            {attempt?.explanation && (
              <div style={{ color: "#334155", fontSize: "0.9em", overflowWrap: "anywhere" }}>
                {attempt.explanation}
              </div>
            )}
            <div style={{ display: "grid", gap: "0.25rem", fontSize: "0.85em", color: "#334155" }}>
              {session.review?.pendingAckOutboundId ? (
                <div>
                  Pending acknowledgement outbound: <code>{session.review.pendingAckOutboundId}</code>
                </div>
              ) : pendingReview ? (
                <div style={{ color: "#92400e" }}>Pending acknowledgement outbound has not been recorded.</div>
              ) : null}
              {session.review?.decisionOutboundId ? (
                <div>
                  Final approved outbound: <code>{session.review.decisionOutboundId}</code>
                </div>
              ) : session.review?.status && !pendingReview ? (
                <div style={{ color: "#64748b" }}>No final outbound id recorded on this session.</div>
              ) : null}
            </div>
            {attempt?.dimensions?.length ? (
              <table style={{ width: "100%", fontSize: "0.82em", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>dimension</th>
                    <th>score</th>
                    <th>conf</th>
                    <th style={{ textAlign: "left" }}>rationale</th>
                  </tr>
                </thead>
                <tbody>
                  {attempt.dimensions.map((d) => (
                    <tr key={d.dimensionId}>
                      <td style={{ padding: "0.25rem" }}>{d.dimensionId}</td>
                      <td style={{ padding: "0.25rem", textAlign: "center" }}>{d.score}</td>
                      <td style={{ padding: "0.25rem", textAlign: "center" }}>{d.confidence.toFixed(2)}</td>
                      <td style={{ padding: "0.25rem" }}>{d.rationale}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {pendingReview && attempt?.attemptId ? (
              <div style={{ display: "grid", gap: "0.5rem" }}>
                <label style={{ display: "grid", gap: "0.25rem", fontSize: "0.9em" }}>
                  Final outcome
                  <select
                    value={selectedTerminal}
                    onChange={(e) => setSelectedTerminal(cleanReviewTerminal(e.target.value) ?? "FAIL")}
                    style={{ maxWidth: 240, padding: "0.4rem" }}
                  >
                    <option value="PASS">PASS</option>
                    <option value="FAIL">FAIL</option>
                    <option value="HARD_STOP">HARD_STOP</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: "0.25rem", fontSize: "0.9em" }}>
                  Final candidate message
                  <textarea
                    value={candidateMessageBody}
                    onChange={(e) => setCandidateMessageBody(e.target.value)}
                    rows={5}
                    placeholder="Write the exact iMessage WeKruit should send after approval."
                    style={{ width: "100%", padding: "0.5rem", fontFamily: "inherit" }}
                  />
                </label>
                <label style={{ display: "grid", gap: "0.25rem", fontSize: "0.9em" }}>
                  Candidate-visible decision reason
                  <textarea
                    value={decisionReason}
                    onChange={(e) => setDecisionReason(e.target.value)}
                    rows={3}
                    placeholder="One evidence-backed reason candidates can see."
                    style={{ width: "100%", padding: "0.5rem", fontFamily: "inherit" }}
                  />
                </label>
                <label style={{ display: "grid", gap: "0.25rem", fontSize: "0.9em" }}>
                  Candidate-visible recommended actions
                  <textarea
                    value={recommendedActionsText}
                    onChange={(e) => setRecommendedActionsText(e.target.value)}
                    rows={4}
                    placeholder="One action per line."
                    style={{ width: "100%", padding: "0.5rem", fontFamily: "inherit" }}
                  />
                </label>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    disabled={!canApproveReview || reviewBusy}
                    onClick={() => void approveReview()}
                  >
                    {reviewBusy ? "Approving..." : "Approve and queue outbound"}
                  </button>
                  {reviewError && <span style={{ color: "#b91c1c", fontSize: "0.85em" }}>{reviewError}</span>}
                  {reviewSaved && <span style={{ color: "#166534", fontSize: "0.85em" }}>{reviewSaved}</span>}
                </div>
              </div>
            ) : session.review?.decisionOutboundId ? (
              <div style={{ fontSize: "0.9em", color: "#334155" }}>
                Approved outbound: <code>{session.review.decisionOutboundId}</code>
                {session.review.candidateDecision?.decisionReason ? (
                  <div style={{ marginTop: "0.5rem" }}>
                    <strong>Candidate decision:</strong> {session.review.candidateDecision.decisionReason}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </Panel>

      <Panel title={`Transcript (${turns.length})`}>
        {turns.length === 0 ? (
          <div style={{ color: "#64748b" }}>No candidate replies recorded for this session yet.</div>
        ) : (
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {turns.map((t) => (
              <div
                key={t.id}
                style={{
                  border: "1px solid rgba(0,0,0,0.1)",
                  borderRadius: 6,
                  padding: "0.75rem",
                  background: "#fff",
                }}
              >
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                  <Badge tone="info">{t.qId}</Badge>
                  {t.action?.kind && <Badge tone={t.action.kind === "terminal" ? "warn" : "info"}>{t.action.kind}</Badge>}
                  <span style={{ color: "#64748b", fontSize: "0.82em" }}>{t.ts}</span>
                </div>
                <div style={{ marginTop: "0.5rem", overflowWrap: "anywhere" }}>{t.reply}</div>
                {t.scored && (
                  <div style={{ marginTop: "0.5rem", color: "#334155", fontSize: "0.9em" }}>
                    score {t.scored.aggregate.s.toFixed(2)} / confidence {t.scored.aggregate.c.toFixed(2)} —{" "}
                    {t.scored.aggregate.summary}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Per-Question Breakdown">
        {session.qOrder.map((qId) => {
          const qState = session.questions[qId]
          const qTurns = turns.filter((t) => t.qId === qId)
          const isExpanded = expanded[qId] ?? false
          return (
            <div
              key={qId}
              style={{
                marginBottom: "0.5rem",
                border: "1px solid rgba(0,0,0,0.1)",
                borderRadius: 4,
                padding: "0.5rem",
              }}
            >
              <div
                onClick={() => setExpanded((p) => ({ ...p, [qId]: !p[qId] }))}
                style={{ cursor: "pointer", display: "flex", gap: "0.5rem", alignItems: "center" }}
              >
                <strong>{qId}</strong>
                <Badge tone={qState.type === "MUST_HAVE" ? "warn" : qState.type === "PROBING" ? "info" : "ok"}>
                  {qState.type}
                </Badge>
                <span style={{ fontSize: "0.85em" }}>weight {qState.weight}</span>
                {qState.finalS !== undefined && (
                  <>
                    <span style={{ fontSize: "0.85em" }}>
                      s = {qState.finalS.toFixed(2)}, c = {(qState.finalC ?? 0).toFixed(2)}
                    </span>
                    {qState.terminalCause && (
                      <Badge tone="warn">{qState.terminalCause}</Badge>
                    )}
                  </>
                )}
                {qState.clarifyRounds > 0 && (
                  <Badge tone="info">k = {qState.clarifyRounds}</Badge>
                )}
                <span style={{ marginLeft: "auto", fontSize: "0.8em", opacity: 0.6 }}>
                  {isExpanded ? "▼" : "▶"} {qTurns.length} turn{qTurns.length === 1 ? "" : "s"}
                </span>
              </div>
              {isExpanded && (
                <div style={{ marginTop: "0.5rem" }}>
                  {qTurns.map((t) => (
                    <div
                      key={t.id}
                      style={{
                        marginTop: "0.5rem",
                        paddingLeft: "0.75rem",
                        borderLeft: "3px solid rgba(0,123,255,0.4)",
                      }}
                    >
                      <div style={{ fontSize: "0.85em", fontStyle: "italic", opacity: 0.85 }}>
                        candidate reply: "{t.reply}"
                      </div>
                      {t.scored && (
                        <>
                          <div style={{ fontSize: "0.85em", marginTop: "0.25rem" }}>
                            <strong>aggregate:</strong> s={t.scored.aggregate.s.toFixed(2)}, c=
                            {t.scored.aggregate.c.toFixed(2)} — {t.scored.aggregate.summary}
                          </div>
                          {t.scored.abortHint && (
                            <div style={{ fontSize: "0.85em" }}>
                              <Badge tone="warn">abort: {t.scored.abortHint.kind}</Badge>
                              <span style={{ marginLeft: "0.5rem" }}>{t.scored.abortHint.reason}</span>
                            </div>
                          )}
                          <table
                            style={{ width: "100%", fontSize: "0.8em", marginTop: "0.25rem" }}
                          >
                            <thead>
                              <tr>
                                <th style={{ textAlign: "left" }}>keyword</th>
                                <th>match</th>
                                <th>conf</th>
                                <th style={{ textAlign: "left" }}>evidence</th>
                                <th style={{ textAlign: "left" }}>reasoning</th>
                              </tr>
                            </thead>
                            <tbody>
                              {t.scored.perKeyword.map((k, i) => (
                                <tr key={i}>
                                  <td>{k.keyword}</td>
                                  <td style={{ textAlign: "center" }}>{k.match.toFixed(2)}</td>
                                  <td style={{ textAlign: "center" }}>{k.confidence.toFixed(2)}</td>
                                  <td style={{ fontStyle: "italic" }}>"{k.evidence}"</td>
                                  <td style={{ opacity: 0.8 }}>{k.reasoning}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </>
                      )}
                      {t.action && (
                        <div style={{ fontSize: "0.8em", marginTop: "0.25rem", opacity: 0.7 }}>
                          → {t.action.kind}
                          {t.action.reason ? `: ${t.action.reason}` : ""}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </Panel>
    </div>
  )
}
