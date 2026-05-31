/**
 * upload-card.test.ts — proves uploadToSendblueMedia() returns the permanent,
 * non-signed, .png-terminated Sendblue CDN URL (the only shape Sendblue's
 * media_url accepts) and FAILS LOUD on bad responses so the caller fails open.
 */
import { test, afterEach } from "node:test"
import assert from "node:assert/strict"

import { uploadToSendblueMedia } from "../upload-card.js"

const CREDS = { apiKeyId: "key-id", apiSecretKey: "secret" }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG magic
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const captured: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    captured.push({ url: String(url), init: init as RequestInit })
    return impl(String(url), init as RequestInit)
  }) as typeof fetch
  return captured
}

test("uploadToSendblueMedia: POSTs multipart to .co host + returns .png CDN url (no signed query)", async () => {
  const captured = stubFetch((_url, init) => {
    // headers carry the sb-api creds; body is multipart FormData.
    const headers = (init.headers ?? {}) as Record<string, string>
    assert.equal(headers["sb-api-key-id"], "key-id")
    assert.equal(headers["sb-api-secret-key"], "secret")
    assert.ok(init.body instanceof FormData, "must POST multipart FormData")
    return new Response(
      JSON.stringify({
        status: "OK",
        media_url: "https://storage.googleapis.com/inbound-file-store/Xy12_wk-rec-job-1.png",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    )
  })

  const url = await uploadToSendblueMedia(PNG, "wk-rec-job-1.png", CREDS)
  assert.equal(captured.length, 1)
  assert.equal(captured[0]!.url, "https://api.sendblue.co/api/upload-file")
  assert.equal(captured[0]!.init.method, "POST")
  // THE DELIVERY-FIX ASSERTIONS on the returned media_url:
  assert.match(url, /\.png$/, "media_url must end in .png")
  assert.ok(!url.includes("?"), "media_url must NOT be a signed/query URL")
  assert.ok(!/token=/.test(url), "media_url must not carry a token")
})

test("uploadToSendblueMedia: appends .png to a filename missing the extension", async () => {
  let sentName = ""
  stubFetch(async (_url, init) => {
    const fd = init.body as FormData
    const file = fd.get("file") as File
    sentName = file.name
    return new Response(JSON.stringify({ media_url: "https://x/y_z.png" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  await uploadToSendblueMedia(PNG, "noext", CREDS)
  assert.match(sentName, /\.png$/)
})

test("uploadToSendblueMedia: non-2xx → throws (caller fails open)", async () => {
  stubFetch(() => new Response("nope", { status: 500 }))
  await assert.rejects(() => uploadToSendblueMedia(PNG, "x.png", CREDS), /HTTP 500/)
})

test("uploadToSendblueMedia: 2xx without media_url → throws", async () => {
  stubFetch(
    () =>
      new Response(JSON.stringify({ status: "OK" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
  )
  await assert.rejects(() => uploadToSendblueMedia(PNG, "x.png", CREDS), /no media_url/)
})

test("uploadToSendblueMedia: missing creds → throws before any fetch", async () => {
  let called = false
  stubFetch(() => {
    called = true
    return new Response("{}", { status: 200 })
  })
  await assert.rejects(
    () => uploadToSendblueMedia(PNG, "x.png", { apiKeyId: "", apiSecretKey: "" }),
    /missing apiKeyId/,
  )
  assert.equal(called, false)
})
