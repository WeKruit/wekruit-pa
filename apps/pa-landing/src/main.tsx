import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./lib/auth-redirect-bootstrap.js"
import "./styles/wekruit-tokens.css"
import "./styles/wekruit-pages.css"
import Landing from "./pages/Landing.js"
import LayoffLanding from "./pages/LayoffLanding.js"
import Legal from "./pages/Legal.js"
import CandidateLogin from "./pages/CandidateLogin.js"
import { CandidateMe, CandidateProfile, CandidateMatches } from "./pages/CandidatePortal.js"
import Market from "./pages/Market.js"
import PublicJob from "./pages/PublicJob.js"
import PublicJobCv from "./pages/PublicJobCv.js"
import CompanyProfile from "./pages/CompanyProfile.js"
import OpenJobs from "./pages/OpenJobs.js"
import Onboarding from "./pages/Onboarding.js"
import EmployerSignup from "./pages/EmployerSignup.js"
import Employers, { EmployersInbox } from "./pages/Employers.js"
import ReferPage, { ReferPublicPage } from "./pages/Refer.js"

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

// Host-aware landing. layoff.wekruit.com → cream WeKruit Open layout
// (LayoffLanding.tsx) per Claude Design 2026-05-15 handoff bundle.
// candidate.wekruit.com / pa.wekruit.com / wekruit-pa-landing.web.app keep
// the iter33 black-gradient Landing.tsx. Detected client-side because the
// same bundle is served from all three Firebase Hosting sites.
const host = typeof window !== "undefined" ? window.location.hostname.toLowerCase() : ""
const IS_LAYOFF_HOST = host.startsWith("layoff.") || host === "layoff-wekruit.web.app"
const HomeLanding = IS_LAYOFF_HOST ? LayoffLanding : Landing

// Canonical host = apex `wekruit.com`. Adam directive 2026-05-27 — partner
// API now emits `wekruitUrl: https://wekruit.com/j/<id>` instead of
// `candidate.wekruit.com/j/<id>`. Stale partner caches still link to the
// old `candidate.` subdomain; transparently bounce those to apex so the
// address bar never leaks the internal subdomain. Skip during SSR
// (`typeof window`), skip if the path doesn't start with `/j/` (the
// candidate portal at /me etc. stays on candidate. for now), skip in
// dev/preview hosts.
if (
  typeof window !== "undefined" &&
  host === "candidate.wekruit.com" &&
  window.location.pathname.startsWith("/j/")
) {
  const target = `https://wekruit.com${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.replace(target)
}

// Adam directive 2026-05-16: "tanstack / cache / paginated job load". Single
// shared QueryClient — 5 min staleTime means revisits to /open and /market
// paint instantly from cache; 30 min gcTime keeps freed entries around for
// back/forward navigation. Disable refetchOnWindowFocus to avoid burning a
// Firestore read every time the user tabs back.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

// Layoff host: landing, login, onboarding intake, employer signup — full flow
// stays on layoff.wekruit.com (Firebase Auth session is per-origin on this host).
// Candidate portal (/me) lives on candidate.wekruit.com only.
const layoffRoutes = (
  <Routes>
    <Route path="/" element={<HomeLanding />} />
    <Route path="/login" element={<CandidateLogin />} />
    <Route path="/onboarding" element={<Onboarding />} />
    <Route path="/employer" element={<EmployerSignup />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
)

const fullRoutes = (
  <Routes>
    <Route path="/" element={<HomeLanding />} />
    <Route path="/legal" element={<Legal />} />
    <Route path="/login" element={<CandidateLogin />} />
    <Route path="/me" element={<CandidateMe />} />
    <Route path="/me/matches" element={<CandidateMatches />} />
    <Route path="/me/profile" element={<CandidateProfile />} />
    <Route path="/market" element={<Market />} />
    <Route path="/jobs" element={<Market />} />
    <Route path="/companies/:companyId" element={<CompanyProfile />} />
    <Route path="/j/:jobId" element={<PublicJob />} />
    <Route path="/j/:jobId/cv" element={<PublicJobCv />} />
    <Route path="/open" element={<OpenJobs />} />
    <Route path="/onboarding" element={<Onboarding />} />
    <Route path="/employer" element={<EmployerSignup />} />
    <Route path="/employers" element={<Employers />} />
    <Route path="/employers/inbox" element={<EmployersInbox />} />
    <Route path="/refer" element={<ReferPublicPage />} />
    <Route path="/r/:slug" element={<ReferPublicPage />} />
    <Route path="/me/refer" element={<ReferPage />} />
    <Route path="*" element={<HomeLanding />} />
  </Routes>
)

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {IS_LAYOFF_HOST ? layoffRoutes : fullRoutes}
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
