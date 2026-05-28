/**
 * Unit tests — scrape-freshness-monitor.
 *
 * Coverage:
 *   - ok path: newest sync < 24h → no Slack call, ok severity
 *   - warn path: newest sync 30h → severity warn, Slack warn level
 *   - error path: newest sync 72h → severity error, Slack error level
 *   - empty pool: no active docs → severity error
 *   - audit doc always written (even on success)
 *   - slack helper failure surfaces as slackPosted=false but does not throw
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  runScrapeFreshnessMonitor,
  type MonitorStore,
  type ScrapeMonitorRunRecord,
  type RunScrapeFreshnessMonitorDeps,
} from "./scrape-freshness-monitor.js"
import type { SlackAlertResult } from "./lib/slack-alert.js"

/** Build a fake store that returns canned values + records writes. */
function makeFakeStore(opts: {
  newestSyncedAtMs: number | null
  freshDocsLast24h?: number
  writeShouldThrow?: boolean
}): {
  store: MonitorStore
  writes: ScrapeMonitorRunRecord[]
} {
  const writes: ScrapeMonitorRunRecord[] = []
  const store: MonitorStore = {
    readNewestSyncedAtMs: async () => opts.newestSyncedAtMs,
    countActiveSyncedSince: async () => opts.freshDocsLast24h ?? 0,
    writeRunRecord: async (record) => {
      if (opts.writeShouldThrow) throw new Error("firestore down")
      writes.push(record)
    },
  }
  return { store, writes }
}

/** Build a fake postSlack that records calls + returns canned result. */
function makeFakeSlack(result: SlackAlertResult): {
  postSlack: RunScrapeFreshnessMonitorDeps["postSlack"]
  calls: Array<{
    title: string
    message: string
    level: "warn" | "error" | "info"
    fields: { name: string; value: string }[]
  }>
} {
  const calls: Array<{
    title: string
    message: string
    level: "warn" | "error" | "info"
    fields: { name: string; value: string }[]
  }> = []
  const postSlack: RunScrapeFreshnessMonitorDeps["postSlack"] = async (
    title,
    message,
    level,
    fields
  ) => {
    calls.push({ title, message, level, fields })
    return result
  }
  return { postSlack, calls }
}

const NOW_MS = Date.parse("2026-05-27T12:00:00Z")

describe("runScrapeFreshnessMonitor", () => {
  it("ok path: <24h since last sync → no Slack call, ok severity", async () => {
    const { store, writes } = makeFakeStore({
      newestSyncedAtMs: NOW_MS - 6 * 3600 * 1000, // 6h ago
      freshDocsLast24h: 500,
    })
    const { postSlack, calls } = makeFakeSlack({ posted: true })

    const result = await runScrapeFreshnessMonitor({
      store,
      postSlack,
      now: () => NOW_MS,
      log: () => {},
    })

    assert.equal(result.severity, "ok")
    assert.equal(result.slackPosted, false)
    assert.equal(calls.length, 0, "no Slack call on ok path")
    assert.equal(writes.length, 1, "audit doc written")
    assert.equal(writes[0].severity, "ok")
    assert.equal(writes[0].freshDocsLast24h, 500)
  })

  it("warn path: 30h stale → severity warn, Slack warn level", async () => {
    const { store, writes } = makeFakeStore({
      newestSyncedAtMs: NOW_MS - 30 * 3600 * 1000,
      freshDocsLast24h: 0,
    })
    const { postSlack, calls } = makeFakeSlack({ posted: true })

    const result = await runScrapeFreshnessMonitor({
      store,
      postSlack,
      now: () => NOW_MS,
      log: () => {},
    })

    assert.equal(result.severity, "warn")
    assert.equal(result.slackPosted, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].level, "warn")
    assert.match(calls[0].title, /stale/i)
    assert.equal(writes[0].severity, "warn")
  })

  it("error path: 72h stale → severity error, Slack error level", async () => {
    const { store, writes } = makeFakeStore({
      newestSyncedAtMs: NOW_MS - 72 * 3600 * 1000,
      freshDocsLast24h: 0,
    })
    const { postSlack, calls } = makeFakeSlack({ posted: true })

    const result = await runScrapeFreshnessMonitor({
      store,
      postSlack,
      now: () => NOW_MS,
      log: () => {},
    })

    assert.equal(result.severity, "error")
    assert.equal(result.slackPosted, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].level, "error")
    assert.match(calls[0].title, /DEAD/)
    assert.equal(writes[0].severity, "error")
  })

  it("empty pool: no active docs → error severity", async () => {
    const { store, writes } = makeFakeStore({
      newestSyncedAtMs: null,
      freshDocsLast24h: 0,
    })
    const { postSlack, calls } = makeFakeSlack({ posted: true })

    const result = await runScrapeFreshnessMonitor({
      store,
      postSlack,
      now: () => NOW_MS,
      log: () => {},
    })

    assert.equal(result.severity, "error")
    assert.equal(result.hoursSinceNewest, null)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].level, "error")
    assert.equal(writes[0].severity, "error")
    assert.equal(writes[0].newestSyncedAtMs, null)
  })

  it("slack helper failure surfaces but does not throw", async () => {
    const { store, writes } = makeFakeStore({
      newestSyncedAtMs: NOW_MS - 72 * 3600 * 1000,
    })
    const { postSlack } = makeFakeSlack({
      posted: false,
      reason: "PA_SLACK_ALERT_WEBHOOK not set",
    })

    const result = await runScrapeFreshnessMonitor({
      store,
      postSlack,
      now: () => NOW_MS,
      log: () => {},
    })

    assert.equal(result.slackPosted, false)
    assert.equal(result.slackReason, "PA_SLACK_ALERT_WEBHOOK not set")
    // run record still captured for audit
    assert.equal(writes.length, 1)
    assert.equal(writes[0].slackPosted, false)
  })

  it("threshold boundary: exactly 24h stale → warn (inclusive)", async () => {
    const { store } = makeFakeStore({
      newestSyncedAtMs: NOW_MS - 24 * 3600 * 1000,
    })
    const { postSlack, calls } = makeFakeSlack({ posted: true })

    const result = await runScrapeFreshnessMonitor({
      store,
      postSlack,
      now: () => NOW_MS,
      log: () => {},
    })

    assert.equal(result.severity, "warn")
    assert.equal(calls[0].level, "warn")
  })

  it("threshold boundary: exactly 48h stale → error (inclusive)", async () => {
    const { store } = makeFakeStore({
      newestSyncedAtMs: NOW_MS - 48 * 3600 * 1000,
    })
    const { postSlack, calls } = makeFakeSlack({ posted: true })

    const result = await runScrapeFreshnessMonitor({
      store,
      postSlack,
      now: () => NOW_MS,
      log: () => {},
    })

    assert.equal(result.severity, "error")
    assert.equal(calls[0].level, "error")
  })
})
