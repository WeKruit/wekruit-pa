import { isProductionProject } from "./prod-test-user-guard.mjs"

export function productionTestRunLockId({ scope, userId, jobId }) {
  return [scope, userId, jobId]
    .filter(Boolean)
    .map((part) =>
      String(part)
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120),
    )
    .filter(Boolean)
    .join("_")
}

export async function acquireProductionTestRunLock(db, {
  lockId,
  runId,
  scriptName = "unknown-script",
  nowMs = Date.now(),
  ttlMs = 15 * 60 * 1000,
  projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "wekruit-5f89b",
  env = process.env,
} = {}) {
  if (!lockId) throw new Error(`${scriptName} requires lockId`)
  if (!runId) throw new Error(`${scriptName} requires runId`)
  if (!isProductionProject(projectId)) return async () => {}

  const ref = db.collection("pa-test-run-locks").doc(lockId)
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const data = snap.exists ? snap.data() ?? {} : {}
    const heldByOther =
      snap.exists &&
      data.runId !== runId &&
      typeof data.expiresAtMs === "number" &&
      data.expiresAtMs > nowMs
    if (heldByOther && env.WEKRUIT_FORCE_PROD_TEST_RUN_LOCK !== "1") {
      throw new Error(
        `${scriptName} production test lock is already held: ${lockId} by ${data.runId} until ${new Date(data.expiresAtMs).toISOString()}`,
      )
    }
    tx.set(ref, {
      lockId,
      runId,
      scriptName,
      acquiredAtMs: nowMs,
      acquiredAt: new Date(nowMs).toISOString(),
      expiresAtMs: nowMs + ttlMs,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    })
  })

  return async () => {
    const snap = await ref.get()
    const data = snap.exists ? snap.data() ?? {} : {}
    if (data.runId === runId) await ref.delete()
  }
}
