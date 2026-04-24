import { PA_COLLECTIONS } from "@pa/core-types"
import {
  addDoc,
  collection,
  deleteField,
  doc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore"
import { useCallback, useEffect, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { auth, db } from "../lib/firebase.js"

function normalizeE164(input: string): string {
  const t = input.trim()
  const d = t.replace(/\D/g, "")
  if (t.startsWith("+")) return `+${d}`
  return d.length === 10 ? `+1${d}` : `+${d}`
}

type UserRow = {
  id: string
  phoneE164?: string
  activeAgentId?: string
  onboardingStatus?: string
  createdAt?: string
}
type MsgRow = { id: string; role?: string; body?: string; createdAt?: string; sessionId?: string }
type OutRow = { id: string; status?: string; toE164?: string; body?: string; createdAt?: string; error?: string; sentAt?: string }
type HealthJson = { ok?: boolean; service?: string; firebase?: boolean; outboundListener?: boolean; imessageReady?: boolean; uptimeSec?: number }

const WORKER_HELP =
  "Optional: set VITE_WORKER_HEALTH_URL in .env.local to a public URL that proxies to the Mac (e.g. ngrok http 8787) so this page can show live status."

export function Playground() {
  const fire = db() as Firestore
  const [users, setUsers] = useState<UserRow[]>([])
  const [userId, setUserId] = useState<string>("")
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([])
  const [createPhone, setCreatePhone] = useState("")
  const [toE164, setToE164] = useState("")
  const [outBody, setOutBody] = useState("")
  const [messages, setMessages] = useState<MsgRow[]>([])
  const [outbound, setOutbound] = useState<OutRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [workerHealth, setWorkerHealth] = useState<HealthJson | { error: string } | null>(null)

  const selected = users.find((u) => u.id === userId) ?? null

  const loadUsersAndAgents = useCallback(async () => {
    setErr(null)
    const [uSnap, aSnap] = await Promise.all([
      getDocs(collection(fire, PA_COLLECTIONS.users)),
      getDocs(collection(fire, PA_COLLECTIONS.agents)),
    ])
    setUsers(
      uSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }) as UserRow)
        .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    )
    setAgents(
      aSnap.docs.map((d) => ({
        id: d.id,
        name: String((d.data() as { name?: string }).name || d.id),
      }))
    )
  }, [fire])

  useEffect(() => {
    loadUsersAndAgents().catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [loadUsersAndAgents])

  const healthBase = (import.meta.env.VITE_WORKER_HEALTH_URL || "").trim().replace(/\/$/, "")
  useEffect(() => {
    if (!healthBase) {
      setWorkerHealth(null)
      return
    }
    let cancelled = false
    const run = () => {
      fetch(`${healthBase}/health`, { mode: "cors" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j: HealthJson) => {
          if (!cancelled) setWorkerHealth(j)
        })
        .catch(() => {
          if (!cancelled) setWorkerHealth({ error: "unreachable" })
        })
    }
    run()
    const id = window.setInterval(run, 12_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [healthBase])

  useEffect(() => {
    if (!userId) {
      setMessages([])
      setOutbound([])
      return
    }
    const mq = query(collection(fire, PA_COLLECTIONS.messages), where("userId", "==", userId))
    const oq = query(collection(fire, PA_COLLECTIONS.outbound), where("userId", "==", userId))
    const unsubM = onSnapshot(
      mq,
      (snap) => {
        const ml = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as MsgRow[]
        ml.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        setMessages(ml)
      },
      (e) => setErr(e.message)
    )
    const unsubO = onSnapshot(
      oq,
      (snap) => {
        const ol = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as OutRow[]
        ol.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        setOutbound(ol)
      },
      (e) => setErr(e.message)
    )
    return () => {
      unsubM()
      unsubO()
    }
  }, [fire, userId])

  async function onCreateUser(e: FormEvent) {
    e.preventDefault()
    const n = normalizeE164(createPhone)
    if (!n || n.length < 8) {
      setErr("Enter a valid phone (E.164)")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const id = crypto.randomUUID()
      await setDoc(doc(fire, PA_COLLECTIONS.users, id), {
        id,
        phoneE164: n,
        createdAt: new Date().toISOString(),
        onboardingStatus: "provisional",
        channels: { imessageHandle: n },
      })
      setCreatePhone("")
      await loadUsersAndAgents()
      setUserId(id)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onAssignAgent(aid: string) {
    if (!userId) return
    await updateDoc(doc(fire, PA_COLLECTIONS.users, userId), {
      activeAgentId: aid ? aid : deleteField(),
    })
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, activeAgentId: aid || undefined } : u)))
  }

  async function onEnqueueOutbound(e: FormEvent) {
    e.preventDefault()
    if (!userId) {
      setErr("Select a user")
      return
    }
    const to = normalizeE164(toE164)
    const body = outBody.trim()
    if (!to || !body) {
      setErr("to and body required")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const uid = auth().currentUser?.uid
      await addDoc(collection(fire, PA_COLLECTIONS.outbound), {
        userId,
        toE164: to,
        body,
        status: "pending",
        createdAt: new Date().toISOString(),
        ...(uid ? { createdBy: uid } : {}),
        idempotencyKey: `pg-${userId}-${Date.now()}`,
      })
      setOutBody("")
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (err && !userId && users.length === 0) return <div className="panel">Error: {err}</div>

  return (
    <div>
      <p>
        <Link to="/">← Users</Link> · <Link to="/agents">Agents</Link>
      </p>
      <h1>Playground</h1>
      <div
        className="panel"
        style={{
          marginBottom: "1rem",
          background: "linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)",
          borderColor: "#cbd5e1",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>POC: end-to-end send</h2>
        <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem", lineHeight: 1.6, color: "#334155" }}>
          <li>
            <b>Mac</b> — run the worker: <code>cd apps/macos-imessage-worker && npm run start</code> (Health: default{" "}
            <code>http://127.0.0.1:8787/health</code>, set <code>PA_HEALTH_PORT=0</code> to disable).
          </li>
          <li>
            <b>Agents</b> — create at least one agent and note the <b>default</b> or assign one below.
          </li>
          <li>
            <b>User + outbound</b> — select or create a user, set <b>To</b> to an E.164 the Mac can iMessage, enqueue; watch
            status go to <code>sent</code> (or see error) in the table below.
          </li>
        </ol>
        {healthBase ? (
          <p style={{ marginTop: "0.75rem" }}>
            <b>Worker (remote check):</b>{" "}
            {workerHealth && "error" in workerHealth ? (
              <span style={{ color: "#b91c1c" }}>unreachable</span>
            ) : workerHealth && "ok" in workerHealth ? (
              <span style={{ color: workerHealth.ok ? "#15803d" : "#b45309" }}>
                {workerHealth.ok ? "ready" : "degraded"}
                {typeof workerHealth.uptimeSec === "number" ? ` (up ${workerHealth.uptimeSec}s)` : ""}
              </span>
            ) : (
              <span style={{ color: "#64748b" }}>…</span>
            )}{" "}
            <span style={{ color: "#64748b", fontSize: "0.85rem" }}>({healthBase}/health)</span>
          </p>
        ) : (
          <p style={{ marginTop: "0.75rem", color: "#64748b", fontSize: "0.9rem" }}>{WORKER_HELP}</p>
        )}
      </div>
      <p style={{ color: "#64748b", maxWidth: 640 }}>
        Outbound jobs are picked up by the <b>macOS worker</b> (Photon). Messages and the outbox for the selected user
        update in <b>real time</b> via Firestore.
      </p>
      {err ? <p className="panel" style={{ borderColor: "#fca5a5" }}>{err}</p> : null}

      <div className="panel" style={{ marginTop: "1rem" }}>
        <h3>User</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "end" }}>
          <label>
            Select user
            <br />
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              style={{ minWidth: 220 }}
            >
              <option value="">—</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.phoneE164 || u.id}
                </option>
              ))}
            </select>
          </label>
          <form onSubmit={onCreateUser} style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
            <label>
              Or create (E.164)
              <br />
              <input
                value={createPhone}
                onChange={(e) => setCreatePhone(e.target.value)}
                placeholder="+1…"
              />
            </label>
            <button type="submit" disabled={busy}>
              Create user
            </button>
          </form>
        </div>
        {selected ? (
          <p style={{ marginTop: "0.75rem", color: "#64748b", fontSize: "0.9rem" }}>
            Onboarding: {selected.onboardingStatus ?? "—"} ·{" "}
            <Link to={`/users/${selected.id}`}>Open user detail</Link>
          </p>
        ) : null}
      </div>

      <div className="panel" style={{ marginTop: "1rem" }}>
        <h3>Assign agent</h3>
        <select
          value={selected?.activeAgentId || ""}
          onChange={(e) => onAssignAgent(e.target.value)}
          disabled={!userId}
        >
          <option value="">—</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <div className="panel" style={{ marginTop: "1rem" }}>
        <h3>Enqueue outbound (pa_outbound)</h3>
        <form onSubmit={onEnqueueOutbound}>
          <label>
            To (E.164)
            <br />
            <input
              style={{ width: "100%", maxWidth: 360 }}
              value={toE164}
              onChange={(e) => setToE164(e.target.value)}
              placeholder="+1…"
              disabled={!userId}
            />
          </label>
          <label>
            Body
            <br />
            <textarea
              style={{ width: "100%", minHeight: 72, maxWidth: 480 }}
              value={outBody}
              onChange={(e) => setOutBody(e.target.value)}
              disabled={!userId}
            />
          </label>
          <p>
            <button type="submit" disabled={busy || !userId}>
              Enqueue send
            </button>
          </p>
        </form>
      </div>

      <p>
        <button type="button" onClick={() => void loadUsersAndAgents()} disabled={busy}>
          Refresh user &amp; agent lists
        </button>
      </p>

      <h2>Messages (pa_messages)</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Role</th>
            <th>Text</th>
          </tr>
        </thead>
        <tbody>
          {messages.map((m) => (
            <tr key={m.id}>
              <td style={{ whiteSpace: "nowrap" }}>{m.createdAt?.slice(0, 19) || m.id}</td>
              <td>{m.role}</td>
              <td style={{ maxWidth: 480 }}>{m.body}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Outbound queue</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Status</th>
            <th>To</th>
            <th>Body</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {outbound.map((o) => (
            <tr key={o.id}>
              <td style={{ whiteSpace: "nowrap" }}>{o.createdAt?.slice(0, 19) || o.id}</td>
              <td>{o.status}</td>
              <td>{o.toE164}</td>
              <td style={{ maxWidth: 240 }}>{o.body}</td>
              <td style={{ color: "#b91c1c" }}>{o.error || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
