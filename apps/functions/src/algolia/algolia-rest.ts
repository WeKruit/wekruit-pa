/**
 * Minimal Algolia write client over the REST API (no SDK dep — mirrors the
 * fetch pattern already used by scripts/import-practice-question-bank.mjs).
 * Reads ALGOLIA_APP_ID + ALGOLIA_ADMIN_KEY (Firebase secrets). When unset, the
 * helpers no-op so the sync triggers fail open until the secrets are provided.
 */

export interface AlgoliaConfig {
  appId: string
  adminKey: string
}

/** Reads the Algolia write config from env/secrets, or null when not configured. */
export function algoliaConfigFromEnv(): AlgoliaConfig | null {
  const appId = (process.env.ALGOLIA_APP_ID ?? "").trim()
  const adminKey = (process.env.ALGOLIA_ADMIN_KEY ?? "").trim()
  if (!appId || !adminKey) return null
  return { appId, adminKey }
}

export type BatchAction = "updateObject" | "deleteObject"

export interface BatchRequest {
  action: BatchAction
  body: object
}

/** Pure: build the `{requests}` body for the Algolia batch endpoint. */
export function buildBatchRequests(
  objects: ReadonlyArray<object>,
  action: BatchAction,
): { requests: BatchRequest[] } {
  return {
    requests: objects.map((body) => ({ action, body })),
  }
}

async function postBatch(
  cfg: AlgoliaConfig,
  index: string,
  requests: BatchRequest[],
): Promise<void> {
  // Write endpoint is the non-DSN host.
  const res = await fetch(`https://${cfg.appId}.algolia.net/1/indexes/${encodeURIComponent(index)}/batch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-algolia-api-key": cfg.adminKey,
      "x-algolia-application-id": cfg.appId,
    },
    body: JSON.stringify({ requests }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Algolia batch ${index} failed: ${res.status} ${text.slice(0, 300)}`)
  }
}

/** Upsert records (chunked at 1000/req per Algolia limits). No-op if unconfigured. */
export async function algoliaSaveObjects(
  index: string,
  records: ReadonlyArray<object>,
  cfg: AlgoliaConfig | null = algoliaConfigFromEnv(),
): Promise<{ saved: number; configured: boolean }> {
  if (!cfg) {
    // Silent skip — the pa-users trigger fires often; no log spam before the
    // ALGOLIA_* secrets are set.
    return { saved: 0, configured: false }
  }
  let saved = 0
  for (let i = 0; i < records.length; i += 1000) {
    const chunk = records.slice(i, i + 1000)
    await postBatch(cfg, index, buildBatchRequests(chunk, "updateObject").requests)
    saved += chunk.length
  }
  return { saved, configured: true }
}

/** Delete one object. No-op if unconfigured. */
export async function algoliaDeleteObject(
  index: string,
  objectID: string,
  cfg: AlgoliaConfig | null = algoliaConfigFromEnv(),
): Promise<{ configured: boolean }> {
  if (!cfg) return { configured: false }
  await postBatch(cfg, index, [{ action: "deleteObject", body: { objectID } }])
  return { configured: true }
}
