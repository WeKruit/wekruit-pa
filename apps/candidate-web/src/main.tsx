import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import PublicJob from "./pages/PublicJob.js"
import PublicJobCv from "./pages/PublicJobCv.js"

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/j/:jobId" element={<PublicJob />} />
        <Route path="/j/:jobId/cv" element={<PublicJobCv />} />
        <Route path="*" element={<Navigate to="/j/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
)
