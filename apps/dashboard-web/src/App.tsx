import { getRedirectResult, onAuthStateChanged, signOut } from "firebase/auth"
import { useEffect, useState } from "react"
import { Navigate, NavLink, Route, Routes } from "react-router-dom"
import { AgentBuilder } from "./pages/AgentBuilder.js"
import { Login } from "./pages/Login.js"
import { Operations } from "./pages/Operations.js"
import { Overview } from "./pages/Overview.js"
import { Platform } from "./pages/Platform.js"
import { UserDetail } from "./pages/UserDetail.js"
import { Playground } from "./pages/Playground.js"
import { Users } from "./pages/Users.js"
import { Abuse } from "./pages/Abuse.js"
import { Beta } from "./pages/Beta.js"
import { Flags } from "./pages/Flags.js"
import { Triggers } from "./pages/Triggers.js"
import { Voice } from "./pages/Voice.js"
import { auth } from "./lib/firebase.js"

export default function App() {
  const [user, setUser] = useState<unknown | null>(undefined)
  const [redirectHandled, setRedirectHandled] = useState(false)

  // Consume Google redirect *before* routing (avoids redirect / sign-in races)
  useEffect(() => {
    getRedirectResult(auth())
      .catch((e) => {
        console.warn("[auth] getRedirectResult", e)
      })
      .finally(() => {
        setRedirectHandled(true)
      })
  }, [])

  useEffect(() => {
    return onAuthStateChanged(auth(), setUser)
  }, [])

  if (!redirectHandled || user === undefined) {
    return <div className="panel">Loading…</div>
  }

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    )
  }

  return (
    <div className="layout">
      <nav className="side-nav">
        <div className="brand-lockup">
          <span>WK</span>
          <strong>PA Console</strong>
        </div>
        <NavLink to="/" end>Overview</NavLink>
        <NavLink to="/conversations">Conversations</NavLink>
        <NavLink to="/agents">Agents</NavLink>
        <NavLink to="/operations">Operations</NavLink>
        <NavLink to="/platform">Platform</NavLink>
        <NavLink to="/beta">Beta</NavLink>
        <NavLink to="/abuse">Abuse</NavLink>
        <NavLink to="/triggers">Triggers</NavLink>
        <NavLink to="/admin/flags">Flags</NavLink>
        <NavLink to="/voice">Voice</NavLink>
        <NavLink to="/playground">E2E Lab</NavLink>
        <button
          type="button"
          onClick={() => signOut(auth())}
          className="sign-out"
        >
          Sign out
        </button>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/conversations" element={<Users />} />
          <Route path="/users/:id" element={<UserDetail />} />
          <Route path="/agents" element={<AgentBuilder />} />
          <Route path="/operations" element={<Operations />} />
          <Route path="/platform" element={<Platform />} />
          <Route path="/beta" element={<Beta />} />
          <Route path="/abuse" element={<Abuse />} />
          <Route path="/triggers" element={<Triggers />} />
          <Route path="/admin/flags" element={<Flags />} />
          <Route path="/voice" element={<Voice />} />
          <Route path="/playground" element={<Playground />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
