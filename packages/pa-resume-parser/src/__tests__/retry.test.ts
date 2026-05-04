import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { withOuterRetry, isRetryable, NonRetryableError } from "../retry.js"

const noSleep = async () => {}

describe("isRetryable", () => {
  it("matches 5xx codes", () => {
    assert.equal(isRetryable(new Error("HTTP 503 Service Unavailable")), true)
    assert.equal(isRetryable(new Error("status 502 bad gateway")), true)
    assert.equal(isRetryable(new Error("HTTP 500 internal")), true)
  })
  it("matches timeout / overloaded / rate-limit / network", () => {
    assert.equal(isRetryable(new Error("connection timeout")), true)
    assert.equal(isRetryable(new Error("Server overloaded, retry later")), true)
    assert.equal(isRetryable(new Error("rate-limit exceeded")), true)
    assert.equal(isRetryable(new Error("ECONNRESET on socket")), true)
  })
  it("matches numeric status property", () => {
    const err: Error & { status?: number } = new Error("server overload")
    err.status = 503
    assert.equal(isRetryable(err), true)
    const err429: Error & { status?: number } = new Error("too many")
    err429.status = 429
    assert.equal(isRetryable(err429), true)
  })
  it("rejects 4xx without retry indicators", () => {
    const err: Error & { status?: number } = new Error("Bad request")
    err.status = 400
    assert.equal(isRetryable(err), false)
  })
  it("never retries NonRetryableError", () => {
    assert.equal(isRetryable(new NonRetryableError("auth")), false)
  })
})

describe("withOuterRetry", () => {
  it("succeeds on first try without retry", async () => {
    let calls = 0
    const out = await withOuterRetry(
      async () => {
        calls++
        return "ok"
      },
      { attempts: 3, sleep: noSleep }
    )
    assert.equal(out, "ok")
    assert.equal(calls, 1)
  })

  it("retries retryable errors then succeeds", async () => {
    let calls = 0
    const out = await withOuterRetry(
      async () => {
        calls++
        if (calls < 2) throw new Error("HTTP 503 transient")
        return "recovered"
      },
      { attempts: 3, sleep: noSleep }
    )
    assert.equal(out, "recovered")
    assert.equal(calls, 2)
  })

  it("aborts immediately on NonRetryableError", async () => {
    let calls = 0
    await assert.rejects(
      () =>
        withOuterRetry(
          async () => {
            calls++
            throw new NonRetryableError("missing_api_key")
          },
          { attempts: 3, sleep: noSleep }
        ),
      /missing_api_key/
    )
    assert.equal(calls, 1)
  })

  it("throws after exhausting attempts on persistent retryable error", async () => {
    let calls = 0
    await assert.rejects(
      () =>
        withOuterRetry(
          async () => {
            calls++
            throw new Error("HTTP 502 bad gateway")
          },
          { attempts: 3, sleep: noSleep }
        ),
      /502/
    )
    assert.equal(calls, 3)
  })
})
