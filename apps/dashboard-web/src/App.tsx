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
// iter30/WS8 — biz-demo Wave 2 — full match-* admin surface.
import { MatchWeights } from "./pages/MatchWeights.js"
import { MatchWeightsTest } from "./pages/MatchWeightsTest.js"
import { MatchExplainerHistory } from "./pages/MatchExplainerHistory.js"
import { MatchExplainerTest } from "./pages/MatchExplainerTest.js"
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

        {/* Phase 32 Wave 1 — sidebar reorg into 5 categories. Old flat list
            replaced with grouped sections; runtime/debug pages (Operations,
            Playground, standalone Platform) demoted out of sidebar. All old
            routes still resolve to keep muscle memory + bookmarks alive. */}
        <div className="nav-section">
          <div className="nav-section-label">Monitor</div>
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/conversations">Conversations</NavLink>
          <NavLink to="/abuse">Abuse</NavLink>
        </div>

        <div className="nav-section">
          <div className="nav-section-label">Agent</div>
          <NavLink to="/agents">Agents</NavLink>
          <NavLink to="/admin/handbook">Handbook</NavLink>
          <NavLink to="/admin/onboarding">Onboarding</NavLink>
          <NavLink to="/admin/onboarding-questions">Onboarding Qs (class)</NavLink>
          <NavLink to="/agent/playbooks">Playbooks</NavLink>
          <NavLink to="/agent/personas">Personas</NavLink>
        </div>

        <div className="nav-section">
          <div className="nav-section-label">Eval</div>
          <NavLink to="/eval/voice-review">Voice Review</NavLink>
          <NavLink to="/eval/n-round-sim">N-Round Sim</NavLink>
        </div>

        <div className="nav-section">
          <div className="nav-section-label">Match</div>
          <NavLink to="/match/candidates">Candidates</NavLink>
          {/* iter30/WS8 Wave 2 — biz-demo match admin surface. */}
          <NavLink to="/match/weights">Weights</NavLink>
          <NavLink to="/match/weights/test">Weights · Dry Run</NavLink>
          <NavLink to="/match/explainer-history">Explainer History</NavLink>
          <NavLink to="/match/explainer-test">Explainer Test</NavLink>
        </div>

        <div className="nav-section">
          <div className="nav-section-label">Integrations</div>
          <NavLink to="/admin/upstream-templates">Upstream Templates</NavLink>
          <NavLink to="/admin/downstream-triggers">Downstream Triggers</NavLink>
          <NavLink to="/beta">Beta Allowlist</NavLink>
          <NavLink to="/triggers">Triggers</NavLink>
        </div>

        <div className="nav-section">
          <div className="nav-section-label">Platform</div>
          <NavLink to="/admin/flags">Flags</NavLink>
        </div>

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
          {/* Phase 49 (v1.5 Stream-H D9) — operator reverse-match dashboard. Admin-only;
              CF gates on paReverseMatchEnabled flag (default OFF). */}
          <Route path="/match/candidates" element={<MatchCandidates />} />
          {/* iter30/WS8 Wave 2 — biz-demo match admin surface. */}
          <Route path="/match/weights" element={<MatchWeights />} />
          <Route path="/match/weights/test" element={<MatchWeightsTest />} />
          <Route
            path="/match/explainer-history"
            element={<MatchExplainerHistory />}
          />
          <Route path="/match/explainer-test" element={<MatchExplainerTest />} />
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
