import { strict as assert } from "node:assert"
import test from "node:test"

import { shouldCreateProvisionalUserForBrokerPayload } from "../index.js"

test("organic broker iMessage can create a provisional user when phone is unknown", () => {
  assert.equal(
    shouldCreateProvisionalUserForBrokerPayload({
      kind: "imessage",
      participant: "+15551234567",
      chatId: "iMessage;-;+15551234567",
      text: "hi",
    }),
    true,
  )
})

test("DIRECT-START (Adam 2026-06-02): a Sendblue text from an unknown phone now creates a provisional user", () => {
  assert.equal(
    shouldCreateProvisionalUserForBrokerPayload({
      kind: "imessage",
      source: "sendblue",
      participant: "+15551234567",
      chatId: "iMessage;-;+15551234567",
      text: "hi",
    } as never),
    true,
  )
})

test("a Sendblue event with NO text (typing/delivery/system) still must NOT create a user", () => {
  assert.equal(
    shouldCreateProvisionalUserForBrokerPayload({
      kind: "imessage",
      source: "sendblue",
      participant: "+15551234567",
      chatId: "iMessage;-;+15551234567",
      text: "   ",
    } as never),
    false,
  )
})

test("Sendblue E2E broker events must not create production pa-users when phone is unknown", () => {
  assert.equal(
    shouldCreateProvisionalUserForBrokerPayload({
      kind: "imessage",
      participant: "+19995550123",
      chatId: "iMessage;-;+19995550123",
      text: "hi",
      e2eTest: true,
    }),
    false,
  )
})

// Direct-start (Adam 2026-06-02): the sync gate now ALLOWS any sendblue text to
// self-provision. A genuine QR opener still gets its special provisioning
// (source='qr_imessage' + scanToken claim + sticky number) because
// resolveQrOpenerProvision runs FIRST in processBrokerImessageEvent — the sync
// gate is the plain-text fallback. So a QR-looking text passes the gate (TRUE);
// whether it binds a real scanToken is decided by the async QR check.
test("a sendblue payload that looks like a QR opener passes the (now relaxed) sync gate", () => {
  assert.equal(
    shouldCreateProvisionalUserForBrokerPayload({
      kind: "imessage",
      source: "sendblue",
      participant: "+15551234567",
      chatId: "iMessage;-;+15551234567",
      text: "Hello, WeKruit! 11111111-2222-3333-4444-555555555555",
    } as never),
    true,
  )
})
