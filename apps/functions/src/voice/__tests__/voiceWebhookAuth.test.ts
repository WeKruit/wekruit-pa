import { test } from "node:test"
import assert from "node:assert/strict"

import { parseAuthorizedVoiceWebhookEvent } from "../index.js"

test("voice webhook auth accepts legacy shared-secret callbacks", async () => {
  const event = await parseAuthorizedVoiceWebhookEvent(
    {
      get(name: string) {
        return name === "X-Wekruit-Voice-Webhook-Secret" ? "shared" : undefined
      },
      body: {
        CallSid: "CA1",
        CallStatus: "in-progress",
      },
    },
    {
      sharedSecret: "shared",
      livekitApiKey: "",
      livekitApiSecret: "",
    },
  )

  assert.equal(event?.source, "twilio")
  if (event?.source !== "twilio") throw new Error("expected twilio event")
  assert.equal(event.CallSid, "CA1")
})

test("voice webhook auth accepts LiveKit signed Authorization callbacks", async () => {
  const rawBody = JSON.stringify({
    event: "room_finished",
    room: { name: "B-1" },
  })
  const received: Array<{ rawBody: string; authHeader: string }> = []
  const event = await parseAuthorizedVoiceWebhookEvent(
    {
      get(name: string) {
        return name.toLowerCase() === "authorization" ? "Bearer signed-livekit-token" : undefined
      },
      rawBody: Buffer.from(rawBody),
      body: JSON.parse(rawBody),
    },
    {
      sharedSecret: "shared",
      livekitApiKey: "lk-key",
      livekitApiSecret: "lk-secret",
      makeLiveKitWebhookReceiver() {
        return {
          receive(body: string, authHeader: string) {
            received.push({ rawBody: body, authHeader })
            return JSON.parse(body)
          },
        }
      },
    },
  )

  assert.equal(event?.source, "livekit")
  if (event?.source !== "livekit") throw new Error("expected livekit event")
  assert.equal(event.event, "room_finished")
  assert.deepEqual(received, [{ rawBody, authHeader: "Bearer signed-livekit-token" }])
})

test("voice webhook auth rejects callbacks without either accepted auth path", async () => {
  const event = await parseAuthorizedVoiceWebhookEvent(
    {
      get() {
        return undefined
      },
      body: {
        event: "room_finished",
        room: { name: "B-1" },
      },
    },
    {
      sharedSecret: "shared",
      livekitApiKey: "lk-key",
      livekitApiSecret: "lk-secret",
    },
  )

  assert.equal(event, null)
})
