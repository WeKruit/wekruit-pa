const BROKER_PRESCREEN_TRIGGER_RE = /WeKruit_([A-Za-z0-9_-]+)_([A-Za-z0-9]+)_Job/

export type BrokerPrescreenTriggerDecision =
  | { kind: "not_trigger" }
  | { kind: "authorized"; jobId: string; userId: string }
  | { kind: "unauthorized"; jobId: string; targetUserId: string; reason: "not_self" }

export function decideBrokerPrescreenTrigger(
  text: string,
  resolvedUserId: string,
): BrokerPrescreenTriggerDecision {
  const match = text.match(BROKER_PRESCREEN_TRIGGER_RE)
  if (!match) return { kind: "not_trigger" }
  const [, jobId, targetUserId] = match
  if (targetUserId !== resolvedUserId) {
    return { kind: "unauthorized", jobId, targetUserId, reason: "not_self" }
  }
  return { kind: "authorized", jobId, userId: resolvedUserId }
}
