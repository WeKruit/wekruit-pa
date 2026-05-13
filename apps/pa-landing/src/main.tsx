import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter, Routes, Route } from "react-router-dom"
import Landing from "./pages/Landing.js"
import Legal from "./pages/Legal.js"
import CandidateLogin from "./pages/CandidateLogin.js"
import { CandidateMe, CandidateProfile } from "./pages/CandidatePortal.js"
import PublicJob from "./pages/PublicJob.js"
import PublicJobCv from "./pages/PublicJobCv.js"

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/legal" element={<Legal />} />
        <Route path="/login" element={<CandidateLogin />} />
        <Route path="/me" element={<CandidateMe />} />
        <Route path="/me/profile" element={<CandidateProfile />} />
        <Route path="/j/:jobId" element={<PublicJob />} />
        <Route path="/j/:jobId/cv" element={<PublicJobCv />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
)
