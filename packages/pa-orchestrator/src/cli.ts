import "dotenv/config"
import { randomUUID } from "node:crypto"
import { hydrateOpenAiFromAtm } from "@pa/agent-runtime"
import { getFirebaseApp, getFirestore } from "@pa/firebase-admin"
import { processAvailableInboundEvents } from "./index.js"

const atm = await hydrateOpenAiFromAtm()
if (atm.ok) {
  console.log(new Date().toISOString(), "[atm] OpenAI runtime:", atm.reason || "hydrated")
} else if (atm.reason && atm.reason !== "no ATM url or token" && atm.reason !== "disabled") {
  console.log(new Date().toISOString(), "[atm] skipped or failed:", atm.reason)
}

const db = getFirestore(getFirebaseApp())
const claimerId = process.env.PA_ORCHESTRATOR_ID || `pa-orchestrator-${randomUUID()}`
const pollMs = Number(process.env.PA_ORCHESTRATOR_POLL_MS || "2000")
const once = process.env.PA_ORCHESTRATOR_ONCE === "1"

async function tick() {
  const result = await processAvailableInboundEvents(db, { claimerId })
  if (result.claimed > 0) {
    console.log(new Date().toISOString(), "[orchestrator]", JSON.stringify(result))
  }
}

if (once) {
  await tick()
} else {
  console.log(new Date().toISOString(), "[orchestrator] running", claimerId)
  for (;;) {
    try {
      await tick()
    } catch (e) {
      console.error(new Date().toISOString(), "[orchestrator] tick error", e)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
