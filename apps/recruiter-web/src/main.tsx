import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import "./lib/auth-redirect-bootstrap.js"
import { RecruiterSessionProvider } from "./lib/recruiter-session-context.js"
import RecruiterBoard from "./pages/RecruiterBoard.js"
import RoleSheetPage from "./pages/RoleSheetPage.js"

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

const routes = (
  <Routes>
    <Route path="/" element={<Navigate to="/recruiters" replace />} />
    <Route path="/recruiters" element={<RecruiterBoard />} />
    <Route path="/recruiters/job/:jobId" element={<RoleSheetPage />} />
    <Route path="*" element={<Navigate to="/recruiters" replace />} />
  </Routes>
)

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <RecruiterSessionProvider>{routes}</RecruiterSessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
