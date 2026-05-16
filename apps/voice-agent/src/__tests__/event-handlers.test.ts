import { test } from "node:test"
import assert from "node:assert/strict"

import {
  EVENT_NAMES,
  registerEventHandlers,
  type RegisterSinks,
} from "../event-handlers.js"

// Stub emitter implementation: records (event, listener) pairs.
function makeStubEmitter() {
  const calls: Array<{ event: string; listener: (...args: unknown[]) => void }> = []
  const offCalls: Array<{ event: string; listener: (...args: unknown[]) => void }> = []
  return {
    calls,
    offCalls,
    on(event: string, listener: (...args: unknown[]) => void) {
      calls.push({ event, listener })
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      offCalls.push({ event, listener })
    },
  }
}

function defaultSinks(): RegisterSinks {
  return {
    onUserSpeechCommitted: () => {},
  }
}

test("registerEventHandlers: registers 6 events on session", () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  registerEventHandlers(session, room, defaultSinks())
  const events = session.calls.map((c) => c.event).sort()
  assert.deepEqual(events, [
    EVENT_NAMES.ErrorEvent,
    EVENT_NAMES.agent_false_interruption,
    EVENT_NAMES.close,
    EVENT_NAMES.conversation_item_added,
    EVENT_NAMES.session_usage_updated,
    EVENT_NAMES.user_speech_committed,
  ].sort())
})

test("registerEventHandlers: registers participant_disconnected on room", () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  registerEventHandlers(session, room, defaultSinks())
  assert.equal(room.calls.length, 1)
  assert.equal(room.calls[0].event, EVENT_NAMES.participant_disconnected)
})

test("registerEventHandlers: all 7 spec events accounted for via returned 'registered' map", () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  const { registered } = registerEventHandlers(session, room, defaultSinks())
  const keys = Object.keys(registered).sort()
  assert.deepEqual(keys, [
    "ErrorEvent",
    "agent_false_interruption",
    "close",
    "conversation_item_added",
    "participant_disconnected",
    "session_usage_updated",
    "user_speech_committed",
  ])
})

test("user_speech_committed: invokes sink only for isFinal=true", async () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  const seen: Array<{ transcript: string; isFinal: boolean }> = []
  const sinks: RegisterSinks = {
    onUserSpeechCommitted: (p) => {
      seen.push({ transcript: p.transcript, isFinal: p.isFinal })
    },
  }
  registerEventHandlers(session, room, sinks)
  const listener = session.calls.find(
    (c) => c.event === EVENT_NAMES.user_speech_committed
  )!.listener
  listener({ transcript: "partial", isFinal: false })
  listener({ transcript: "final", isFinal: true })
  // wait microtask
  await new Promise((r) => setImmediate(r))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].transcript, "final")
})

test("conversation_item_added: forwards role + textContent", () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  const seen: unknown[] = []
  const sinks: RegisterSinks = {
    onUserSpeechCommitted: () => {},
    onConversationItemAdded: (p) => seen.push(p),
  }
  registerEventHandlers(session, room, sinks)
  const listener = session.calls.find(
    (c) => c.event === EVENT_NAMES.conversation_item_added
  )!.listener
  listener({ item: { role: "assistant", textContent: "hi" } })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], { role: "assistant", textContent: "hi" })
})

test("agent_false_interruption: forwards resumed flag", () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  let captured: unknown
  const sinks: RegisterSinks = {
    onUserSpeechCommitted: () => {},
    onAgentFalseInterruption: (p) => {
      captured = p
    },
  }
  registerEventHandlers(session, room, sinks)
  const listener = session.calls.find(
    (c) => c.event === EVENT_NAMES.agent_false_interruption
  )!.listener
  listener({ resumed: true })
  assert.deepEqual(captured, { resumed: true })
})

test("session_usage_updated: normalizes modelUsage / model_usage", () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  let captured: unknown
  const sinks: RegisterSinks = {
    onUserSpeechCommitted: () => {},
    onSessionUsageUpdated: (p) => {
      captured = p
    },
  }
  registerEventHandlers(session, room, sinks)
  const listener = session.calls.find(
    (c) => c.event === EVENT_NAMES.session_usage_updated
  )!.listener
  listener({ usage: { model_usage: [{ provider: "deepgram", model: "nova-3" }] } })
  assert.deepEqual(captured, {
    modelUsage: [{ provider: "deepgram", model: "nova-3" }],
  })
})

test("close: forwards reason", () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  let captured: unknown
  const sinks: RegisterSinks = {
    onUserSpeechCommitted: () => {},
    onClose: (p) => {
      captured = p
    },
  }
  registerEventHandlers(session, room, sinks)
  const listener = session.calls.find(
    (c) => c.event === EVENT_NAMES.close
  )!.listener
  listener({ reason: "user_left" })
  assert.deepEqual(captured, { reason: "user_left" })
})

test("dispose unwires registered listeners", () => {
  const session = makeStubEmitter()
  const room = makeStubEmitter()
  const { dispose } = registerEventHandlers(session, room, defaultSinks())
  assert.equal(session.offCalls.length, 0)
  dispose()
  // 6 session offs + 1 room off
  assert.equal(session.offCalls.length, 6)
  assert.equal(room.offCalls.length, 1)
})
