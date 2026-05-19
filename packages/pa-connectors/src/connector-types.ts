import type { Firestore } from "firebase-admin/firestore"
import type { AgentDef } from "@pa/core-types"
import type { z } from "zod"

export type ConnectorNarrationTemplates = {
  preCall: Record<"en" | "zh", string>
  frameResult: Record<"en" | "zh", (ctx: { count: number }) => string>
}

export type FindMatchHookInput = {
  lang?: "en" | "zh"
  requestedCount?: number
  source?: string
}

export type FindMatchHookOutput = {
  ok: boolean
  source: "find-match"
  reason: string | null
  jobCount: number
  summary: string
  message: string | null
}

export type MatchCollabHookOutput = {
  ok: boolean
  source: "match-against-collab-jobs"
  reason: string | null
  jobCount: number
  topJobId: string | null
  topTitle: string | null
  topCompany: string | null
  matchScore?: number
  summary: string
}

export type MatchConnectorHooks = {
  findMatch?: (
    input: FindMatchHookInput,
    ctx: ConnectorContext
  ) => Promise<FindMatchHookOutput>
  matchCollabJobs?: (
    input: { lang?: "en" | "zh"; source?: string },
    ctx: ConnectorContext
  ) => Promise<MatchCollabHookOutput>
}

export type ConnectorContext = {
  db: Firestore
  agent: AgentDef
  turnId: string
  userId: string
  sessionId: string
  hooks?: MatchConnectorHooks
}

export type ConnectorDef<I, O> = {
  name: string
  version: string
  description: string
  inputSchema: z.ZodType<I>
  outputSchema: z.ZodType<O>
  expectedLatencyMs?: number
  narration?: ConnectorNarrationTemplates
  execute: (input: I, ctx: ConnectorContext) => Promise<O>
}
