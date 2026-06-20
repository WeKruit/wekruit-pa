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
  maxReeval: z.number().int().min(1).max(60).nullish(),
  cursor: z.string().nullish(),
  adminToken: z.string().nullish(),
})

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
    const maxReeval = parsed.data.maxReeval ?? 25
    const db = getFirestore()
    const deps = makeProdEvalDeps(db)

    // Targeted by explicit ids (e.g. re-eval Joseph specifically).
    if (ids && ids.length) {
      const results: Array<Record<string, unknown>> = []
      for (const id of ids.slice(0, maxReeval)) {
        try {
          const r = await runRecruiterSubmissionEval({ submissionId: id, submission: {}, force: true }, deps)
          results.push({ id, status: r.status, verdict: r.aiEvaluation?.verdict })
        } catch (e) {
          results.push({ id, status: "error", error: String(e).slice(0, 140) })
        }
      }
      return { mode: "ids", results }
    }

    // Paginated scan of the reject/borderline-with-résumé harm set.
    let q = db.collection(SUBMISSIONS).orderBy("__name__").limit(pageLimit)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()
    let scanned = 0
    let reevaluated = 0
    let hitMax = false
    let lastId: string | null = cursor ?? null
    const sample: Array<Record<string, unknown>> = []
    for (const d of snap.docs) {
      scanned += 1
      lastId = d.id
      const data = d.data() as Record<string, unknown>
      const ev = data.aiEvaluation as { verdict?: string } | undefined
      const cand = data.candidate as { resumeUrl?: string; linkedinUrl?: string; link?: string } | undefined
      const hasResume = Boolean(cand?.resumeUrl || cand?.linkedinUrl || cand?.link)
      if (!ev?.verdict || !TARGET_VERDICTS.has(ev.verdict) || !hasResume) continue
      if (reevaluated >= maxReeval) {
        hitMax = true
        break
      }
      try {
        const r = await runRecruiterSubmissionEval({ submissionId: d.id, submission: {}, force: true }, deps)
        reevaluated += 1
        if (sample.length < 12) sample.push({ id: d.id, was: ev.verdict, now: r.aiEvaluation?.verdict })
      } catch (e) {
        logger.error("[reeval] failed", { id: d.id, error: String(e).slice(0, 200) })
      }
    }
    const done = !hitMax && snap.size < pageLimit
    return { mode: "scan", scanned, reevaluated, sample, nextCursor: lastId, done }
  },
)
