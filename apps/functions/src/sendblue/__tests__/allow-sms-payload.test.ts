/**
 * 2026-07-21 — allowSMS on every send-message POST (Android/green-bubble SMS
 * fallback, fleet-wide). Kill-switch: PA_SENDBLUE_ALLOW_SMS=0.
 */
import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { sendImessage } from "../sendblue-client.js"

const CREDS = { apiKeyId: "k", apiSecretKey: "s", fromNumber: "+15550000000" }
const originalFetch = globalThis.fetch

function stubFetch(capture: { body?: Record<string, unknown> }) {
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    capture.body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>
    return new Response(
      JSON.stringify({ status: "QUEUED", uuid: "u1", message_handle: "h1", service: "iMessage", is_outbound: true, number: "+15551112222", from_number: "+15550000000", content: "hi" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.PA_SENDBLUE_ALLOW_SMS
})

test("allowSMS:true rides every send by default", async () => {
  const capture: { body?: Record<string, unknown> } = {}
  stubFetch(capture)
  await sendImessage(
    { to: "+15551112222", content: "hi", fromNumber: "+15550000000" },
    CREDS,
  )
  assert.equal(capture.body?.allowSMS, true)
  assert.equal(capture.body?.number, "+15551112222")
})

test("PA_SENDBLUE_ALLOW_SMS=0 kill-switch removes the flag", async () => {
  process.env.PA_SENDBLUE_ALLOW_SMS = "0"
  const capture: { body?: Record<string, unknown> } = {}
  stubFetch(capture)
  await sendImessage(
    { to: "+15551112222", content: "hi", fromNumber: "+15550000000" },
    CREDS,
  )
  assert.equal("allowSMS" in (capture.body ?? {}), false)
})
