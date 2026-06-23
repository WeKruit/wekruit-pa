import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  composePostCallFollowup,
  handleVoicePostCallFollowup,
  isCompletedCallTransition,
} from "../post-call-followup.js"
import type { OutboundBookingRow } from "../types.js"

type Doc = Record<string, unknown>

class FakeDocRef {
  constructor(
    private readonly db: FakeDb,
    private readonly collectionPath: string,
    readonly id: string,
  ) {}

  private get key(): string {
    return `${this.collectionPath}/${this.id}`
  }

  async get() {
    const data = this.db.docs.get(this.key)
    return {
      exists: data !== undefined,
      data: () => data,
    }
  }

  async set(data: Doc, opts?: { merge?: boolean }) {
    const prev = this.db.docs.get(this.key) ?? {}
    this.db.docs.set(this.key, opts?.merge ? { ...prev, ...data } : { ...data })
  }

  async create(data: Doc) {
    if (this.db.docs.has(this.key)) {
      const err = new Error("already exists") as Error & { code?: number }
      err.code = 6
      throw err
    }
    this.db.docs.set(this.key, { ...data })
  }

  collection(name: string) {
    return new FakeCollection(this.db, `${this.key}/${name}`)
  }
}

class FakeCollection {
  constructor(
    private readonly db: FakeDb,
    private readonly collectionPath: string,
  ) {}

  doc(id: string) {
    return new FakeDocRef(this.db, this.collectionPath, id)
  }

  async get() {
    const prefix = `${this.collectionPath}/`
    const docs = Array.from(this.db.docs.entries())
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map(([path, data]) => ({
        id: path.slice(prefix.length),
        data: () => data,
      }))
    return { docs, empty: docs.length === 0 }
  }
}

class FakeDb {
  docs = new Map<string, Doc>()
  collection(name: string) {
    return new FakeCollection(this, name)
  }
}

function seed(db: FakeDb, path: string, data: Doc) {
  db.docs.set(path, { ...data })
}

describe("post-call follow-up", () => {
  it("detects only voiceState -> completed transitions", () => {
    assert.equal(isCompletedCallTransition({ voiceState: "connected" }, { voiceState: "completed" }), true)
    assert.equal(isCompletedCallTransition({ voiceState: "completed" }, { voiceState: "completed" }), false)
    assert.equal(isCompletedCallTransition({ voiceState: "dialing" }, { voiceState: "failed" }), false)
  })

  it("composes thanks + short summary + opt-in role pull", () => {
    const msg = composePostCallFollowup({
      purpose: "onboarding",
      turns: [
        { userTranscript: "I am looking for backend infra roles.", createdAt: "1" },
        { userTranscript: "Remote in the US is best.", createdAt: "2" },
      ],
    })
    assert.match(msg, /^thanks for taking the time/)
    assert.match(msg, /backend infra roles/)
    assert.match(msg, /want me to pull a few roles/)
  })

  it("sends exactly one follow-up for a completed call with stored turns", async () => {
    const db = new FakeDb()
    const booking: OutboundBookingRow = {
      paUserId: "u1",
      phoneE164: "+15551234567",
      purpose: "onboarding",
      voiceState: "completed",
    }
    seed(db, "outbound-bookings/b1", booking)
    seed(db, "outbound-bookings/b1/turns/t1", {
      userTranscript: "I want founding engineer roles.",
      claireReply: "Got it.",
      createdAt: "2026-06-01T00:00:00.000Z",
    })

    const result = await handleVoicePostCallFollowup({
      bookingId: "b1",
      before: { voiceState: "connected" },
      after: booking,
      db: db as never,
      nowIso: "2026-06-01T00:01:00.000Z",
    })

    assert.equal(result.action, "sent")
    const outbound = Array.from(db.docs.entries()).filter(([path]) => path.startsWith("pa-outbound/"))
    assert.equal(outbound.length, 1)
    assert.equal(outbound[0]![1].runtimeApproved, true)
    assert.equal(outbound[0]![1].runtimeSource, "pa_voice_post_call")
    assert.match(String(outbound[0]![1].body), /founding engineer roles/)
    assert.equal(db.docs.get("outbound-bookings/b1")!.postCallFollowupStatus, "sent")

    const duplicate = await handleVoicePostCallFollowup({
      bookingId: "b1",
      before: { voiceState: "completed" },
      after: db.docs.get("outbound-bookings/b1") as OutboundBookingRow,
      db: db as never,
      nowIso: "2026-06-01T00:02:00.000Z",
    })
    assert.equal(duplicate.action, "skipped")
    assert.equal(Array.from(db.docs.entries()).filter(([path]) => path.startsWith("pa-outbound/")).length, 1)
  })

  it("never thanks a failed call, but DOES thank a connected call with no transcript", async () => {
    const failed = await handleVoicePostCallFollowup({
      bookingId: "b-failed",
      before: { voiceState: "dialing" },
      after: { voiceState: "failed" },
      db: new FakeDb() as never,
    })
    assert.equal(failed.reason, "not_completed_transition")

    // Connected call that ended with no recorded transcript → generic thanks +
    // job-rec opt-in still sent (Adam 2026-06-21: a hangup must always send a text;
    // a short/latency-test call previously got nothing via the no_voice_turns skip).
    const db = new FakeDb()
    const booking: OutboundBookingRow = {
      paUserId: "u1",
      phoneE164: "+15551234567",
      voiceState: "completed",
    }
    seed(db, "outbound-bookings/b-empty", booking)
    const empty = await handleVoicePostCallFollowup({
      bookingId: "b-empty",
      before: { voiceState: "connected" },
      after: booking,
      db: db as never,
      nowIso: "2026-06-01T00:00:00.000Z",
    })
    assert.equal(empty.action, "sent")
    assert.match(empty.message ?? "", /pull a few roles/i)
    const outbound = Array.from(db.docs.entries()).filter(([path]) => path.startsWith("pa-outbound/"))
    assert.equal(outbound.length, 1)
    assert.match(String(outbound[0]![1].body), /thanks for hopping on/i)
    assert.equal(db.docs.get("outbound-bookings/b-empty")!.postCallFollowupStatus, "sent")
  })
})
