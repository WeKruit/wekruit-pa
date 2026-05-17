import test from "node:test"
import assert from "node:assert/strict"

import {
  FirestoreTurnRecorder,
  InMemoryTurnRecorder,
  type PrescreenTurnRecord,
} from "../turn-recorder.js"

test("InMemoryTurnRecorder.record stores records per session", async () => {
  const r = new InMemoryTurnRecorder()
  const turn: PrescreenTurnRecord = {
    qId: "q1",
    reply: "hello",
    action: { kind: "clarify", qId: "q1", kAfter: 1 },
    ts: "2026-05-16T00:00:00Z",
  }
  await r.record("s1", turn)
  assert.deepEqual(r.getRecords("s1"), [turn])
})

test("InMemoryTurnRecorder.record isolates by session", async () => {
  const r = new InMemoryTurnRecorder()
  await r.record("s1", { qId: "q1", reply: "a", action: { kind: "clarify", qId: "q1", kAfter: 1 }, ts: "t1" })
  await r.record("s2", { qId: "q2", reply: "b", action: { kind: "advance", fromQId: "q1", toQId: "q2" }, ts: "t2" })
  assert.equal(r.getRecords("s1").length, 1)
  assert.equal(r.getRecords("s2").length, 1)
  assert.equal(r.getRecords("s1")[0]!.reply, "a")
})

test("InMemoryTurnRecorder.record carries scored snapshot when present", async () => {
  const r = new InMemoryTurnRecorder()
  await r.record("s1", {
    qId: "q1",
    reply: "x",
    scored: { perKeyword: [{ keyword: "k1", match: 0.9 }], aggregate: { s: 0.9 } },
    action: { kind: "advance", fromQId: "q1", toQId: "q2" },
    ts: "t",
  })
  const recorded = r.getRecords("s1")[0]!
  assert.ok(recorded.scored)
  assert.deepEqual(recorded.scored!.aggregate, { s: 0.9 })
})

test("InMemoryTurnRecorder.markPostTerminalAck stores ack timestamp", async () => {
  const r = new InMemoryTurnRecorder()
  await r.markPostTerminalAck("s1", "2026-05-16T00:00:00Z")
  assert.equal(r.getAck("s1"), "2026-05-16T00:00:00Z")
})

test("InMemoryTurnRecorder.markPostTerminalAck overwrites previous ack", async () => {
  const r = new InMemoryTurnRecorder()
  await r.markPostTerminalAck("s1", "t1")
  await r.markPostTerminalAck("s1", "t2")
  assert.equal(r.getAck("s1"), "t2")
})

test("InMemoryTurnRecorder.record accepts all action kinds without coercion", async () => {
  const r = new InMemoryTurnRecorder()
  const kinds: PrescreenTurnRecord["action"][] = [
    { kind: "clarify", qId: "q1", kAfter: 1 },
    { kind: "advance", fromQId: "q1", toQId: "q2" },
    { kind: "terminal", terminal: "PASS", reason: "score_met" },
    { kind: "error", reason: "stub" },
    { kind: "post_terminal_followup", terminal: "PASS", reason: "recent_ended" },
  ]
  for (let i = 0; i < kinds.length; i++) {
    await r.record("s1", { qId: "q1", reply: `r${i}`, action: kinds[i]!, ts: `t${i}` })
  }
  assert.equal(r.getRecords("s1").length, 5)
  assert.equal(r.getRecords("s1")[2]!.action.kind, "terminal")
})

/* ────────────────────────────────────────────────────────────────────────── */
/* Firestore impl — fake-Firestore spy tests                                  */
/* ────────────────────────────────────────────────────────────────────────── */

interface AddCall { payload: Record<string, unknown> }
interface SetCall { id: string; patch: Record<string, unknown>; merge: boolean }

function makeFakeFirestore() {
  const adds: AddCall[] = []
  const sets: SetCall[] = []
  const fake = {
    collection: (name: string) => {
      if (name !== "pa-prescreen-sessions") throw new Error("unexpected collection " + name)
      return {
        doc: (id: string) => ({
          collection: (sub: string) => {
            if (sub !== "turns") throw new Error("unexpected subcollection " + sub)
            return {
              add: async (payload: Record<string, unknown>) => {
                adds.push({ payload })
              },
            }
          },
          set: async (patch: Record<string, unknown>, opts?: { merge?: boolean }) => {
            sets.push({ id, patch, merge: opts?.merge === true })
          },
        }),
      }
    },
    _adds: adds,
    _sets: sets,
  }
  return fake
}

test("FirestoreTurnRecorder.record writes to {sessionId}/turns/", async () => {
  const fake = makeFakeFirestore()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = new FirestoreTurnRecorder(fake as any)
  await r.record("s1", {
    qId: "q1",
    reply: "hi",
    action: { kind: "advance", fromQId: "q1", toQId: "q2" },
    ts: "2026-05-16T00:00:00Z",
  })
  assert.equal(fake._adds.length, 1)
  assert.equal(fake._adds[0]!.payload.qId, "q1")
  assert.equal(fake._adds[0]!.payload.reply, "hi")
  assert.equal((fake._adds[0]!.payload.action as { kind: string }).kind, "advance")
})

test("FirestoreTurnRecorder.record omits scored when absent", async () => {
  const fake = makeFakeFirestore()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = new FirestoreTurnRecorder(fake as any)
  await r.record("s1", {
    qId: "q1",
    reply: "hi",
    action: { kind: "clarify", qId: "q1", kAfter: 1 },
    ts: "t",
  })
  assert.equal("scored" in fake._adds[0]!.payload, false)
})

test("FirestoreTurnRecorder.record includes scored snapshot when present", async () => {
  const fake = makeFakeFirestore()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = new FirestoreTurnRecorder(fake as any)
  await r.record("s1", {
    qId: "q1",
    reply: "hi",
    scored: { perKeyword: [{ k: 1 }], aggregate: { s: 0.7 }, abortHint: { kind: "low_confidence", reason: "x" } },
    action: { kind: "clarify", qId: "q1", kAfter: 1 },
    ts: "t",
  })
  const scored = fake._adds[0]!.payload.scored as Record<string, unknown>
  assert.ok(scored)
  assert.deepEqual(scored.aggregate, { s: 0.7 })
  assert.deepEqual(scored.abortHint, { kind: "low_confidence", reason: "x" })
})

test("FirestoreTurnRecorder.markPostTerminalAck merges ack timestamp", async () => {
  const fake = makeFakeFirestore()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = new FirestoreTurnRecorder(fake as any)
  await r.markPostTerminalAck("s1", "2026-05-16T01:00:00Z")
  assert.equal(fake._sets.length, 1)
  assert.equal(fake._sets[0]!.id, "s1")
  assert.equal(fake._sets[0]!.merge, true)
  assert.equal(fake._sets[0]!.patch.postTerminalFollowupAckAt, "2026-05-16T01:00:00Z")
  assert.equal(fake._sets[0]!.patch.updatedAt, "2026-05-16T01:00:00Z")
})
