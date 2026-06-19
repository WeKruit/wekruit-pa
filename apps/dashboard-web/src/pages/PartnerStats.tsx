import { useEffect, useState, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import {
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"
import {
  PARTNER_STATS_CALLABLE,
  SET_AWAITING_HM_CALLABLE,
  formatDate,
  stageLabel,
  stageTone,
  type PartnerStatsSnapshot,
  type PartnerStatsUserRow,
  type StageFilter,
} from "./PartnerStats.helpers.js"

async function loadPartnerStats(partnerSource?: string): Promise<PartnerStatsSnapshot> {
  const [{ httpsCallable }, firebase] = await Promise.all([
    import("firebase/functions"),
    import("../lib/firebase.js"),
  ])
  const fn = httpsCallable<{ partnerSource?: string }, PartnerStatsSnapshot>(
    firebase.functions(),
    PARTNER_STATS_CALLABLE,
  )
  const result = await fn({ partnerSource })
  return result.data
}

async function setAwaitingHm(candidateJobStateId: string, value: boolean): Promise<void> {
  const [{ httpsCallable }, firebase] = await Promise.all([
    import("firebase/functions"),
    import("../lib/firebase.js"),
  ])
  const fn = httpsCallable(firebase.functions(), SET_AWAITING_HM_CALLABLE)
  await fn({ candidateJobStateId, awaitingHmResponse: value })
}

function FunnelCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className={`funnel-card ${tone ?? ""}`}>
      <div className="funnel-card__value">{value}</div>
      <div className="funnel-card__label">{label}</div>
    </div>
  )
}

function StageBadge({ stage }: { stage: string }) {
  const tone = stageTone(stage)
  const cls = tone === "good" ? "good" : tone === "bad" ? "bad" : tone === "warn" ? "warn" : "muted"
  return <span className={`status-badge ${cls}`}>{stageLabel(stage)}</span>
}

function AttributionBadge({ via }: { via: string }) {
  const cls = via === "both" ? "good" : via === "top_level" ? "muted" : "warn"
  return <span className={`status-badge ${cls}`}>{via.replace(/_/g, " ")}</span>
}

function UserRow({ user, onViewUser, onToggleHm }: {
  user: PartnerStatsUserRow
  onViewUser: (id: string) => void
  onToggleHm: (userId: string, jobId: string, value: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <tr className="partner-row" onClick={() => setExpanded(!expanded)} style={{ cursor: "pointer" }}>
        <td>
          <div style={{ fontWeight: 500 }}>{user.displayName ?? "—"}</div>
          <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>{user.email}</div>
        </td>
        <td><StageBadge stage={user.currentStage} /></td>
        <td>{user.hasResume ? "Yes" : "No"}</td>
        <td>{user.roleFunction.join(", ").replace(/_/g, " ") || "—"}</td>
        <td>{user.careerStage?.replace(/_/g, " ") ?? "—"}</td>
        <td>{user.yoeRange ?? "—"}</td>
        <td><AttributionBadge via={user.attributedVia} /></td>
        <td>{formatDate(user.registeredAt)}</td>
        <td>{user.jobs.length}</td>
        <td>
          <button
            type="button"
            className="btn btn--sm"
            onClick={(e) => { e.stopPropagation(); onViewUser(user.userId) }}
          >
            View
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="partner-row-detail">
          <td colSpan={10}>
            <div style={{ padding: "0.5rem 0" }}>
              <div style={{ marginBottom: "0.4rem" }}>
                <strong>Skills:</strong> {user.topSkills.length ? user.topSkills.join(", ") : "—"}
              </div>
              <div style={{ marginBottom: "0.4rem" }}>
                <strong>Source:</strong> {user.source ?? "—"} &nbsp;|&nbsp;
                <strong>Entry source:</strong> {user.entrySource ?? "—"} &nbsp;|&nbsp;
                <strong>Entry job:</strong> {user.entryJobId ?? "—"}
              </div>
              {user.jobs.length > 0 && (
                <table style={{ width: "100%", fontSize: "0.85rem", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>Job</th>
                      <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>Company</th>
                      <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>State</th>
                      <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>Updated</th>
                      <th style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {user.jobs.map((j) => {
                      const isAwaitingHm = j.reviewStatus === "awaiting_hm_response"
                      const canToggle = j.state === "prescreen_review_pending"
                      return (
                        <tr key={j.jobId}>
                          <td style={{ padding: "0.2rem 0.5rem" }}>{j.jobTitle}</td>
                          <td style={{ padding: "0.2rem 0.5rem" }}>{j.company}</td>
                          <td style={{ padding: "0.2rem 0.5rem" }}>
                            <StageBadge stage={isAwaitingHm ? "awaiting_hm_response" : j.state} />
                          </td>
                          <td style={{ padding: "0.2rem 0.5rem" }}>{formatDate(j.stateUpdatedAt)}</td>
                          <td style={{ padding: "0.2rem 0.5rem" }}>
                            {canToggle && (
                              <button
                                type="button"
                                className="btn btn--sm"
                                style={{ fontSize: "0.75rem" }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onToggleHm(user.userId, j.jobId, !isAwaitingHm)
                                }}
                              >
                                {isAwaitingHm ? "Unmark HM" : "Awaiting HM"}
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export default function PartnerStats() {
  const navigate = useNavigate()
  const [snapshot, setSnapshot] = useState<PartnerStatsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedPartner, setSelectedPartner] = useState<string>("layoffhedge")
  const [stageFilter, setStageFilter] = useState<StageFilter>("all")

  const load = useCallback((partner: string) => {
    setLoading(true)
    setError(null)
    void loadPartnerStats(partner)
      .then(setSnapshot)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(selectedPartner) }, [selectedPartner, load])

  const handleToggleHm = useCallback(async (userId: string, jobId: string, value: boolean) => {
    const stateId = `${userId}__${jobId}`
    try {
      await setAwaitingHm(stateId, value)
      load(selectedPartner)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }, [selectedPartner, load])

  const filteredUsers = snapshot?.users.filter(
    (u) => stageFilter === "all" || u.currentStage === stageFilter,
  ) ?? []

  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error} />

  const f = snapshot!.funnel

  return (
    <div className="page-stack">
      <PageHeader
        title="Partner stats"
        description="Referral funnel and candidate pipeline per partner source"
        actions={
          <select
            value={selectedPartner}
            onChange={(e) => setSelectedPartner(e.target.value)}
            style={{ padding: "0.4rem 0.8rem", borderRadius: 6, border: "1px solid var(--ink-6, #ccc)" }}
          >
            {(snapshot?.allPartnerSources ?? [selectedPartner]).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        }
      />

      <Panel title="Funnel">
        <div className="funnel-grid">
          <FunnelCard label="Signed up" value={f.signedUp} />
          <FunnelCard label="Submitted resume" value={f.withResume} />
          <FunnelCard label="Have skills parsed" value={f.withSkills} />
          <FunnelCard label="Entered job flow" value={f.enteredJobFlow} />
          <FunnelCard label="Interviewing" value={f.prescreenStarted} tone="warn" />
          <FunnelCard label="Under review" value={f.prescreenReviewPending} tone="warn" />
          <FunnelCard label="Awaiting HM" value={f.awaitingHmResponse} tone="warn" />
          <FunnelCard label="Passed" value={f.passed} tone="good" />
          <FunnelCard label="Not passed" value={f.notPassed} tone="bad" />
          <FunnelCard label="Employer visible" value={f.employerVisible} tone="good" />
        </div>
      </Panel>

      <Panel
        title={`Candidates (${filteredUsers.length})`}
        actions={
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value as StageFilter)}
            style={{ padding: "0.3rem 0.6rem", borderRadius: 6, border: "1px solid var(--ink-6, #ccc)", fontSize: "0.85rem" }}
          >
            <option value="all">All stages</option>
            <option value="signed_up">Signed up</option>
            <option value="resume_submitted">Resume submitted</option>
            <option value="interviewing">Interviewing</option>
            <option value="review_pending">Under review</option>
            <option value="awaiting_hm_response">Awaiting HM</option>
            <option value="passed">Passed</option>
            <option value="not_passed">Not passed</option>
            <option value="employer_visible">Employer visible</option>
          </select>
        }
      >
        {filteredUsers.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", opacity: 0.6 }}>
            No candidates in this filter.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Stage</th>
                  <th>Resume</th>
                  <th>Role</th>
                  <th>Level</th>
                  <th>YoE</th>
                  <th>Attribution</th>
                  <th>Registered</th>
                  <th>Jobs</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((u) => (
                  <UserRow
                    key={u.userId}
                    user={u}
                    onViewUser={(id) => navigate(`/users/${id}`)}
                    onToggleHm={handleToggleHm}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <style>{`
        .funnel-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
          gap: 0.75rem;
          padding: 0.5rem 0;
        }
        .funnel-card {
          background: var(--surface-2, #f8f8f6);
          border-radius: 8px;
          padding: 1rem;
          text-align: center;
          border: 1px solid var(--ink-6, #e8e6e0);
        }
        .funnel-card.good { border-left: 3px solid var(--green, #22c55e); }
        .funnel-card.warn { border-left: 3px solid var(--amber, #f59e0b); }
        .funnel-card.bad { border-left: 3px solid var(--red, #ef4444); }
        .funnel-card__value {
          font-size: 1.8rem;
          font-weight: 700;
          line-height: 1.2;
          color: var(--ink-1, #1a1918);
        }
        .funnel-card__label {
          font-size: 0.78rem;
          color: var(--ink-3, #6b6966);
          margin-top: 0.25rem;
        }
        .partner-row:hover { background: var(--surface-2, #f8f8f6); }
        .partner-row-detail td {
          background: var(--surface-2, #f8f8f6);
          border-top: none;
        }
      `}</style>
    </div>
  )
}
