import { PA_COLLECTIONS } from "@pa/core-types"
import { collection, getDocs, limit, query } from "firebase/firestore"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { db } from "../lib/firebase.js"

type Row = {
  id: string
  phoneE164?: string
  onboardingStatus?: string
  activeAgentId?: string
  createdAt?: string
}

export function Users() {
  const [rows, setRows] = useState<Row[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const q = query(collection(db(), PA_COLLECTIONS.users), limit(500))
        const snap = await getDocs(q)
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Row[]
        list.sort(
          (a, b) =>
            String(b.createdAt || "").localeCompare(String(a.createdAt || ""), undefined, { numeric: true })
        )
        setRows(list.slice(0, 200))
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  if (err) return <div className="panel">Error: {err}</div>

  return (
    <div>
      <h1>Users</h1>
      <table>
        <thead>
          <tr>
            <th>Phone</th>
            <th>Onboarding</th>
            <th>Active agent</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/users/${r.id}`}>{r.phoneE164 || r.id}</Link>
              </td>
              <td>{r.onboardingStatus}</td>
              <td>{r.activeAgentId || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
