/**
 * iter30 WS1 — 5MB CV download size cap.
 *
 * HEAD probe → bounded GET. Some hosts ignore HEAD (405 / 501) — fall through
 * to body GET with a Content-Length sniff after fetch. AbortController kills
 * the stream if the body explodes past the cap mid-flight.
 *
 * Why bounded GET (not stream-clip): node fetch under firebase-functions
 * doesn't always honor stream cancellation cleanly under load; a finite
 * arrayBuffer + post-check is safer and the common case is far below 5MB.
 *
 * Kill-switch: `PA_RESUME_SIZE_CAP_DISABLED=true` env.
 */

export const MAX_PDF_BYTES = (() => {
  const env = parseInt(process.env.PA_RESUME_MAX_BYTES ?? "5242880", 10)
  return Number.isFinite(env) && env > 0 ? env : 5 * 1024 * 1024
})()

const DEFAULT_TIMEOUT_MS = (() => {
  const env = parseInt(process.env.PA_RESUME_FETCH_TIMEOUT_MS ?? "30000", 10)
  return Number.isFinite(env) && env > 0 ? env : 30_000
})()

export class PdfSizeError extends Error {
  constructor(public observedBytes: number, public limit: number) {
    super(`pdf_too_large: ${observedBytes} > ${limit}`)
    this.name = "PdfSizeError"
  }
}

export function sizeCapKillSwitchOn(): boolean {
  const v = (process.env.PA_RESUME_SIZE_CAP_DISABLED ?? "").trim().toLowerCase()
  return v === "true" || v === "1" || v === "on" || v === "yes"
}

export type FetchPdfWithSizeCapResult = { bytes: Uint8Array; contentType?: string }

export async function fetchPdfWithSizeCap(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<FetchPdfWithSizeCapResult> {
  const cap = sizeCapKillSwitchOn() ? Number.MAX_SAFE_INTEGER : MAX_PDF_BYTES

  // 1. HEAD probe (best-effort). 405 / 501 / network errors → skip.
  if (cap !== Number.MAX_SAFE_INTEGER) {
    try {
      const head = await fetchImpl(url, { method: "HEAD" })
      if (head.ok) {
        const lenRaw = head.headers.get("content-length") ?? ""
        const len = parseInt(lenRaw, 10)
        if (Number.isFinite(len) && len > cap) {
          throw new PdfSizeError(len, cap)
        }
      }
    } catch (err) {
      if (err instanceof PdfSizeError) throw err
      // HEAD failed (server doesn't support / rejected); fall through to GET.
    }
  }

  // 2. Bounded GET — abort on timeout; reject on body length over cap.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal })
    if (!r.ok) {
      throw new Error(`HTTP ${r.status} ${r.statusText}`)
    }
    // Sniff content-length first (cheap pre-arrayBuffer check).
    const lenRaw = r.headers.get("content-length") ?? ""
    const len = parseInt(lenRaw, 10)
    if (Number.isFinite(len) && len > cap) {
      throw new PdfSizeError(len, cap)
    }
    const buf = await r.arrayBuffer()
    if (buf.byteLength > cap) {
      throw new PdfSizeError(buf.byteLength, cap)
    }
    return {
      bytes: new Uint8Array(buf),
      contentType: r.headers.get("content-type") ?? undefined,
    }
  } finally {
    clearTimeout(timer)
  }
}
