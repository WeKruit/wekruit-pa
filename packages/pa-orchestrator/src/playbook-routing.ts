/**
 * Playbook / skill routing for Claire turns — v1 cache path vs Skill Router v2.
 */
import type { Firestore } from "firebase-admin/firestore"
import type { AgentTurnTool } from "@pa/agent-runtime"
import { getFlag } from "@pa/pa-persistence"
import { matchCachedPlaybooks } from "./playbook-cache.js"
import { createMockContext, type ClaireContext } from "./run-context.js"
import { route as routeSkillsV2 } from "./skill-router.js"

export type PlaybookRoutingResult = {
  addendum: string
  /** Union of allowedTools from active skills (empty when v1 path or no skills). */
  allowedTools: string[]
  activeSkillKeys: string[]
  source: "v1_cache" | "skill_router_v2"
}

export async function isSkillRouterV2Enabled(
  db: Firestore | undefined,
  userId: string
): Promise<boolean> {
  if (!db) return false
  try {
    return (await getFlag(db, "paSkillRouterV2Enabled", { userId, env: process.env })) === true
  } catch {
    return false
  }
}

function buildRoutingContext(
  userId: string,
  db: Firestore | undefined,
  log: (event: string, payload: Record<string, unknown>) => void
): ClaireContext {
  return createMockContext({
    userId,
    db,
    log: (evt, payload) => log(evt, payload ?? {}),
    guardrailHits: [],
  })
}

export async function resolvePlaybookForTurn(input: {
  db: Firestore | undefined
  userId: string
  messageBody: string
  log: (event: string, payload: Record<string, unknown>) => void
}): Promise<PlaybookRoutingResult> {
  const { db, userId, messageBody, log } = input
  if (!db) {
    return { addendum: "", allowedTools: [], activeSkillKeys: [], source: "v1_cache" }
  }

  const v2 = await isSkillRouterV2Enabled(db, userId)
  if (v2) {
    const ctx = buildRoutingContext(userId, db, log)
    const routed = await routeSkillsV2(messageBody, ctx, { db })
    const addendum = routed.addendum.trim()
    const activeSkillKeys = routed.activeSkills.map((s) => s.playbookKey)
    log("pa.skill_router.v2.applied", {
      userId,
      active: activeSkillKeys,
      allowedTools: routed.allowedTools,
      regex: routed.source.regex,
      llm: routed.source.llm,
    })
    return {
      addendum,
      allowedTools: routed.allowedTools,
      activeSkillKeys,
      source: "skill_router_v2",
    }
  }

  try {
    const { matched, addendum } = await matchCachedPlaybooks(db, messageBody)
    if (matched.length > 0 && addendum.trim().length > 0) {
      for (const p of matched) {
        log("pa.playbook.matched", {
          userId,
          playbookKey: p.playbookKey,
          playbookVersion: p.version,
        })
      }
    }
    return {
      addendum: addendum.trim(),
      allowedTools: [],
      activeSkillKeys: matched.map((p) => p.playbookKey),
      source: "v1_cache",
    }
  } catch {
    return { addendum: "", allowedTools: [], activeSkillKeys: [], source: "v1_cache" }
  }
}

/** Filter SDK tools when Skill Router v2 declares an allowlist for active skills. */
export function filterTurnToolsForSkillAllowlist(
  tools: AgentTurnTool[],
  routing: PlaybookRoutingResult
): AgentTurnTool[] {
  if (routing.source !== "skill_router_v2") return tools
  if (routing.activeSkillKeys.length === 0) return tools
  if (routing.allowedTools.length === 0) return []
  const allowed = new Set(routing.allowedTools)
  return tools.filter((t) => allowed.has(t.name))
}
