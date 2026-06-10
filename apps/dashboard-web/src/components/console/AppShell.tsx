// WeKruit Console — outer 2-col app shell (sidebar + main pane).
// Wrap the Routes element with this component to apply the new chrome
// without touching every page individually.

import { useMemo, type ReactNode } from "react"
import { useWorkQueueCounts } from "../../lib/work-queue-counts.js"
import { Sidebar } from "./Sidebar.js"
import { Topbar } from "./Topbar.js"

export function AppShell({
  userEmail,
  onSignOut,
  children,
}: {
  userEmail: string
  onSignOut: () => void
  children: ReactNode
}) {
  const counts = useWorkQueueCounts()
  const hitlCounts = useMemo(() => {
    const map: Record<string, number> = {}
    const add = (to: string, value: number | null) => {
      if (typeof value === "number") map[to] = value
    }
    add("/admin/prescreen-sessions", counts.prescreenPending)
    add("/admin/prescreen-ops", counts.prescreenPending)
    add("/admin/identity-conflicts", counts.identityOpen)
    add("/admin/job-enrichment", counts.enrichmentDrafts)
    add("/admin/recruiter-hub", counts.recruiterNew)
    add("/admin/pending-outbound", counts.pendingOutbound)
    add("/admin/layoff-employers", counts.layoffPending)
    return map
  }, [counts])

  return (
    <div className="app">
      <Sidebar userEmail={userEmail} hitlCounts={hitlCounts} onSignOut={onSignOut} />
      <div className="app__main">
        <Topbar />
        <div className="page">{children}</div>
      </div>
    </div>
  )
}
