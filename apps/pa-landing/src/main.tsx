import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter, Routes, Route } from "react-router-dom"
import Landing from "./pages/Landing.js"
import LayoffLanding from "./pages/LayoffLanding.js"
import Legal from "./pages/Legal.js"
import CandidateLogin from "./pages/CandidateLogin.js"
import CandidateMatches from "./pages/CandidateMatches.js"
import { CandidateMe, CandidateProfile } from "./pages/CandidatePortal.js"
import Market from "./pages/Market.js"
import PublicJob from "./pages/PublicJob.js"
import PublicJobCv from "./pages/PublicJobCv.js"
import OpenJobs from "./pages/OpenJobs.js"

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

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomeLanding />} />
        <Route path="/legal" element={<Legal />} />
        <Route path="/login" element={<CandidateLogin />} />
        <Route path="/me" element={<CandidateMe />} />
        <Route path="/me/matches" element={<CandidateMatches />} />
        <Route path="/me/profile" element={<CandidateProfile />} />
        <Route path="/market" element={<Market />} />
        <Route path="/jobs" element={<Market />} />
        <Route path="/j/:jobId" element={<PublicJob />} />
        <Route path="/j/:jobId/cv" element={<PublicJobCv />} />
        <Route path="/open" element={<OpenJobs />} />
        <Route path="*" element={<HomeLanding />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
)
