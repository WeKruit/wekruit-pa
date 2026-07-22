/**
 * yc-intake-admin tests — the YC event operator queue (list + one-click send).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import { runYcIntakeToday, runYcSendMatches } from "./yc-intake-admin.js"

type DocData = Record<string, unknown>

function makeDb(users: Record<string, DocData>) {
  const store = new Map(Object.entries(users))
  const db = {
    collection(name: string) {
      if (name !== "pa-users") throw new Error(`unexpected collection ${name}`)
      return {
        where(field: string, _op: string, val: unknown) {
          return {
            limit(_n: number) {
              return this
            },
            async get() {
              const docs = [...store.entries()]
                .filter(([, d]) => d[field] === val)
                .map(([id, d]) => ({ id, data: () => d }))
              return { docs, size: docs.length }
            },
          }
        },
        doc(id: string) {
          return {
            async get() {
              const d = store.get(id)
              return { exists: d !== undefined, data: () => d }
            },
            async set(patch: DocData, opts?: { merge?: boolean }) {
              if (opts?.merge) store.set(id, { ...(store.get(id) ?? {}), ...patch })
              else store.set(id, { ...patch })
            },
          }
        },
      }
    },
  } as unknown as Firestore
  return { db, store }
}

const YC_BASE = {
  source: "yc_startup_school",
  phoneE164: "+19999990001",
  displayName: "Devi",
  createdAt: "2026-07-21T18:00:00.000Z",
}

test("runYcIntakeToday splits ready vs incomplete, drops test/demo + phoneless rows", async () => {
  const { db } = makeDb({
    ready1: {
      ...YC_BASE,
      ycIntake: { building: "an eval tool", wantsToMeet: "infra founders", completedAt: "2026-07-21T18:30:00.000Z" },
    },
    straggler: { ...YC_BASE, ycIntake: { building: "a robot" } },
    testy: { ...YC_BASE, testMode: true, ycIntake: { completedAt: "2026-07-21T18:30:00.000Z" } },
    phoneless: { source: "yc_startup_school", ycIntake: { completedAt: "2026-07-21T18:30:00.000Z" } },
    otherSource: { source: "candidate", phoneE164: "+19999990002" },
  })
  const res = await runYcIntakeToday({ db })
  assert.equal(res.ready.length, 1)
  assert.equal(res.ready[0]!.userId, "ready1")
  assert.equal(res.ready[0]!.building, "an eval tool")
  assert.equal(res.incomplete.length, 1)
  assert.equal(res.incomplete[0]!.userId, "straggler")
})

test("runYcSendMatches: guards (not yc / incomplete / already sent today) + happy path stamps", async () => {
  const NOW = "2026-07-21T19:00:00.000Z"
  const { db, store } = makeDb({
    ok1: { ...YC_BASE, ycIntake: { building: "x", wantsToMeet: "y", completedAt: NOW } },
    notYc: { source: "candidate", phoneE164: "+1", ycIntake: { completedAt: NOW } },
    incomplete: { ...YC_BASE, ycIntake: { building: "x" } },
    sentAlready: {
      ...YC_BASE,
      ycIntake: { building: "x", wantsToMeet: "y", completedAt: NOW },
      ycEveningMatchSentAt: "2026-07-21T18:59:00.000Z",
    },
  })
  const sends: Array<{ userId: string; context: Record<string, unknown>; idempotencyKey: string }> = []
  const sendImessage = async (args: { userId: string; context: Record<string, unknown>; idempotencyKey?: string }) => {
    sends.push({ userId: args.userId, context: args.context, idempotencyKey: args.idempotencyKey ?? "" })
    return { ok: true }
  }
  const matchCalls: string[] = []
  const findMatch = async ({ userId }: { userId: string; requestedCount?: number | null }) => {
    matchCalls.push(userId)
    return {
      ok: true,
      recCount: 2,
      jobs: ["Founding Engineer @ VoiceCursor\nhttps://wekruit.com/j/vc-1", "ML Engineer @ Sekai\nhttps://wekruit.com/j/sk-1"],
      reason: null,
    }
  }
  const deps = { db, findMatch, sendImessage, nowIso: () => NOW }

  assert.deepEqual(await runYcSendMatches(deps, "missing"), { ok: false, reason: "user_not_found" })
  assert.deepEqual(await runYcSendMatches(deps, "notYc"), { ok: false, reason: "not_yc_user" })
  assert.deepEqual(await runYcSendMatches(deps, "incomplete"), { ok: false, reason: "intake_incomplete" })
  assert.deepEqual(await runYcSendMatches(deps, "sentAlready"), { ok: false, reason: "already_sent_today" })
  assert.equal(sends.length, 0, "no send fired for any guard")

  const ok = await runYcSendMatches(deps, "ok1")
  assert.deepEqual(ok, { ok: true, recCount: 2 })
  assert.deepEqual(matchCalls, ["ok1"], "guards never reach the matcher")
  assert.equal(sends.length, 1)
  assert.equal(sends[0]!.userId, "ok1")
  assert.equal(sends[0]!.idempotencyKey, "yc-evening-match:ok1:2026-07-21")
  const body = String(sends[0]!.context.trustedOutboundBody)
  assert.match(body, /tonight's founder matches, as promised/)
  assert.match(body, /Founding Engineer @ VoiceCursor/)
  assert.match(body, /make an intro/)
  assert.equal(store.get("ok1")!.ycEveningMatchSentAt, NOW, "sent stamp recorded")
})

test("runYcSendMatches: zero matches → honest no_matches, NOTHING sent, no stamp", async () => {
  const NOW = "2026-07-21T19:00:00.000Z"
  const { db, store } = makeDb({
    ok1: { ...YC_BASE, ycIntake: { building: "x", wantsToMeet: "y", completedAt: NOW } },
  })
  const sends: unknown[] = []
  const deps = {
    db,
    findMatch: async () => ({ ok: true, recCount: 0, jobs: [], reason: "no matches" }),
    sendImessage: async (args: unknown) => {
      sends.push(args)
      return { ok: true }
    },
    nowIso: () => NOW,
  }
  const res = await runYcSendMatches(deps, "ok1")
  assert.deepEqual(res, { ok: false, reason: "no_matches", recCount: 0 })
  assert.equal(sends.length, 0)
  assert.equal(store.get("ok1")!.ycEveningMatchSentAt, undefined)
})
