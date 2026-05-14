import * as React from "react"
import { useEffect, useMemo, useState, type CSSProperties } from "react"

import { ErrorState, LoadingState, PageHeader, Panel } from "../components/ui.js"
import {
  LAUNCH_READINESS_DEFAULT_LIMIT,
  LAUNCH_READINESS_ROUTE,
  buildLaunchReadinessSnapshotRequest,
  getLaunchReadinessSnapshot,
  setOutreachStopControl,
  type LaunchReadinessResult,
  type LaunchReadinessSnapshotRequest,
} from "../lib/launch-readiness-api.js"
import { Fact, LaunchReadinessSnapshotView, formatTimestamp } from "./LaunchReadinessView.js"

type SnapshotLoader = (request: LaunchReadinessSnapshotRequest) => Promise<LaunchReadinessResult>
type StopControlWriter = typeof setOutreachStopControl

export default function LaunchReadiness({
  loadSnapshot = getLaunchReadinessSnapshot,
  writeStopControl = setOutreachStopControl,
}: {
  loadSnapshot?: SnapshotLoader
  writeStopControl?: StopControlWriter
}) {
  const [limit, setLimit] = useState(LAUNCH_READINESS_DEFAULT_LIMIT)
  const [result, setResult] = useState<LaunchReadinessResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState("launch readiness pause")
  const [controlSaving, setControlSaving] = useState(false)

  async function refresh(nextLimit = limit): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      setResult(await loadSnapshot(buildLaunchReadinessSnapshotRequest(nextLimit, true)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh(LAUNCH_READINESS_DEFAULT_LIMIT)
    // Initial snapshot only; explicit refresh below reloads with current limit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSnapshot])

  const snapshot = result?.snapshot ?? null
  const globalControl = useMemo(
    () => snapshot?.stopControls.find((control) => control.scope === "global"),
    [snapshot],
  )
  const globalPaused = Boolean(globalControl?.paused)

  async function toggleGlobalPause(): Promise<void> {
    setControlSaving(true)
    setError(null)
    try {
      await writeStopControl({
        scope: "global",
        paused: !globalPaused,
        reason: !globalPaused ? reason.trim() || "launch readiness pause" : undefined,
      })
      await refresh(limit)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setControlSaving(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="v2.0 S9 / Admin"
        title="Launch Readiness"
        description="Privacy request queue, outreach stop controls, and delivery gate state for candidate marketplace launch."
        actions={
          <button type="button" onClick={() => void refresh()} disabled={loading} style={buttonStyle(loading)}>
            {loading ? "Loading" : "Refresh"}
          </button>
        }
      />

      <Panel title="Global Marketplace Outreach" eyebrow={LAUNCH_READINESS_ROUTE}>
        <div style={controlGridStyle}>
          <Fact label="global gate" value={globalPaused ? "paused" : "open"} />
          <Fact label="snapshot" value={snapshot?.snapshotId ?? "-"} />
          <Fact label="generated" value={formatTimestamp(snapshot?.generatedAt)} />
          <label style={labelStyle}>
            <span>Pause reason</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={controlSaving || globalPaused}
              style={inputStyle}
            />
          </label>
          <button type="button" onClick={() => void toggleGlobalPause()} disabled={controlSaving} style={buttonStyle(controlSaving)}>
            {controlSaving ? "Saving" : globalPaused ? "Resume outreach" : "Pause outreach"}
          </button>
        </div>
      </Panel>

      <Panel title="Snapshot Scope">
        <div style={controlGridStyle}>
          <label style={labelStyle}>
            <span>Recent row limit</span>
            <input
              type="number"
              min={1}
              max={100}
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              style={inputStyle}
            />
          </label>
          <Fact label="privacy rows" value={snapshot?.counts.privacyTotal ?? 0} />
          <Fact label="open privacy" value={snapshot?.counts.privacyOpen ?? 0} />
          <Fact label="paused controls" value={snapshot?.counts.pausedControls ?? 0} />
        </div>
      </Panel>

      {error ? (
        <Panel title="Launch Readiness Error" eyebrow="callable failure">
          <ErrorState message={error} />
        </Panel>
      ) : null}

      {loading && !snapshot ? (
        <Panel title="Loading Snapshot">
          <LoadingState label="Loading launch readiness snapshot..." />
        </Panel>
      ) : null}

      {snapshot ? <LaunchReadinessSnapshotView snapshot={snapshot} /> : null}
    </div>
  )
}

function buttonStyle(disabled?: boolean): CSSProperties {
  return {
    minHeight: 38,
    border: "1px solid #284238",
    borderRadius: 8,
    padding: "0 14px",
    background: disabled ? "#e5e7eb" : "#284238",
    color: disabled ? "#6b7280" : "#fff",
    fontWeight: 800,
    cursor: disabled ? "not-allowed" : "pointer",
  }
}

const controlGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
  alignItems: "end",
}

const labelStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  fontWeight: 800,
}

const inputStyle: CSSProperties = {
  minHeight: 38,
  border: "1px solid #d1d5db",
  borderRadius: 8,
  padding: "0 10px",
  font: "inherit",
}
