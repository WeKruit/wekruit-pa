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

test("organic Sendblue broker events must not create pa-users when phone is unknown", () => {
  assert.equal(
    shouldCreateProvisionalUserForBrokerPayload({
      kind: "imessage",
      source: "sendblue",
      participant: "+15551234567",
      chatId: "iMessage;-;+15551234567",
      text: "hi",
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

// QR onboarding (doc §4) — the sync gate still BLOCKS every sendblue payload
// (anti-spam invariant unchanged). The QR exception is layered on TOP via the
// async resolveQrOpenerProvision check (covered in qr-onboarding/scan.test.ts);
// the sync gate must NOT relax just because the text looks like a QR opener,
// otherwise a spammer could forge `Hello, WeKruit! <token>` and self-provision.
test("a sendblue payload that merely looks like a QR opener still fails the SYNC gate (anti-spam)", () => {
  assert.equal(
    shouldCreateProvisionalUserForBrokerPayload({
      kind: "imessage",
      source: "sendblue",
      participant: "+15551234567",
      chatId: "iMessage;-;+15551234567",
      text: "Hello, WeKruit! 11111111-2222-3333-4444-555555555555",
    } as never),
    false,
  )
})
