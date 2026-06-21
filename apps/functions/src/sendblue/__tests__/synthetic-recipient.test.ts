/**
 * synthetic-recipient guard — universal hard backstop at EVERY Sendblue POST seam.
 *
 * 2026-06-19 incident, hardened 2026-06-21: the pa-outbound outbox gate only
 * covered the durable `sendText` path. The Claire transport ALSO posts to
 * Sendblue directly (sendStatus → sendImessage, typing/markRead →
 * sendTypingIndicator/sendReadReceipt, tapback → sendReaction), bypassing the
 * outbox. Forensics found 53 synthetic-range rows that POSTed and got
 * `sendblue 400: INBOUND_ONLY_PLAN`. This test proves each low-level send
 * function now hard-blocks the reserved +1999999xxxx range BEFORE any fetch,
 * while real numbers still post unchanged.
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import {
  isSyntheticRecipientNumber,
  RESERVED_SYNTHETIC_PHONE_RE,
} from "../synthetic-recipient.js"
import { sendImessage, SendblueClientError } from "../sendblue-client.js"
import { sendReaction } from "../send-reaction.js"
import { sendTypingIndicator } from "../typing-indicator.js"
import { sendReadReceipt } from "../read-receipt.js"
import { _resetPoolCache } from "../pool.js"
import { __resetSendblueBreakerForTests } from "../circuit-breaker.js"

type FetchCall = { url: string; init: RequestInit }

function installFetchMock(handler: (call: FetchCall) => Response): {
  calls: FetchCall[]
  restore: () => void
} {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  ;(globalThis as { fetch: unknown }).fetch = async (
    url: string,
    init: RequestInit
  ): Promise<Response> => {
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }
  return {
    calls,
    restore: () => {
      ;(globalThis as { fetch: unknown }).fetch = original
    },
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const CREDS = { apiKeyId: "key", apiSecretKey: "secret", fromNumber: "+18885550000" }
const SYNTH = "+19999990321" // exactly the number on the incident dashboard screenshot
const REAL = "+15551234567"

describe("isSyntheticRecipientNumber / RESERVED_SYNTHETIC_PHONE_RE", () => {
  it("matches the reserved +1999999xxxx range", () => {
    assert.equal(isSyntheticRecipientNumber("+19999990321"), true)
    assert.equal(isSyntheticRecipientNumber("+19999990000"), true)
    assert.equal(isSyntheticRecipientNumber("+19999999999"), true)
    assert.equal(RESERVED_SYNTHETIC_PHONE_RE.test("+19999990321"), true)
  })

  it("does NOT match real numbers", () => {
    assert.equal(isSyntheticRecipientNumber("+15551234567"), false)
    assert.equal(isSyntheticRecipientNumber("+14243201960"), false) // dev phone
    assert.equal(isSyntheticRecipientNumber("+19998880321"), false) // near miss
    assert.equal(isSyntheticRecipientNumber("+199999903210"), false) // too long
    assert.equal(isSyntheticRecipientNumber("+1999999032"), false) // too short
  })

  it("tolerates surrounding whitespace; rejects non-strings", () => {
    assert.equal(isSyntheticRecipientNumber("  +19999990321 "), true)
    assert.equal(isSyntheticRecipientNumber(undefined), false)
    assert.equal(isSyntheticRecipientNumber(null), false)
    assert.equal(isSyntheticRecipientNumber(19999990321), false)
  })
})

describe("synthetic recipient hard backstop — all Sendblue POST seams", () => {
  beforeEach(() => {
    __resetSendblueBreakerForTests()
    _resetPoolCache()
  })
  afterEach(() => {
    __resetSendblueBreakerForTests()
    _resetPoolCache()
  })

  // ── seam 1: sendImessage (sendStatus + outbox send) ──────────────────────
  it("sendImessage: synthetic recipient throws non-retryable 4xx, NEVER posts", async () => {
    const mock = installFetchMock(() => jsonResponse(200, { status: "QUEUED" }))
    try {
      await assert.rejects(
        () => sendImessage({ to: SYNTH, content: "got it — locking your matches" }, CREDS),
        (err: unknown) => {
          assert.ok(err instanceof SendblueClientError, "expected SendblueClientError (4xx, non-retryable)")
          assert.equal((err as SendblueClientError).status, 400)
          assert.match((err as SendblueClientError).message, /synthetic\/test recipient/)
          return true
        }
      )
      assert.equal(mock.calls.length, 0, "synthetic recipient must NEVER POST to Sendblue")
    } finally {
      mock.restore()
    }
  })

  it("sendImessage: real recipient still posts normally", async () => {
    const mock = installFetchMock(() => jsonResponse(200, { status: "QUEUED", uuid: "u-1" }))
    try {
      const out = await sendImessage({ to: REAL, content: "hi" }, CREDS)
      assert.equal(out.status, "QUEUED")
      assert.equal(mock.calls.length, 1)
      assert.equal(mock.calls[0]!.url, "https://api.sendblue.co/api/send-message")
    } finally {
      mock.restore()
    }
  })

  // ── seam 2: sendReaction (tapback) ───────────────────────────────────────
  it("sendReaction: synthetic recipient throws non-retryable 4xx, NEVER posts", async () => {
    const mock = installFetchMock(() => jsonResponse(200, { status: "QUEUED" }))
    try {
      await assert.rejects(
        () => sendReaction({ to: SYNTH, messageHandle: "msg-1", reaction: "like" }, CREDS),
        (err: unknown) => {
          assert.ok(err instanceof SendblueClientError)
          assert.equal((err as SendblueClientError).status, 400)
          assert.match((err as SendblueClientError).message, /synthetic\/test recipient/)
          return true
        }
      )
      assert.equal(mock.calls.length, 0, "synthetic recipient must NEVER POST a reaction")
    } finally {
      mock.restore()
    }
  })

  it("sendReaction: real recipient still posts normally", async () => {
    const mock = installFetchMock(() => jsonResponse(200, { status: "QUEUED", message_handle: "rx-1" }))
    try {
      const out = await sendReaction({ to: REAL, messageHandle: "msg-1", reaction: "like" }, CREDS)
      assert.equal(out.status, "QUEUED")
      assert.equal(mock.calls.length, 1)
      assert.equal(mock.calls[0]!.url, "https://api.sendblue.co/api/send-reaction")
    } finally {
      mock.restore()
    }
  })

  // ── seam 3: sendTypingIndicator (typing / markRead) ──────────────────────
  it("sendTypingIndicator: synthetic recipient returns silently, NEVER posts", async () => {
    const mock = installFetchMock(() => jsonResponse(200, {}))
    try {
      await sendTypingIndicator({ to: SYNTH }, CREDS, () => {})
      assert.equal(mock.calls.length, 0, "synthetic recipient must NEVER POST a typing indicator")
    } finally {
      mock.restore()
    }
  })

  it("sendTypingIndicator: real recipient still posts normally", async () => {
    const mock = installFetchMock(() => jsonResponse(200, {}))
    try {
      await sendTypingIndicator({ to: REAL }, CREDS, () => {})
      assert.equal(mock.calls.length, 1)
      assert.equal(mock.calls[0]!.url, "https://api.sendblue.co/api/send-typing-indicator")
    } finally {
      mock.restore()
    }
  })

  // ── seam 4: sendReadReceipt (markRead) ───────────────────────────────────
  it("sendReadReceipt: synthetic recipient returns silently, NEVER posts", async () => {
    const mock = installFetchMock(() => jsonResponse(200, {}))
    try {
      await sendReadReceipt({ to: SYNTH }, CREDS, () => {})
      assert.equal(mock.calls.length, 0, "synthetic recipient must NEVER POST a read receipt")
    } finally {
      mock.restore()
    }
  })

  it("sendReadReceipt: real recipient still posts (both hosts attempted)", async () => {
    const mock = installFetchMock(() => jsonResponse(200, {}))
    try {
      await sendReadReceipt({ to: REAL }, CREDS, () => {})
      // mark-read fans out to both .com and .co hosts in parallel.
      assert.ok(mock.calls.length >= 1, "real recipient should POST at least one mark-read")
      for (const c of mock.calls) assert.match(c.url, /\/api\/mark-read$/)
    } finally {
      mock.restore()
    }
  })
})
