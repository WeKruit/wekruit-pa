/**
 * v1.5 Stage A canary — flip 9 flags to perUser scope with allowlist=[adamUserId].
 * Idempotent. Run with: npx tsx apps/functions/scripts/canary-stage-a.ts
 */
import admin from "firebase-admin"
import { setFlag } from "@pa/pa-persistence"

const ADAM_UID = "e5d97cd8-1e1d-439d-8672-3008f8aeef2e"
const ACTOR = "v1.5-canary-stage-a@wekruit.com"
const REASON = "v1.5 Stage A — Adam canary perUser allowlist before 10% ramp"

const FLAGS = [
  "paOnboardingProbeV2Enabled",
  "paHardFiltersEnabled",
  "paStartupBoostEnabled",
  "paMatchExplainerEnabled",
  "paMatchingPipelineWebhookEnabled",
  "paMessageCoalesceEnabled",
  "paSafetyCheckEnabled",
  "paReverseMatchEnabled",
  "paTagClusterRecEnabled",
] as const

async function main() {
  if (admin.apps.length === 0) {
    admin.initializeApp({ projectId: "wekruit-5f89b" })
  }
  const db = admin.firestore()

  for (const key of FLAGS) {
    try {
      await setFlag(
        db,
        key,
        {
          value: true,
          type: "boolean",
          scope: "perUser",
          allowlist: [ADAM_UID],
        },
        { actor: ACTOR, reason: REASON }
      )
      console.log(`✔ ${key} → perUser allowlist=[${ADAM_UID.slice(0, 8)}…]`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`✗ ${key} — ${msg}`)
      process.exitCode = 1
    }
  }
  console.log(`\nStage A canary complete. ${FLAGS.length} flags flipped.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
