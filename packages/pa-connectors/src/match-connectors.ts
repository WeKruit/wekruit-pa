import { z } from "zod"
import type { ConnectorContext, ConnectorDef, ConnectorNarrationTemplates } from "./connector-types.js"

export type { MatchConnectorHooks } from "./connector-types.js"

const FindMatchInputSchema = z.object({
  lang: z.enum(["en", "zh"]).optional(),
  requestedCount: z.number().int().min(1).max(5).optional(),
  source: z.string().optional(),
  roleFocus: z.array(z.string()).nullable().optional(),
  hardConstraintsActive: z.boolean().nullable().optional(),
  allowBroadFallback: z.boolean().nullable().optional(),
})
const FindMatchOutputSchema = z.object({
  ok: z.boolean(),
  source: z.literal("find-match"),
  reason: z.string().nullable(),
  jobCount: z.number().int().nonnegative(),
  summary: z.string(),
  message: z.string().nullable(),
})

const MatchCollabInputSchema = z.object({
  lang: z.enum(["en", "zh"]).optional(),
  source: z.string().optional(),
})
const MatchCollabOutputSchema = z.object({
  ok: z.boolean(),
  source: z.literal("match-against-collab-jobs"),
  reason: z.string().nullable(),
  jobCount: z.number().int().nonnegative(),
  topJobId: z.string().nullable(),
  topTitle: z.string().nullable(),
  topCompany: z.string().nullable(),
  matchScore: z.number().optional(),
  summary: z.string(),
})

const nullableStringArray = z.array(z.string().min(1)).nullable()

const SetMatchingPreferencesInputSchema = z.object({
  visaStatus: z.enum(["sponsor_needed", "authorized", "citizen", "green_card", "opt", "unknown"]).nullable().optional(),
  targetLocations: nullableStringArray.optional(),
  roleFocus: nullableStringArray.optional(),
  companyStage: nullableStringArray.optional(),
  jobType: nullableStringArray.optional(),
  negativeCompanies: nullableStringArray.optional(),
  constraintStrength: z.enum(["hard", "soft", "unknown"]).nullable().optional(),
  evidenceText: z.string().min(1).max(1000).nullable().optional(),
  source: z.string().min(1).max(120).nullable().optional(),
})

const SetMatchingPreferencesOutputSchema = z.object({
  ok: z.boolean(),
  source: z.literal("set-matching-preferences"),
  reason: z.string().nullable(),
  hardConstraint: z.boolean(),
  updatedTags: z.array(z.string()),
  summary: z.string(),
})

export const FIND_MATCH_NARRATION: ConnectorNarrationTemplates = {
  preCall: {
    en: "ok hold on, let me pull up roles that fit — one sec",
    zh: "等我看看哪些合适啊...",
  },
  frameResult: {
    en: ({ count }) =>
      count > 0 ? `ok so I found ${count} that look like a fit —` : "hmm didn't find much yet —",
    zh: ({ count }) => (count > 0 ? `我这边看到 ${count} 个还挺合适的 —` : "暂时没捞到特别合适的 —"),
  },
}

export const MATCH_COLLAB_NARRATION: ConnectorNarrationTemplates = {
  preCall: {
    en: "ok lemme see if any of our partner roles fit you, one sec",
    zh: "等我看看有没有合作的岗位适合你...",
  },
  frameResult: {
    en: ({ count }) =>
      count > 0 ? `ok — ${count} partner role${count === 1 ? "" : "s"} look worth a shot —` : "no strong partner fit yet —",
    zh: ({ count }) => (count > 0 ? `有 ${count} 个合作岗看着还行 —` : "暂时没看到特别合适的合作岗 —"),
  },
}

export const FIND_MATCH_CONNECTOR: ConnectorDef<
  z.infer<typeof FindMatchInputSchema>,
  z.infer<typeof FindMatchOutputSchema>
> = {
  name: "find-match",
  version: "1",
  description:
    "Find ranked job matches for this user from the general WeKruit job catalog (V16 cascade). " +
    "Use when the user asks for job recommendations, new openings, or 'what fits me' in the open market. " +
    "Do NOT use for WeKruit partner/collab interview roles — use match-against-collab-jobs instead.",
  inputSchema: FindMatchInputSchema,
  outputSchema: FindMatchOutputSchema,
  expectedLatencyMs: 3500,
  narration: FIND_MATCH_NARRATION,
  execute: async (input, ctx) => {
    const hook = ctx.hooks?.findMatch
    if (!hook) {
      return {
        ok: false,
        source: "find-match",
        reason: "hook_not_configured",
        jobCount: 0,
        summary: "Matching is not wired on this runtime.",
        message: null,
      }
    }
    return hook(
      {
        lang: input.lang,
        requestedCount: input.requestedCount,
        source: input.source ?? "claire_tool",
        roleFocus: input.roleFocus ?? undefined,
        hardConstraintsActive: input.hardConstraintsActive ?? undefined,
        allowBroadFallback: input.allowBroadFallback ?? undefined,
      },
      ctx
    )
  },
}

function normalizeStringArray(value: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value) {
    const normalized = raw.trim().replace(/\s+/g, " ")
    if (!normalized || seen.has(normalized.toLowerCase())) continue
    seen.add(normalized.toLowerCase())
    out.push(normalized)
  }
  return out
}

export const SET_MATCHING_PREFERENCES_CONNECTOR: ConnectorDef<
  z.infer<typeof SetMatchingPreferencesInputSchema>,
  z.infer<typeof SetMatchingPreferencesOutputSchema>
> = {
  name: "set-matching-preferences",
  version: "1",
  description:
    "Persist durable matching preferences and hard constraints before recommending jobs. " +
    "Use when the user states visa/H1B sponsorship needs, location or remote constraints, role focus, company stage, job type, or companies to avoid. " +
    "If the user needs H1B/OPT employer sponsorship, set visaStatus to sponsor_needed and constraintStrength to hard.",
  inputSchema: SetMatchingPreferencesInputSchema,
  outputSchema: SetMatchingPreferencesOutputSchema,
  expectedLatencyMs: 600,
  execute: async (input, ctx) => {
    const tagsPatch: Record<string, unknown> = {}
    const updatedTags: string[] = []

    if (input.visaStatus) {
      tagsPatch.visaStatus = input.visaStatus
      updatedTags.push("visaStatus")
    }
    const targetLocations = normalizeStringArray(input.targetLocations)
    if (targetLocations.length > 0) {
      tagsPatch.targetLocations = targetLocations
      updatedTags.push("targetLocations")
    }
    const roleFocus = normalizeStringArray(input.roleFocus)
    if (roleFocus.length > 0) {
      tagsPatch.targetRoleFunction = roleFocus
      updatedTags.push("targetRoleFunction")
    }
    const companyStage = normalizeStringArray(input.companyStage)
    if (companyStage.length > 0) {
      tagsPatch.targetCompanyTags = companyStage
      updatedTags.push("targetCompanyTags")
    }
    const jobType = normalizeStringArray(input.jobType)
    if (jobType.length > 0) {
      tagsPatch.targetJobType = jobType
      updatedTags.push("targetJobType")
    }
    const negativeCompanies = normalizeStringArray(input.negativeCompanies)
    if (negativeCompanies.length > 0) {
      tagsPatch.companyNegativeList = negativeCompanies
      updatedTags.push("companyNegativeList")
    }

    if (updatedTags.length === 0) {
      return {
        ok: false,
        source: "set-matching-preferences",
        reason: "no_preferences",
        hardConstraint: false,
        updatedTags,
        summary: "No matching preference fields were supplied.",
      }
    }

    const hardConstraint =
      input.constraintStrength === "hard" ||
      input.visaStatus === "sponsor_needed" ||
      negativeCompanies.length > 0
    const now = new Date().toISOString()
    const matchingProfilePatch = {
      visaStatus: input.visaStatus ?? null,
      targetLocations: targetLocations.length > 0 ? targetLocations : null,
      roleFocus: roleFocus.length > 0 ? roleFocus : null,
      companyStage: companyStage.length > 0 ? companyStage : null,
      jobType: jobType.length > 0 ? jobType : null,
      negativeCompanies: negativeCompanies.length > 0 ? negativeCompanies : null,
      constraintStrength: hardConstraint ? "hard" : input.constraintStrength ?? "unknown",
      evidenceText: input.evidenceText ?? null,
      source: input.source ?? "claire_tool",
      turnId: ctx.turnId,
      sessionId: ctx.sessionId,
      updatedAt: now,
    }

    await ctx.db.collection("pa-users").doc(ctx.userId).set(
      {
        tags: tagsPatch,
        conversationDerivedPreferences: {
          matchingProfile: {
            last: matchingProfilePatch,
            updatedAt: now,
          },
          updatedAt: now,
        },
        updatedAt: now,
      },
      { merge: true },
    )

    return {
      ok: true,
      source: "set-matching-preferences",
      reason: null,
      hardConstraint,
      updatedTags,
      summary: hardConstraint
        ? "Saved hard matching constraints."
        : "Saved matching preferences.",
    }
  },
}

export const MATCH_COLLAB_CONNECTOR: ConnectorDef<
  z.infer<typeof MatchCollabInputSchema>,
  z.infer<typeof MatchCollabOutputSchema>
> = {
  name: "match-against-collab-jobs",
  version: "1",
  description:
    "Match the user against WeKruit partner/collab jobs (employer interview programs with prescreen). " +
    "Use when the user asks about partner roles, collab opportunities, interview invites, or jobs WeKruit runs screens for. " +
    "Do NOT use for general open-market job search — use find-match instead.",
  inputSchema: MatchCollabInputSchema,
  outputSchema: MatchCollabOutputSchema,
  expectedLatencyMs: 4000,
  narration: MATCH_COLLAB_NARRATION,
  execute: async (input, ctx) => {
    const hook = ctx.hooks?.matchCollabJobs
    if (!hook) {
      return {
        ok: false,
        source: "match-against-collab-jobs",
        reason: "hook_not_configured",
        jobCount: 0,
        topJobId: null,
        topTitle: null,
        topCompany: null,
        summary: "Collab matching unavailable.",
      }
    }
    return hook(
      {
        lang: input.lang,
        source: input.source ?? "claire_tool",
      },
      ctx
    )
  },
}
