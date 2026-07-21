/**
 * `paAdminReevaluatePrescreens` — admin backlog re-eval of existing prescreen
 * sessions with the current (transcript-as-primary, wrong-identity-aware,
 * unverifiable→borderline) judge. The eval trigger is onDocumentWritten gated on
 * "pending review just entered", so it never re-fires on already-evaluated
 * sessions; stale verdicts (e.g. strong candidates over-rejected for a thin
 * transcript) need this. Targets review.candidateChecklistEval.verdict ∈
 * {reject, borderline}, paginated + bounded + concurrent. force-overwrites the
 * stored eval; the FSM PASS/FAIL decision is NEVER touched (eval is advisory).
 */
import { getFirestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"
import { makeProdPrescreenEvalDeps, runPrescreenCandidateEval } from "./prescreen-candidate-eval.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY")
const CORESIGNAL_API_KEY = defineSecret("CORESIGNAL_API_KEY")

const SESSIONS = "pa-prescreen-sessions"
const TARGET_VERDICTS = new Set(["reject", "borderline"])

const Input = z.object({
  ids: z.array(z.string()).nullish(),
  pageLimit: z.number().int().min(1).max(800).nullish(),
  maxReeval: z.number().int().min(1).max(120).nullish(),
  concurrency: z.number().int().min(1).max(8).nullish(),
  verdicts: z.array(z.string()).nullish(),
  cursor: z.string().nullish(),
  adminToken: z.string().nullish(),
})

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

export const paAdminReevaluatePrescreens = onCall(
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
    const maxReeval = parsed.data.maxReeval ?? 50
    const concurrency = parsed.data.concurrency ?? 5
    const targetVerdicts = parsed.data.verdicts?.length ? new Set(parsed.data.verdicts) : TARGET_VERDICTS
    const db = getFirestore()
    const deps = makeProdPrescreenEvalDeps(db)
    const reevalOne = async (id: string) => {
      try {
        const r = await runPrescreenCandidateEval(id, deps, { force: true })
        return { id, status: r.status, verdict: r.eval?.verdict as string | undefined }
      } catch (e) {
        logger.error("[prescreen-reeval] failed", { id, error: String(e).slice(0, 200) })
        return { id, status: "error", verdict: undefined }
      }
    }

    if (ids && ids.length) {
      const results = await mapConcurrent(ids.slice(0, maxReeval), concurrency, reevalOne)
      return { mode: "ids", results }
    }

    let q = db.collection(SESSIONS).orderBy("__name__").limit(pageLimit)
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
      const review = data.review as { candidateChecklistEval?: { verdict?: string } } | undefined
      const verdict = review?.candidateChecklistEval?.verdict
      if (!verdict || !targetVerdicts.has(verdict)) continue
      if (targets.length >= maxReeval) {
        hitMax = true
        break
      }
      targets.push({ id: d.id, was: verdict })
    }
    const results = await mapConcurrent(targets, concurrency, (t) => reevalOne(t.id))
    const sample = results.slice(0, 12).map((r, i) => ({ id: r.id, was: targets[i]!.was, now: r.verdict }))
    const done = !hitMax && snap.size < pageLimit
    return { mode: "scan", scanned, reevaluated: results.length, sample, nextCursor: lastId, done }
  },
)
