/** Must match packages/pa-orchestrator shared-onboarding HELLO_WEKRUIT_OPENER_PREFIX. */
export const HELLO_WEKRUIT_OPENER_PREFIX = "Hello, WeKruit!"

export function buildHelloWekruitOpenerBody(candidateId: string): string {
  const id = candidateId.trim()
  if (!id) return HELLO_WEKRUIT_OPENER_PREFIX
  return `${HELLO_WEKRUIT_OPENER_PREFIX} ${id}`
}
