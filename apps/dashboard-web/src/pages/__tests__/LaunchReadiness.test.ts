import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"

import {
  LAUNCH_READINESS_ROUTE,
  LAUNCH_READINESS_SNAPSHOT_CALLABLE,
  OUTREACH_STOP_CONTROL_CALLABLE,
  buildLaunchReadinessSnapshotRequest,
  normalizeLaunchReadinessResult,
  type LaunchReadinessSnapshot,
} from "../../lib/launch-readiness-api.js"
import { LaunchReadinessSnapshotView } from "../LaunchReadinessView.js"

;(globalThis as typeof globalThis & { React: typeof React }).React = React

test("LaunchReadiness API helpers target the S9 admin callables", () => {
  assert.equal(LAUNCH_READINESS_ROUTE, "/admin/launch-readiness")
  assert.equal(LAUNCH_READINESS_SNAPSHOT_CALLABLE, "paAdminLaunchReadinessSnapshot")
  assert.equal(OUTREACH_STOP_CONTROL_CALLABLE, "paAdminOutreachStopControl")
  assert.deepEqual(buildLaunchReadinessSnapshotRequest(500), { limit: 100, persistSnapshot: true })
  assert.deepEqual(buildLaunchReadinessSnapshotRequest(0, false), { limit: 25, persistSnapshot: false })
})

test("LaunchReadiness route and nav are wired under admin platform only", () => {
  const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8")
  const sidebarSource = readFileSync(
    new URL("../../components/console/Sidebar.tsx", import.meta.url),
    "utf8",
  )

  assert.match(appSource, /import LaunchReadiness from "\.\/pages\/LaunchReadiness\.js"/)
  assert.match(sidebarSource, /to: "\/admin\/launch-readiness"/)
  assert.match(appSource, /<Route path="\/admin\/launch-readiness" element={<LaunchReadiness \/>} \/>/)
  assert.doesNotMatch(appSource, /<Route path="\/j\/:jobId"/)
  assert.doesNotMatch(sidebarSource, /to: "\/j\//)
})

test("LaunchReadiness page renders readiness status request queue and stop controls", () => {
  const snapshot: LaunchReadinessSnapshot = {
    snapshotId: "launch_readiness_2026-05-14T01-00-00-000Z",
    generatedAt: "2026-05-14T01:00:00.000Z",
    status: "yellow",
    counts: {
      privacyTotal: 1,
      privacyOpen: 1,
      pausedControls: 1,
    },
    sections: [
      {
        key: "privacy_requests",
        label: "Privacy Requests",
        status: "yellow",
        count: 1,
        summary: "1 open privacy request needs operator review.",
        sourceRoute: "/admin/launch-readiness",
      },
      {
        key: "outreach_stop_controls",
        label: "Outreach Stop Controls",
        status: "yellow",
        count: 1,
        summary: "Global marketplace outreach is paused.",
      },
    ],
    privacyRequests: [
      {
        requestId: "privacy_request_delete__cand-1",
        kind: "delete",
        status: "submitted",
        candidateId: "cand-1",
        sourceSurface: "me_profile",
        createdAt: "2026-05-14T00:55:00.000Z",
        updatedAt: "2026-05-14T00:55:00.000Z",
      },
    ],
    stopControls: [
      {
        controlId: "outreach_stop_global",
        scope: "global",
        paused: true,
        reason: "launch readiness pause",
        updatedAt: "2026-05-14T00:57:00.000Z",
      },
    ],
  }

  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(LaunchReadinessSnapshotView, { snapshot }),
    ),
  )

  assert.match(html, /Readiness Overview/)
  assert.match(html, /yellow/)
  assert.match(html, /Privacy Requests/)
  assert.match(html, /privacy_request_delete__cand-1/)
  assert.match(html, /Outreach Stop Controls/)
  assert.match(html, /outreach_stop_global/)
  assert.match(html, /paused/)
  assert.doesNotMatch(html, /candidate@example\.com/)
  assert.doesNotMatch(html, /\+15555550100/)
  assert.doesNotMatch(html, /raw transcript/)
})

test("LaunchReadiness normalization creates empty snapshot state", () => {
  const result = normalizeLaunchReadinessResult(null, { limit: 25, persistSnapshot: true })
  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(LaunchReadinessSnapshotView, { snapshot: result.snapshot }),
    ),
  )

  assert.equal(result.ok, true)
  assert.equal(result.snapshot.status, "unknown")
  assert.match(html, /No privacy requests/)
  assert.match(html, /No stop controls/)
})
