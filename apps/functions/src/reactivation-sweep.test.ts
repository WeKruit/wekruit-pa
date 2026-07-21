import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  isEligibleForReactivation,
  runReactivationSweep,
  REACTIVATION_INACTIVE_DAYS,
  REACTIVATION_REPEAT_DAYS,
  REACTIVATION_COPY,
} from "./reactivation-sweep.js"
import { CLAIRE_VOICE_DEV_PHONES } from "./voice/dev-phone-gate.js"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse("2026-06-24T00:00:00.000Z")
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString()

describe("isEligibleForReactivation", () => {
  it("eligible: inbounded >20d ago, reachable, never pinged", () => {
    const r = isEligibleForReactivation({ phoneE164: "+1555", lastInboundAt: daysAgo(25) }, NOW)
    assert.equal(r.eligible, true)
  })
  it("inbound-first: a user who NEVER inbounded is excluded (no cold open)", () => {
    const r = isEligibleForReactivation({ phoneE164: "+1555" }, NOW)
    assert.equal(r.eligible, false)
    assert.equal(r.reason, "never_inbound")
  })
  it("recently active (<20d) is excluded", () => {
    const r = isEligibleForReactivation({ phoneE164: "+1555", lastInboundAt: daysAgo(REACTIVATION_INACTIVE_DAYS - 1) }, NOW)
    assert.equal(r.eligible, false)
    assert.equal(r.reason, "recently_active")
  })
  it("doNotContact hard-excluded", () => {
    const r = isEligibleForReactivation({ phoneE164: "+1555", lastInboundAt: daysAgo(40), doNotContact: true }, NOW)
    assert.equal(r.eligible, false)
    assert.equal(r.reason, "do_not_contact")
  })
  it("opted_out hard-excluded", () => {
    const r = isEligibleForReactivation({ phoneE164: "+1555", lastInboundAt: daysAgo(40), outreach: { status: "opted_out" } }, NOW)
    assert.equal(r.eligible, false)
    assert.equal(r.reason, "opted_out")
  })
  it("repeat cadence: re-pinged within 30d is skipped, eligible again after", () => {
    const within = isEligibleForReactivation({ phoneE164: "+1555", lastInboundAt: daysAgo(40), lastReactivationPingAt: daysAgo(REACTIVATION_REPEAT_DAYS - 1) }, NOW)
    assert.equal(within.eligible, false)
    assert.equal(within.reason, "pinged_recently")
    const after = isEligibleForReactivation({ phoneE164: "+1555", lastInboundAt: daysAgo(40), lastReactivationPingAt: daysAgo(REACTIVATION_REPEAT_DAYS + 1) }, NOW)
    assert.equal(after.eligible, true)
  })
  it("no phone excluded", () => {
    assert.equal(isEligibleForReactivation({ lastInboundAt: daysAgo(40) }, NOW).reason, "no_phone")
  })
})

// Minimal Firestore stub for the canary sweep path.
function makeDb(usersByPhone: Record<string, { id: string; data: Record<string, unknown> }>) {
  const writes: Record<string, Record<string, unknown>> = {}
  return {
    writes,
    collection: (name: string) => ({
      where: (field: string, _op: string, value: unknown) => ({
        limit: () => ({
          get: async () => {
            if (name === "pa-users" && field === "phoneE164") {
              const hit = usersByPhone[String(value)]
              return { docs: hit ? [{ id: hit.id, data: () => hit.data }] : [] }
            }
            return { docs: [] } // pa-messages derive → none
          },
        }),
      }),
      doc: (id: string) => ({
        set: async (data: Record<string, unknown>) => {
          writes[id] = { ...(writes[id] ?? {}), ...data }
        },
      }),
    }),
  }
}

describe("runReactivationSweep (canary)", () => {
  it("pings an eligible dev-phone candidate once and stamps lastReactivationPingAt", async () => {
    const devPhone = [...CLAIRE_VOICE_DEV_PHONES][0]
    const db = makeDb({ [devPhone]: { id: "devUser", data: { phoneE164: devPhone, lastInboundAt: daysAgo(30) } } })
    const sent: Array<{ to: string; content: string }> = []
    const out = await runReactivationSweep({
      db: db as never,
      nowMs: NOW,
      rampAll: false,
      send: (async (a: { to: string; content: string }) => {
        sent.push({ to: a.to, content: a.content })
        return { status: "queued" }
      }) as never,
    })
    assert.equal(out.sent, 1)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].content, REACTIVATION_COPY)
    assert.equal(typeof db.writes.devUser?.lastReactivationPingAt, "string")
    assert.equal(db.writes.devUser?.lastReactivationPingCount, 1)
  })

  it("does NOT ping a dev-phone candidate active within 20d", async () => {
    const devPhone = [...CLAIRE_VOICE_DEV_PHONES][0]
    const db = makeDb({ [devPhone]: { id: "devUser", data: { phoneE164: devPhone, lastInboundAt: daysAgo(5) } } })
    let sentCount = 0
    const out = await runReactivationSweep({
      db: db as never,
      nowMs: NOW,
      rampAll: false,
      send: (async () => { sentCount++; return { status: "queued" } }) as never,
    })
    assert.equal(out.sent, 0)
    assert.equal(sentCount, 0)
  })
})
