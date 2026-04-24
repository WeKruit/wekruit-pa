import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { parseAgentDef } from "./parse.js"
import type { AgentDef } from "@pa/core-types"
import { ensureSeedAgents } from "./seed.js"

export async function getAgentById(db: Firestore, id: string): Promise<AgentDef | null> {
  const d = await db.collection(PA_COLLECTIONS.agents).doc(id).get()
  if (!d.exists) return null
  try {
    return parseAgentDef({ id, ...d.data() })
  } catch {
    return null
  }
}

export async function getDefaultAgent(db: Firestore): Promise<AgentDef | null> {
  const snap = await db.collection(PA_COLLECTIONS.agents).where("isDefault", "==", true).limit(1).get()
  if (snap.empty) {
    await ensureSeedAgents(db)
    return getAgentById(db, "default")
  }
  const d = snap.docs[0]!
  return parseAgentDef({ id: d.id, ...d.data() })
}

export async function listAgents(db: Firestore, limit = 100): Promise<AgentDef[]> {
  let snap = await db.collection(PA_COLLECTIONS.agents).limit(limit).get()
  if (snap.empty) {
    await ensureSeedAgents(db)
    snap = await db.collection(PA_COLLECTIONS.agents).limit(limit).get()
  }
  return snap.docs.map((d) => parseAgentDef({ id: d.id, ...d.data() }))
}

export { ensureSeedAgents, loadSeedAgents } from "./seed.js"
