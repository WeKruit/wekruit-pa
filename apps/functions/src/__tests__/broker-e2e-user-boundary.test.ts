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
