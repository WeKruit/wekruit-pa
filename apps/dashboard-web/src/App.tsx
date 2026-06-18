import { getRedirectResult, onAuthStateChanged, signOut } from "firebase/auth"
import { completeAdminMagicLink } from "./lib/magic-link.js"
import { useEffect, useState } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { AppShell } from "./components/console/AppShell.js"
import { AgentBuilder } from "./pages/AgentBuilder.js"
import Legal from "./pages/Legal.js"
import { Login } from "./pages/Login.js"
import { Operations } from "./pages/Operations.js"
import OperationsOverview from "./pages/OperationsOverview.js"
import RejectedCandidates from "./pages/RejectedCandidates.js"
import { Overview } from "./pages/Overview.js"
import { UserDetail } from "./pages/UserDetail.js"
import { Users } from "./pages/Users.js"
import { Candidates } from "./pages/Candidates.js"
import { Abuse } from "./pages/Abuse.js"
import { Beta } from "./pages/Beta.js"
import { Flags } from "./pages/Flags.js"
import { Handbook } from "./pages/Handbook.js"
import { Onboarding } from "./pages/Onboarding.js"
import { OnboardingQuestions } from "./pages/OnboardingQuestions.js"
import { PracticeQuestionBank } from "./pages/PracticeQuestionBank.js"
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
// Phase A4 (WEK-yc) — /admin/companies CRUD over pa-companies collection.
import { Companies } from "./pages/Companies.js"
// Employer role packets — /admin/layoff-employers reviews candidate.wekruit.com /employer submissions.
import LayoffEmployers from "./pages/LayoffEmployers.js"
// Coresignal Agentic Search playground — calls /v2/agentic_search/reasoning via CF proxy.
import CoresignalPlayground from "./pages/CoresignalPlayground.js"
import { QaEvaluator } from "./pages/QaEvaluator.js"
import FlywheelEval from "./pages/FlywheelEval.js"
import EvalLabels from "./pages/EvalLabels.js"
import LaunchReadiness from "./pages/LaunchReadiness.js"
// v1.7 Phase 70 (MATCHDEBUG-01..04) — admin live debugger for the V16 cascade
// with score-weight sandbox sliders. Backed by paAdminMatchDebug callable.
import { MatchDebug } from "./pages/MatchDebug.js"
// v2.2 W6 — One-shot dial form for smoke-testing the deployed LK Cloud
// voice agent (CA_CyhBjJioxJR9) with the in-process WekruitLLM.
import { VoiceTestDial } from "./pages/VoiceTestDial.js"
import { VoiceProfiles } from "./pages/VoiceProfiles.js"
// DANGER — complete-delete-user testing tool. Hard-deletes a candidate to a
// true blank slate. Backed by the paAdminDeleteUser callable (server-gated to
// @wekruit.com). Admin domain only.
import { DeleteUser } from "./pages/DeleteUser.js"
// v1.8 Phase 78 — Job pre-screen config editor.
import JobPrescreen from "./pages/JobPrescreen.js"
import { JobEnrichmentReview } from "./pages/JobEnrichmentReview.js"
// v1.8 Phase 79 — Pre-screen session detail + tag-snapshot rollback.
import PrescreenSession from "./pages/PrescreenSession.js"
import TagSnapshots from "./pages/TagSnapshots.js"
import PrescreenSessionsList from "./pages/PrescreenSessionsList.js"
// Wave 2 — job-centric prescreen ops board backed by paAdminPrescreenOpsSnapshot.
import PrescreenOps from "./pages/PrescreenOps.js"
// v1.9 Phase 86 — ATS inbound dashboard.
import AtsInbound from "./pages/AtsInbound.js"
import BulkResumes from "./pages/BulkResumes.js"
import { IdentityConflicts } from "./pages/IdentityConflicts.js"
// v1.9 Phase 88 — Sendblue number pool admin.
import SendbluePool from "./pages/SendbluePool.js"
// QR campaign manager — generate onboarding QR + scan→conversion funnel.
import { QrCampaigns } from "./pages/QrCampaigns.js"
// v2.0 S6 - admin outreach readiness snapshot.
import OutreachOps from "./pages/OutreachOps.js"
// Batch human-approve-then-send queue (pa-pending-outbound). Send is gated.
import PendingOutbound from "./pages/PendingOutbound.js"
// v2.0 S7 - job-scoped passed candidate snapshots.
import PassedCandidates from "./pages/PassedCandidates.js"
// v1.9 Phase 89 — pre-screen feedback aggregate.
import PrescreenFeedback from "./pages/PrescreenFeedback.js"
// Recruiter board (wekruit-recruiters.web.app/recruiters) — admin review surface.
import RecruiterSubmissions from "./pages/RecruiterSubmissions.js"
import RecruiterHub from "./pages/RecruiterHub.js"
import RecruiterDigests from "./pages/RecruiterDigests.js"
// v2.0 External Supply V1 — Wave D admin surfaces (Landing, BatchNew,
// BatchDetail, Review, Evaluations, EvaluationDetail, Research, Outreach,
// Sync, Audit). All routes live under /admin/external-supply/**.
import { Landing as ExternalSupplyLanding } from "./pages/external-supply/Landing.js"
import { BatchNew as ExternalSupplyBatchNew } from "./pages/external-supply/BatchNew.js"
// v2.1 — CoreSignal paste-IDs operator surface (sibling to BatchNew).
import { CoresignalBatchNew } from "./pages/external-supply/CoresignalBatchNew.js"
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
import { JobWorkspace } from "./pages/admin/JobWorkspace.js"

import { auth } from "./lib/firebase.js"
import {
  bootstrapSsoFromCookie,
  clearSsoCookie,
  registerSsoCookieRefresh,
} from "./lib/cross-domain-sso.js"

export default function App() {
  const [user, setUser] = useState<unknown | null>(undefined)
  const [redirectHandled, setRedirectHandled] = useState(false)

  // Consume Google redirect *before* routing (avoids redirect / sign-in races).
  // Also try to restore the per-origin session from the shared `.wekruit.com`
  // SSO cookie in parallel so the admin survives navigating from another
  // wekruit.com subdomain without re-authenticating.
  useEffect(() => {
    Promise.allSettled([completeAdminMagicLink(), getRedirectResult(auth()), bootstrapSsoFromCookie()])
      .catch((e) => {
        console.warn("[auth] bootstrap", e)
      })
      .finally(() => {
        setRedirectHandled(true)
      })
    const unsubRefresh = registerSsoCookieRefresh()
    return () => unsubRefresh()
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

  const email =
    (user && typeof user === "object" && (user as { email?: string }).email) || "operator"

  return (
    <AppShell
      userEmail={email}
      onSignOut={async () => {
        await clearSsoCookie()
        await signOut(auth())
      }}
    >
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/admin/operations" element={<OperationsOverview />} />
          <Route path="/conversations" element={<Users />} />
          {/* v2.0 marketplace candidate browser — replaces /conversations
              as the canonical "All candidates" surface. Reads pa-users +
              pa-candidate-source-links; renders lifecycle state, source,
              profile completeness, top tags. Drawer links out to existing
              detail surfaces. */}
          <Route path="/admin/candidates" element={<Candidates />} />
          <Route path="/admin/delete-user" element={<DeleteUser />} />
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
          {/* Phase A4 (WEK-yc) — centralized company directory CRUD. */}
          <Route path="/admin/companies" element={<Companies />} />
          {/* Employer role packets — review candidate.wekruit.com /employer submissions. */}
          <Route path="/admin/layoff-employers" element={<LayoffEmployers />} />
          {/* Coresignal Agentic Search playground — admin-only, CF proxy. */}
          <Route path="/admin/coresignal-playground" element={<CoresignalPlayground />} />
          <Route path="/admin/qa-evaluator" element={<QaEvaluator />} />
          <Route path="/admin/launch-readiness" element={<LaunchReadiness />} />
          <Route path="/admin/handbook" element={<Handbook />} />
          <Route path="/admin/onboarding" element={<Onboarding />} />
          <Route
            path="/admin/onboarding-questions"
            element={<OnboardingQuestions />}
          />
          <Route path="/admin/practice-question-bank" element={<PracticeQuestionBank />} />
          <Route path="/admin/upstream-templates" element={<UpstreamTemplates />} />
          <Route path="/admin/downstream-triggers" element={<DownstreamTriggers />} />
          {/* Phase 32 Wave 2c — /voice split into /eval/voice-review +
              /eval/n-round-sim. Old /voice URL redirects for back-compat. */}
          <Route path="/voice" element={<Navigate to="/eval/voice-review" replace />} />
          <Route path="/eval/voice-review" element={<VoiceReview />} />
          <Route path="/eval/n-round-sim" element={<NRoundSim />} />
          <Route path="/admin/flywheel-eval" element={<FlywheelEval />} />
          <Route path="/admin/eval-labels" element={<EvalLabels />} />
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
          <Route path="/admin/voice-test-dial" element={<VoiceTestDial />} />
          <Route path="/admin/voice-profiles" element={<VoiceProfiles />} />
          <Route path="/admin/passed-candidates" element={<PassedCandidates />} />
          <Route path="/admin/rejected-candidates" element={<RejectedCandidates />} />
          {/* v1.8 Phase 78 — Job pre-screen config editor. */}
          <Route path="/admin/jobs/:jobId/prescreen" element={<JobPrescreen />} />
          <Route path="/admin/job-prescreen" element={<JobPrescreen />} />
          {/* v2.0 S4 — admin-only job enrichment draft review. */}
          <Route path="/admin/job-enrichment" element={<JobEnrichmentReview />} />
          {/* Wave 2 — job-centric prescreen ops board (snapshot-backed). */}
          <Route path="/admin/prescreen-ops" element={<PrescreenOps />} />
          {/* v1.8 Phase 79 — Session list + detail + tag-snapshot rollback. */}
          <Route path="/admin/prescreen-sessions" element={<PrescreenSessionsList />} />
          <Route path="/admin/prescreen-sessions/:sessionId" element={<PrescreenSession />} />
          <Route path="/admin/users/:uid/tag-snapshots" element={<TagSnapshots />} />
          {/* v1.9 Phase 86 — ATS inbound funnel observability. */}
          <Route path="/admin/ats-inbound" element={<AtsInbound />} />
          <Route path="/admin/bulk-resumes" element={<BulkResumes />} />
          <Route path="/admin/outreach-ops" element={<OutreachOps />} />
          {/* Batch human-approve-then-send queue (pa-pending-outbound). */}
          <Route path="/admin/pending-outbound" element={<PendingOutbound />} />
          {/* v1.9 Phase 88 — Sendblue number pool admin. */}
          <Route path="/admin/sendblue-pool" element={<SendbluePool />} />
          {/* QR campaign manager — onboarding QR generator + scan→conversion funnel. */}
          <Route path="/admin/qr-campaigns" element={<QrCampaigns />} />
          {/* v1.9 Phase 89 — pre-screen feedback aggregate. */}
          <Route path="/admin/prescreen-feedback" element={<PrescreenFeedback />} />
          {/* Recruiter board admin surfaces. */}
          <Route path="/admin/recruiter-hub" element={<RecruiterHub />} />
          <Route path="/admin/recruiter-digests" element={<RecruiterDigests />} />
          <Route path="/admin/recruiter-access" element={<RecruiterSubmissions section="codes" />} />
          <Route path="/admin/recruiter-codes" element={<Navigate to="/admin/recruiter-access" replace />} />
          <Route path="/admin/recruiter-roles" element={<RecruiterSubmissions section="roles" />} />
          <Route path="/admin/recruiter-quality" element={<RecruiterSubmissions section="quality" />} />
          <Route path="/admin/recruiter-applications" element={<RecruiterSubmissions section="applications" />} />
          <Route path="/admin/recruiter-sourced" element={<RecruiterSubmissions section="sourced" />} />
          <Route path="/admin/recruiter-feedback" element={<RecruiterSubmissions section="feedback" />} />
          <Route path="/admin/recruiter-questions" element={<RecruiterSubmissions section="questions" />} />
          <Route path="/admin/recruiter-submissions" element={<RecruiterSubmissions section="submissions" />} />
          {/* v2.0 External Supply V1 — Wave D admin surfaces. */}
          <Route path="/admin/external-supply" element={<ExternalSupplyLanding />} />
          <Route path="/admin/external-supply/jobs" element={<ExternalSupplyJobs mode="collab" />} />
          <Route path="/admin/external-supply/jobs/:companyId" element={<ExternalSupplyJobs mode="collab" />} />
          <Route path="/admin/external-supply/non-collab-jobs" element={<ExternalSupplyJobs mode="non_collab" />} />
          <Route path="/admin/external-supply/non-collab-jobs/:companyId" element={<ExternalSupplyJobs mode="non_collab" />} />
          <Route path="/admin/jobs/new" element={<JobWorkspace createMode />} />
          <Route path="/admin/jobs/:jobId" element={<JobWorkspace />} />
          <Route path="/admin/external-supply/batches/new" element={<ExternalSupplyBatchNew />} />
          <Route path="/admin/external-supply/batches/new-coresignal" element={<CoresignalBatchNew />} />
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
    </AppShell>
  )
}
