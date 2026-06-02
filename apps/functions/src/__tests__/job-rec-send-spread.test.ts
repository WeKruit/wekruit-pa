/**
 * Tests for the production send-spread wiring (cadence + time-spread, 2026-06-02).
 * Covers: per-group cap derivation, sticky from-number → group bucket key,
 * Cloud Tasks env resolution + fail-open, and the scheduleSend enqueue path
 * with a fake TasksClient.
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { Firestore } from "firebase-admin/firestore"
import type { SendbluePoolConfig } from "../sendblue/pool.js"
import { _resetPoolCache, _resetCountersCache } from "../sendblue/pool.js"
import {
  buildNumberCapacities,
  resolveJobRecTasksConfig,
  sanitizeTaskName,
  buildJobRecSendSpreadDeps,
} from "../job-rec-send-spread.js"
import type { EnqueueInput, TasksClient } from "../coalesce/tasks-client.js"

const POOL: SendbluePoolConfig = {
  groups: [
    {
      groupId: "g1",
      status: "active",
      audience: "public",
      dailySendCap: 300,
      numbers: ["+15550000001", "+15550000002"],
    },
    {
      groupId: "g2",
      status: "active",
      audience: "public",
      dailySendCap: 500,
      numbers: ["+15550000003"],
    },
    {
      // No cap → unbounded → omitted from numberCapacities.
      groupId: "g3",
      status: "active",
      audience: "public",
      numbers: ["+15550000004"],
    },
  ],
}

/** Minimal Firestore stub for `pa-config/{doc}` reads only. */
function stubFirestore(pool: SendbluePoolConfig | null): Firestore {
  return {
    collection(name: string) {
      assert.equal(name, "pa-config")
      return {
        doc(id: string) {
          return {
            async get() {
              if (id === "sendblue-pool") {
                return { exists: pool !== null, data: () => pool }
              }
              // sendblue-pool-counters → empty
              return { exists: false, data: () => ({}) }
            },
          }
        },
      }
    },
  } as unknown as Firestore
}

class FakeTasksClient implements TasksClient {
  enqueued: EnqueueInput[] = []
  throwCode: number | null = null
  async enqueueDelayedTask(input: EnqueueInput): Promise<string> {
    if (this.throwCode !== null) {
      const e = new Error("fake") as Error & { code?: number }
      e.code = this.throwCode
      throw e
    }
    this.enqueued.push(input)
    return `tasks/${input.taskName}`
  }
  async cancelTask(): Promise<boolean> {
    return true
  }
  taskPath(s: string): string {
    return `q/${s}`
  }
  queuePath(): string {
    return "q"
  }
}

beforeEach(() => {
  _resetPoolCache()
  _resetCountersCache()
})

describe("buildNumberCapacities", () => {
  it("derives per-group remaining from dailySendCap; uncapped groups omitted", () => {
    const caps = buildNumberCapacities(POOL)
    assert.deepEqual(caps, { g1: { remaining: 300 }, g2: { remaining: 500 } })
  })
  it("null pool → empty (unbounded everywhere)", () => {
    assert.deepEqual(buildNumberCapacities(null), {})
  })
})

describe("resolveJobRecTasksConfig", () => {
  it("returns null when required env is missing (→ sync fallback)", () => {
    assert.equal(resolveJobRecTasksConfig({} as NodeJS.ProcessEnv), null)
  })
  it("resolves a complete config; queue/location default sensibly", () => {
    const cfg = resolveJobRecTasksConfig({
      GCLOUD_PROJECT: "wekruit-5f89b",
      PA_JOBREC_SEND_TARGET_URL: "https://x/paJobRecSendTask",
      PA_COALESCE_INVOKER_SA: "sa@wekruit.iam.gserviceaccount.com",
    } as NodeJS.ProcessEnv)
    assert.ok(cfg)
    assert.equal(cfg!.queue, "pa-jobrec-send")
    assert.equal(cfg!.location, "us-central1")
    assert.equal(cfg!.targetUrl, "https://x/paJobRecSendTask")
  })
})

describe("sanitizeTaskName", () => {
  it("maps disallowed chars to '-' and caps length", () => {
    assert.equal(sanitizeTaskName("u1-20260602-batch"), "u1-20260602-batch")
    assert.equal(sanitizeTaskName("u/1:x@y"), "u-1-x-y")
  })
})

describe("buildJobRecSendSpreadDeps", () => {
  it("maps a user's sticky number to its group bucket key + builds caps", async () => {
    const db = stubFirestore(POOL)
    const deps = await buildJobRecSendSpreadDeps(db, {
      env: {} as NodeJS.ProcessEnv, // no tasks env → scheduleSend omitted
    })
    // numberCapacities keyed by groupId.
    assert.deepEqual(deps.numberCapacities, { g1: { remaining: 300 }, g2: { remaining: 500 } })
    // fromNumberForUser returns a GROUP id (bucket key), stable per user.
    const k1 = deps.fromNumberForUser!("alice")
    assert.ok(k1 && ["g1", "g2", "g3"].includes(k1))
    assert.equal(deps.fromNumberForUser!("alice"), k1) // stable
    // No tasks env → sync fallback.
    assert.equal(deps.scheduleSend, undefined)
  })

  it("wires scheduleSend via Cloud Tasks when env present; enqueues with delay + idempotent name", async () => {
    const db = stubFirestore(POOL)
    const fake = new FakeTasksClient()
    const deps = await buildJobRecSendSpreadDeps(db, {
      tasksClient: fake,
      env: {
        GCLOUD_PROJECT: "wekruit-5f89b",
        PA_JOBREC_SEND_TARGET_URL: "https://x/paJobRecSendTask",
        PA_COALESCE_INVOKER_SA: "sa@wekruit.iam.gserviceaccount.com",
      } as NodeJS.ProcessEnv,
    })
    assert.ok(deps.scheduleSend)
    const r = await deps.scheduleSend!({
      userId: "u1",
      context: { foo: "bar" },
      idempotencyKey: "u1-20260602-batch",
      delayMs: 12345,
      fromNumber: "g1",
    })
    assert.deepEqual(r, { ok: true })
    assert.equal(fake.enqueued.length, 1)
    assert.equal(fake.enqueued[0]!.delayMs, 12345)
    assert.equal(fake.enqueued[0]!.taskName, "jobrec-u1-20260602-batch")
    assert.equal((fake.enqueued[0]!.payload as { userId?: string }).userId, "u1")
  })

  it("scheduleSend treats ALREADY_EXISTS (code 6) as idempotent ok", async () => {
    const db = stubFirestore(POOL)
    const fake = new FakeTasksClient()
    fake.throwCode = 6
    const deps = await buildJobRecSendSpreadDeps(db, {
      tasksClient: fake,
      env: {
        GCLOUD_PROJECT: "p",
        PA_JOBREC_SEND_TARGET_URL: "https://x",
        PA_COALESCE_INVOKER_SA: "sa@x",
      } as NodeJS.ProcessEnv,
    })
    const r = await deps.scheduleSend!({
      userId: "u1",
      context: {},
      idempotencyKey: "k",
      delayMs: 0,
    })
    assert.deepEqual(r, { ok: true })
  })

  it("scheduleSend returns ok:false on a real enqueue error (fail → not stamped → retried)", async () => {
    const db = stubFirestore(POOL)
    const fake = new FakeTasksClient()
    fake.throwCode = 13 // INTERNAL
    const deps = await buildJobRecSendSpreadDeps(db, {
      tasksClient: fake,
      env: {
        GCLOUD_PROJECT: "p",
        PA_JOBREC_SEND_TARGET_URL: "https://x",
        PA_COALESCE_INVOKER_SA: "sa@x",
      } as NodeJS.ProcessEnv,
    })
    const r = await deps.scheduleSend!({
      userId: "u1",
      context: {},
      idempotencyKey: "k",
      delayMs: 0,
    })
    assert.deepEqual(r, { ok: false })
  })

  it("pool load failure → empty deps (best-effort, never throws)", async () => {
    const db = stubFirestore(null)
    const deps = await buildJobRecSendSpreadDeps(db, { env: {} as NodeJS.ProcessEnv })
    assert.deepEqual(deps.numberCapacities, {})
    assert.equal(deps.fromNumberForUser!("anyone"), undefined)
  })
})
