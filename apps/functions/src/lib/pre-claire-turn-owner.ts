export type PreClaireTurnOwner = "prescreen" | "layoff_orchestrator" | "generic"

export function decidePreClaireTurnOwner(args: {
  prescreenHandled: boolean
  layoffOwnsTurn: boolean
}): PreClaireTurnOwner {
  if (args.prescreenHandled) return "prescreen"
  if (args.layoffOwnsTurn) return "layoff_orchestrator"
  return "generic"
}
