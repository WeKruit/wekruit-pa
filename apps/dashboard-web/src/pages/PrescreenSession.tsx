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
import { Link, useParams } from "react-router-dom"
import { collection, doc, getDoc, getDocs, orderBy, query } from "firebase/firestore"
import { ErrorState, LoadingState, PageHeader, Panel, Badge } from "../components/ui.js"
import { db } from "../lib/firebase.js"

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
  if (t === null) return "info"
  return "warn"
}

export default function PrescreenSession() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [session, setSession] = useState<SessionDoc | null>(null)
  const [turns, setTurns] = useState<PrescreenTurn[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

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
        setSession({ ...(sessSnap.data() as SessionDoc), sessionId })
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
  }, [sessionId])

  if (loading) return <LoadingState label="Loading session..." />
  if (err) return <ErrorState message={err} />
  if (!session) return <ErrorState message="no session" />

  const ratio = session.scoreMax === 0 ? 0 : session.score / session.scoreMax

  return (
    <div>
      <PageHeader
        title={`Pre-screen Session: ${session.sessionId}`}
        description={`Job ${session.jobId} • User ${session.userId} • Created ${session.createdAt}`}
      />

      <Panel title="Summary">
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          <Badge tone={terminalTone(session.terminal)}>
            {session.terminal ?? "IN_PROGRESS"}
          </Badge>
          <Badge tone="info">
            score = {session.score.toFixed(2)} / {session.scoreMax.toFixed(2)} (ratio {(ratio * 100).toFixed(1)}%)
          </Badge>
          <Badge tone="info">threshold = {(session.threshold * 100).toFixed(0)}%</Badge>
        </div>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem", fontSize: "0.9em" }}>
          <Link to={`/admin/candidates/${session.userId}/profile`}>Open candidate marketplace profile</Link>
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
