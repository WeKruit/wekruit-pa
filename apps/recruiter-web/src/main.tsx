import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import "./lib/auth-redirect-bootstrap.js"
import { initAnalytics } from "./lib/analytics.js"
import { RecruiterSessionProvider } from "./lib/recruiter-session-context.js"
import OpenJobsPage from "./pages/OpenJobsPage.js"
import RecruiterWorkspace from "./pages/RecruiterWorkspace.js"
import RecruiterRole from "./pages/RecruiterRole.js"
import SubmissionDetailPage from "./pages/SubmissionDetailPage.js"

void initAnalytics()

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

const routes = (
  <Routes>
    <Route path="/" element={<Navigate to="/recruiters/jobs" replace />} />
    <Route path="/recruiters" element={<RecruiterWorkspace />} />
    <Route path="/recruiters/jobs" element={<OpenJobsPage />} />
    <Route path="/recruiters/classic" element={<Navigate to="/recruiters" replace />} />
    <Route path="/recruiters/job/:jobId" element={<RecruiterRole />} />
    <Route path="/recruiters/submission/:submissionId" element={<SubmissionDetailPage />} />
    <Route path="*" element={<Navigate to="/recruiters/jobs" replace />} />
  </Routes>
)

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <RecruiterSessionProvider>{routes}</RecruiterSessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
