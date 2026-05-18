/**
 * iter34 followup G.3 — paBackfillMatchingJobsAtsUrl callable Cloud Function.
 *
 * Purpose: One-shot (re-runnable) admin-callable that fills the missing
 * `atsApplyUrl` on `matching-jobs/{id}` rows that were ingested from
 * jobright.ai mirrors but never resolved to a real ATS apply URL.
 *
 * Background. The macmini Stage 2.5 url_resolver.py never landed in prod
 * (Supabase pooler hangs). End result: only ~27.9% of active matching-jobs
 * carry `atsApplyUrl`. After D.5 (which hard-drops jobs missing
 * `atsApplyUrl` to keep jobright.ai mirrors out of user-facing copy) this
 * cratered the SWE candidate inventory. The fix is to do the resolve in
 * the cloud, in TS, against the same Serper API key the macmini was
 * configured with.
 *
 * Algorithm — 3 resolve passes (mirrors macmini url_resolver.py):
 *
 *   Pass 1 (free) — primaryUrl is already an ATS host
 *     If `primaryUrl` host is one of the known ATS providers (greenhouse,
 *     lever, ashby, workday, bamboohr, teamtailor) — copy primaryUrl into
 *     atsApplyUrl. Zero cost, zero extra calls.
 *
 *   Pass 2 (free, optional) — direct ATS listings API hit by company slug
 *     Skipped in this implementation. Resolving company → slug requires a
 *     curated registry that wekruit-pa doesn't carry, and fuzzy slug
 *     matching adds noise. Fall through to Pass 3.
 *
 *   Pass 3 (paid) — Serper Google Search proxy
 *     Query: `"<jobTitle>" "<companyName>" careers apply`. Take top-10
 *     organic hits, return the first link whose host matches an ATS
 *     provider. If no hit, retry with a broader query (`"<jobTitle>"
 *     "<companyName>"`). Cap at 2 queries / job.
 *
 *   Pass 4 (post-resolve) — Liveness HEAD sweep
 *     For every active doc with an atsApplyUrl (newly resolved OR
 *     pre-existing), HEAD the URL. 4xx5xx/timeout → mark `dead=true`
 *     with `deadCheckedAt` + `deadReason`; success → `dead=false`. The
 *     query-layer liveness filter (`applyLivenessFilter`) consumes
 *     these to drop stale rows without doing per-query HEAD.
 *
 * If pass 1+3 both miss, the doc gets `urlResolutionAttemptedAt` set so
 * the next backfill pass can skip it (configurable later).
 *
 * Auth: callable rejects when `req.auth.token.admin` is not truthy. We
 * also accept `x-admin-token` header equality with `PA_ADMIN_TOKEN` for
 * scripted invocations (matches admin-bootstrap convention).
 *
 * Architecture: handler logic lives in `runBackfill` (pure, deps-injected)
 * so unit tests can drive it without booting firebase-admin. The onCall
 * wrapper at the bottom is a thin shim that wires production deps
 * (Firestore + real fetch).
 */

import { onCall, HttpsError } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"

// SERPER_API_KEY — same key macmini was using. Set via:
//   echo -n "<key>" | firebase functions:secrets:set SERPER_API_KEY --data-file=- --project wekruit-5f89b
const SERPER_API_KEY = defineSecret("SERPER_API_KEY")

// PA_ADMIN_TOKEN already used by paAdminBootstrap; bind here too so
// scripts that call this CF over HTTPS-callable can pass the token via
// the `data.adminToken` payload field as a fallback to the Firebase Auth
// admin claim.
const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

// ---------------------------------------------------------------------------
// URL acceptance — single exclusion only
// ---------------------------------------------------------------------------

// 2026-05-18 — Adam directive: kill the ATS allowlist. Old design rejected
// every non-curated host, which caused the hourly Serper backfill to miss
// 100% of valid hits (anthropic.com/careers, careers.stripe.com, aggregator
// pages — all bounced). Replaced with single-rule: only `jobright` is
// excluded. Everything else (real ATS providers, careers pages, aggregators,
// LinkedIn, anything non-jobright) is considered a valid apply destination.
//
// Why hostname-substring "jobright" is not enough: Serper also returns the
// SimplifyJobs github mirror at `github.com/jobright-ai/2026-...-New-Grad`
// for niche jobright-only listings (5/3636 active docs observed leaking).
// Hostname is `github.com`, so a hostname-only check accepted it. The full
// URL check below rejects the mirror too. Trade-off: any legitimate URL
// containing the brand string "jobright" is also blocked — accepted (the
// brand is the aggregator we're trying to bypass).

export function isJobrightUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== "string") return false
  try {
    void new URL(url)
  } catch {
    return false
  }
  return url.toLowerCase().includes("jobright")
}

/**
 * A URL is accepted as an apply destination as long as it is parseable AND
 * the full URL string does not contain "jobright". Catches both
 * `jobright.ai/...` redirects and `github.com/jobright-ai/...` mirrors.
 */
export function isAcceptableApplyUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== "string") return false
  try {
    void new URL(url)
  } catch {
    return false
  }
  return !url.toLowerCase().includes("jobright")
}

// ---------------------------------------------------------------------------
// Pure resolver (pass 1 + pass 3)
// ---------------------------------------------------------------------------

export type ResolveJobInput = {
  primaryUrl?: string
  companyName?: string
  jobTitle?: string
  /** Some legacy jobright docs use `roleTitle`; tolerated as fallback. */
  roleTitle?: string
}

export type ResolveOutcome =
  | { kind: "pass1"; url: string }
  | { kind: "pass3"; url: string }
  | { kind: "miss" }

export type SerperFn = (
  title: string,
  company: string
) => Promise<string | null>

/**
 * Pure resolver — no Firestore, no globals. Deps inject Serper.
 *
 * Pass 1 (free): if `primaryUrl` is acceptable (parseable + non-jobright),
 *   trust it directly. Direct-ATS scrapers (greenhouse_direct, lever_direct,
 *   ashby_direct, wellfound, linkedin, otta) emit real ATS URLs as
 *   `primaryUrl`, so this is the fast path for them.
 *
 * Pass 3 (paid): if Pass 1 missed (primaryUrl absent or jobright redirect),
 *   ask Serper for `"<title>" "<company>" careers apply` and take the first
 *   non-jobright organic hit.
 */
export async function resolveAtsUrl(
  job: ResolveJobInput,
  deps: { serper: SerperFn }
): Promise<ResolveOutcome> {
  // Pass 1 — primaryUrl is already acceptable (any non-jobright URL).
  if (isAcceptableApplyUrl(job.primaryUrl)) {
    return { kind: "pass1", url: job.primaryUrl as string }
  }

  // Pass 3 — Serper search. Skip when companyName/title missing — the
  // search query degenerates to noise without both anchors.
  const title = (job.jobTitle ?? job.roleTitle ?? "").trim()
  const company = (job.companyName ?? "").trim()
  if (!title || !company) return { kind: "miss" }

  const url = await deps.serper(title, company)
  if (url && isAcceptableApplyUrl(url)) return { kind: "pass3", url }
  return { kind: "miss" }
}

// ---------------------------------------------------------------------------
// Serper client
// ---------------------------------------------------------------------------

type SerperOrganicHit = { link?: string }
type SerperResponse = { organic?: SerperOrganicHit[] }

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Construct a Serper-backed SerperFn. Tries up to 2 query variants per
 * job: precise (with "careers apply" tail) → fall back to broader query.
 *
 * Returns the first organic hit whose URL is acceptable (parseable +
 * hostname does not contain "jobright"). No allowlist filtering. Adam
 * directive 2026-05-18: "filter是干什么？" — the old allowlist rejected
 * 100% of valid hits (anthropic.com/careers, etc). Trust Serper's top-1
 * organic result for the same query a candidate would type.
 */
export function createSerperSearch(opts: {
  apiKey: string
  fetchImpl?: FetchFn
}): SerperFn {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn)
  const apiKey = opts.apiKey
  return async (title, company) => {
    const queries = [
      `"${title}" "${company}" careers apply`,
      `"${title}" "${company}"`,
    ]
    for (const q of queries) {
      let resp: Response
      try {
        resp = await fetchImpl("https://google.serper.dev/search", {
          method: "POST",
          headers: {
            "X-API-KEY": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ q, num: 10 }),
        })
      } catch {
        continue
      }
      if (!resp.ok) continue
      let data: SerperResponse
      try {
        data = (await resp.json()) as SerperResponse
      } catch {
        continue
      }
      for (const hit of data.organic ?? []) {
        if (hit.link && isAcceptableApplyUrl(hit.link)) return hit.link
      }
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// Liveness HEAD check
// ---------------------------------------------------------------------------

export type LivenessResult =
  | { dead: false }
  | { dead: true; reason: string }

/**
 * HEAD the URL with a 10s timeout, follow redirects. Status codes
 * matching {404, 410, 500, 502, 503} → dead. Network/timeout errors →
 * dead with reason "timeout" or "network". Anything else (200, 301
 * follow, 401/403 auth gates) → alive.
 *
 * Note: many ATS providers reject HEAD with 405 (method not allowed)
 * but the URL is alive — so 405 is treated as alive, NOT dead.
 */
export async function checkLiveness(
  url: string,
  opts?: { fetchImpl?: FetchFn; timeoutMs?: number }
): Promise<LivenessResult> {
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchFn)
  const timeoutMs = opts?.timeoutMs ?? 10_000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    })
    if ([404, 410, 500, 502, 503].includes(resp.status)) {
      return { dead: true, reason: String(resp.status) }
    }
    return { dead: false }
  } catch (err) {
    const e = err as { name?: string; message?: string }
    if (e?.name === "AbortError" || (e?.message ?? "").toLowerCase().includes("timeout")) {
      return { dead: true, reason: "timeout" }
    }
    return { dead: true, reason: "network" }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Backfill driver — pure, deps-injected
// ---------------------------------------------------------------------------

export type MatchingJobDoc = {
  id: string
  primaryUrl?: string
  companyName?: string
  jobTitle?: string
  roleTitle?: string
  atsApplyUrl?: string
  status?: string
  dead?: boolean
}

export type BackfillUpdates = {
  atsApplyUrl?: string
  atsResolvedAt?: string
  atsResolvedBy?: string
  urlResolutionAttemptedAt?: string
  dead?: boolean
  deadCheckedAt?: string
  deadReason?: string
}

export type BackfillStore = {
  /**
   * Snapshot of `matching-jobs` where `status==active`, capped to limit.
   * Returned in deterministic order (creation/insertion).
   */
  fetchActiveJobs: (limit: number) => Promise<MatchingJobDoc[]>
  /** Apply field updates (Firestore `update`). */
  updateJob: (id: string, updates: BackfillUpdates) => Promise<void>
}

export type BackfillMode = "all" | "pass1-only" | "liveness-only"

export type BackfillRequest = {
  mode?: BackfillMode
  limit?: number
}

export type BackfillResult = {
  totalProcessed: number
  pass1Count: number
  pass3Count: number
  missCount: number
  livenessChecked: number
  livenessFailCount: number
  errors: number
}

export type BackfillDeps = {
  store: BackfillStore
  serper: SerperFn
  liveness: (url: string) => Promise<LivenessResult>
  now: () => string
  log?: (...args: unknown[]) => void
  errorLog?: (...args: unknown[]) => void
}

/**
 * Drives the 4-pass pipeline. Returns counters for the operator.
 *
 * Behaviour by mode:
 *   - "all"           : pass 1 + pass 3 (resolve missing) + pass 4 (liveness)
 *   - "pass1-only"    : pass 1 only — copies host-matching primaryUrl into
 *                       atsApplyUrl. No Serper, no HEAD. Cheap one-shot.
 *   - "liveness-only" : skip resolve passes; HEAD-check every doc that
 *                       already has atsApplyUrl. Useful for nightly sweeps.
 */
export async function runBackfill(
  req: BackfillRequest,
  deps: BackfillDeps
): Promise<BackfillResult> {
  const log = deps.log ?? (() => {})
  const errorLog = deps.errorLog ?? log
  const limit = Math.max(1, Math.min(req.limit ?? 1000, 5000))
  const mode: BackfillMode = req.mode ?? "all"

  const result: BackfillResult = {
    totalProcessed: 0,
    pass1Count: 0,
    pass3Count: 0,
    missCount: 0,
    livenessChecked: 0,
    livenessFailCount: 0,
    errors: 0,
  }

  let jobs: MatchingJobDoc[]
  try {
    jobs = await deps.store.fetchActiveJobs(limit)
  } catch (err) {
    errorLog("backfill fetch_active_jobs_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  for (const job of jobs) {
    result.totalProcessed++
    let resolvedUrl: string | undefined = job.atsApplyUrl

    // ---- resolve passes ----
    if (!resolvedUrl && mode !== "liveness-only") {
      try {
        const outcome = await resolveAtsUrl(job, {
          serper: mode === "pass1-only"
            // pass1-only short-circuits Serper to a no-op miss
            ? async () => null
            : deps.serper,
        })
        if (outcome.kind === "pass1") {
          resolvedUrl = outcome.url
          result.pass1Count++
          await deps.store.updateJob(job.id, {
            atsApplyUrl: outcome.url,
            atsResolvedAt: deps.now(),
            atsResolvedBy: "cf-backfill-pass1",
          })
        } else if (outcome.kind === "pass3") {
          resolvedUrl = outcome.url
          result.pass3Count++
          await deps.store.updateJob(job.id, {
            atsApplyUrl: outcome.url,
            atsResolvedAt: deps.now(),
            atsResolvedBy: "cf-backfill-pass3",
          })
        } else {
          result.missCount++
          // Stamp the attempt timestamp so future backfill runs can skip
          // hard-miss docs (D.5 already drops them at query time anyway).
          await deps.store.updateJob(job.id, {
            urlResolutionAttemptedAt: deps.now(),
          })
        }
      } catch (err) {
        result.errors++
        errorLog("backfill resolve_failed", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        })
        continue // skip liveness for this job
      }
    }

    // ---- pass 4 — liveness ----
    if (mode !== "pass1-only" && resolvedUrl) {
      try {
        const live = await deps.liveness(resolvedUrl)
        result.livenessChecked++
        if (live.dead) {
          result.livenessFailCount++
          await deps.store.updateJob(job.id, {
            dead: true,
            deadCheckedAt: deps.now(),
            deadReason: live.reason,
          })
        } else {
          await deps.store.updateJob(job.id, {
            dead: false,
            deadCheckedAt: deps.now(),
          })
        }
      } catch (err) {
        result.errors++
        errorLog("backfill liveness_failed", {
          jobId: job.id,
          url: resolvedUrl,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  log("backfill complete", { mode, ...result })
  return result
}

// ---------------------------------------------------------------------------
// Production CF — thin shim over runBackfill.
// ---------------------------------------------------------------------------

/**
 * Verify caller is admin: either Firebase Auth custom claim `admin: true`
 * OR `data.adminToken` matches `PA_ADMIN_TOKEN`. Throws an HttpsError
 * otherwise.
 */
function authorizeAdminCallable(
  req: { auth?: { token?: { admin?: unknown; email?: unknown } }; data?: unknown }
): void {
  const claim = req.auth?.token?.admin
  if (claim === true || claim === "true") return

  const dataObj = (req.data && typeof req.data === "object") ? req.data as Record<string, unknown> : {}
  const provided = typeof dataObj.adminToken === "string" ? dataObj.adminToken.trim() : ""
  const expected = (process.env.PA_ADMIN_TOKEN ?? "").trim()
  if (expected && provided && provided === expected) return

  throw new HttpsError("permission-denied", "admin only")
}

/** Production Firestore-backed BackfillStore. */
function makeFirestoreStore(): BackfillStore {
  return {
    fetchActiveJobs: async (limit) => {
      const db = getFirestore()
      const snap = await db
        .collection("matching-jobs")
        .where("status", "==", "active")
        .limit(limit)
        .get()
      return snap.docs.map((d): MatchingJobDoc => {
        const data = d.data() as Record<string, unknown>
        return {
          id: d.id,
          primaryUrl: typeof data.primaryUrl === "string" ? data.primaryUrl : undefined,
          companyName: typeof data.companyName === "string" ? data.companyName : undefined,
          jobTitle: typeof data.jobTitle === "string" ? data.jobTitle : undefined,
          roleTitle: typeof data.roleTitle === "string" ? data.roleTitle : undefined,
          atsApplyUrl: typeof data.atsApplyUrl === "string" ? data.atsApplyUrl : undefined,
          status: typeof data.status === "string" ? data.status : undefined,
          dead: typeof data.dead === "boolean" ? data.dead : undefined,
        }
      })
    },
    updateJob: async (id, updates) => {
      const db = getFirestore()
      await db.collection("matching-jobs").doc(id).update(updates)
    },
  }
}

export const paBackfillMatchingJobsAtsUrl = onCall(
  {
    region: "us-central1",
    cpu: 2,
    memory: "1GiB",
    // Callable max — 9 minutes. Enough for ~600 jobs with sequential
    // Serper + HEAD calls (rate limits dominate, not function cold-start).
    timeoutSeconds: 540,
    secrets: [SERPER_API_KEY, PA_ADMIN_TOKEN],
  },
  async (req): Promise<BackfillResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown; email?: unknown } }; data?: unknown })

    const data = (req.data && typeof req.data === "object")
      ? (req.data as Record<string, unknown>)
      : {}
    const mode: BackfillMode =
      data.mode === "pass1-only" || data.mode === "liveness-only"
        ? data.mode
        : "all"
    const limit = typeof data.limit === "number" && Number.isFinite(data.limit)
      ? Math.floor(data.limit)
      : 1000

    const apiKey = (process.env.SERPER_API_KEY ?? "").trim()
    if (!apiKey && mode === "all") {
      logger.warn("[backfill-ats-urls] SERPER_API_KEY missing — pass3 will no-op")
    }

    const serper: SerperFn = apiKey
      ? createSerperSearch({ apiKey })
      : async () => null

    return await runBackfill(
      { mode, limit },
      {
        store: makeFirestoreStore(),
        serper,
        liveness: (url) => checkLiveness(url),
        now: () => new Date().toISOString(),
        log: (...args) => logger.info("[backfill-ats-urls]", ...args),
        errorLog: (...args) => logger.error("[backfill-ats-urls]", ...args),
      }
    )
  }
)
