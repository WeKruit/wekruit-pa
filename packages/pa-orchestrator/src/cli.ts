import "dotenv/config"
import { hydrateOpenAiFromAtm } from "@pa/agent-runtime"
import { getFirebaseApp, getFirestore } from "@pa/firebase-admin"
import { processPendingInboundEvents, startInboundEventListener } from "./index.js"

// Sprint-1 prod: the orchestrator runs as a Cloud Functions Gen 2 Firestore
// trigger (`apps/functions` -> `onPaInbound`). The long-running CLI listener
// is now opt-in via PA_ORCHESTRATOR_LOCAL=1 to avoid double-processing
// inbound events when both run.
if (process.env.PA_ORCHESTRATOR_LOCAL !== "1") {
  console.log(
    new Date().toISOString(),
    "[orchestrator] local listener disabled (set PA_ORCHESTRATOR_LOCAL=1 to enable). Cloud Functions handles inbound events.",
  )
  process.exit(0)
}

const atm = await hydrateOpenAiFromAtm()
if (atm.ok) console.log(new Date().toISOString(), "[atm] OpenAI runtime:", atm.reason || "hydrated")
else if (atm.reason && atm.reason !== "no ATM url or token" && atm.reason !== "disabled") {
  console.log(new Date().toISOString(), "[atm] skipped or failed:", atm.reason)
}

const db = getFirestore(getFirebaseApp())

console.log(new Date().toISOString(), "[orchestrator] listening for pending inbound events")
const stop = startInboundEventListener(db)

const repairLimit = Number(process.env.PA_ORCHESTRATOR_STARTUP_REPAIR_LIMIT || "20")
try {
  const count = await processPendingInboundEvents(db, repairLimit)
  if (count > 0) console.log(new Date().toISOString(), "[orchestrator] startup repair processed", count)
} catch (e) {
  console.error(new Date().toISOString(), "[orchestrator] startup repair error", e)
}

process.once("SIGINT", () => {
  stop()
  process.exit(0)
})
process.once("SIGTERM", () => {
  stop()
  process.exit(0)
})
