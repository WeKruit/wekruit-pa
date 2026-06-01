import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import "../../pa-landing/src/lib/auth-redirect-bootstrap.js"
import RecruiterBoard from "../../pa-landing/src/pages/RecruiterBoard.js"
import RecruiterRole from "../../pa-landing/src/pages/RecruiterRole.js"

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

const routes = (
  <Routes>
    <Route path="/" element={<Navigate to="/recruiters" replace />} />
    <Route path="/recruiters" element={<RecruiterBoard />} />
    <Route path="/recruiters/job/:jobId" element={<RecruiterRole />} />
    <Route path="*" element={<Navigate to="/recruiters" replace />} />
  </Routes>
)

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>{routes}</BrowserRouter>
  </React.StrictMode>,
)
