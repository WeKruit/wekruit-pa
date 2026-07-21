/**
 * `paAdminReevaluateRecruiterSubmissions` — admin one-shot re-eval of existing
 * recruiter submissions with the current (résumé-grounded, wrong-identity-aware)
 * judge. Needed because the eval trigger is onDocumentCreated — it never re-fires
 * on existing rows, so submissions judged before the résumé-read + identity fixes
 * keep their stale verdict (e.g. a strong SWE stuck at reject from wrong Coresignal).
 *
 * Targets verdict ∈ {reject, borderline} that have a résumé/LinkedIn (the harm
 * set). Paginated + bounded per call (maxReeval) to fit the 540s timeout; the
 * caller loops with `nextCursor` until `done`. Each re-eval uses force:true to
 * overwrite the stale evaluation; status is NEVER touched (label-only).
 */
import { getFirestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"
import { makeProdEvalDeps, runRecruiterSubmissionEval } from "./recruiter-submission-eval.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY")
const CORESIGNAL_API_KEY = defineSecret("CORESIGNAL_API_KEY")

const SUBMISSIONS = "pa-recruiter-submissions"
const TARGET_VERDICTS = new Set(["reject", "borderline"])

const Input = z.object({
  ids: z.array(z.string()).nullish(),
  pageLimit: z.number().int().min(1).max(800).nullish(),
  maxReeval: z.number().int().min(1).max(120).nullish(),
  concurrency: z.number().int().min(1).max(10).nullish(),
  verdicts: z.array(z.string()).nullish(),
  cursor: z.string().nullish(),
  adminToken: z.string().nullish(),
})

/** Run `tasks` with at most `n` in flight; returns results in input order. */
async function mapConcurrent<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i]!)
      }
    }),
  )
  return out
}

export const paAdminReevaluateRecruiterSubmissions = onCall(
  {
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 540,
    secrets: [PA_ADMIN_TOKEN, PA_OPENAI_AGENT_API_KEY, ANTHROPIC_API_KEY, CORESIGNAL_API_KEY],
  },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = Input.safeParse(req.data ?? {})
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    const { ids, cursor } = parsed.data
    const pageLimit = parsed.data.pageLimit ?? 300
    const maxReeval = parsed.data.maxReeval ?? 60
    const concurrency = parsed.data.concurrency ?? 6
    const targetVerdicts = parsed.data.verdicts?.length ? new Set(parsed.data.verdicts) : TARGET_VERDICTS
    const db = getFirestore()
    const deps = makeProdEvalDeps(db)
    const reevalOne = async (id: string) => {
      try {
        const r = await runRecruiterSubmissionEval({ submissionId: id, submission: {}, force: true }, deps)
        return { id, status: r.status, verdict: r.aiEvaluation?.verdict as string | undefined }
      } catch (e) {
        logger.error("[reeval] failed", { id, error: String(e).slice(0, 200) })
        return { id, status: "error", verdict: undefined }
      }
    }

    // Targeted by explicit ids (e.g. re-eval Joseph specifically).
    if (ids && ids.length) {
      const results = await mapConcurrent(ids.slice(0, maxReeval), concurrency, reevalOne)
      return { mode: "ids", results }
    }

    // Paginated scan; re-eval the target-verdict-with-résumé docs in this page
    // (bounded by maxReeval) concurrently.
    let q = db.collection(SUBMISSIONS).orderBy("__name__").limit(pageLimit)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    let scanned = 0
    let hitMax = false
    let lastId: string | null = cursor ?? null
    const targets: Array<{ id: string; was: string }> = []
    for (const d of snap.docs) {
      scanned += 1
      lastId = d.id
      const data = d.data() as Record<string, unknown>
      const ev = data.aiEvaluation as { verdict?: string } | undefined
      const cand = data.candidate as { resumeUrl?: string; linkedinUrl?: string; link?: string } | undefined
      const hasResume = Boolean(cand?.resumeUrl || cand?.linkedinUrl || cand?.link)
      if (!ev?.verdict || !targetVerdicts.has(ev.verdict) || !hasResume) continue
      if (targets.length >= maxReeval) {
        hitMax = true
        break
      }
      targets.push({ id: d.id, was: ev.verdict })
    }
    const results = await mapConcurrent(targets, concurrency, (t) => reevalOne(t.id))
    const sample = results.slice(0, 12).map((r, i) => ({ id: r.id, was: targets[i]!.was, now: r.verdict }))
    const done = !hitMax && snap.size < pageLimit
    return { mode: "scan", scanned, reevaluated: results.length, sample, nextCursor: lastId, done }
  },
)
