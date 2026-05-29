import { z } from "zod"
import { PA_COLLECTIONS } from "@pa/core-types"
import type { ConnectorContext, ConnectorDef, ConnectorNarrationTemplates } from "./connector-types.js"

export type { MatchConnectorHooks } from "./connector-types.js"

// STRICT-COMPATIBLE (P1): the OpenAI Responses API rejects function schemas with
// optional keys under strict function-calling ("required must include every key").
// Use `.nullable()` (required + nullable) so the agent can call find-match through
// the @openai/agents SDK without a 400. runConnector still re-parses with this Zod;
// the execute coerces null → undefined for the hook. (Systemic Zod→strict-JSON in
// the adapter buildSdkTools is deferred to a later phase; this slice only needs find-match.)
const FindMatchInputSchema = z.object({
  lang: z.enum(["en", "zh"]).nullable(),
  requestedCount: z.number().int().min(1).max(5).nullable(),
  source: z.string().nullable(),
  roleFocus: z.array(z.string()).nullable(),
  hardConstraintsActive: z.boolean().nullable(),
  allowBroadFallback: z.boolean().nullable(),
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
  targetCountry: nullableStringArray.optional(),
  roleFocus: nullableStringArray.optional(),
  careerStage: z.enum(["student", "intern", "entry_level", "junior", "mid_level", "senior", "staff", "principal", "manager", "director", "vp", "c_level", "founder"]).nullable().optional(),
  companyStage: nullableStringArray.optional(),
  jobType: nullableStringArray.optional(),
  negativeCompanies: nullableStringArray.optional(),
  negativeRoleFunctions: nullableStringArray.optional(),
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

const SetDailyJobRecommendationSubscriptionInputSchema = z.object({
  optedIn: z.boolean(),
  consentText: z.string().min(1).max(1000).nullable().optional(),
  source: z.string().min(1).max(120).nullable().optional(),
  lang: z.enum(["en", "zh"]).nullable().optional(),
})

const SetDailyJobRecommendationSubscriptionOutputSchema = z.object({
  ok: z.boolean(),
  source: z.literal("set-daily-job-recommendation-subscription"),
  optedIn: z.boolean(),
  jobProfileStatus: z.enum(["active", "paused"]),
  reason: z.string().nullable(),
  summary: z.string(),
})

export const FIND_MATCH_NARRATION: ConnectorNarrationTemplates = {
  preCall: {
    en: "ok hold on, let me pull up roles that fit — one sec",
    zh: "等我看看哪些合适啊...",
  },
  frameResult: {
    en: ({ count }) =>
      count > 0
        ? `ok so I found ${count} role${count === 1 ? "" : "s"} that ${count === 1 ? "looks" : "look"} like a fit —`
        : "hmm didn't find much yet —",
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
  // Hermes-style routing boundary (replaces the deleted job_search regex router):
  // WHAT + verbatim positive triggers (EN + ZH) + explicit "Do NOT call when ...".
  // The positive triggers fix the P0 baseline's EN under-call; the negatives encode
  // the BFCL abstention cases (chit-chat, past-outcome questions, mere preference).
  description:
    "Find ranked open-market job matches for this user from the general WeKruit catalog (V16 cascade). " +
    "CALL THIS as soon as the user expresses they want to see jobs / matches / recommendations / new openings / " +
    "'what fits me' — even briefly. Example triggers: \"find me a job\", \"find me some software engineering jobs\", " +
    "\"any new roles for me?\", \"show me matches\", \"got any recommendations?\", \"what's out there for me\", " +
    "\"帮我看看有什么岗位匹配\", \"有没有合适的工作\", \"最近有没有推荐机会\", \"看看有什么新职位\". " +
    "Do NOT call for: casual chit-chat or emotional support; a question about a PAST prescreen/interview outcome; " +
    "PII edits; WeKruit partner/collab interview roles (use match-against-collab-jobs instead); or when the user is " +
    "merely stating a preference/constraint without asking to search (use set-matching-preferences instead).",
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
        lang: input.lang ?? undefined,
        requestedCount: input.requestedCount ?? undefined,
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
    "Use when the user states visa/H1B sponsorship needs, location or remote constraints, role focus, role functions to avoid, company stage, job type, or companies to avoid. " +
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
    const targetCountry = normalizeStringArray(input.targetCountry)
    if (targetCountry.length > 0) {
      tagsPatch.targetCountry = targetCountry
      updatedTags.push("targetCountry")
    }
    const roleFocus = normalizeStringArray(input.roleFocus)
    if (roleFocus.length > 0) {
      tagsPatch.targetRoleFunction = roleFocus
      updatedTags.push("targetRoleFunction")
    }
    if (input.careerStage) {
      tagsPatch.careerStage = input.careerStage
      updatedTags.push("careerStage")
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
    const negativeRoleFunctions = normalizeStringArray(input.negativeRoleFunctions)
    if (negativeRoleFunctions.length > 0) {
      // Write the SINGLE canonical field `negativeRoleFunction` (mirrors
      // `negativeIndustrySector`) — the SAME field the live conversation
      // extractor writes and the V16 matcher reads. No second source of truth
      // (was `roleFunctionNegativeList`, renamed 2026-05-28).
      tagsPatch.negativeRoleFunction = negativeRoleFunctions
      updatedTags.push("negativeRoleFunction")
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
      targetCountry.length > 0 ||
      Boolean(input.careerStage) ||
      negativeCompanies.length > 0 ||
      negativeRoleFunctions.length > 0
    const now = new Date().toISOString()
    const matchingProfilePatch = {
      visaStatus: input.visaStatus ?? null,
      targetLocations: targetLocations.length > 0 ? targetLocations : null,
      targetCountry: targetCountry.length > 0 ? targetCountry : null,
      roleFocus: roleFocus.length > 0 ? roleFocus : null,
      careerStage: input.careerStage ?? null,
      companyStage: companyStage.length > 0 ? companyStage : null,
      jobType: jobType.length > 0 ? jobType : null,
      negativeCompanies: negativeCompanies.length > 0 ? negativeCompanies : null,
      negativeRoleFunctions: negativeRoleFunctions.length > 0 ? negativeRoleFunctions : null,
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

export const SET_DAILY_JOB_RECOMMENDATION_SUBSCRIPTION_CONNECTOR: ConnectorDef<
  z.infer<typeof SetDailyJobRecommendationSubscriptionInputSchema>,
  z.infer<typeof SetDailyJobRecommendationSubscriptionOutputSchema>
> = {
  name: "set-daily-job-recommendation-subscription",
  version: "1",
  description:
    "Persist the user's opt-in or opt-out for daily job recommendation texts. " +
    "Use only when the user explicitly accepts or declines recurring fresh/daily job texts. " +
    "Call this before confirming that daily recommendations are saved.",
  inputSchema: SetDailyJobRecommendationSubscriptionInputSchema,
  outputSchema: SetDailyJobRecommendationSubscriptionOutputSchema,
  expectedLatencyMs: 600,
  execute: async (input, ctx) => {
    const now = new Date().toISOString()
    const status = input.optedIn ? "active" : "paused"
    const source = input.source ?? "claire_tool"
    const subscription = input.optedIn
      ? {
          optedIn: true,
          optedInAt: now,
          source,
          ...(input.consentText ? { consentText: input.consentText } : {}),
        }
      : {
          optedIn: false,
          optedOutAt: now,
          source,
          ...(input.consentText ? { consentText: input.consentText } : {}),
        }
    await ctx.db.collection(PA_COLLECTIONS.users).doc(ctx.userId).set(
      {
        dailyJobRecSubscribe: subscription,
        updatedAt: now,
      },
      { merge: true },
    )
    await ctx.db.collection("pa-job-profiles").doc(ctx.userId).set(
      {
        userId: ctx.userId,
        status,
        updatedAt: now,
      },
      { merge: true },
    )
    return {
      ok: true,
      source: "set-daily-job-recommendation-subscription",
      optedIn: input.optedIn,
      jobProfileStatus: status,
      reason: null,
      summary: input.optedIn
        ? "Daily job recommendation texts are active."
        : "Daily job recommendation texts are paused.",
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
