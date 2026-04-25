import assert from "node:assert/strict"
import test from "node:test"
import type { Message } from "@photon-ai/imessage-kit"
import { buildInboundEventFromMessage } from "./inbound.js"

test("buildInboundEventFromMessage creates idempotent iMessage inbound event", () => {
  const msg = {
    rowId: 42,
    id: "guid-42",
    chatId: "iMessage;-;+13125550123",
    participant: "+1 (312) 555-0123",
    text: "  记住 我喜欢冰美式  ",
    isFromMe: false,
  } as Message

  const event = buildInboundEventFromMessage({
    msg,
    userId: "u1",
    sessionId: "s1",
    externalChatId: "+13125550123",
  })

  assert.equal(event.id, "imessage-guid-42")
  assert.equal(event.idempotencyKey, "imessage-in-guid-42")
  assert.equal(event.body, "记住 我喜欢冰美式")
  assert.equal(event.status, "pending")
  assert.equal(event.channel, "imessage")
  assert.deepEqual(event.rawMeta, { source: "imessage", messageRowId: 42, messageGuid: "guid-42" })
})
