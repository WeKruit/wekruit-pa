import type { Firestore } from "firebase-admin/firestore"
import type { MatchConnectorHooks } from "@pa/pa-connectors"

export type GenerateJobRecsResult = {
  message: string
  recCount: number
  topJob?: {
    jobId: string
    title: string
    company: string
    score: number
  }
}

export type GenerateJobRecsFn = (
  userId: string,
  lang: "zh" | "en",
  opts?: {
    force?: boolean
    requestedCount?: number
    roleFocus?: string[]
    allowBroadFallback?: boolean
    collabPrescreenOnly?: boolean
    excludeInternships?: boolean
  }
) => Promise<GenerateJobRecsResult | null>

export type MatchConnectorHooksDeps = {
  db: Firestore
  generateJobRecs?: GenerateJobRecsFn
}

export function buildMatchConnectorHooks(deps: MatchConnectorHooksDeps): MatchConnectorHooks {
  return {
    findMatch: async (input, ctx) => {
      const gen = deps.generateJobRecs
      if (!gen) {
        return {
          ok: false,
          source: "find-match",
          reason: "generate_job_recs_not_configured",
          jobCount: 0,
          summary: "Matching unavailable.",
          message: null,
        }
      }
      const lang = input.lang === "zh" ? "zh" : "en"
      const recs = await gen(ctx.userId, lang, {
        force: true,
        requestedCount: input.requestedCount ?? 2,
        ...(input.roleFocus && input.roleFocus.length > 0 ? { roleFocus: input.roleFocus } : {}),
        ...(typeof input.allowBroadFallback === "boolean" ? { allowBroadFallback: input.allowBroadFallback } : {}),
      })
      const jobCount = recs?.recCount ?? 0
      return {
        ok: jobCount > 0,
        source: "find-match",
        reason: jobCount > 0 ? null : "no_matches",
        jobCount,
        summary: recs?.message?.slice(0, 200) ?? "No matches yet.",
        message: recs?.message ?? null,
      }
    },
    matchCollabJobs: async (input, ctx) => {
      const gen = deps.generateJobRecs
      if (!gen) {
        return {
          ok: false,
          source: "match-against-collab-jobs",
          reason: "generate_job_recs_not_configured",
          jobCount: 0,
          topJobId: null,
          topTitle: null,
          topCompany: null,
          summary: "Collab matching unavailable.",
        }
      }
      const lang = input.lang === "zh" ? "zh" : "en"
      const recs = await gen(ctx.userId, lang, {
        force: true,
        requestedCount: 3,
        collabPrescreenOnly: true,
      })
      const top = recs?.topJob
      const jobCount = top ? 1 : recs?.recCount ?? 0
      return {
        ok: Boolean(top?.jobId),
        source: "match-against-collab-jobs",
        reason: top?.jobId ? null : "no_collab_matches",
        jobCount: top ? 1 : jobCount,
        topJobId: top?.jobId ?? null,
        topTitle: top?.title ?? null,
        topCompany: top?.company ?? null,
        matchScore: top?.score,
        summary: recs?.message?.slice(0, 240) ?? "No collab matches.",
      }
    },
  }
}
