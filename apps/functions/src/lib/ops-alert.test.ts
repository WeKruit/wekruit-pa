/**
 * ops-alert.ts unit tests.
 *
 * Coverage:
 *   - opsAlertRecipients: env parse, default fallback, malformed → default
 *   - resolveMailgunFromEnv: full vs partial provisioning, __UNSET__ sentinel
 *   - notifyOps: no channel → no_channel; email-only; slack-only; both
 *   - notifyOps dedup: first fires, second deduped (fake db)
 */

import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"

import {
  notifyOps,
  opsAlertRecipients,
  resolveMailgunFromEnv,
  claimOpsAlertOnce,
  hourBucket,
  isoWeekBucket,
  DEFAULT_OPS_ALERT_EMAILS,
} from "./ops-alert.js"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Record every fetch call; route by URL substring. */
function stubFetch(): { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = []
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") })
    // Mailgun returns JSON; Slack returns 200 ok.
    const isMailgun = String(url).includes("mailgun")
    return {
      ok: true,
      status: 200,
      async text() {
        return isMailgun ? JSON.stringify({ id: "<msg@mg>" }) : "ok"
      },
      async json() {
        return { id: "<msg@mg>" }
      },
    } as Response
  }) as typeof fetch
  return { calls }
}

const MG = { apiKey: "key-x", domain: "mg.wekruit.com", from: "Claire <c@mg.wekruit.com>", region: "us" as const }

describe("opsAlertRecipients", () => {
  it("defaults to exactly admin1@ + adam.ylol@ when env empty (Adam 2026-06-14)", () => {
    assert.deepEqual(opsAlertRecipients(""), [...DEFAULT_OPS_ALERT_EMAILS])
    assert.deepEqual([...DEFAULT_OPS_ALERT_EMAILS], ["admin1@wekruit.com", "adam.ylol@wekruit.com"])
  })
  it("parses comma/space/semicolon separated emails", () => {
    assert.deepEqual(opsAlertRecipients("a@x.com, b@y.com;c@z.com"), ["a@x.com", "b@y.com", "c@z.com"])
  })
  it("ignores non-email tokens and falls back when none valid", () => {
    assert.deepEqual(opsAlertRecipients("not-an-email"), [...DEFAULT_OPS_ALERT_EMAILS])
  })
})

describe("resolveMailgunFromEnv", () => {
  const keys = ["MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_FROM", "MAILGUN_REGION"] as const
  const snap: Record<string, string | undefined> = {}
  for (const k of keys) snap[k] = process.env[k]
  afterEach(() => {
    for (const k of keys) {
      if (snap[k] === undefined) delete process.env[k]
      else process.env[k] = snap[k]
    }
  })
  it("returns config when all three core secrets present", () => {
    process.env.MAILGUN_API_KEY = "key-x"
    process.env.MAILGUN_DOMAIN = "mg.wekruit.com"
    process.env.MAILGUN_FROM = "Claire <c@mg.wekruit.com>"
    delete process.env.MAILGUN_REGION
    const cfg = resolveMailgunFromEnv()
    assert.ok(cfg)
    assert.equal(cfg?.region, "us")
  })
  it("undefined when a core secret is missing", () => {
    process.env.MAILGUN_API_KEY = "key-x"
    process.env.MAILGUN_DOMAIN = "mg.wekruit.com"
    delete process.env.MAILGUN_FROM
    assert.equal(resolveMailgunFromEnv(), undefined)
  })
  it("treats __UNSET__ sentinel as missing", () => {
    process.env.MAILGUN_API_KEY = "__UNSET__"
    process.env.MAILGUN_DOMAIN = "mg.wekruit.com"
    process.env.MAILGUN_FROM = "Claire <c@mg.wekruit.com>"
    assert.equal(resolveMailgunFromEnv(), undefined)
  })
})

describe("notifyOps", () => {
  it("no channel configured → no_channel, nothing delivered", async () => {
    const { calls } = stubFetch()
    const r = await notifyOps(
      { level: "warn", title: "t", message: "m" },
      { slackWebhookUrl: "", mailgun: null }
    )
    assert.equal(r.anyDelivered, false)
    assert.equal("reason" in r.email ? r.email.reason : "", "no_channel")
    assert.equal(calls.length, 0)
  })

  it("email-only path sends Mailgun to the configured recipients", async () => {
    const { calls } = stubFetch()
    const r = await notifyOps(
      { level: "error", title: "Capacity high", message: "717 at 90%", fields: [{ name: "pct", value: "90%" }] },
      { slackWebhookUrl: "", mailgun: MG, emails: ["ops@wekruit.com"] }
    )
    assert.equal(r.anyDelivered, true)
    assert.equal("ok" in r.email ? r.email.ok : false, true)
    const mg = calls.find((c) => c.url.includes("mailgun"))
    assert.ok(mg, "mailgun called")
    assert.ok(mg!.body.includes("ops%40wekruit.com"), "recipient encoded in form body")
    assert.ok(mg!.body.includes("Capacity+high"))
  })

  it("slack-only path posts to Slack", async () => {
    const { calls } = stubFetch()
    const r = await notifyOps(
      { level: "warn", title: "t", message: "m" },
      { slackWebhookUrl: "https://hooks.slack.com/services/x", mailgun: null }
    )
    assert.equal(r.slack.posted, true)
    assert.equal(r.anyDelivered, true)
    assert.ok(calls.some((c) => c.url.includes("hooks.slack.com")))
  })

  it("both channels fire when both configured", async () => {
    const { calls } = stubFetch()
    const r = await notifyOps(
      { level: "warn", title: "t", message: "m" },
      { slackWebhookUrl: "https://hooks.slack.com/services/x", mailgun: MG, emails: ["a@b.com"] }
    )
    assert.equal(r.slack.posted, true)
    assert.equal("ok" in r.email ? r.email.ok : false, true)
    assert.equal(calls.filter((c) => c.url.includes("slack") || c.url.includes("mailgun")).length, 2)
  })

  it("dedup gate: first fires, identical second is deduped", async () => {
    stubFetch()
    const store = new Map<string, unknown>()
    const db = {
      collection() {
        return {
          doc(id: string) {
            return { id }
          },
        }
      },
      async runTransaction(fn: (tx: unknown) => Promise<boolean>) {
        const tx = {
          async get(ref: { id: string }) {
            return { exists: store.has(ref.id) }
          },
          set(ref: { id: string }, data: unknown) {
            store.set(ref.id, data)
          },
        }
        return fn(tx)
      },
    } as unknown as import("firebase-admin/firestore").Firestore

    const input = { level: "warn" as const, title: "t", message: "m" }
    const opts = { slackWebhookUrl: "", mailgun: MG, emails: ["a@b.com"], dedupe: { db, key: "k-2026-06-14" } }
    const r1 = await notifyOps(input, opts)
    const r2 = await notifyOps(input, opts)
    assert.equal(r1.deduped, false)
    assert.equal(r1.anyDelivered, true)
    assert.equal(r2.deduped, true)
    assert.equal(r2.anyDelivered, false)
  })
})

describe("throttle helpers", () => {
  function txDb() {
    const store = new Map<string, unknown>()
    return {
      collection() {
        return { doc(id: string) { return { id } } }
      },
      async runTransaction(fn: (tx: unknown) => Promise<boolean>) {
        const tx = {
          async get(ref: { id: string }) { return { exists: store.has(ref.id) } },
          set(ref: { id: string }, data: unknown) { store.set(ref.id, data) },
        }
        return fn(tx)
      },
    } as unknown as import("firebase-admin/firestore").Firestore
  }

  it("claimOpsAlertOnce: first claim true, repeat of same key false", async () => {
    const db = txDb()
    assert.equal(await claimOpsAlertOnce(db, "capacity-info-2026-W24"), true)
    assert.equal(await claimOpsAlertOnce(db, "capacity-info-2026-W24"), false)
    assert.equal(await claimOpsAlertOnce(db, "capacity-warn-2026-W24"), true, "escalated band = new key = re-alert")
  })

  it("claimOpsAlertOnce fail-OPEN when the store throws (alert rather than miss)", async () => {
    const brokenDb = {
      collection() { return { doc(id: string) { return { id } } } },
      async runTransaction() { throw new Error("firestore down") },
    } as unknown as import("firebase-admin/firestore").Firestore
    assert.equal(await claimOpsAlertOnce(brokenDb, "k"), true)
  })

  it("hourBucket / isoWeekBucket produce stable bucket keys", () => {
    const ms = Date.parse("2026-06-14T21:35:00Z")
    assert.equal(hourBucket(ms), "2026-06-14T21")
    assert.match(isoWeekBucket(ms), /^2026-W\d{2}$/)
  })
})
