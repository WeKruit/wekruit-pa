import { test } from "node:test"
import assert from "node:assert/strict"

import {
  EVENT_NAMES,
  registerEventHandlers,
  type RegisterSinks,
} from "../event-handlers.js"

function makeStubEmitter() {
  const calls: Array<{ event: string; listener: (...args: unknown[]) => void }> = []
  return {
    calls,
    on(event: string, listener: (...args: unknown[]) => void) {
      calls.push({ event, listener })
    },
    off() {},
  }
}

test("graceful close: participant_disconnected invokes shutdown exactly once", async () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  let shutdowns = 0
  const sinks: RegisterSinks = {
    onUserSpeechCommitted: () => {},
    shutdown: () => {
      shutdowns++
    },
  }
  registerEventHandlers(session, room, sinks)
  const listener = room.calls.find(
    (c) => c.event === EVENT_NAMES.participant_disconnected
  )!.listener
  listener({ identity: "voice-prescreen" })
  await new Promise((r) => setImmediate(r))
  assert.equal(shutdowns, 1)
})

test("graceful close: error event invokes shutdown exactly once", async () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  let shutdowns = 0
  let errorPayload: unknown
  const sinks: RegisterSinks = {
    onUserSpeechCommitted: () => {},
    shutdown: () => {
      shutdowns++
    },
    onError: (p) => {
      errorPayload = p
    },
  }
  registerEventHandlers(session, room, sinks)
  const listener = session.calls.find(
    (c) => c.event === EVENT_NAMES.ErrorEvent
  )!.listener
  listener(new Error("upstream STT down"))
  await new Promise((r) => setImmediate(r))
  assert.equal(shutdowns, 1)
  const e = errorPayload as { message?: string }
  assert.equal(e.message, "upstream STT down")
})

test("graceful close: error with {error, message} shape", async () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  let errorPayload: unknown
  registerEventHandlers(session, room, {
    onUserSpeechCommitted: () => {},
    onError: (p) => {
      errorPayload = p
    },
  })
  const listener = session.calls.find(
    (c) => c.event === EVENT_NAMES.ErrorEvent
  )!.listener
  listener({ message: "rate_limited", error: new Error("429") })
  assert.deepEqual(
    {
      message: (errorPayload as { message: string }).message,
      errMsg: (errorPayload as { error: Error }).error?.message,
    },
    { message: "rate_limited", errMsg: "429" }
  )
})

test("graceful close: shutdown throw does not propagate", async () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  registerEventHandlers(session, room, {
    onUserSpeechCommitted: () => {},
    shutdown: () => {
      throw new Error("teardown failed")
    },
  })
  const listener = room.calls.find(
    (c) => c.event === EVENT_NAMES.participant_disconnected
  )!.listener
  // Should NOT throw synchronously; the handler swallows.
  assert.doesNotThrow(() => listener({ identity: "x" }))
  // Allow microtask to flush — error path is logged not thrown.
  await new Promise((r) => setImmediate(r))
})
