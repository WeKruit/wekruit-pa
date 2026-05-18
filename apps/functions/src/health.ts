/**
 * Phase 27 T2 — /health endpoint factory.
 *
 * Each Cloud Function exports a sibling /health CF (paHealth*) that returns
 * a small JSON envelope used by uptime probes + dashboard wiring. Endpoints
 * are PUBLIC (no admin token) — health probes must be reachable from any
 * monitoring agent.
 *
 * Shape:
 *   {
 *     ok: boolean,
 *     name: string,                       // e.g. "paSendblueWebhook"
 *     version: string,                    // git sha or pkg version
 *     ts: ISO timestamp,
 *     deps: {
 *       firestore: "ok" | "fail",         // 1-doc read on a sentinel
 *       secrets: "ok" | "missing",        // required env vars present
 *     }
 *   }
 *
 * Dep probes have a 1.5s timeout; on timeout we mark the dep as failing but
 * still return HTTP 200 so the probe can read the body (matches the T3 spec
 * in the original Phase 27 PLAN.md §T3).
 */

import { onRequest } from "firebase-functions/v2/https"
import type { Request } from "firebase-functions/v2/https"
import type { Response } from "express"
import { getFirestore } from "firebase-admin/firestore"
import { getApps, initializeApp } from "firebase-admin/app"

export type DepCheck = {
  /** Short ID for the dep (e.g. "firestore", "secrets"). */
  name: "firestore" | "secrets"
  /** Async probe — must resolve to "ok" or any other value (treated as fail). */
  probe: () => Promise<"ok" | "missing" | "fail">
}

export type HealthBody = {
  ok: boolean
  name: string
  version: string
  ts: string
  deps: Record<string, "ok" | "missing" | "fail">
}

const PROBE_TIMEOUT_MS = 1500

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve(fallback)
      }
    )
  })
}

function readVersion(): string {
  // Cloud Run sets K_REVISION on every revision; fall back to a build-time
  // env (PA_GIT_SHA, settable via `firebase functions:config` or env file)
  // and finally to "dev" so local invocation still has a non-empty value.
  return (
    process.env.K_REVISION?.trim() ||
    process.env.PA_GIT_SHA?.trim() ||
    process.env.GAE_VERSION?.trim() ||
    "dev"
  )
}

/**
 * Standard Firestore probe — read the `pa-health-sentinel/ping` doc.
 * The doc need not exist; a successful round-trip (even with empty result)
 * counts as "ok". Wrap the whole thing in 1.5s timeout.
 */
export async function probeFirestore(): Promise<"ok" | "fail"> {
  try {
    if (!getApps().length) initializeApp()
    const db = getFirestore()
    const result = await withTimeout(
      db.collection("pa-health-sentinel").doc("ping").get().then(() => "ok" as const),
      PROBE_TIMEOUT_MS,
      "fail" as const
    )
    return result
  } catch {
    return "fail"
  }
}

/**
 * Verify required secret/env-var names are populated. Returns "ok" if every
 * key has a non-empty value, "missing" otherwise.
 */
export function probeSecrets(requiredEnvKeys: readonly string[]): () => Promise<"ok" | "missing"> {
  return async () => {
    for (const k of requiredEnvKeys) {
      const v = process.env[k]
      if (!v || !v.trim()) return "missing"
    }
    return "ok"
  }
}

export type HealthHandlerInput = {
  /** Logical CF name (e.g. "paSendblueWebhook"). */
  name: string
  /** Required env vars for this CF — used by the secrets probe. */
  requiredSecrets: readonly string[]
  /**
   * Secrets to bind to this health function runtime. Defaults to
   * `requiredSecrets` so the probe checks the same runtime visibility the
   * target function depends on.
   */
  boundSecrets?: readonly string[]
  /** Optional override for tests. */
  now?: () => string
  /** Optional probe overrides (tests inject fakes). */
  probes?: {
    firestore?: () => Promise<"ok" | "fail">
    secrets?: () => Promise<"ok" | "missing">
  }
}

/**
 * Pure handler — exposed for tests. Computes the health body without any
 * HTTP framework dependency.
 */
export async function computeHealthBody(input: HealthHandlerInput): Promise<HealthBody> {
  const now = input.now ?? (() => new Date().toISOString())
  const fsProbe = input.probes?.firestore ?? probeFirestore
  const secretsProbe = input.probes?.secrets ?? probeSecrets(input.requiredSecrets)

  const [firestoreResult, secretsResult] = await Promise.all([
    fsProbe(),
    secretsProbe(),
  ])

  const deps = { firestore: firestoreResult, secrets: secretsResult }
  const ok = firestoreResult === "ok" && secretsResult === "ok"
  return {
    ok,
    name: input.name,
    version: readVersion(),
    ts: now(),
    deps,
  }
}

/**
 * Build a public /health onRequest handler. Returns HTTP 200 always (probes
 * reflect failure in the body).
 */
export function makeHealthHandler(input: HealthHandlerInput) {
  return onRequest(
    {
      region: "us-central1",
      memory: "256MiB",
      timeoutSeconds: 30,
      maxInstances: 1,
      cors: false,
      secrets: [...(input.boundSecrets ?? input.requiredSecrets)],
    },
    async (req: Request, res: Response) => {
      try {
        const body = await computeHealthBody(input)
        res.status(200).json(body)
      } catch (err) {
        // Failsafe: any unexpected error still returns JSON so probes can
        // parse it. We never throw out of /health.
        res.status(200).json({
          ok: false,
          name: input.name,
          version: readVersion(),
          ts: new Date().toISOString(),
          deps: { firestore: "fail", secrets: "missing" },
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  )
}
