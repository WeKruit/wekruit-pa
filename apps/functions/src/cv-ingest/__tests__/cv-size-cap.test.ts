import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { fetchPdfWithSizeCap, PdfSizeError, MAX_PDF_BYTES } from "../cv-size-cap.js"

function fakeFetchOK(bytes: Uint8Array, contentLength?: number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const method = (init as { method?: string } | undefined)?.method ?? "GET"
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers:
          contentLength != null
            ? { "content-length": String(contentLength) }
            : {},
      })
    }
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        ...(contentLength != null ? { "content-length": String(contentLength) } : {}),
      },
    })
  }) as unknown as typeof fetch
}

function fakeFetchHeadFails(bytes: Uint8Array): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const method = (init as { method?: string } | undefined)?.method ?? "GET"
    if (method === "HEAD") {
      return new Response(null, { status: 405, statusText: "Method Not Allowed" })
    }
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    })
  }) as unknown as typeof fetch
}

describe("fetchPdfWithSizeCap", () => {
  it("returns bytes for small PDF (HEAD path)", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF
    const r = await fetchPdfWithSizeCap("https://x/a.pdf", fakeFetchOK(bytes, bytes.byteLength))
    assert.equal(r.bytes.byteLength, 4)
    assert.equal(r.contentType, "application/pdf")
  })

  it("rejects with PdfSizeError when HEAD reports oversize", async () => {
    const bytes = new Uint8Array(10)
    await assert.rejects(
      () =>
        fetchPdfWithSizeCap(
          "https://x/big.pdf",
          fakeFetchOK(bytes, MAX_PDF_BYTES + 1)
        ),
      (err: unknown) => err instanceof PdfSizeError
    )
  })

  it("falls through HEAD-405 to bounded GET", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const r = await fetchPdfWithSizeCap("https://x/a.pdf", fakeFetchHeadFails(bytes))
    assert.equal(r.bytes.byteLength, 4)
  })

  it("rejects when body content-length exceeds cap", async () => {
    const bytes = new Uint8Array(10)
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET"
      if (method === "HEAD") {
        return new Response(null, { status: 200 }) // no content-length
      }
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { "content-length": String(MAX_PDF_BYTES + 1) },
      })
    }) as unknown as typeof fetch
    await assert.rejects(
      () => fetchPdfWithSizeCap("https://x/a.pdf", fakeFetch),
      (err: unknown) => err instanceof PdfSizeError
    )
  })

  it("rejects when actual body bytes exceed cap (post-buffer check)", async () => {
    const big = new Uint8Array(MAX_PDF_BYTES + 100)
    // Don't include content-length so the post-buffer check is the gate.
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET"
      if (method === "HEAD") {
        return new Response(null, { status: 200 })
      }
      return new Response(big as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })
    }) as unknown as typeof fetch
    await assert.rejects(
      () => fetchPdfWithSizeCap("https://x/a.pdf", fakeFetch),
      (err: unknown) => err instanceof PdfSizeError
    )
  })

  it("throws on non-2xx GET response", async () => {
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET"
      if (method === "HEAD") return new Response(null, { status: 405 })
      return new Response(null, { status: 404, statusText: "Not Found" })
    }) as unknown as typeof fetch
    await assert.rejects(() => fetchPdfWithSizeCap("https://x/a.pdf", fakeFetch), /HTTP 404/)
  })
})
