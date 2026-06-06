/**
 * progress-heartbeat.test.ts — the once-only, ordering-safe "still working" nudge (Adam 2026-06-06).
 *
 * Locks the four properties Adam required:
 *   1. ONCE — a single nudge, never re-armed, even after ticking well past the threshold.
 *   2. ONLY IF SLOW — no nudge when the work finishes under the threshold (the clearTimeout guard) →
 *      structurally guarantees the nudge can never trail the real result.
 *   3. fires when the work overruns the threshold.
 *   4. FAIL-OPEN — a send error never disturbs the work promise.
 *  + the optional stillInFlight cross-invocation guard suppresses a stale nudge.
 */
import { test, mock } from "node:test"
import assert from "node:assert/strict"
import {
  withProgressHeartbeat,
  PROGRESS_HEARTBEAT_DELAY_MS,
  PROGRESS_HEARTBEAT_COPY,
} from "./progress-heartbeat.js"

/** Flush the microtask queue a few times so the timer's async send IIFE settles. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** A promise plus its resolver, so a test can hold work "pending" then release it. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test("fires ONE nudge when work overruns the 30s threshold", async () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const sent: string[] = []
    const work = deferred<string>()
    const wrapped = withProgressHeartbeat(work.promise, {
      send: async (t) => {
        sent.push(t)
      },
      message: PROGRESS_HEARTBEAT_COPY.resume,
    })

    mock.timers.tick(PROGRESS_HEARTBEAT_DELAY_MS)
    await flush()
    assert.deepEqual(sent, [PROGRESS_HEARTBEAT_COPY.resume], "exactly one nudge with the resume copy")

    work.resolve("done")
    assert.equal(await wrapped, "done", "wrapper resolves to the work's value")
  } finally {
    mock.timers.reset()
  }
})

test("does NOT nudge when work settles before the threshold (no result-then-heartbeat)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const sent: string[] = []
    const work = deferred<string>()
    const wrapped = withProgressHeartbeat(work.promise, {
      send: async (t) => {
        sent.push(t)
      },
      message: PROGRESS_HEARTBEAT_COPY.resume,
    })

    work.resolve("fast")
    await wrapped // finally runs → settled + clearTimeout
    await flush()

    mock.timers.tick(PROGRESS_HEARTBEAT_DELAY_MS * 3)
    await flush()
    assert.deepEqual(sent, [], "timer was cancelled — no nudge ever sent")
  } finally {
    mock.timers.reset()
  }
})

test("nudges at most ONCE even when timers run far past the threshold", async () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    let calls = 0
    const work = deferred<void>()
    withProgressHeartbeat(work.promise, {
      send: async () => {
        calls++
      },
      message: "x",
    })

    mock.timers.tick(PROGRESS_HEARTBEAT_DELAY_MS)
    await flush()
    mock.timers.tick(PROGRESS_HEARTBEAT_DELAY_MS * 5)
    await flush()
    assert.equal(calls, 1, "single setTimeout, never re-armed")
    work.resolve()
  } finally {
    mock.timers.reset()
  }
})

test("stillInFlight=false suppresses a stale nudge (cross-invocation clear)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const sent: string[] = []
    const work = deferred<void>()
    withProgressHeartbeat(work.promise, {
      send: async (t) => {
        sent.push(t)
      },
      message: "x",
      stillInFlight: () => false,
    })

    mock.timers.tick(PROGRESS_HEARTBEAT_DELAY_MS)
    await flush()
    assert.deepEqual(sent, [], "guard returned false → no nudge")
    work.resolve()
  } finally {
    mock.timers.reset()
  }
})

test("fail-open: a send error never rejects the work promise", async () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const work = deferred<string>()
    const wrapped = withProgressHeartbeat(work.promise, {
      send: async () => {
        throw new Error("sendblue 500")
      },
      message: "x",
    })

    mock.timers.tick(PROGRESS_HEARTBEAT_DELAY_MS)
    await flush()
    work.resolve("ok")
    assert.equal(await wrapped, "ok", "work still resolves despite the failed nudge")
  } finally {
    mock.timers.reset()
  }
})

test("respects a custom delayMs threshold", async () => {
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const sent: string[] = []
    const work = deferred<void>()
    withProgressHeartbeat(work.promise, {
      send: async (t) => {
        sent.push(t)
      },
      message: "soon",
      delayMs: 5_000,
    })

    mock.timers.tick(4_000)
    await flush()
    assert.deepEqual(sent, [], "not yet at the custom threshold")
    mock.timers.tick(1_000)
    await flush()
    assert.deepEqual(sent, ["soon"], "fired exactly at the custom threshold")
    work.resolve()
  } finally {
    mock.timers.reset()
  }
})
