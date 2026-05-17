export type PreClaireTurnOwner = "prescreen" | "layoff_orchestrator" | "generic"

export function decidePreClaireTurnOwner(args: {
  prescreenHandled: boolean
  layoffOwnsTurn: boolean
}): PreClaireTurnOwner {
  if (args.layoffOwnsTurn) return "layoff_orchestrator"
  if (args.prescreenHandled) return "prescreen"
  return "generic"
}
