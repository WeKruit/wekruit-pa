import { AgentDefSchema, type AgentDef } from "@pa/core-types"

export function parseAgentDef(data: unknown): AgentDef {
  return AgentDefSchema.parse(data)
}
