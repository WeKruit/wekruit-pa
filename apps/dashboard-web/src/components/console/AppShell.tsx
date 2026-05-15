// WeKruit Console — outer 2-col app shell (sidebar + main pane).
// Wrap the Routes element with this component to apply the new chrome
// without touching every page individually.

import type { ReactNode } from "react"
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
  return (
    <div className="app">
      <Sidebar userEmail={userEmail} onSignOut={onSignOut} />
      <div className="app__main">
        <Topbar />
        <div className="page">{children}</div>
      </div>
    </div>
  )
}
