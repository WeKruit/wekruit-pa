/**
 * Shared dual-pane layout tokens for the "opening review modal" used by BOTH the
 * prescreen review drawer (PrescreenReviewDrawers) and the recruiter candidate
 * detail (RecruiterBoardOps). One source of truth so the two modals look identical:
 * same SideDrawer width (xl), same two-column grid (read-only LEFT, human-review
 * RIGHT) that collapses to a single column on narrow widths, and the same
 * uppercase pane-header style.
 *
 * Each modal differs only in the EXTRAS rendered inside the panes — prescreen adds
 * the transcript / engagement / outbound compose; recruiter adds the role checklist
 * + recruiter status actions — but the candidate-info presentation (résumé iframe,
 * LinkedIn/sources, AI verdict, background pillars) is shared via CandidateResumePreview
 * and the same grid tokens here.
 */
import type { CSSProperties } from "react"

/** Two-column review grid: read-only LEFT gets the bulk of the width, human-review RIGHT is the rail. */
export const dualPaneStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 0.8fr)",
  gap: 18,
  alignItems: "start",
}

/** Small uppercase eyebrow that labels each pane ("AI evaluation · read-only" / "Human review"). */
export const paneHeaderStyle: CSSProperties = {
  fontSize: "0.72em",
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#94a3b8",
}

/**
 * CSS rule string that collapses the `.pa-eval-dualpane` grid to a single column on
 * narrow widths. Inject once per modal via a `<style>` tag so both modals collapse
 * identically. Class name is shared so a single rule could cover both at once.
 */
export const DUAL_PANE_COLLAPSE_CSS =
  "@media (max-width: 900px){.pa-eval-dualpane{grid-template-columns:minmax(0,1fr) !important;}}"
