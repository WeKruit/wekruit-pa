/**
 * paScrapeQualitySamplePublic — public read-only HTTP endpoint that returns
 * a small RANDOM sample of recently-scraped jobs from `matching-jobs` so a
 * Claude routine (which has no Firestore creds) can do HEAD-checks + name
 * sanity in the open.
 *
 * Why
 * ---
 * Adam directive 2026-05-27: "我们能加一个routine吗，来给claude routine跑，
 * 这样每天跑完我们可以自己检查". The existing health CF
 * (`paScrapeFreshnessStatusPublic`) only answers "did the pipeline run".
 * It does NOT tell us whether the jobs that landed are real. This CF is
 * the second layer: counters per source + a small random sample of
 * concrete rows so the routine can curl each URL and write a quality
 * report.
 *
 * Body shape
 * ----------
 *   {
 *     ts: ISO,
 *     window: { sinceHours, generatedAt },
 *     counts: { total, bySource: { "vcboard:a16z": 12, ... } },
 *     samples: [
 *       { id, companyName, roleTitle, atsApplyUrl, source, syncedAt },
 *       ...
 *     ],
 *     thresholds: { sampleSize, sinceHours }
 *   }
 *
 * Payload is small (counts + ≤20 samples). 60s CDN cache absorbs routine
 * bursts. No PII — every field is already publicly visible on the
 * portfolio job board it was scraped from.
 */
import { onRequest } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, Timestamp } from "firebase-admin/firestore"

const SINCE_HOURS = 24 // sample window — last 24h of scraping
const SAMPLE_SIZE = 20 // small enough for one HTTP response

interface SampleRow {
  id: string
  companyName: string | null
  roleTitle: string | null
  atsApplyUrl: string | null
  source: string | null
  syncedAt: string | null
}

interface QualityBody {
  ts: string
  window: { sinceHours: number; generatedAt: string }
  counts: { total: number; bySource: Record<string, number> }
  samples: SampleRow[]
  thresholds: { sampleSize: number; sinceHours: number }
}

function ensureAdmin() {
  if (getApps().length === 0) initializeApp()
}

/** Fisher-Yates shuffle (in-place) for the sample picker. */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

async function buildBody(): Promise<QualityBody> {
  ensureAdmin()
  const db = getFirestore()
  const now = new Date()
  const cutoff = Timestamp.fromMillis(now.getTime() - SINCE_HOURS * 3600_000)

  // Pull the recent set ordered by syncedAt desc. We cap at 500 so a
  // ~5000-row daily batch doesn't blow the function's memory or the
  // payload. The sample is drawn from the most-recently-synced 500;
  // that's the slice we actually care about for "what JUST landed".
  const snap = await db
    .collection("matching-jobs")
    .where("syncedAt", ">=", cutoff)
    .orderBy("syncedAt", "desc")
    .limit(500)
    .get()

  const total = snap.size
  const bySource: Record<string, number> = {}
  const all: SampleRow[] = []
  for (const doc of snap.docs) {
    const d = doc.data()
    // Source attribution lives in `sources: string[]` (Phase 63) or the
    // legacy `source` / `source_repo` strings. Bucket by the first
    // matching value we find.
    let src: string | null = null
    if (Array.isArray(d.sources) && d.sources.length) src = String(d.sources[0])
    else if (typeof d.source === "string") src = d.source
    else if (typeof d.source_repo === "string") src = d.source_repo
    const srcKey = src ?? "(unknown)"
    bySource[srcKey] = (bySource[srcKey] ?? 0) + 1

    const syncedAt = d.syncedAt as Timestamp | undefined
    all.push({
      id: doc.id,
      companyName: (d.companyName as string) ?? (d.company_name as string) ?? null,
      roleTitle: (d.roleTitle as string) ?? (d.role_title as string) ?? null,
      atsApplyUrl: (d.atsApplyUrl as string) ?? (d.ats_apply_url as string) ?? null,
      source: src,
      syncedAt: syncedAt && typeof syncedAt.toDate === "function" ? syncedAt.toDate().toISOString() : null,
    })
  }

  const samples = shuffle(all).slice(0, SAMPLE_SIZE)

  return {
    ts: now.toISOString(),
    window: { sinceHours: SINCE_HOURS, generatedAt: now.toISOString() },
    counts: { total, bySource },
    samples,
    thresholds: { sampleSize: SAMPLE_SIZE, sinceHours: SINCE_HOURS },
  }
}

export const paScrapeQualitySamplePublic = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,
    cors: true,
    invoker: "public",
  },
  async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "method_not_allowed" })
      return
    }
    try {
      const body = await buildBody()
      // 60s cache so the routine's curl + any ad-hoc poll don't fan
      // out Firestore reads.
      res.set("Cache-Control", "public, max-age=60, s-maxage=60")
      res.set("X-Content-Type-Options", "nosniff")
      res.status(200).json(body)
    } catch (err) {
      logger.error("[scrape-quality-sample] read failed", {
        err: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ error: "internal", message: "see Cloud Logging" })
    }
  }
)
