import { z } from "zod"
import type { ConnectorContext, ConnectorDef, ConnectorNarrationTemplates } from "./connector-types.js"

export type { MatchConnectorHooks } from "./connector-types.js"

const FindMatchInputSchema = z.object({
  lang: z.enum(["en", "zh"]).optional(),
  requestedCount: z.number().int().min(1).max(5).optional(),
  source: z.string().optional(),
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
      },
      ctx
    )
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
