/**
 * Phase 49 (v1.5 / Stream-H / D9) — paReverseMatch Cloud Function.
 *
 * Operator-facing reverse-match endpoint. Pasted JD + tags + industry →
 * top-K connected users ranked against the JD. Mirrors the daily-batch
 * forward path (apps/functions/src/job-rec-daily.ts) but reverses the
 * iteration: 1 JD × N users → top-K users instead of N jobs × 1 user →
 * top-K jobs.
 *
 * Auth: x-admin-token header against PA_ADMIN_TOKEN secret. Same shape
 * as paAdminBootstrap. Admin-only — no user-facing path.
 *
 * Flag: paReverseMatchEnabled (default OFF). When false, returns 503
 * with `{error:"flag_disabled"}`. Toggleable via /admin/flags.
 *
 * Actions (POST body `action` field):
 *   - "match" — run the rank pipeline. Body: {jobDescription, tags,
 *     industry, location?, topK?, companyName?, jobTitle?}.
 *   - "notify" — hand one candidate/event to Claire runtime. Body:
 *     {userId, jobTitle, companyName}. No direct pa-outbound write.
 *   - "bulkNotify" — loop notify for an explicit userIds[] list, capped
 *     at REVERSE_MATCH_BULK_NOTIFY_CAP (5). Caller MUST pre-filter to
 *     opted-in users.
 *
 * Rate-limit guidance lives in DELIVERY.md (operator runbook). Code
 * enforces only the per-call BULK_NOTIFY_CAP; daily/per-JD ceilings are
 * operator discipline (50/JD/day).
 *
 * Cost: 1 OpenAI text-embedding-3-small call per match (~$0.0001) + 1
 * SiliconFlow rerank call (free tier). Latency target: < 3s for 1k user
 * pool → top 20.
 *
 * ZERO regression on forward path: separate file, separate function;
 * daily-batch path doesn't import this module.
 */

import { onRequest } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import {
  runReverseMatch,
  REVERSE_MATCH_FLAG_KEY,
  REVERSE_MATCH_POOL_CAP,
  REVERSE_MATCH_BULK_NOTIFY_CAP,
  type ReverseMatchInput,
  type ReverseMatchUserProfile,
  type ReverseMatchDeps,
} from "@pa/job-rec"
import { getFlag } from "@pa/pa-persistence"
import { JOB_REC_FLAG_KEY } from "@pa/job-rec"
import { PA_COLLECTIONS } from "@pa/core-types"
import { checkAdminToken } from "./admin-bootstrap.js"
import { logTokenSpend } from "./instrumentation/cost-logger.js"
import { enqueueRuntimeEventHandoff } from "./runtime-event-handoff.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const SILICONFLOW_API_KEY = defineSecret("SILICONFLOW_API_KEY")
const PA_OPENAI_AGENT_API_KEY = defineSecret("PA_OPENAI_AGENT_API_KEY")

/** Whitelist 6-enum industry strings the operator may submit. */
const ALLOWED_INDUSTRIES = ["tech", "fintech", "healthtech", "consumer", "b2b", "any"] as const

/**
 * OpenAI text-embedding-3-small wrapper. Mirrors the embed-compute path
 * in job-rec-daily.ts. Fail-open (returns null) on any error — caller
 * surfaces empty candidates with a "couldn't embed JD" log.
 */
async function defaultEmbedJd(text: string): Promise<number[] | null> {
  try {
    // 2026-05-07 Adam directive — JD embed is real OpenAI. Drop poisoned
    // OPENAI_API_KEY fallback. Pass explicit baseURL so SDK doesn't read
    // OPENAI_BASE_URL env (legacy SF alias).
    const { getOpenAIConfig } = await import("./lib/llm-providers.js")
    const cfg = getOpenAIConfig()
    if (!cfg.apiKey) {
      logger.warn("[paReverseMatch] embed_no_api_key")
      return null
    }
    const { default: OpenAI } = await import("openai")
    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })
    const resp = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    })
    const vec = resp.data?.[0]?.embedding
    if (!vec || vec.length === 0) {
      logger.warn("[paReverseMatch] embed_empty_response")
      return null
    }
    // Backlog #23 — cost-ledger wiring. Mirrors the job-rec-daily emit so
    // the operator-facing reverse-match path doesn't ghost-spend.
    try {
      const usage = (resp as { usage?: { prompt_tokens?: number; total_tokens?: number } }).usage
      const tokens =
        usage?.prompt_tokens ?? usage?.total_tokens ?? Math.ceil(text.slice(0, 8000).length / 4)
      logTokenSpend({
        kind: "embedding",
        service: "openai",
        model: "text-embedding-3-small",
        inputTokens: tokens,
        count: 1,
        labels: { caller: "paReverseMatch" },
      })
    } catch {
      /* fail-open */
    }
    return vec
  } catch (err) {
    logger.error("[paReverseMatch] embed_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Default candidate-pool loader. Reads pa-job-profiles where
 * status=active. When industry !== "any", filters on profile.industry.
 * Cap REVERSE_MATCH_POOL_CAP for latency.
 */
async function defaultLoadCandidatePool(
  db: Firestore,
  industry: ReverseMatchInput["industry"],
): Promise<Array<{ userId: string; profileIndustry: string }>> {
  try {
    let q = db.collection("pa-job-profiles").where("status", "==", "active")
    if (industry !== "any") {
      q = q.where("profile.industry", "==", industry)
    }
    const snap = await q.limit(REVERSE_MATCH_POOL_CAP).get()
    const out: Array<{ userId: string; profileIndustry: string }> = []
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>
      const userId = typeof d.userId === "string" ? d.userId : doc.id
      const profile = (d.profile ?? {}) as Record<string, unknown>
      const pIndustry = typeof profile.industry === "string" ? profile.industry : ""
      out.push({ userId, profileIndustry: pIndustry })
    }
    return out
  } catch (err) {
    logger.error("[paReverseMatch] load_pool_failed", {
      error: err instanceof Error ? err.message : String(err),
      industry,
    })
    return []
  }
}

/**
 * Default per-user signals loader. Pulls:
 *   - parsedCandidateResumes (latest by userId,createdAt) → cvEmbedding,
 *     candidateProfile, experiences, recent company
 *   - pa-users/{userId} → displayName, preferredLanguage, statedPreferences,
 *     phoneE164 (for opt-in)
 *   - pa-feature-flags/paJobRecEnabled per-user (allowlist) → opt-in
 *     bool combined with phone presence.
 *
 * Returns null when the user has no parsed CV at all (we can't rank them
 * meaningfully). All other lookups fail-open.
 */
async function defaultLoadUserSignals(
  db: Firestore,
  userId: string,
): Promise<ReverseMatchUserProfile | null> {
  // 1. parsedCandidateResumes (latest)
  let cvEmbedding: number[] | null = null
  let topSkills: string[] = []
  let recentCompany = ""
  let cvText = ""
  try {
    const snap = await db
      .collection("parsedCandidateResumes")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get()
    if (snap.empty) return null
    const data = snap.docs[0]!.data() as Record<string, unknown>
    const emb = Array.isArray(data.embedding) ? (data.embedding as unknown[]) : null
    if (emb && emb.every((n) => typeof n === "number")) {
      cvEmbedding = emb as number[]
    }
    const cp = (data.candidateProfile ?? {}) as Record<string, unknown>
    const skills = Array.isArray(cp.skills) ? cp.skills : []
    topSkills = skills.filter((s): s is string => typeof s === "string").slice(0, 12)
    const exps = Array.isArray(data.experiences) ? data.experiences : []
    if (exps.length > 0) {
      const e0 = exps[0] as Record<string, unknown>
      recentCompany = typeof e0.company === "string" ? e0.company : ""
    }
    const skillsLine = topSkills.slice(0, 8).join(", ")
    cvText = `${userId} skills: ${skillsLine}${recentCompany ? `; recent: ${recentCompany}` : ""}`
  } catch (err) {
    logger.warn("[paReverseMatch] cv_lookup_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  // 2. pa-users
  let displayName = userId
  let preferredLanguage: "zh" | "en" = "zh"
  let phoneE164 = ""
  let statedPreferences: ReverseMatchUserProfile["hardFilterProfile"]["statedPreferences"] | undefined
  let experiences: ReverseMatchUserProfile["hardFilterProfile"]["experiences"] | undefined
  try {
    const userDoc = await db.collection("pa-users").doc(userId).get()
    if (userDoc.exists) {
      const ud = userDoc.data() as Record<string, unknown>
      if (typeof ud.displayName === "string" && ud.displayName.length > 0) displayName = ud.displayName
      if (ud.preferredLanguage === "en") preferredLanguage = "en"
      if (typeof ud.phoneE164 === "string") phoneE164 = ud.phoneE164
      const sp = ud.statedPreferences
      if (sp && typeof sp === "object") {
        statedPreferences = sp as ReverseMatchUserProfile["hardFilterProfile"]["statedPreferences"]
      }
    }
  } catch (err) {
    logger.warn("[paReverseMatch] user_lookup_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 3. parsedCandidateResumes experiences[] for the hard-filter shape
  try {
    const snap = await db
      .collection("parsedCandidateResumes")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get()
    if (!snap.empty) {
      const rd = snap.docs[0]!.data() as Record<string, unknown>
      const exps = Array.isArray(rd.experiences) ? rd.experiences : []
      experiences = exps
        .map((e) => {
          const x = (e ?? {}) as Record<string, unknown>
          return {
            startDate: typeof x.startDate === "string" ? x.startDate : undefined,
            endDate: typeof x.endDate === "string" ? x.endDate : undefined,
          }
        })
        .filter((e) => e.startDate !== undefined || e.endDate !== undefined)
    }
  } catch {
    /* fail-open */
  }

  // 4. opt-in: phone present + paJobRecEnabled flag
  let optedFlag = false
  try {
    optedFlag = Boolean(
      await getFlag(db, JOB_REC_FLAG_KEY, { userId, env: process.env }, false)
    )
  } catch {
    /* fail closed: opt-in remains false */
  }
  const hasOptedIn = phoneE164.length > 0 && optedFlag

  return {
    userId,
    displayName,
    profileIndustry: "", // overwritten by caller from pool row
    hardFilterProfile: { statedPreferences, experiences },
    cvEmbedding,
    cvText,
    topSkills,
    recentCompany,
    preferredLanguage,
    hasOptedIn,
  }
}

/**
 * Build deps with real Firestore + OpenAI + SiliconFlow. Tests do NOT
 * call this — they construct a fake deps inline (see reverse-match.test.ts).
 */
function buildProductionDeps(db: Firestore): ReverseMatchDeps {
  return {
    db,
    embedJd: defaultEmbedJd,
    loadCandidatePool: defaultLoadCandidatePool,
    loadUserSignals: async (db, userId) => {
      const sig = await defaultLoadUserSignals(db, userId)
      return sig
    },
    log: (event, payload) => logger.info(event, payload ?? {}),
  }
}

/**
 * Single-user notify enqueue. Resolves phone, composes bilingual body,
 * writes pa-outbound. Returns {ok, outboundId, error?}.
 */
export async function enqueueReverseMatchNotify(
  db: Firestore,
  args: { userId: string; jobTitle: string; companyName: string },
): Promise<{ ok: boolean; outboundId?: string; error?: string }> {
  // Resolve user → phone + language.
  let phoneE164 = ""
  let preferredLanguage: "zh" | "en" = "zh"
  try {
    const userDoc = await db.collection("pa-users").doc(args.userId).get()
    if (!userDoc.exists) return { ok: false, error: "user_not_found" }
    const ud = userDoc.data() as Record<string, unknown>
    if (typeof ud.phoneE164 === "string") phoneE164 = ud.phoneE164
    if (ud.preferredLanguage === "en") preferredLanguage = "en"
  } catch (err) {
    return {
      ok: false,
      error: `user_lookup_failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!phoneE164) return { ok: false, error: "user_missing_phone" }

  try {
    const runtime = await enqueueRuntimeEventHandoff(db, {
      userId: args.userId,
      toE164: phoneE164,
      source: "reverse_match",
      eventKind: "operator_notify",
      idempotencyKey: `reverse-match:${args.userId}:${args.companyName}:${args.jobTitle}`,
      requireExistingSession: true,
      context: {
        jobTitle: args.jobTitle,
        companyName: args.companyName,
        preferredLanguage,
        suggestedIntent:
          "Operator found a potentially relevant role. Decide whether to message the candidate, include the role/company, a clear job link only if present in context, and keep language consistent.",
      },
    })
    if (!runtime.ok) return { ok: false, error: runtime.reason }
    return { ok: true, outboundId: runtime.eventId }
  } catch (err) {
    return {
      ok: false,
      error: `runtime_handoff_failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export const paReverseMatch = onRequest(
  {
    region: "us-central1",
    memory: "1GiB",
    timeoutSeconds: 60,
    cors: [
      "https://wekruit-pa.web.app",
      "https://wekruit-pa.firebaseapp.com",
      "http://localhost:5173",
    ],
    secrets: [PA_ADMIN_TOKEN, SILICONFLOW_API_KEY, PA_OPENAI_AGENT_API_KEY],
  },
  async (req, res) => {
    // 1. Admin auth gate
    const auth = checkAdminToken(req.header("x-admin-token") ?? undefined)
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error })
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" })
      return
    }

    if (!getApps().length) initializeApp()
    const db = getFirestore()

    // 2. Flag gate (default OFF — Adam directive: "default off; admin-only initially")
    try {
      const enabled = await getFlag(db, REVERSE_MATCH_FLAG_KEY, {}, false)
      if (!enabled) {
        res.status(503).json({ error: "flag_disabled", flag: REVERSE_MATCH_FLAG_KEY })
        return
      }
    } catch (err) {
      logger.error("[paReverseMatch] flag_check_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ error: "flag_check_failed" })
      return
    }

    // 3. Bind LLM secrets so the embed call has env access.
    try {
      const k = PA_OPENAI_AGENT_API_KEY.value().trim()
      if (k) process.env.PA_OPENAI_AGENT_API_KEY = k
    } catch { /* secret unbound in dev */ }
    try {
      process.env.SILICONFLOW_API_KEY = SILICONFLOW_API_KEY.value()
    } catch { /* secret unbound in dev */ }

    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>
    const action = typeof body.action === "string" ? body.action : "match"

    try {
      if (action === "match") {
        const jd = typeof body.jobDescription === "string" ? body.jobDescription : ""
        const tags = Array.isArray(body.tags)
          ? body.tags.filter((t): t is string => typeof t === "string")
          : []
        const industryRaw = typeof body.industry === "string" ? body.industry : "any"
        const industry = (ALLOWED_INDUSTRIES as readonly string[]).includes(industryRaw)
          ? (industryRaw as ReverseMatchInput["industry"])
          : "any"
        const location = typeof body.location === "string" ? body.location : undefined
        const topK = typeof body.topK === "number" && Number.isFinite(body.topK)
          ? Math.max(1, Math.min(REVERSE_MATCH_POOL_CAP, Math.floor(body.topK)))
          : undefined
        const companyName = typeof body.companyName === "string" ? body.companyName : undefined
        const jobTitle = typeof body.jobTitle === "string" ? body.jobTitle : undefined
        if (jd.trim().length === 0) {
          res.status(400).json({ error: "missing_jobDescription" })
          return
        }
        // Augment loadUserSignals with the pool row's profileIndustry so
        // buildMatchedReasons can show industry alignment cleanly.
        const deps = buildProductionDeps(db)
        const pool = await deps.loadCandidatePool(db, industry)
        const industryByUser = new Map(pool.map((r) => [r.userId, r.profileIndustry]))
        const wrappedDeps: ReverseMatchDeps = {
          ...deps,
          loadCandidatePool: async () => pool,
          loadUserSignals: async (db, userId) => {
            const sig = await deps.loadUserSignals(db, userId)
            if (!sig) return null
            return { ...sig, profileIndustry: industryByUser.get(userId) ?? sig.profileIndustry }
          },
        }
        const out = await runReverseMatch(
          { jobDescription: jd, tags, industry, location, topK, companyName, jobTitle },
          wrappedDeps,
        )
        res.json({ ok: true, action, ...out })
        return
      }

      if (action === "notify") {
        const userId = typeof body.userId === "string" ? body.userId : ""
        const jobTitle = typeof body.jobTitle === "string" ? body.jobTitle : ""
        const companyName = typeof body.companyName === "string" ? body.companyName : ""
        if (!userId) {
          res.status(400).json({ error: "missing_userId" })
          return
        }
        const result = await enqueueReverseMatchNotify(db, { userId, jobTitle, companyName })
        if (!result.ok) {
          res.status(400).json({ error: result.error ?? "notify_failed" })
          return
        }
        res.json({ ok: true, action, outboundId: result.outboundId })
        return
      }

      if (action === "bulkNotify") {
        const userIds = Array.isArray(body.userIds)
          ? body.userIds.filter((s): s is string => typeof s === "string")
          : []
        if (userIds.length === 0) {
          res.status(400).json({ error: "missing_userIds" })
          return
        }
        if (userIds.length > REVERSE_MATCH_BULK_NOTIFY_CAP) {
          res.status(400).json({
            error: "bulk_cap_exceeded",
            cap: REVERSE_MATCH_BULK_NOTIFY_CAP,
          })
          return
        }
        const jobTitle = typeof body.jobTitle === "string" ? body.jobTitle : ""
        const companyName = typeof body.companyName === "string" ? body.companyName : ""
        const results: Array<{ userId: string; ok: boolean; outboundId?: string; error?: string }> = []
        for (const uid of userIds) {
          const r = await enqueueReverseMatchNotify(db, { userId: uid, jobTitle, companyName })
          results.push({ userId: uid, ...r })
        }
        res.json({
          ok: true,
          action,
          enqueued: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          results,
        })
        return
      }

      res.status(400).json({ error: "unknown_action", action })
    } catch (err) {
      logger.error("[paReverseMatch] handler_threw", {
        error: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({
        error: "internal",
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  },
)
