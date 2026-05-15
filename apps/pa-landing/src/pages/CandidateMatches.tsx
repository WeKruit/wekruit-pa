/**
 * /me/matches → /me redirect.
 *
 * In the warm-editorial redesign the candidate pipeline and the "new roles
 * for you" matches all live on /me as a single unified feed (Up next ·
 * In motion · New roles). Keeping /me/matches as a stable URL just routes
 * back to that surface.
 */
import { Navigate } from "react-router-dom"

export default function CandidateMatches() {
  return <Navigate to="/me" replace />
}
