import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  normalizeSendblueInbound,
  isInboundReceiveEvent,
} from "../normalize.js"
import type { SendblueInboundPayload } from "../types.js"

function basePayload(overrides: Partial<SendblueInboundPayload> = {}): SendblueInboundPayload {
  return {
    content: "hello world",
    from_number: "+15551234567",
    to_number: "+15557654321",
    message_handle: "msg-handle-abc-123",
    date_sent: "2026-04-27T20:53:49.802Z",
    status: "RECEIVED",
    service: "iMessage",
    ...overrides,
  }
}

describe("isInboundReceiveEvent", () => {
  it("returns true for well-formed receive payload", () => {
    assert.equal(isInboundReceiveEvent(basePayload()), true)
  })

  it("returns false when is_outbound=true (outbound mirror, not receive)", () => {
    assert.equal(isInboundReceiveEvent({ ...basePayload(), is_outbound: true }), false)
  })

  it("returns false when message_handle missing", () => {
    const p = basePayload()
    delete (p as Partial<SendblueInboundPayload>).message_handle
    assert.equal(isInboundReceiveEvent(p), false)
  })

  it("returns false when from_number missing", () => {
    const p = basePayload()
    delete (p as Partial<SendblueInboundPayload>).from_number
    assert.equal(isInboundReceiveEvent(p), false)
  })

  it("returns false on null / non-object inputs", () => {
    assert.equal(isInboundReceiveEvent(null as unknown as SendblueInboundPayload), false)
    assert.equal(isInboundReceiveEvent("string" as unknown as SendblueInboundPayload), false)
  })
})

describe("normalizeSendblueInbound", () => {
  it("extracts canonical fields with sendblue- idempotency key prefix (D-02)", () => {
    const out = normalizeSendblueInbound(basePayload())
    assert.ok(out)
    assert.equal(out.idempotencyKey, "sendblue-msg-handle-abc-123")
    assert.equal(out.fromNumber, "+15551234567")
    assert.equal(out.toNumber, "+15557654321")
    assert.equal(out.text, "hello world")
    assert.equal(out.messageHandle, "msg-handle-abc-123")
    assert.equal(out.isGroup, false)
    assert.equal(out.service, "iMessage")
  })

  it("synthesizes 1:1 chatId in iMessage;-;${from_number} form", () => {
    const out = normalizeSendblueInbound(basePayload())
    assert.ok(out)
    assert.equal(out.chatId, "iMessage;-;+15551234567")
  })

  it("returns null for outbound mirror events", () => {
    const out = normalizeSendblueInbound({ ...basePayload(), is_outbound: true })
    assert.equal(out, null)
  })

  it("flags isGroup=true when group_id is non-empty", () => {
    const out = normalizeSendblueInbound({ ...basePayload(), group_id: "g-abc" })
    assert.ok(out)
    assert.equal(out.isGroup, true)
  })

  it("treats empty string group_id as 1:1 (not group)", () => {
    const out = normalizeSendblueInbound({ ...basePayload(), group_id: "" })
    assert.ok(out)
    assert.equal(out.isGroup, false)
  })

  it("returns null for empty content (matches macOS worker '[dm] empty; skip')", () => {
    const out = normalizeSendblueInbound({ ...basePayload(), content: "" })
    assert.equal(out, null)
  })

  it("returns null for whitespace-only content", () => {
    const out = normalizeSendblueInbound({ ...basePayload(), content: "   " })
    assert.equal(out, null)
  })

  it("throws when message_handle is missing (cannot enqueue without idempotency key)", () => {
    const p = basePayload()
    delete (p as Partial<SendblueInboundPayload>).message_handle
    assert.throws(() => normalizeSendblueInbound(p as SendblueInboundPayload), /message_handle/)
  })

  it("trims content whitespace", () => {
    const out = normalizeSendblueInbound({ ...basePayload(), content: "  hi there  " })
    assert.ok(out)
    assert.equal(out.text, "hi there")
  })
})
