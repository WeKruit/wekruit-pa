import assert from "node:assert/strict"
import test from "node:test"

const {
  acquireProductionTestRunLock,
  productionTestRunLockId,
} = await import("../lib/prod-test-run-lock.mjs")

function makeFakeDb(initial = {}) {
  const store = new Map(Object.entries(initial))
  const doc = (id) => ({
    id,
    async get() {
      return {
        exists: store.has(id),
        id,
        data: () => store.get(id),
      }
    },
    async delete() {
      store.delete(id)
    },
  })
  return {
    store,
    collection(name) {
      assert.equal(name, "pa-test-run-locks")
      return { doc }
    },
    async runTransaction(fn) {
      return fn({
        async get(ref) {
          return ref.get()
        },
        set(ref, value) {
          store.set(ref.id, value)
        },
        delete(ref) {
          store.delete(ref.id)
        },
      })
    },
  }
}

test("productionTestRunLockId is stable and Firestore-safe", () => {
  assert.equal(
    productionTestRunLockId({ scope: "prescreen stress", userId: "u/1", jobId: "rain:job" }),
    "prescreen-stress_u-1_rain-job",
  )
})

test("acquireProductionTestRunLock writes an owner lock and release removes it", async () => {
  const db = makeFakeDb()
  const release = await acquireProductionTestRunLock(db, {
    lockId: "pa-user_u1",
    runId: "run-a",
    scriptName: "test-script",
    nowMs: 1000,
    ttlMs: 5000,
    projectId: "wekruit-5f89b",
    env: {},
  })
  assert.equal(db.store.get("pa-user_u1").runId, "run-a")
  assert.equal(db.store.get("pa-user_u1").expiresAtMs, 6000)

  await release()
  assert.equal(db.store.has("pa-user_u1"), false)
})

test("acquireProductionTestRunLock rejects a live lock from another run", async () => {
  const db = makeFakeDb({
    "pa-user_u1": {
      lockId: "pa-user_u1",
      runId: "run-a",
      scriptName: "other-script",
      expiresAtMs: 6000,
    },
  })
  await assert.rejects(
    () =>
      acquireProductionTestRunLock(db, {
        lockId: "pa-user_u1",
        runId: "run-b",
        scriptName: "test-script",
        nowMs: 2000,
        ttlMs: 5000,
        projectId: "wekruit-5f89b",
        env: {},
      }),
    /production test lock is already held/,
  )
  assert.equal(db.store.get("pa-user_u1").runId, "run-a")
})

test("acquireProductionTestRunLock can replace an expired lock and release only its own run", async () => {
  const db = makeFakeDb({
    "pa-user_u1": {
      lockId: "pa-user_u1",
      runId: "old-run",
      scriptName: "old-script",
      expiresAtMs: 1500,
    },
  })
  const release = await acquireProductionTestRunLock(db, {
    lockId: "pa-user_u1",
    runId: "run-b",
    scriptName: "test-script",
    nowMs: 2000,
    ttlMs: 5000,
    projectId: "wekruit-5f89b",
    env: {},
  })
  assert.equal(db.store.get("pa-user_u1").runId, "run-b")

  db.store.set("pa-user_u1", { runId: "run-c", expiresAtMs: 9000 })
  await release()
  assert.equal(db.store.get("pa-user_u1").runId, "run-c")
})
