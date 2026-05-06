/**
 * v1.6 Phase 59 — `/admin/qa-evaluator` page. [DASH-03]
 *
 * Displays weekly QA evaluator runs (Phase 61 produces the data, Phase 59
 * displays it). Each run = 100 user×match sample, hard-filter pass rate +
 * top-3 acceptable rate via Qwen-7B judge.
 *
 * Two views:
 *   - List: latest 20 runs by `runAt` desc
 *   - Detail: clicking a run opens per-pair drill-down (raw JSON)
 *
 * Adam-locked decisions:
 *  - D13: QA evaluator runs weekly auto-eval; loop until milestone-shipped
 *
 * Auth: behind dashboard sign-in wall (admin-only convention mirrors
 * /match/weights, /admin/flags).
 */
import { useEffect, useState } from "react"
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit as fsLimit,
  orderBy,
  query,
} from "firebase/firestore"

import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from "../components/ui.js"
import { db } from "../lib/firebase.js"

const QA_RUNS_COLLECTION = "pa-qa-evaluator-runs"

interface QaRun {
  runId: string
  runAt: string
  sampleSize: number
  hardFilterPassRate: number
  top3AcceptableRate: number
  alertSent: boolean
  /** Inline pair details (some runs may inline; others use subcollection). */
  pairs?: unknown[]
  /** Anything else the run writes (we render as raw JSON in detail view). */
  [key: string]: unknown
}

function pct(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(1)}%`
}

function fmtTime(iso: string | undefined): string {
  if (!iso) return "—"
  return iso.slice(0, 19).replace("T", " ")
}

export function QaEvaluator() {
  const [runs, setRuns] = useState<QaRun[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<QaRun | null>(null)
  const [detail, setDetail] = useState<QaRun | null>(null)
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setRuns(null)
    setErr(null)
    const q = query(
      collection(db(), QA_RUNS_COLLECTION),
      orderBy("runAt", "desc"),
      fsLimit(20),
    )
    getDocs(q)
      .then((snap) => {
        if (cancelled) return
        const rows = snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          return {
            runId: d.id,
            runAt: typeof data.runAt === "string" ? data.runAt : "",
            sampleSize:
              typeof data.sampleSize === "number" ? data.sampleSize : 0,
            hardFilterPassRate:
              typeof data.hardFilterPassRate === "number"
                ? data.hardFilterPassRate
                : 0,
            top3AcceptableRate:
              typeof data.top3AcceptableRate === "number"
                ? data.top3AcceptableRate
                : 0,
            alertSent: data.alertSent === true,
            ...data,
          } as QaRun
        })
        setRuns(rows)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  // Load detail (full doc with pairs) when a run is selected.
  useEffect(() => {
    if (!selected) {
      setDetail(null)
      setDetailErr(null)
      return
    }
    let cancelled = false
    setDetail(null)
    setDetailErr(null)
    getDoc(doc(db(), QA_RUNS_COLLECTION, selected.runId))
      .then((d) => {
        if (cancelled) return
        if (!d.exists()) {
          setDetailErr("Run not found")
          return
        }
        const data = d.data() as Record<string, unknown>
        setDetail({
          runId: d.id,
          runAt: typeof data.runAt === "string" ? data.runAt : "",
          sampleSize: typeof data.sampleSize === "number" ? data.sampleSize : 0,
          hardFilterPassRate:
            typeof data.hardFilterPassRate === "number"
              ? data.hardFilterPassRate
              : 0,
          top3AcceptableRate:
            typeof data.top3AcceptableRate === "number"
              ? data.top3AcceptableRate
              : 0,
          alertSent: data.alertSent === true,
          ...data,
        } as QaRun)
      })
      .catch((e) => {
        if (!cancelled) setDetailErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  if (selected) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="v1.6 Phase 59 / Admin"
          title={`QA Run: ${selected.runId}`}
          description={`runAt=${fmtTime(selected.runAt)} · sampleSize=${selected.sampleSize}`}
          actions={
            <button type="button" onClick={() => setSelected(null)}>
              ← Back to runs
            </button>
          }
        />
        <Panel title="Summary" eyebrow="metrics">
          <ul style={{ margin: 0, fontSize: "0.9em", lineHeight: 1.6 }}>
            <li>
              Hard-filter pass rate: <strong>{pct(selected.hardFilterPassRate)}</strong>
            </li>
            <li>
              Top-3 acceptable rate: <strong>{pct(selected.top3AcceptableRate)}</strong>
            </li>
            <li>
              Alert sent: <strong>{selected.alertSent ? "yes" : "no"}</strong>
            </li>
          </ul>
        </Panel>
        <Panel title="Per-pair detail" eyebrow="raw doc">
          {detailErr ? (
            <ErrorState message={detailErr} />
          ) : !detail ? (
            <LoadingState label="Loading detail…" />
          ) : (
            <pre
              style={{
                background: "#f8fafc",
                padding: "1rem",
                borderRadius: 6,
                fontSize: "0.75em",
                maxHeight: "60vh",
                overflow: "auto",
                margin: 0,
              }}
            >
              {JSON.stringify(detail, null, 2)}
            </pre>
          )}
        </Panel>
      </div>
    )
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v1.6 Phase 59 / Admin"
        title="QA Evaluator Runs"
        description="Weekly auto-eval runs (Phase 61 producer). 100 user×match samples per run; Qwen-7B judges hard-filter pass + top-3 acceptable. Loop until milestone-shipped (D13)."
        actions={
          <button type="button" onClick={() => setRefreshKey((n) => n + 1)}>
            Refresh
          </button>
        }
      />

      <Panel title="Recent runs" eyebrow={`${QA_RUNS_COLLECTION} · last 20`}>
        {err ? (
          <ErrorState message={err} />
        ) : runs === null ? (
          <LoadingState label="Loading runs…" />
        ) : runs.length === 0 ? (
          <EmptyState
            title="No runs yet"
            body="Phase 61 (paQaEvaluatorWeekly) runs Mon 09:00 UTC. After the first run, results land here."
          />
        ) : (
          <table style={{ width: "100%", fontSize: "0.85em" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                <th style={{ padding: "0.5rem 0" }}>Run at</th>
                <th style={{ padding: "0.5rem 0" }}>Sample size</th>
                <th style={{ padding: "0.5rem 0" }}>Hard-filter pass</th>
                <th style={{ padding: "0.5rem 0" }}>Top-3 acceptable</th>
                <th style={{ padding: "0.5rem 0" }}>Alert</th>
                <th style={{ padding: "0.5rem 0" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.runId}
                  style={{
                    borderBottom: "1px solid #f1f5f9",
                    background: r.alertSent ? "#fef2f2" : undefined,
                  }}
                >
                  <td style={{ padding: "0.4rem 0" }}>{fmtTime(r.runAt)}</td>
                  <td style={{ padding: "0.4rem 0" }}>{r.sampleSize}</td>
                  <td style={{ padding: "0.4rem 0" }}>{pct(r.hardFilterPassRate)}</td>
                  <td style={{ padding: "0.4rem 0" }}>{pct(r.top3AcceptableRate)}</td>
                  <td style={{ padding: "0.4rem 0" }}>
                    {r.alertSent ? (
                      <span className="status-badge bad">alert</span>
                    ) : (
                      <span style={{ color: "#94a3b8" }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: "0.4rem 0" }}>
                    <button
                      type="button"
                      onClick={() => setSelected(r)}
                      style={{
                        color: "#1a73e8",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        textDecoration: "underline",
                        padding: 0,
                      }}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
