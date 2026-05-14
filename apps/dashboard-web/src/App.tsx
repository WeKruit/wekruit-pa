import { getRedirectResult, onAuthStateChanged, signOut } from "firebase/auth"
import { useEffect, useState } from "react"
import { Navigate, NavLink, Route, Routes } from "react-router-dom"
import { AgentBuilder } from "./pages/AgentBuilder.js"
import Legal from "./pages/Legal.js"
import { Login } from "./pages/Login.js"
import { Operations } from "./pages/Operations.js"
import { Overview } from "./pages/Overview.js"
import { UserDetail } from "./pages/UserDetail.js"
import { Users } from "./pages/Users.js"
import { Abuse } from "./pages/Abuse.js"
import { Beta } from "./pages/Beta.js"
import { Flags } from "./pages/Flags.js"
import { Handbook } from "./pages/Handbook.js"
import { Onboarding } from "./pages/Onboarding.js"
import { OnboardingQuestions } from "./pages/OnboardingQuestions.js"
import { Playbooks } from "./pages/Playbooks.js"
import { Personas } from "./pages/Personas.js"
import { Triggers } from "./pages/Triggers.js"
import { UpstreamTemplates } from "./pages/UpstreamTemplates.js"
import { DownstreamTriggers } from "./pages/DownstreamTriggers.js"
import { VoiceReview } from "./pages/VoiceReview.js"
import { NRoundSim } from "./pages/NRoundSim.js"
import { MatchCandidates } from "./pages/MatchCandidates.js"
import CandidateProfile from "./pages/CandidateProfile.js"
// iter30/WS8 — biz-demo Wave 2 — full match-* admin surface.
import { MatchWeights } from "./pages/MatchWeights.js"
import { MatchWeightsTest } from "./pages/MatchWeightsTest.js"
import { MatchExplainerHistory } from "./pages/MatchExplainerHistory.js"
import { MatchExplainerTest } from "./pages/MatchExplainerTest.js"
// v1.6 Phase 59 (DASH-01..04) — canonical-tags vocab browser/promote +
// QA evaluator weekly run viewer.
import { CanonicalTags } from "./pages/CanonicalTags.js"
import { QaEvaluator } from "./pages/QaEvaluator.js"
import FlywheelEval from "./pages/FlywheelEval.js"
import LaunchReadiness from "./pages/LaunchReadiness.js"
// v1.7 Phase 70 (MATCHDEBUG-01..04) — admin live debugger for the V16 cascade
// with score-weight sandbox sliders. Backed by paAdminMatchDebug callable.
import { MatchDebug } from "./pages/MatchDebug.js"
// v1.8 Phase 78 — Job pre-screen config editor.
import JobPrescreen from "./pages/JobPrescreen.js"
import { JobEnrichmentReview } from "./pages/JobEnrichmentReview.js"
// v1.8 Phase 79 — Pre-screen session detail + tag-snapshot rollback.
import PrescreenSession from "./pages/PrescreenSession.js"
import TagSnapshots from "./pages/TagSnapshots.js"
import PrescreenSessionsList from "./pages/PrescreenSessionsList.js"
// v1.9 Phase 86 — ATS inbound dashboard.
import AtsInbound from "./pages/AtsInbound.js"
import BulkResumes from "./pages/BulkResumes.js"
import { IdentityConflicts } from "./pages/IdentityConflicts.js"
// v1.9 Phase 88 — Sendblue number pool admin.
import SendbluePool from "./pages/SendbluePool.js"
// v2.0 S6 - admin outreach readiness snapshot.
import OutreachOps from "./pages/OutreachOps.js"
// v2.0 S7 - job-scoped passed candidate snapshots.
import PassedCandidates from "./pages/PassedCandidates.js"
// v1.9 Phase 89 — pre-screen feedback aggregate.
import PrescreenFeedback from "./pages/PrescreenFeedback.js"
// v2.0 External Supply V1 — Wave D admin surfaces (Landing, BatchNew,
// BatchDetail, Review, Evaluations, EvaluationDetail, Research, Outreach,
// Sync, Audit). All routes live under /admin/external-supply/**.
import { Landing as ExternalSupplyLanding } from "./pages/external-supply/Landing.js"
import { BatchNew as ExternalSupplyBatchNew } from "./pages/external-supply/BatchNew.js"
import { BatchDetail as ExternalSupplyBatchDetail } from "./pages/external-supply/BatchDetail.js"
import { BatchCandidates as ExternalSupplyBatchCandidates } from "./pages/external-supply/BatchCandidates.js"
import { Review as ExternalSupplyReview } from "./pages/external-supply/Review.js"
import { Evaluations as ExternalSupplyEvaluations } from "./pages/external-supply/Evaluations.js"
import { EvaluationDetail as ExternalSupplyEvaluationDetail } from "./pages/external-supply/EvaluationDetail.js"
import { Research as ExternalSupplyResearch } from "./pages/external-supply/Research.js"
import { Outreach as ExternalSupplyOutreach } from "./pages/external-supply/Outreach.js"
import { Sync as ExternalSupplySync } from "./pages/external-supply/Sync.js"
import { Audit as ExternalSupplyAudit } from "./pages/external-supply/Audit.js"
// v2.0 External Supply V2 — Wave D dashboard UX — agent-ranking review surface.
import { EvaluationAgentRanking as ExternalSupplyEvaluationAgentRanking } from "./pages/external-supply/EvaluationAgentRanking.js"
// Post-V2 hotfix 2026-05-14 — per-company / per-job sourcing entry surface.
import { Jobs as ExternalSupplyJobs } from "./pages/external-supply/Jobs.js"

// v1.8 — collapsible sidebar section. Persists open/closed to localStorage.
function NavSection({
  id,
  label,
  children,
  defaultOpen,
  dim,
}: {
  id: string
  label: string
  children: React.ReactNode
  defaultOpen?: boolean
  dim?: boolean
}) {
  const storageKey = `nav-section-${id}`
  const stored = typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null
  const initial = stored === null ? !!defaultOpen : stored === "open"
  const [open, setOpen] = useState(initial)
  const handleToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const next = (e.currentTarget as HTMLDetailsElement).open
    setOpen(next)
    try {
      window.localStorage.setItem(storageKey, next ? "open" : "closed")
    } catch { /* ignore */ }
  }
  return (
    <details
      className="nav-section"
      open={open}
      onToggle={handleToggle}
      style={dim ? { opacity: 0.65 } : undefined}
    >
      <summary
        className="nav-section-label"
        style={{
          cursor: "pointer",
          userSelect: "none",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          gap: "0.4em",
        }}
      >
        <span style={{ fontSize: "0.7em", opacity: 0.6, transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "none" }}>▶</span>
        {label}
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        {children}
      </div>
    </details>
  )
}
import { auth } from "./lib/firebase.js"

export default function App() {
  const [user, setUser] = useState<unknown | null>(undefined)
  const [redirectHandled, setRedirectHandled] = useState(false)

  // Consume Google redirect *before* routing (avoids redirect / sign-in races)
  useEffect(() => {
    getRedirectResult(auth())
      .catch((e) => {
        console.warn("[auth] getRedirectResult", e)
      })
      .finally(() => {
        setRedirectHandled(true)
      })
  }, [])

  useEffect(() => {
    return onAuthStateChanged(auth(), setUser)
  }, [])

  if (!redirectHandled || user === undefined) {
    return <div className="panel">Loading…</div>
  }

  if (!user) {
    return (
      <Routes>
        {/* iter31 — public privacy + terms route. Linked from onboarding ToS
            prompt sent over iMessage; biz testers tap through before signing
            in to the dashboard, so it must render outside the auth wall. */}
        <Route path="/legal" element={<Legal />} />
        <Route path="*" element={<Login />} />
      </Routes>
    )
  }

  return (
    <div className="layout">
      <nav className="side-nav">
        <div className="brand-lockup">
          <span>WK</span>
          <strong>PA Console</strong>
        </div>

        {/* v1.8 — collapsible sidebar via <details>/<summary>. Persists
            open/closed state to localStorage so it survives reloads. Each
            section's `open` attribute is read on mount + toggle saves. */}
        <NavSection id="prescreen" label="Pre-Screen" defaultOpen={true}>
          <NavLink to="/admin/job-prescreen">Jobs · Config</NavLink>
          <NavLink to="/admin/job-enrichment">Job Enrichment</NavLink>
          <NavLink to="/admin/prescreen-sessions">Sessions</NavLink>
          <NavLink to="/admin/ats-inbound">ATS Inbound</NavLink>
          <NavLink to="/admin/bulk-resumes">Bulk Resumes</NavLink>
          <NavLink to="/admin/prescreen-feedback">Feedback</NavLink>
        </NavSection>
        <NavSection id="monitor" label="Monitor" defaultOpen={true}>
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/conversations">Conversations</NavLink>
          <NavLink to="/abuse">Abuse</NavLink>
        </NavSection>
        <NavSection id="agent" label="Agent" defaultOpen={false}>
          <NavLink to="/agents">Agents</NavLink>
          <NavLink to="/admin/handbook">Handbook</NavLink>
          <NavLink to="/admin/onboarding-questions">Onboarding Qs</NavLink>
          <NavLink to="/agent/playbooks">Playbooks</NavLink>
          <NavLink to="/agent/personas">Personas</NavLink>
        </NavSection>
        <NavSection id="match" label="Match" defaultOpen={false}>
          <NavLink to="/admin/match-debug">Match Debug</NavLink>
          <NavLink to="/match/candidates">Candidates</NavLink>
          <NavLink to="/admin/passed-candidates">Passed Candidates</NavLink>
          <NavLink to="/admin/identity-conflicts">Identity Conflicts</NavLink>
        </NavSection>
        <NavSection id="eval" label="Eval" defaultOpen={false}>
          <NavLink to="/eval/voice-review">Voice Review</NavLink>
          <NavLink to="/eval/n-round-sim">N-Round Sim</NavLink>
          <NavLink to="/admin/flywheel-eval">Flywheel Eval</NavLink>
        </NavSection>
        <NavSection id="external-supply" label="External Supply" defaultOpen={false}>
          <NavLink to="/admin/external-supply" end>Landing</NavLink>
          <NavLink to="/admin/external-supply/jobs">Jobs by company</NavLink>
          <NavLink to="/admin/external-supply/batches/new">New batch</NavLink>
          <NavLink to="/admin/external-supply/review">Review queue</NavLink>
          <NavLink to="/admin/external-supply/evaluations">Evaluations</NavLink>
          <NavLink to="/admin/external-supply/research">Agent research</NavLink>
          <NavLink to="/admin/external-supply/outreach">Outreach</NavLink>
          <NavLink to="/admin/external-supply/sync">Instantly sync</NavLink>
          <NavLink to="/admin/external-supply/audit">Audit</NavLink>
        </NavSection>
        <NavSection id="integrations" label="Integrations" defaultOpen={false}>
          <NavLink to="/admin/upstream-templates">Upstream Templates</NavLink>
          <NavLink to="/admin/downstream-triggers">Downstream Triggers</NavLink>
          <NavLink to="/beta">Beta Allowlist</NavLink>
          <NavLink to="/triggers">Triggers</NavLink>
          <NavLink to="/admin/outreach-ops">Outreach Ops</NavLink>
          <NavLink to="/admin/sendblue-pool">Sendblue Pool</NavLink>
        </NavSection>
        <NavSection id="platform" label="Platform" defaultOpen={false}>
          <NavLink to="/admin/flags">Flags</NavLink>
          <NavLink to="/admin/canonical-tags">Canonical Tags</NavLink>
          <NavLink to="/admin/qa-evaluator">QA Evaluator</NavLink>
          <NavLink to="/admin/launch-readiness">Launch Readiness</NavLink>
        </NavSection>
        <NavSection id="legacy" label="Legacy / advanced" defaultOpen={false} dim>
          <NavLink to="/admin/onboarding">Onboarding (legacy)</NavLink>
          <NavLink to="/match/weights">Match Weights</NavLink>
          <NavLink to="/match/weights/test">Weights · Dry Run</NavLink>
          <NavLink to="/match/explainer-history">Explainer History</NavLink>
          <NavLink to="/match/explainer-test">Explainer Test</NavLink>
        </NavSection>

        <button
          type="button"
          onClick={() => signOut(auth())}
          className="sign-out"
        >
          Sign out
        </button>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/conversations" element={<Users />} />
          <Route path="/users/:id" element={<UserDetail />} />
          <Route path="/agents" element={<AgentBuilder />} />
          {/* Phase 32 Wave 1 — Operations no longer in sidebar; reachable via
              Overview "View ops queue" link + UserDetail "Debug ops" footer. */}
          <Route path="/operations" element={<Operations />} />
          {/* Phase 32 Wave 1 — /platform standalone page deleted; kill switch +
              model override merged into /admin/flags as "Platform Controls". */}
          <Route path="/platform" element={<Navigate to="/admin/flags" replace />} />
          <Route path="/beta" element={<Beta />} />
          <Route path="/abuse" element={<Abuse />} />
          <Route path="/triggers" element={<Triggers />} />
          <Route path="/admin/flags" element={<Flags />} />
          {/* v1.6 Phase 59 (DASH-01..03) — canonical-tags + QA evaluator. */}
          <Route path="/admin/canonical-tags" element={<CanonicalTags />} />
          <Route path="/admin/qa-evaluator" element={<QaEvaluator />} />
          <Route path="/admin/launch-readiness" element={<LaunchReadiness />} />
          <Route path="/admin/handbook" element={<Handbook />} />
          <Route path="/admin/onboarding" element={<Onboarding />} />
          <Route
            path="/admin/onboarding-questions"
            element={<OnboardingQuestions />}
          />
          <Route path="/admin/upstream-templates" element={<UpstreamTemplates />} />
          <Route path="/admin/downstream-triggers" element={<DownstreamTriggers />} />
          {/* Phase 32 Wave 2c — /voice split into /eval/voice-review +
              /eval/n-round-sim. Old /voice URL redirects for back-compat. */}
          <Route path="/voice" element={<Navigate to="/eval/voice-review" replace />} />
          <Route path="/eval/voice-review" element={<VoiceReview />} />
          <Route path="/eval/n-round-sim" element={<NRoundSim />} />
          <Route path="/admin/flywheel-eval" element={<FlywheelEval />} />
          {/* Phase 49 (v1.5 Stream-H D9) — operator reverse-match dashboard. Admin-only;
              CF gates on paReverseMatchEnabled flag (default OFF). */}
          <Route path="/match/candidates" element={<MatchCandidates />} />
          <Route path="/admin/candidates/:candidateId/profile" element={<CandidateProfile />} />
          <Route path="/admin/identity-conflicts" element={<IdentityConflicts />} />
          {/* iter30/WS8 Wave 2 — biz-demo match admin surface. */}
          <Route path="/match/weights" element={<MatchWeights />} />
          <Route path="/match/weights/test" element={<MatchWeightsTest />} />
          <Route
            path="/match/explainer-history"
            element={<MatchExplainerHistory />}
          />
          <Route path="/match/explainer-test" element={<MatchExplainerTest />} />
          {/* v1.7 Phase 70 (MATCHDEBUG-01..04) — V16 live debugger. */}
          <Route path="/admin/match-debug" element={<MatchDebug />} />
          <Route path="/admin/passed-candidates" element={<PassedCandidates />} />
          {/* v1.8 Phase 78 — Job pre-screen config editor. */}
          <Route path="/admin/jobs/:jobId/prescreen" element={<JobPrescreen />} />
          <Route path="/admin/job-prescreen" element={<JobPrescreen />} />
          {/* v2.0 S4 — admin-only job enrichment draft review. */}
          <Route path="/admin/job-enrichment" element={<JobEnrichmentReview />} />
          {/* v1.8 Phase 79 — Session list + detail + tag-snapshot rollback. */}
          <Route path="/admin/prescreen-sessions" element={<PrescreenSessionsList />} />
          <Route path="/admin/prescreen-sessions/:sessionId" element={<PrescreenSession />} />
          <Route path="/admin/users/:uid/tag-snapshots" element={<TagSnapshots />} />
          {/* v1.9 Phase 86 — ATS inbound funnel observability. */}
          <Route path="/admin/ats-inbound" element={<AtsInbound />} />
          <Route path="/admin/bulk-resumes" element={<BulkResumes />} />
          <Route path="/admin/outreach-ops" element={<OutreachOps />} />
          {/* v1.9 Phase 88 — Sendblue number pool admin. */}
          <Route path="/admin/sendblue-pool" element={<SendbluePool />} />
          {/* v1.9 Phase 89 — pre-screen feedback aggregate. */}
          <Route path="/admin/prescreen-feedback" element={<PrescreenFeedback />} />
          {/* v2.0 External Supply V1 — Wave D admin surfaces. */}
          <Route path="/admin/external-supply" element={<ExternalSupplyLanding />} />
          <Route path="/admin/external-supply/jobs" element={<ExternalSupplyJobs />} />
          <Route path="/admin/external-supply/jobs/:companyId" element={<ExternalSupplyJobs />} />
          <Route path="/admin/external-supply/batches/new" element={<ExternalSupplyBatchNew />} />
          <Route path="/admin/external-supply/batches/:batchId" element={<ExternalSupplyBatchDetail />} />
          <Route
            path="/admin/external-supply/batches/:batchId/candidates"
            element={<ExternalSupplyBatchCandidates />}
          />
          <Route path="/admin/external-supply/review" element={<ExternalSupplyReview />} />
          <Route path="/admin/external-supply/evaluations" element={<ExternalSupplyEvaluations />} />
          <Route path="/admin/external-supply/evaluations/:runId" element={<ExternalSupplyEvaluationDetail />} />
          {/* v2.0 External Supply V2 — agent-ranking review surface. */}
          <Route
            path="/admin/external-supply/evaluations/:runId/agent-ranking"
            element={<ExternalSupplyEvaluationAgentRanking />}
          />
          <Route path="/admin/external-supply/research" element={<ExternalSupplyResearch />} />
          <Route path="/admin/external-supply/outreach" element={<ExternalSupplyOutreach />} />
          <Route path="/admin/external-supply/sync" element={<ExternalSupplySync />} />
          <Route path="/admin/external-supply/audit" element={<ExternalSupplyAudit />} />
          {/* Phase 32 Wave 3 — Playbooks + Personas Firestore CRUD. */}
          <Route path="/agent/playbooks" element={<Playbooks />} />
          <Route path="/agent/personas" element={<Personas />} />
          {/* Phase 32 Wave 1 — /playground (E2E Lab) deleted; superseded by
              /eval/n-round-sim (Wave 3). Redirect to keep old links alive. */}
          <Route path="/playground" element={<Navigate to="/eval/n-round-sim" replace />} />
          {/* iter31 — public privacy + terms route also reachable from inside
              the dashboard (so operators can preview what testers see). */}
          <Route path="/legal" element={<Legal />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
