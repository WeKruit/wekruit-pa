/**
 * v1.9 Phase 88 — /admin/sendblue-pool.
 *
 * Read + edit pa-config/sendblue-pool { numbers: [{number, status, capacity}] }.
 * Add / remove / pause numbers. Single-number BC preserved.
 */
import { useEffect, useState } from "react"
import { doc, getDoc, setDoc } from "firebase/firestore"
import { db } from "../lib/firebase.js"
import { Badge, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"

interface PoolNumber {
  number: string
  status: "active" | "paused"
  capacity?: number
}

interface PoolConfig {
  numbers: PoolNumber[]
}

export default function SendbluePool() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [pool, setPool] = useState<PoolConfig>({ numbers: [] })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const snap = await getDoc(doc(db(), "pa-config", "sendblue-pool"))
        if (cancelled) return
        if (snap.exists()) {
          setPool(snap.data() as PoolConfig)
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function updateNumber(i: number, patch: Partial<PoolNumber>) {
    setPool((p) => ({
      ...p,
      numbers: p.numbers.map((n, idx) => (idx === i ? { ...n, ...patch } : n)),
    }))
  }
  function addNumber() {
    setPool((p) => ({
      ...p,
      numbers: [...p.numbers, { number: "", status: "paused", capacity: 1000 }],
    }))
  }
  function removeNumber(i: number) {
    setPool((p) => ({ ...p, numbers: p.numbers.filter((_, idx) => idx !== i) }))
  }

  async function save() {
    setSaving(true)
    setMsg(null)
    try {
      const filtered = {
        numbers: pool.numbers
          .map((n) => ({ ...n, number: n.number.trim() }))
          .filter((n) => n.number),
      }
      await setDoc(doc(db(), "pa-config", "sendblue-pool"), filtered)
      setMsg("Saved ✓")
    } catch (e) {
      setMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <LoadingState label="Loading pool..." />
  if (err) return <ErrorState message={err} />

  const active = pool.numbers.filter((n) => n.status === "active").length

  return (
    <div>
      <PageHeader
        title="Sendblue Pool"
        description="Outbound iMessage number rotation. sendImessage routes per user via hash(userId) mod activeNumbers. Empty pool falls back to SENDBLUE_FROM_NUMBER env."
      />
      <Panel
        title={
          <>
            {pool.numbers.length} number(s) · <Badge tone="ok">{active} active</Badge>
          </>
        }
      >
        <table style={{ width: "100%", fontSize: "0.9em" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Number (E.164)</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th style={{ textAlign: "left" }}>Daily cap</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pool.numbers.map((n, i) => (
              <tr key={i}>
                <td>
                  <input
                    value={n.number}
                    onChange={(e) => updateNumber(i, { number: e.target.value })}
                    placeholder="+1..."
                    style={{ width: "100%", fontFamily: "monospace" }}
                  />
                </td>
                <td>
                  <select
                    value={n.status}
                    onChange={(e) =>
                      updateNumber(i, { status: e.target.value as "active" | "paused" })
                    }
                  >
                    <option value="active">active</option>
                    <option value="paused">paused</option>
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    value={n.capacity ?? 1000}
                    onChange={(e) => updateNumber(i, { capacity: parseInt(e.target.value, 10) || 0 })}
                    style={{ width: "100px" }}
                  />
                </td>
                <td>
                  <button onClick={() => removeNumber(i)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
          <button onClick={addNumber}>+ Add number</button>
          <button
            onClick={save}
            disabled={saving}
            style={{ background: "#1e6f4e", color: "white", border: "none", padding: "0.5rem 1rem", borderRadius: 6 }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {msg && <span style={{ marginLeft: "0.5rem", color: msg.startsWith("Save failed") ? "red" : "rgba(0,120,40,1)" }}>{msg}</span>}
        </div>
      </Panel>
    </div>
  )
}
