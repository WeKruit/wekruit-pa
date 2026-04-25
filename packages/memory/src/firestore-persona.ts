import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS, type MemoryFact } from "@pa/core-types"

export async function listConfirmedMemoryFacts(db: Firestore, userId: string): Promise<MemoryFact[]> {
  const snap = await db
    .collection(PA_COLLECTIONS.memoryFacts)
    .where("userId", "==", userId)
    .where("status", "==", "confirmed")
    .limit(100)
    .get()
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as MemoryFact)
    .filter((fact) => fact.sensitivity !== "high")
    .sort((a, b) => `${a.key}:${a.value}`.localeCompare(`${b.key}:${b.value}`))
}

export function buildPersonaCard(facts: MemoryFact[]): string | null {
  if (facts.length === 0) return null
  const lines = facts.map((fact) => `- ${fact.key}: ${fact.value}`)
  return `Confirmed persona facts:\n${lines.join("\n")}`
}

export async function loadFirestorePersonaCard(db: Firestore, userId: string): Promise<string | null> {
  return buildPersonaCard(await listConfirmedMemoryFacts(db, userId))
}

export function isSurpriseEligible(input: {
  optedIn?: boolean
  sensitivity?: "low" | "medium" | "high"
  lastSurpriseAt?: string | null
  now?: Date
  cooldownMs?: number
}): boolean {
  if (!input.optedIn) return false
  if (input.sensitivity === "high") return false
  if (!input.lastSurpriseAt) return true
  const now = input.now ?? new Date()
  const cooldownMs = input.cooldownMs ?? 7 * 24 * 60 * 60 * 1000
  return now.getTime() - Date.parse(input.lastSurpriseAt) >= cooldownMs
}

export async function recordMemoryEvolutionEvent(
  db: Firestore,
  input: { userId: string; kind: string; message: string; meta?: Record<string, unknown> }
) {
  await db.collection(PA_COLLECTIONS.memoryEvolutionEvents).add({
    ...input,
    createdAt: new Date().toISOString(),
  })
}

export async function recordSurpriseEvent(
  db: Firestore,
  input: { userId: string; message: string; sensitivity: "low" | "medium" | "high"; meta?: Record<string, unknown> }
) {
  await db.collection(PA_COLLECTIONS.surpriseEvents).add({
    ...input,
    createdAt: new Date().toISOString(),
  })
}
