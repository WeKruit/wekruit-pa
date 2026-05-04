/**
 * iter30 WS1 — outer retry wrapper.
 *
 * Layer C (per ws-1-detail.md §4.1):
 *   attempts=3, backoff=[1s, 4s, 16s], retryable: 5xx/timeout/rate/overloaded.
 *
 * Inner-tier fallback lives in `router.ts` (Layer B). SDK retries are
 * Layer A (handled by the OpenAI SDK itself).
 */

const RETRYABLE_PATTERNS: RegExp[] = [
  /HTTP\s*5\d\d/i,
  /\b5\d\d\b/, // bare status code (e.g. "status 502 bad gateway")
  /timeout/i,
  /timed[\s_]?out/i,
  /overloaded/i,
  /rate[\s._-]?limit/i,
  /\b429\b/, // explicit rate-limit code
  /\b529\b/, // anthropic-style overloaded code
  /ECONN(?:RESET|REFUSED|ABORTED)/,
  /ETIMEDOUT/,
  /AbortError/i,
  /UND_ERR/i,
]

export class NonRetryableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = "NonRetryableError"
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError) return false
  const msg = err instanceof Error ? err.message : String(err)
  // SDK errors sometimes surface a `status` numeric prop on the error object
  // rather than embedding the code in the message string. Normalize it.
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN
  if (Number.isFinite(status) && (status === 429 || status === 529 || (status >= 500 && status <= 599))) {
    return true
  }
  return RETRYABLE_PATTERNS.some((re) => re.test(msg))
}

export type Logger = (event: string, payload?: Record<string, unknown>) => void

export type WithOuterRetryOpts = {
  attempts: number
  /** Base delay in ms (default 1000). Exponential factor=4 → [1s, 4s, 16s] */
  baseMs?: number
  maxMs?: number
  log?: Logger
  /** Optional override for sleep — tests inject a fake to avoid real waits. */
  sleep?: (ms: number) => Promise<void>
}

export const DEFAULT_OUTER_RETRY_OPTS = {
  attempts: 3,
  baseMs: 1000,
  maxMs: 16_000,
} as const

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function withOuterRetry<T>(
  fn: () => Promise<T>,
  opts: WithOuterRetryOpts
): Promise<T> {
  const baseMs = opts.baseMs ?? DEFAULT_OUTER_RETRY_OPTS.baseMs
  const maxMs = opts.maxMs ?? DEFAULT_OUTER_RETRY_OPTS.maxMs
  const sleep = opts.sleep ?? realSleep

  let lastErr: unknown
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const retryable = isRetryable(err)
      const isLast = i === opts.attempts - 1
      opts.log?.("pa.cv_ingest.retry_attempt", {
        attempt: i + 1,
        total: opts.attempts,
        retryable,
        error: err instanceof Error ? err.message : String(err),
      })
      if (!retryable || isLast) {
        throw err
      }
      const delay = Math.min(baseMs * Math.pow(4, i), maxMs)
      opts.log?.("pa.cv_ingest.retry", {
        attempt: i + 1,
        delayMs: delay,
        error: err instanceof Error ? err.message : String(err),
      })
      await sleep(delay)
    }
  }
  // Loop exits via return / throw; this is unreachable but satisfies TS.
  /* istanbul ignore next */
  throw lastErr ?? new Error("retry_loop_exhausted")
}
