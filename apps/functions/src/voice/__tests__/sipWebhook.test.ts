/**
 * S3 — sipWebhook reconciler tests.
 *
 * Covers acceptance:
 *   - "sipWebhook reconciles dialing→connected on first delivery"
 *   - "sipWebhook idempotent on duplicate delivery (no state regression)"
 *   - "sipWebhook records voiceLastError on failure callback"
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  reconcileVoiceCallback,
  mapEventToTargetState,
  type BookingDocSnap,
  type BookingTxnContext,
  type ReconcileDeps,
} from "../sipWebhook.js"
import type { OutboundBookingRow, VoiceCallbackEvent } from "../types.js"

const NOW = new Date("2026-05-15T12:00:00.000Z")

function makeFakeContext(initial: Record<string, OutboundBookingRow>): {
  ctx: BookingTxnContext
  store: Map<string, OutboundBookingRow>
  writes: Array<{ id: string; update: Partial<OutboundBookingRow> }>
} {
  const store = new Map<string, OutboundBookingRow>(Object.entries(initial))
  const writes: Array<{ id: string; update: Partial<OutboundBookingRow> }> = []

  const snapFor = (id: string): BookingDocSnap | null => {
    if (!store.has(id)) return null
    return {
      exists: true,
      id,
      data: () => store.get(id),
      ref: {
        async set(update, opts) {
          writes.push({ id, update: { ...update } })
          const existing = store.get(id) ?? {}
          if (opts?.merge === false) {
            store.set(id, { ...update } as OutboundBookingRow)
          } else {
            store.set(id, { ...existing, ...update })
          }
          return undefined
        },
      },
    }
  }

  return {
    store,
    writes,
    ctx: {
      async getById(id) {
        return snapFor(id)
      },
      async findByCallSid(callSid) {
        for (const [id, row] of store.entries()) {
          if (row.voiceCallSid === callSid) return snapFor(id)
        }
        return null
      },
      async findByRoomName(roomName) {
        for (const [id, row] of store.entries()) {
          if (row.voiceRoomName === roomName) return snapFor(id)
        }
        return null
      },
    },
  }
}

function deps(ctx: BookingTxnContext): ReconcileDeps {
  return {
    txnContext: ctx,
    now: () => NOW,
  }
}

describe("mapEventToTargetState", () => {
  it("twilio in-progress → connected + voiceStartedAt", () => {
    const r = mapEventToTargetState(
      { source: "twilio", CallSid: "CA1", CallStatus: "in-progress" },
      NOW,
    )
    assert.equal(r.target, "connected")
    assert.equal(r.sideEffects.voiceStartedAt, NOW.toISOString())
  })

  it("twilio completed → completed + voiceOutcome", () => {
    const r = mapEventToTargetState(
      { source: "twilio", CallSid: "CA1", CallStatus: "completed" },
      NOW,
    )
    assert.equal(r.target, "completed")
    assert.equal(r.sideEffects.voiceOutcome, "completed:ok")
  })

  it("twilio busy → failed + outcome", () => {
    const r = mapEventToTargetState(
      { source: "twilio", CallSid: "CA1", CallStatus: "busy" },
      NOW,
    )
    assert.equal(r.target, "failed")
    assert.equal(r.sideEffects.voiceOutcome, "failed:busy")
  })

  it("livekit participant_joined → connected", () => {
    const r = mapEventToTargetState(
      { source: "livekit", event: "participant_joined", room: { name: "B-1" } },
      NOW,
    )
    assert.equal(r.target, "connected")
  })

  it("livekit room_finished → completed", () => {
    const r = mapEventToTargetState(
      { source: "livekit", event: "room_finished", room: { name: "B-1" } },
      NOW,
    )
    assert.equal(r.target, "completed")
  })

  it("livekit participant_left → ignored (target=null)", () => {
    const r = mapEventToTargetState(
      { source: "livekit", event: "participant_left", room: { name: "B-1" } },
      NOW,
    )
    assert.equal(r.target, null)
  })
})

describe("reconcileVoiceCallback", () => {
  it("reconciles dialing → connected on first Twilio in-progress delivery", async () => {
    const { ctx, store, writes } = makeFakeContext({
      "B-1": {
        paUserId: "U1",
        paJobId: "J1",
        voiceState: "dialing",
        voiceCallSid: "CA-1",
        voiceRoomName: "B-1",
      },
    })
    const event: VoiceCallbackEvent = {
      source: "twilio",
      CallSid: "CA-1",
      CallStatus: "in-progress",
    }
    const result = await reconcileVoiceCallback(event, deps(ctx))
    assert.equal(result.applied, true)
    assert.equal(result.bookingId, "B-1")
    assert.equal(result.fromState, "dialing")
    assert.equal(result.toState, "connected")
    assert.equal(store.get("B-1")?.voiceState, "connected")
    assert.equal(store.get("B-1")?.voiceStartedAt, NOW.toISOString())
    assert.equal(writes.length, 1)
  })

  it("is idempotent on duplicate delivery — no state regression, no second write", async () => {
    const { ctx, store, writes } = makeFakeContext({
      "B-1": {
        paUserId: "U1",
        paJobId: "J1",
        voiceState: "dialing",
        voiceCallSid: "CA-1",
        voiceRoomName: "B-1",
      },
    })
    const event: VoiceCallbackEvent = {
      source: "twilio",
      CallSid: "CA-1",
      CallStatus: "in-progress",
    }
    // First delivery
    const r1 = await reconcileVoiceCallback(event, deps(ctx))
    assert.equal(r1.applied, true)
    // Second delivery (replay)
    const r2 = await reconcileVoiceCallback(event, deps(ctx))
    assert.equal(r2.applied, false)
    assert.equal(r2.reason, "no_op_self_transition")
    assert.equal(store.get("B-1")?.voiceState, "connected")
    // voiceStartedAt unchanged on replay.
    assert.equal(store.get("B-1")?.voiceStartedAt, NOW.toISOString())
    // Only one Firestore write happened total.
    assert.equal(writes.length, 1)
  })

  it("rejects invalid backward transition (completed → dialing) and does not write", async () => {
    const { ctx, store, writes } = makeFakeContext({
      "B-1": {
        paUserId: "U1",
        paJobId: "J1",
        voiceState: "completed",
        voiceCallSid: "CA-1",
        voiceRoomName: "B-1",
      },
    })
    const event: VoiceCallbackEvent = {
      source: "twilio",
      CallSid: "CA-1",
      CallStatus: "ringing", // would map to dialing — invalid from completed
    }
    const result = await reconcileVoiceCallback(event, deps(ctx))
    assert.equal(result.applied, false)
    assert.equal(result.reason, "invalid_transition")
    assert.equal(store.get("B-1")?.voiceState, "completed")
    assert.equal(writes.length, 0)
  })

  it("records voiceLastError + voiceOutcome on Twilio failure callback", async () => {
    const { ctx, store } = makeFakeContext({
      "B-1": {
        paUserId: "U1",
        paJobId: "J1",
        voiceState: "dialing",
        voiceCallSid: "CA-1",
        voiceRoomName: "B-1",
      },
    })
    const event: VoiceCallbackEvent = {
      source: "twilio",
      CallSid: "CA-1",
      CallStatus: "failed",
      ErrorCode: "31002",
      ErrorMessage: "Connection Declined",
    }
    const result = await reconcileVoiceCallback(event, deps(ctx))
    assert.equal(result.applied, true)
    assert.equal(result.toState, "failed")
    const row = store.get("B-1")!
    assert.equal(row.voiceState, "failed")
    assert.equal(row.voiceOutcome, "failed:failed")
    assert.match(String(row.voiceLastError), /31002/)
    assert.match(String(row.voiceLastError), /Connection Declined/)
    assert.equal(row.voiceEndedAt, NOW.toISOString())
  })

  it("resolves booking via LiveKit room name when room == bookingId", async () => {
    const { ctx, store } = makeFakeContext({
      "B-99": {
        paUserId: "U1",
        paJobId: "J1",
        voiceState: "dialing",
        voiceCallSid: "CA-99",
        voiceRoomName: "B-99",
      },
    })
    const event: VoiceCallbackEvent = {
      source: "livekit",
      event: "participant_joined",
      room: { name: "B-99" },
      participant: { identity: "candidate-U1" },
    }
    const result = await reconcileVoiceCallback(event, deps(ctx))
    assert.equal(result.applied, true)
    assert.equal(result.bookingId, "B-99")
    assert.equal(store.get("B-99")?.voiceState, "connected")
  })

  it("stamps missing voiceCallSid when Twilio callback arrives before dispatch-write has settled", async () => {
    const { ctx, store } = makeFakeContext({
      "B-1": {
        paUserId: "U1",
        paJobId: "J1",
        voiceState: "dialing",
        voiceRoomName: "B-1",
        // voiceCallSid intentionally absent (race window).
      },
    })
    // Lookup will find by id (carried in bookingId on the event), then stamp
    // the CallSid.
    const event: VoiceCallbackEvent = {
      source: "twilio",
      CallSid: "CA-late",
      CallStatus: "in-progress",
      bookingId: "B-1",
    }
    const result = await reconcileVoiceCallback(event, deps(ctx))
    assert.equal(result.applied, true)
    assert.equal(store.get("B-1")?.voiceCallSid, "CA-late")
    assert.equal(store.get("B-1")?.voiceState, "connected")
  })

  it("returns booking_not_found when no row matches event", async () => {
    const { ctx } = makeFakeContext({})
    const event: VoiceCallbackEvent = {
      source: "twilio",
      CallSid: "CA-ghost",
      CallStatus: "in-progress",
    }
    const result = await reconcileVoiceCallback(event, deps(ctx))
    assert.equal(result.applied, false)
    assert.equal(result.reason, "booking_not_found")
  })
})
