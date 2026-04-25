import assert from "node:assert/strict"
import test from "node:test"
import { isOutboundLeaseExpired, normalizeOutboundRecipient } from "./outbox.js"

test("isOutboundLeaseExpired treats missing or stale leases as reclaimable", () => {
  const now = new Date("2026-04-25T12:00:00.000Z")
  assert.equal(isOutboundLeaseExpired(undefined, now), true)
  assert.equal(isOutboundLeaseExpired("2026-04-25T11:59:59.000Z", now), true)
  assert.equal(isOutboundLeaseExpired("2026-04-25T12:00:30.000Z", now), false)
})

test("normalizeOutboundRecipient preserves iMessage email handles", () => {
  assert.equal(normalizeOutboundRecipient("admin1@WeKruit.COM"), "admin1@wekruit.com")
  assert.equal(normalizeOutboundRecipient("(215) 403-4668"), "+12154034668")
})
