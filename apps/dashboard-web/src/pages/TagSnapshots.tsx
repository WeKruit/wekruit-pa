/**
 * v1.8 Phase 79 — Tag snapshot list + rollback UI.
 *
 * Renders pa-users-tag-snapshots/{uid}/snapshots ordered by ts desc.
 * Shows: timestamp, reason (pre_compaction / manual / migration), diff
 * vs current pa-users.{uid}.tags. Rollback button writes a
 * pa-tag-rollback-events audit row AND restores pa-users.{uid}.tags from
 * the snapshot (through a Cloud Function callable when wired; for now a
 * direct Firestore write gated by isPaOperator rules).
 *
 * PS13 (30-day retention) — snapshots older than 30d are GC'd by
 * paMemoryCompactionGc CF; UI just renders what's there.
 */
import { useEffect, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import { addDoc, collection, doc, getDoc, getDocs, orderBy, query, setDoc } from "firebase/firestore"
import { ErrorState, LoadingState, PageHeader, Panel, StatusBadge } from "../components/ui.js"
import { db } from "../lib/firebase.js"

type SnapshotDoc = {
  id: string
  ts: string
  reason: "pre_compaction" | "manual" | "migration"
  tagsBefore: Record<string, unknown> | null
  triggeredBy?: {
    turnCount: number
    firstTurnTs: string
    lastTurnTs: string
  }
}

function diffSummary(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  const b = before ?? {}
  const a = after ?? {}
  const keys = new Set([...Object.keys(b), ...Object.keys(a)])
  for (const k of keys) {
    if (!(k in b)) {
      added.push(k)
    } else if (!(k in a)) {
      removed.push(k)
    } else if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) {
      changed.push(k)
    }
  }
  return { added, removed, changed }
}

export default function TagSnapshots() {
  const { uid } = useParams<{ uid: string }>()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [snapshots, setSnapshots] = useState<SnapshotDoc[]>([])
  const [currentTags, setCurrentTags] = useState<Record<string, unknown> | null>(null)
  const [rollbackMsg, setRollbackMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!uid) {
      setErr("missing uid in route")
      setLoading(false)
      return () => {}
    }
    void (async () => {
      try {
        setLoading(true)
        const [snapsSnap, userSnap] = await Promise.all([
          getDocs(
            query(
              collection(db, "pa-users-tag-snapshots", uid, "snapshots"),
              orderBy("ts", "desc")
            )
          ),
          getDoc(doc(db, "pa-users", uid)),
        ])
        if (cancelled) return
        setSnapshots(
          snapsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SnapshotDoc, "id">) }))
        )
        const userData = userSnap.data()
        setCurrentTags(
          userData && typeof userData.tags === "object" ? (userData.tags as Record<string, unknown>) : null
        )
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [uid])

  const handleRollback = async (snap: SnapshotDoc) => {
    if (!uid) return
    if (
      !confirm(
        `Roll back pa-users/${uid}.tags to snapshot from ${snap.ts}?\n\nThis writes pa-tag-rollback-events audit row + overwrites current tags.`
      )
    ) {
      return
    }
    setBusy(true)
    setRollbackMsg(null)
    try {
      // Audit first (so we have a record even if the write fails).
      await addDoc(collection(db, "pa-tag-rollback-events"), {
        uid,
        snapshotId: snap.id,
        snapshotTs: snap.ts,
        triggeredAt: new Date().toISOString(),
        tagsBeforeRollback: currentTags,
        tagsRestored: snap.tagsBefore,
      })
      // Write — restores the snapshot's tagsBefore to pa-users/{uid}.tags.
      await setDoc(
        doc(db, "pa-users", uid),
        { tags: snap.tagsBefore ?? {} },
        { merge: true }
      )
      setCurrentTags(snap.tagsBefore)
      setRollbackMsg(`Rolled back to snapshot ${snap.id}. Audit row written.`)
    } catch (e) {
      setRollbackMsg(`Rollback failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const sortedSnapshots = useMemo(() => snapshots, [snapshots])

  if (loading) return <LoadingState label="Loading snapshots..." />
  if (err) return <ErrorState message={err} />

  return (
    <div>
      <PageHeader
        title={`Tag Snapshots: ${uid}`}
        subtitle="Pre-compaction snapshots of pa-users.{uid}.tags. PS13 — 30-day retention, GC'd nightly."
      />

      {rollbackMsg && (
        <Panel title="Status">
          <StatusBadge tone="info">{rollbackMsg}</StatusBadge>
        </Panel>
      )}

      <Panel title={`${sortedSnapshots.length} snapshot${sortedSnapshots.length === 1 ? "" : "s"}`}>
        {sortedSnapshots.length === 0 && (
          <p style={{ opacity: 0.7 }}>No snapshots yet. Snapshots are written by paMemoryCompaction Cloud Functions.</p>
        )}
        {sortedSnapshots.map((snap) => {
          const diff = diffSummary(snap.tagsBefore, currentTags)
          return (
            <div
              key={snap.id}
              style={{
                marginBottom: "0.75rem",
                border: "1px solid rgba(0,0,0,0.1)",
                borderRadius: 4,
                padding: "0.5rem",
              }}
            >
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                <strong style={{ fontFamily: "monospace", fontSize: "0.85em" }}>{snap.ts}</strong>
                <StatusBadge
                  tone={snap.reason === "pre_compaction" ? "info" : snap.reason === "migration" ? "ok" : "warn"}
                >
                  {snap.reason}
                </StatusBadge>
                {snap.triggeredBy && (
                  <span style={{ fontSize: "0.8em", opacity: 0.7 }}>
                    {snap.triggeredBy.turnCount} turns
                  </span>
                )}
                <button
                  onClick={() => handleRollback(snap)}
                  disabled={busy}
                  style={{
                    marginLeft: "auto",
                    padding: "0.25rem 0.5rem",
                    fontSize: "0.85em",
                  }}
                >
                  {busy ? "..." : "Roll back"}
                </button>
              </div>
              <div style={{ marginTop: "0.5rem", fontSize: "0.85em" }}>
                Diff vs current:{" "}
                {diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0 ? (
                  <em>no diff</em>
                ) : (
                  <>
                    {diff.added.length > 0 && <StatusBadge tone="ok">+{diff.added.length} added</StatusBadge>}{" "}
                    {diff.removed.length > 0 && (
                      <StatusBadge tone="warn">-{diff.removed.length} removed</StatusBadge>
                    )}{" "}
                    {diff.changed.length > 0 && (
                      <StatusBadge tone="info">~{diff.changed.length} changed</StatusBadge>
                    )}
                  </>
                )}
              </div>
              {diff.added.length + diff.removed.length + diff.changed.length > 0 && (
                <details style={{ marginTop: "0.25rem" }}>
                  <summary style={{ fontSize: "0.8em", cursor: "pointer" }}>diff detail</summary>
                  <div style={{ fontSize: "0.75em", fontFamily: "monospace", marginTop: "0.25rem" }}>
                    {diff.added.length > 0 && <div>added: {diff.added.join(", ")}</div>}
                    {diff.removed.length > 0 && <div>removed: {diff.removed.join(", ")}</div>}
                    {diff.changed.length > 0 && <div>changed: {diff.changed.join(", ")}</div>}
                  </div>
                </details>
              )}
            </div>
          )
        })}
      </Panel>

      <Panel title="Current pa-users.tags">
        <pre
          style={{
            fontSize: "0.8em",
            background: "rgba(0,0,0,0.04)",
            padding: "0.5rem",
            borderRadius: 4,
            overflow: "auto",
            maxHeight: "300px",
          }}
        >
          {JSON.stringify(currentTags ?? {}, null, 2)}
        </pre>
      </Panel>
    </div>
  )
}
