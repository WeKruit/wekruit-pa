/**
 * Unified Coresignal response store.
 *
 * ONE Firestore collection (`pa-coresignal-cache`, PA_COLLECTIONS.coresignalResponseCache)
 * holding, per LinkedIn profile, the canonical triple the platform cares about:
 *   { coresignalId, linkedinUrl, employee (the COMPLETE Coresignal V2 response) }
 * plus linkedinHash, fetchedAt, source.
 *
 * Every Coresignal fetch path MUST go through this module instead of caching its
 * own way (the prior state was 5 fragmented stores with 3 key schemes):
 *   - recruiter-submission-eval  → getOrFetchCoresignalByLinkedin
 *   - linkedin-connect-submit     → getOrFetchCoresignalByLinkedin
 *   - coresignal-batch-fetch      → storeCoresignalEmployee (already has id+response)
 *
 * Doc id = canonical LinkedIn hash (coresignalCacheKey), so equivalent URL forms
 * (www / scheme / trailing slash) share one entry and the key matches
 * pa-candidate-handles + external-supply. 30-day TTL on `fetchedAt`.
 */
import { createHash } from "node:crypto"
import { type Firestore } from "firebase-admin/firestore"
import {
  canonicalizeLinkedInUrl,
  linkedinHash,
  type CoresignalEmployeeCollectV2,
} from "@pa/external-supply"
import { PA_COLLECTIONS } from "@pa/core-types"

export const CORESIGNAL_CACHE_COLLECTION = PA_COLLECTIONS.coresignalResponseCache
export const CORESIGNAL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** The unified cache doc shape — coresignal id + linkedin url + complete response. */
export type CoresignalCacheDoc = {
  linkedinUrl: string
  linkedinHash: string
  coresignalId: number | null
  employee: CoresignalEmployeeCollectV2
  fetchedAt: string
  source: string
}

/** Canonical-LinkedIn-hash key (matches linkedinHash); raw-hash fallback for non-LinkedIn links. */
export function coresignalCacheKey(link: string): string {
  const canonical = canonicalizeLinkedInUrl(link)
  if (canonical) return linkedinHash(canonical)
  return createHash("sha256").update(link.trim().toLowerCase()).digest("hex")
}

type Logger = (event: string, fields?: Record<string, unknown>) => void

/** Cache read — returns the complete response if present and within TTL, else undefined. */
export async function readCoresignalCache(
  db: Firestore,
  link: string,
  nowMs: number,
): Promise<CoresignalEmployeeCollectV2 | undefined> {
  try {
    const snap = await db.collection(CORESIGNAL_CACHE_COLLECTION).doc(coresignalCacheKey(link)).get()
    if (!snap.exists) return undefined
    const data = (snap.data() ?? {}) as Partial<CoresignalCacheDoc>
    const fetchedMs = typeof data.fetchedAt === "string" ? Date.parse(data.fetchedAt) : 0
    if (!data.employee || !(nowMs - fetchedMs < CORESIGNAL_CACHE_TTL_MS)) return undefined
    return data.employee
  } catch {
    return undefined
  }
}

/** Idempotent write of the unified triple. Best-effort: a failure never throws. */
export async function storeCoresignalEmployee(args: {
  db: Firestore
  link: string
  coresignalId: number | null
  employee: CoresignalEmployeeCollectV2
  now: string
  source: string
  log?: Logger
}): Promise<void> {
  const key = coresignalCacheKey(args.link)
  const canonical = canonicalizeLinkedInUrl(args.link)
  const doc: CoresignalCacheDoc = {
    linkedinUrl: canonical ?? args.link,
    linkedinHash: key,
    coresignalId: args.coresignalId,
    employee: args.employee,
    fetchedAt: args.now,
    source: args.source,
  }
  try {
    await args.db.collection(CORESIGNAL_CACHE_COLLECTION).doc(key).set(doc, { merge: true })
  } catch (e) {
    args.log?.("coresignal_cache_write_failed", { error: e instanceof Error ? e.message : String(e) })
  }
}

/**
 * Get-or-fetch: the single entry point every read path should use. Returns the
 * complete Coresignal response (cache hit needs no API key), fetching + caching
 * on a miss. Returns undefined when the link isn't LinkedIn / no key / no match
 * / fetch fails (fail-open — callers degrade gracefully).
 */
export async function getOrFetchCoresignalByLinkedin(args: {
  db: Firestore
  link: string
  apiKey: string | null
  now: string
  source: string
  search: (url: string, cfg: { apiKey: string }) => Promise<number | null>
  fetch: (id: number, cfg: { apiKey: string }) => Promise<CoresignalEmployeeCollectV2>
  log?: Logger
}): Promise<CoresignalEmployeeCollectV2 | undefined> {
  const nowMs = Date.parse(args.now)
  const cached = await readCoresignalCache(args.db, args.link, nowMs)
  if (cached) {
    args.log?.("coresignal_cache_hit", { key: coresignalCacheKey(args.link) })
    return cached
  }
  if (!args.apiKey) {
    args.log?.("coresignal_skipped_no_key")
    return undefined
  }
  try {
    const id = await args.search(args.link, { apiKey: args.apiKey })
    if (id === null) {
      args.log?.("coresignal_no_match")
      return undefined
    }
    const employee = await args.fetch(id, { apiKey: args.apiKey })
    await storeCoresignalEmployee({
      db: args.db,
      link: args.link,
      coresignalId: id,
      employee,
      now: args.now,
      source: args.source,
      log: args.log,
    })
    return employee
  } catch (err) {
    args.log?.("coresignal_fetch_failed_fail_open", { error: err instanceof Error ? err.message : String(err) })
    return undefined
  }
}
