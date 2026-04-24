import { PA_COLLECTIONS } from "@pa/core-types"
import { collection, doc, getDoc, getDocs, onSnapshot, query, updateDoc, where } from "firebase/firestore"
import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { db } from "../lib/firebase.js"
import { fetchWorkerHealth, getWorkerHealthBaseUrl, type WorkerHealth } from "../lib/workerHealth.js"

type U = { id: string; phoneE164?: string; activeAgentId?: string; onboardingStatus?: string }
type M = { id: string; role?: string; body?: string; createdAt?: string; sessionId?: string }

export function UserDetail() {
  const { id } = useParams()
  const [user, setUser] = useState<U | null>(null)
  const [messages, setMessages] = useState<M[]>([])
  const [agents, setAgents] = useState<{ id: string; name: string; memoryMode?: string }[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [workerHealth, setWorkerHealth] = useState<WorkerHealth | null>(null)
  const [workerHealthErr, setWorkerHealthErr] = useState<string | null>(null)
  const workerHealthUrl = getWorkerHealthBaseUrl()

  useEffect(() => {
    if (!id) return
    let cancelled = false
    ;(async () => {
      try {
        const u = await getDoc(doc(db(), PA_COLLECTIONS.users, id))
        if (cancelled) return
        if (u.exists()) setUser({ id: u.id, ...u.data() } as U)
        const ag = await getDocs(collection(db(), PA_COLLECTIONS.agents))
        if (cancelled) return
        setAgents(
          ag.docs.map((d) => {
            const raw = d.data() as { name?: string; memoryMode?: string }
            return {
              id: d.id,
              name: String(raw.name || d.id),
              memoryMode: String(raw.memoryMode || "firestore_only"),
            }
          })
        )
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    if (!workerHealthUrl) {
      setWorkerHealth(null)
      setWorkerHealthErr(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const { health, err: he } = await fetchWorkerHealth()
      if (cancelled) return
      setWorkerHealth(health)
      setWorkerHealthErr(he)
    })()
    return () => {
      cancelled = true
    }
  }, [workerHealthUrl])

  useEffect(() => {
    if (!id) return
    const mq = query(collection(db(), PA_COLLECTIONS.messages), where("userId", "==", id))
    return onSnapshot(
      mq,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as M[]
        list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        setMessages(list)
      },
      (e) => setErr(e.message)
    )
  }, [id])

  async function onAssign(aid: string) {
    if (!id) return
    await updateDoc(doc(db(), PA_COLLECTIONS.users, id), { activeAgentId: aid })
    setUser((u) => (u ? { ...u, activeAgentId: aid } : u))
  }

  if (err) return <div className="panel">Error: {err}</div>
  if (!user) return <div className="panel">Loading…</div>

  const activeAgent = agents.find((a) => a.id === user.activeAgentId)

  return (
    <div>
      <p>
        <Link to="/">← Users</Link>
      </p>
      <h1>{user.phoneE164 || user.id}</h1>
      <div className="panel">
        <h3>Assign agent</h3>
        <select
          value={user.activeAgentId || ""}
          onChange={(e) => onAssign(e.target.value)}
        >
          <option value="">—</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <p style={{ color: "#64748b", fontSize: "0.85rem" }}>
          Onboarding: {user.onboardingStatus || "—"} · Messages below are the Firestore transcript (live).
        </p>
        {activeAgent && (
          <p style={{ color: "#64748b", fontSize: "0.85rem" }}>
            Active agent <code>{activeAgent.id}</code> — memory mode: <b>{activeAgent.memoryMode}</b>
            {workerHealthUrl ? (
              workerHealthErr ? (
                <> — worker Mem0 env: <span style={{ color: "#b91c1c" }}>health error ({workerHealthErr})</span></>
              ) : workerHealth ? (
                <>
                  {" "}
                  — worker <code>MEM0_API_KEY</code>:{" "}
                  <b>{workerHealth.mem0ApiKeyPresent ? "present" : "absent"}</b>
                  {(activeAgent.memoryMode === "mem0" || activeAgent.memoryMode === "both") &&
                    workerHealth.mem0ApiKeyPresent === false && (
                      <span style={{ color: "#b45309" }}> (Mem0 features will degrade)</span>
                    )}
                </>
              ) : (
                <> — worker health: loading…</>
              )
            ) : (
              <> — set <code>VITE_WORKER_HEALTH_URL</code> to see Mem0 key status on the worker</>
            )}
            .
          </p>
        )}
      </div>
      <h2>Messages</h2>
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
    </div>
  )
}
