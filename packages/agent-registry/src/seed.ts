import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { parseAgentDef } from "./parse.js"
import type { AgentDef } from "@pa/core-types"

const __dir = dirname(fileURLToPath(import.meta.url))

export function loadSeedAgents(): AgentDef[] {
  const distPath = join(__dir, "seed.json")
  const sourcePath = join(__dir, "../src/seed.json")
  const raw = readFileSync(existsSync(distPath) ? distPath : sourcePath, "utf8")
  const arr = JSON.parse(raw) as unknown[]
  return arr.map((a) => parseAgentDef(a))
}

export async function ensureSeedAgents(db: Firestore): Promise<void> {
  const batch = db.batch()
  for (const agent of loadSeedAgents()) {
    const ref = db.collection(PA_COLLECTIONS.agents).doc(agent.id)
    batch.set(ref, { ...agent, updatedAt: new Date().toISOString() }, { merge: true })
  }
  await batch.commit()
}
