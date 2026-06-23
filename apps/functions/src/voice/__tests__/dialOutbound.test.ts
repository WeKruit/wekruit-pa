/**
 * S3 — dialOutbound handler tests.
 *
 * Covers acceptance:
 *   - "dialOutbound creates LiveKit room + SIP participant on queued→dialing"
 *   - "dialOutbound rotates caller IDs across calls"
 *   - "dialOutbound short-circuits if missing paUserId or paJobId"
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  handleDialOutbound,
  isDialGate,
  type BookingDocRef,
  type DialOutboundDeps,
} from "../dialOutbound.js"
import { RoundRobinCallerIdStrategy } from "../caller-id-rotator.js"
import type { OutboundBookingRow, SipClientLike, SipParticipantInfo } from "../types.js"

const TRUNK_SID = "TKtest1234"
const CALLER_IDS = ["+14157075057", "+16468594057"]
const DEV_PHONE = "+14243201960"
const NON_DEV_PHONE = "+15551234567"

function makeFakeBookingRef(initial: OutboundBookingRow = {}): BookingDocRef & {
  data: OutboundBookingRow
  writes: Array<Partial<OutboundBookingRow>>
} {
  const data: OutboundBookingRow = { ...initial }
  const writes: Array<Partial<OutboundBookingRow>> = []
  return {
    data,
    writes,
    async set(update, _opts) {
      writes.push({ ...update })
      Object.assign(data, update)
      return undefined
    },
  }
}

function makeFakeSipClient(): SipClientLike & {
  calls: Array<Parameters<SipClientLike["createSipParticipant"]>[0]>
  failNext: boolean
  nextSid: string
} {
  const calls: Array<Parameters<SipClientLike["createSipParticipant"]>[0]> = []
  let counter = 0
  const fake = {
    calls,
    failNext: false,
    nextSid: "",
    async createSipParticipant(opts: Parameters<SipClientLike["createSipParticipant"]>[0]): Promise<SipParticipantInfo> {
      calls.push(opts)
      if (fake.failNext) {
        fake.failNext = false
        throw new Error("livekit sip error: trunk auth failed")
      }
      counter += 1
      const sid = fake.nextSid || `CA-test-${counter}`
      fake.nextSid = ""
      return {
        sipCallId: sid,
        roomName: opts.roomName,
        participantIdentity: opts.participantIdentity,
      }
    },
  }
  return fake
}

function makeDeps(overrides: Partial<DialOutboundDeps> = {}): DialOutboundDeps & {
  sipClient: ReturnType<typeof makeFakeSipClient>
} {
  const sipClient = (overrides.sipClient as ReturnType<typeof makeFakeSipClient>) ?? makeFakeSipClient()
  return {
    sipClient,
    callerIdStrategy: overrides.callerIdStrategy ?? new RoundRobinCallerIdStrategy(CALLER_IDS),
    trunkSid: overrides.trunkSid ?? TRUNK_SID,
    deriveRoomName: overrides.deriveRoomName,
    now: overrides.now ?? (() => new Date("2026-05-15T00:00:00.000Z")),
    log: overrides.log,
  }
}

describe("isDialGate", () => {
  it("returns true on queued→dialing", () => {
    assert.equal(
      isDialGate({ voiceState: "queued" }, { voiceState: "dialing" }),
      true,
    )
  })

  it("returns true on undefined→dialing (doc-create)", () => {
    assert.equal(isDialGate(undefined, { voiceState: "dialing" }), true)
  })

  it("returns false on dialing→dialing (idempotent rewrite)", () => {
    assert.equal(
      isDialGate({ voiceState: "dialing" }, { voiceState: "dialing" }),
      false,
    )
  })

  it("returns false on connected→connected (post-dispatch writes)", () => {
    assert.equal(
      isDialGate({ voiceState: "connected" }, { voiceState: "connected" }),
      false,
    )
  })

  it("returns false on delete (after undefined)", () => {
    assert.equal(isDialGate({ voiceState: "dialing" }, undefined), false)
  })
})

describe("handleDialOutbound", () => {
  it("creates LiveKit SIP participant on queued→dialing", async () => {
    const ref = makeFakeBookingRef({
      paUserId: "U1",
      paJobId: "J1",
      phoneE164: DEV_PHONE,
      voiceState: "dialing",
    })
    const deps = makeDeps()
    const result = await handleDialOutbound(
      {
        bookingId: "B-1",
        before: { voiceState: "queued" },
        after: { ...ref.data },
        bookingRef: ref,
      },
      deps,
    )
    assert.equal(result.action, "dispatched")
    assert.equal(deps.sipClient.calls.length, 1)
    const opts = deps.sipClient.calls[0]!
    assert.equal(opts.sipTrunkId, TRUNK_SID)
    assert.equal(opts.sipCallTo, DEV_PHONE)
    assert.equal(opts.roomName, "B-1") // room = bookingId
    assert.equal(opts.participantIdentity, "candidate-U1")
    assert.ok(CALLER_IDS.includes(opts.fromNumber))
    // Booking row written with sid + callerId + roomName.
    assert.ok(ref.data.voiceCallSid)
    assert.equal(ref.data.voiceRoomName, "B-1")
    assert.equal(ref.data.voiceCallerId, opts.fromNumber)
    // Crucially: voiceState NOT advanced here — webhook owns that.
    assert.equal(ref.data.voiceState, "dialing")
  })

  it("dispatches the agent to the room BEFORE creating the SIP participant (warm-first)", async () => {
    const ref = makeFakeBookingRef({ paUserId: "U1", paJobId: "J1", phoneE164: DEV_PHONE, voiceState: "dialing" })
    const order: string[] = []
    const sipClient = makeFakeSipClient()
    const origSip = sipClient.createSipParticipant.bind(sipClient)
    sipClient.createSipParticipant = async (opts) => {
      order.push("sip")
      return origSip(opts)
    }
    const dispatchCalls: Array<{ roomName: string; metadata: string }> = []
    const deps = makeDeps({ sipClient })
    deps.dispatchAgent = async (args) => {
      order.push("dispatch")
      dispatchCalls.push(args)
    }
    const result = await handleDialOutbound(
      { bookingId: "B-1", before: { voiceState: "queued" }, after: { ...ref.data }, bookingRef: ref },
      deps,
    )
    assert.equal(result.action, "dispatched")
    assert.deepEqual(order, ["dispatch", "sip"], "agent must be dispatched BEFORE the SIP call")
    assert.equal(dispatchCalls.length, 1)
    assert.equal(dispatchCalls[0]!.roomName, "B-1")
    assert.match(dispatchCalls[0]!.metadata, /B-1/)
  })

  it("fails the booking and never dials when agent dispatch throws", async () => {
    const ref = makeFakeBookingRef({ paUserId: "U1", paJobId: "J1", phoneE164: DEV_PHONE, voiceState: "dialing" })
    const deps = makeDeps()
    deps.dispatchAgent = async () => {
      throw new Error("dispatch failed: agent worker unavailable")
    }
    const result = await handleDialOutbound(
      { bookingId: "B-1", before: { voiceState: "queued" }, after: { ...ref.data }, bookingRef: ref },
      deps,
    )
    assert.equal(result.action, "failed:agent_dispatch")
    assert.equal(deps.sipClient.calls.length, 0, "must NOT place the call if no agent could be dispatched")
    assert.equal(ref.data.voiceState, "failed")
    assert.equal(ref.data.voiceOutcome, "failed:agent_dispatch_error")
  })

  it("rotates caller IDs across distinct bookings (round-robin)", async () => {
    const deps = makeDeps()
    const usedNumbers: string[] = []
    for (let i = 0; i < 20; i++) {
      const ref = makeFakeBookingRef({
        paUserId: `U-${i}`,
        paJobId: "J1",
        phoneE164: DEV_PHONE,
        voiceState: "dialing",
      })
      const res = await handleDialOutbound(
        {
          bookingId: `B-${i}`,
          before: { voiceState: "queued" },
          after: { ...ref.data },
          bookingRef: ref,
        },
        deps,
      )
      assert.equal(res.action, "dispatched")
      usedNumbers.push(res.callerId!)
    }
    const unique = new Set(usedNumbers)
    assert.equal(unique.size, 2, `expected both caller IDs across 20 bookings; got ${[...unique].join(",")}`)
  })

  it("short-circuits if paUserId missing — never calls SIP, transitions to failed", async () => {
    const ref = makeFakeBookingRef({
      paJobId: "J1",
      phoneE164: DEV_PHONE,
      voiceState: "dialing",
    })
    const deps = makeDeps()
    const result = await handleDialOutbound(
      {
        bookingId: "B-2",
        before: { voiceState: "queued" },
        after: { ...ref.data },
        bookingRef: ref,
      },
      deps,
    )
    assert.equal(result.action, "failed:missing_identity")
    assert.equal(deps.sipClient.calls.length, 0, "SIP client must NOT be called")
    assert.equal(ref.data.voiceState, "failed")
    assert.match(String(ref.data.voiceLastError), /paUserId/)
    assert.equal(ref.data.voiceOutcome, "failed:missing_identity")
  })

  it("short-circuits if paJobId missing — never calls SIP, transitions to failed", async () => {
    const ref = makeFakeBookingRef({
      paUserId: "U1",
      purpose: "prescreen",
      phoneE164: DEV_PHONE,
      voiceState: "dialing",
    })
    const deps = makeDeps()
    const result = await handleDialOutbound(
      {
        bookingId: "B-3",
        before: { voiceState: "queued" },
        after: { ...ref.data },
        bookingRef: ref,
      },
      deps,
    )
    assert.equal(result.action, "failed:missing_identity")
    assert.equal(deps.sipClient.calls.length, 0)
    assert.equal(ref.data.voiceState, "failed")
    assert.match(String(ref.data.voiceLastError), /paJobId/)
  })

  it("allows onboarding bookings without paJobId", async () => {
    const ref = makeFakeBookingRef({
      paUserId: "U1",
      purpose: "onboarding",
      phoneE164: DEV_PHONE,
      voiceState: "dialing",
    })
    const deps = makeDeps()
    const result = await handleDialOutbound(
      {
        bookingId: "B-onboard",
        before: { voiceState: "queued" },
        after: { ...ref.data },
        bookingRef: ref,
      },
      deps,
    )
    assert.equal(result.action, "dispatched")
    assert.equal(deps.sipClient.calls.length, 1)
    assert.equal(deps.sipClient.calls[0]!.participantIdentity, "candidate-U1")
  })

  it("blocks non-dev phone numbers before SIP dispatch", async () => {
    const ref = makeFakeBookingRef({
      paUserId: "U1",
      paJobId: "J1",
      phoneE164: NON_DEV_PHONE,
      voiceState: "dialing",
    })
    const deps = makeDeps()
    const result = await handleDialOutbound(
      {
        bookingId: "B-non-dev",
        before: { voiceState: "queued" },
        after: { ...ref.data },
        bookingRef: ref,
      },
      deps,
    )
    assert.equal(result.action, "failed:dev_phone_gate")
    assert.equal(deps.sipClient.calls.length, 0)
    assert.equal(ref.data.voiceState, "failed")
    assert.equal(ref.data.voiceOutcome, "failed:dev_phone_gate")
  })

  it("short-circuits if phoneE164 missing", async () => {
    const ref = makeFakeBookingRef({
      paUserId: "U1",
      paJobId: "J1",
      voiceState: "dialing",
    })
    const deps = makeDeps()
    const result = await handleDialOutbound(
      {
        bookingId: "B-4",
        before: { voiceState: "queued" },
        after: { ...ref.data },
        bookingRef: ref,
      },
      deps,
    )
    assert.equal(result.action, "failed:missing_identity")
    assert.equal(deps.sipClient.calls.length, 0)
    assert.equal(ref.data.voiceState, "failed")
    assert.equal(ref.data.voiceOutcome, "failed:missing_phone")
  })

  it("captures SIP dispatch failure and writes voiceLastError", async () => {
    const ref = makeFakeBookingRef({
      paUserId: "U1",
      paJobId: "J1",
      phoneE164: DEV_PHONE,
      voiceState: "dialing",
    })
    const deps = makeDeps()
    deps.sipClient.failNext = true
    const result = await handleDialOutbound(
      {
        bookingId: "B-5",
        before: { voiceState: "queued" },
        after: { ...ref.data },
        bookingRef: ref,
      },
      deps,
    )
    assert.equal(result.action, "failed:sip_dispatch")
    assert.equal(ref.data.voiceState, "failed")
    assert.equal(ref.data.voiceOutcome, "failed:sip_dispatch_error")
    assert.match(String(ref.data.voiceLastError), /trunk auth failed/)
  })

  it("skips non-transition writes (e.g. connected→connected)", async () => {
    const ref = makeFakeBookingRef({
      paUserId: "U1",
      paJobId: "J1",
      phoneE164: DEV_PHONE,
      voiceState: "connected",
    })
    const deps = makeDeps()
    const result = await handleDialOutbound(
      {
        bookingId: "B-6",
        before: { voiceState: "connected" },
        after: { ...ref.data },
        bookingRef: ref,
      },
      deps,
    )
    assert.equal(result.action, "skipped:no_transition")
    assert.equal(deps.sipClient.calls.length, 0)
    assert.equal(ref.writes.length, 0)
  })
})
