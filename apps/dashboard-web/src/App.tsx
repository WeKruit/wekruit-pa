import { getRedirectResult, onAuthStateChanged, signOut } from "firebase/auth"
import { useEffect, useState } from "react"
import { Link, Navigate, Route, Routes } from "react-router-dom"
import { AgentBuilder } from "./pages/AgentBuilder.js"
import { Login } from "./pages/Login.js"
import { Platform } from "./pages/Platform.js"
import { UserDetail } from "./pages/UserDetail.js"
import { Playground } from "./pages/Playground.js"
import { Users } from "./pages/Users.js"
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
      <nav>
        <strong>PA Console</strong>
        <Link to="/">Users</Link>
        <Link to="/agents">Agents</Link>
        <Link to="/platform">Platform flags</Link>
        <Link to="/playground">Playground</Link>
        <button
          type="button"
          onClick={() => signOut(auth())}
          style={{ marginTop: "1rem", width: "100%" }}
        >
          Sign out
        </button>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Users />} />
          <Route path="/users/:id" element={<UserDetail />} />
          <Route path="/agents" element={<AgentBuilder />} />
          <Route path="/platform" element={<Platform />} />
          <Route path="/playground" element={<Playground />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
