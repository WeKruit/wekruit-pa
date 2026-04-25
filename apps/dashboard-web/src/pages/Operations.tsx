import { PA_COLLECTIONS } from "@pa/core-types"
import { collection, getDocs, limit, query } from "firebase/firestore"
import { useCallback, useEffect, useMemo, useState } from "react"
import { db } from "../lib/firebase.js"
import { fetchWorkerHealth, getWorkerHealthBaseUrl, type WorkerHealth } from "../lib/workerHealth.js"

type Row = Record<string, unknown> & { id: string; status?: string; createdAt?: string; errorCode?: string; error?: string }

function countBy(rows: Row[], key: string) {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const value = String(row[key] ?? "unknown")
    acc[value] = (acc[value] ?? 0) + 1
    return acc
  }, {})
}

function asRows(snap: Awaited<ReturnType<typeof getDocs>>): Row[] {
  return snap.docs
    .map((d) => {
      const data = d.data() as Record<string, unknown>
      return { id: d.id, ...data } as Row
    })
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
}

export function Operations() {
  const [inbound, setInbound] = useState<Row[]>([])
  const [turns, setTurns] = useState<Row[]>([])
  const [outbound, setOutbound] = useState<Row[]>([])
  const [memoryActions, setMemoryActions] = useState<Row[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [workerHealth, setWorkerHealth] = useState<WorkerHealth | null>(null)
  const [workerHealthErr, setWorkerHealthErr] = useState<string | null>(null)
  const workerHealthUrl = getWorkerHealthBaseUrl()

  const load = useCallback(async () => {
    setErr(null)
    const fire = db()
    const [i, t, o, ma] = await Promise.all([
      getDocs(query(collection(fire, PA_COLLECTIONS.inboundEvents), limit(200))),
      getDocs(query(collection(fire, PA_COLLECTIONS.turns), limit(200))),
      getDocs(query(collection(fire, PA_COLLECTIONS.outbound), limit(200))),
      getDocs(query(collection(fire, PA_COLLECTIONS.memoryActions), limit(200))),
    ])
    setInbound(asRows(i))
    setTurns(asRows(t))
    setOutbound(asRows(o))
    setMemoryActions(asRows(ma))
  }, [])

  useEffect(() => {
    load().catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [load])

  useEffect(() => {
    if (!workerHealthUrl) return
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

  const stuckOutbound = useMemo(
    () =>
      outbound.filter((row) => {
        if (row.status !== "sending") return false
        const leaseUntil = typeof row.leaseUntil === "string" ? Date.parse(row.leaseUntil) : 0
        return !Number.isFinite(leaseUntil) || leaseUntil <= Date.now()
      }),
    [outbound]
  )
  const failedTurns = turns.filter((row) => row.status === "failed")
  const memoryDegraded = turns.filter((row) => row.mem0Degraded === true)

  return (
    <div>
      <h1>Operations</h1>
      {err ? <p className="panel" style={{ borderColor: "#fca5a5" }}>{err}</p> : null}
      <div className="ops-grid">
        <div className="panel">
          <h3>Worker</h3>
          {workerHealthUrl ? (
            workerHealthErr ? (
              <p style={{ color: "#b91c1c" }}>Health error: {workerHealthErr}</p>
            ) : workerHealth ? (
              <p style={{ color: workerHealth.mem0ApiKeyPresent === false ? "#b45309" : "#15803d" }}>
                {workerHealth.service || "worker"} · Mem0 key {workerHealth.mem0ApiKeyPresent ? "present" : "absent"}
              </p>
            ) : (
              <p>Loading…</p>
            )
          ) : (
            <p style={{ color: "#64748b" }}>Set VITE_WORKER_HEALTH_URL to show worker readiness.</p>
          )}
        </div>
        <div className="panel">
          <h3>Inbound</h3>
          <pre>{JSON.stringify(countBy(inbound, "status"), null, 2)}</pre>
        </div>
        <div className="panel">
          <h3>Turns</h3>
          <p>Failed: {failedTurns.length}</p>
          <p>Memory degraded: {memoryDegraded.length}</p>
        </div>
        <div className="panel">
          <h3>Outbound</h3>
          <pre>{JSON.stringify(countBy(outbound, "status"), null, 2)}</pre>
          {stuckOutbound.length > 0 ? <p style={{ color: "#b91c1c" }}>Stuck sending: {stuckOutbound.length}</p> : null}
        </div>
      </div>

      <h2>Recent failures</h2>
      <table>
        <thead>
          <tr>
            <th>Kind</th>
            <th>Time</th>
            <th>Status</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {[...failedTurns.map((r) => ({ ...r, kind: "turn" })), ...outbound.filter((r) => r.status === "failed").map((r) => ({ ...r, kind: "outbound" }))].slice(0, 30).map((r) => (
            <tr key={`${r.kind}-${r.id}`}>
              <td>{r.kind}</td>
              <td>{String(r.createdAt ?? "").slice(0, 19)}</td>
              <td>{r.status}</td>
              <td>{r.errorCode ? `${r.errorCode}: ` : ""}{String(r.error ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Recent memory actions</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Status</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {memoryActions.slice(0, 30).map((r) => (
            <tr key={r.id}>
              <td>{String(r.createdAt ?? "").slice(0, 19)}</td>
              <td>{String(r.action ?? "")}</td>
              <td>{r.status}</td>
              <td>{String(r.reason ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <button type="button" onClick={() => void load()}>Refresh</button>
      </p>
    </div>
  )
}
