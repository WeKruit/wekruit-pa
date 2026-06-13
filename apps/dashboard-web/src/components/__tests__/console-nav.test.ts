/**
 * Console nav IA — Ops | Dev mode split regression tests.
 *
 * Guards the 2026-06-09 sidebar restructure: every route that existed in
 * the old single-mode nav must survive the retag/reorder, ops mode must
 * stay small enough to be founder-usable, and no route may appear twice.
 *
 * Run via:
 *   node --import tsx --test apps/dashboard-web/src/components/__tests__/console-nav.test.ts
 */
import assert from "node:assert/strict"
import test from "node:test"

import { CONSOLE_NAV } from "../console/Sidebar.js"

// Snapshot of every "to" in the pre-split CONSOLE_NAV (IA 2026-05-18).
const OLD_NAV_ROUTES = [
  // candidates
  "/admin/candidates",
  "/admin/passed-candidates",
  "/admin/identity-conflicts",
  "/conversations",
  "/match/candidates",
  "/admin/bulk-resumes",
  "/admin/delete-user",
  // jobs
  "/admin/external-supply/jobs",
  "/admin/job-prescreen",
  "/admin/job-enrichment",
  "/admin/ats-inbound",
  // recruiters (the other 7 legacy recruiter routes were consolidated into
  // /admin/recruiter-hub on 2026-06-09 — see CONSOLIDATED_RECRUITER_ROUTES)
  "/admin/recruiter-access",
  // employers
  "/admin/layoff-employers",
  "/admin/companies",
  // outreach
  "/admin/outreach-ops",
  "/admin/pending-outbound",
  "/admin/external-supply",
  "/admin/external-supply/outreach",
  "/admin/external-supply/sync",
  "/admin/external-supply/audit",
  "/admin/coresignal-playground",
  "/admin/voice-test-dial",
  "/admin/qr-campaigns",
  // matching
  "/admin/match-debug",
  "/match/weights",
  "/match/weights/test",
  "/match/explainer-history",
  "/match/explainer-test",
  // eval
  "/eval/voice-review",
  "/eval/n-round-sim",
  "/admin/flywheel-eval",
  "/admin/qa-evaluator",
  "/admin/prescreen-feedback",
  "/admin/external-supply/review",
  "/admin/external-supply/evaluations",
  // claire
  "/agents",
  "/agent/playbooks",
  "/agent/personas",
  "/admin/handbook",
  "/admin/onboarding-questions",
  "/admin/practice-question-bank",
  "/admin/upstream-templates",
  "/admin/downstream-triggers",
  "/admin/canonical-tags",
  // platform
  "/admin/sendblue-pool",
  "/admin/flags",
  "/triggers",
  "/admin/prescreen-sessions",
  "/admin/launch-readiness",
  "/beta",
  "/abuse",
]

// 2026-06-09 recruiter-hub consolidation: these routes stay ALIVE in App.tsx
// (deep links and the hub's tabs still hit them) but are intentionally NOT in
// the recruiter nav anymore — the recruiters section slimmed to Recruiter hub
// + Invites & roster. /admin/recruiter-roles is promoted into the Jobs section
// as the operator-facing role-priority editor.
const CONSOLIDATED_RECRUITER_ROUTES = [
  "/admin/recruiter-quality",
  "/admin/recruiter-applications",
  "/admin/recruiter-sourced",
  "/admin/recruiter-feedback",
  "/admin/recruiter-questions",
  "/admin/recruiter-submissions",
]

const allRoutes = CONSOLE_NAV.flatMap((sec) => sec.items.map((it) => it.to))

test("every old nav route survives the Ops | Dev split (plus the new prescreen ops board)", () => {
  const routeSet = new Set(allRoutes)
  const missing = OLD_NAV_ROUTES.filter((to) => !routeSet.has(to))
  assert.deepEqual(missing, [], `routes dropped from CONSOLE_NAV: ${missing.join(", ")}`)
  assert.ok(routeSet.has("/admin/prescreen-ops"), "new /admin/prescreen-ops entry missing")
})

test("recruiters section is consolidated into the hub (legacy routes out of nav)", () => {
  const routeSet = new Set(allRoutes)
  assert.ok(routeSet.has("/admin/recruiter-hub"), "new /admin/recruiter-hub entry missing")
  const lingering = CONSOLIDATED_RECRUITER_ROUTES.filter((to) => routeSet.has(to))
  assert.deepEqual(
    lingering,
    [],
    `consolidated recruiter routes back in CONSOLE_NAV: ${lingering.join(", ")}`,
  )
})

test("ops mode stays founder-sized (≤ 20 items)", () => {
  const opsSections = CONSOLE_NAV.filter((sec) => sec.mode === "ops")
  assert.ok(opsSections.length > 0, "no ops-mode sections found")
  const opsItemCount = opsSections.reduce((n, sec) => n + sec.items.length, 0)
  assert.ok(opsItemCount <= 20, `ops mode has ${opsItemCount} items (max 20)`)
})

test("no duplicate route across sections", () => {
  const seen = new Set<string>()
  const dupes = allRoutes.filter((to) => {
    if (seen.has(to)) return true
    seen.add(to)
    return false
  })
  assert.deepEqual(dupes, [], `duplicate routes in CONSOLE_NAV: ${dupes.join(", ")}`)
})

test("every section declares a valid mode", () => {
  for (const sec of CONSOLE_NAV) {
    assert.ok(sec.mode === "ops" || sec.mode === "dev", `section ${sec.id} has invalid mode`)
  }
})
