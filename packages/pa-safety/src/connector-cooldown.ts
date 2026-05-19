import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

export function parseCooldownSec(env: string | undefined, fallbackSec: number): number {
  const n = Number(env)
  if (!Number.isFinite(n) || n < 0) return fallbackSec
  return Math.floor(n)
}

export type ConnectorCooldownResult = {
  allow: boolean
  remainingMs: number
}

export async function assertConnectorCooldown(
  db: Firestore,
  userId: string,
  connectorName: string,
  cooldownSec: number
): Promise<ConnectorCooldownResult> {
  if (cooldownSec <= 0) return { allow: true, remainingMs: 0 }
  const ref = db
    .collection(PA_COLLECTIONS.users)
    .doc(userId)
    .collection("connector-cooldowns")
    .doc(connectorName)
  const snap = await ref.get()
  const lastAt = snap.exists ? String(snap.data()?.lastInvokedAt ?? "") : ""
  if (!lastAt) return { allow: true, remainingMs: 0 }
  const elapsed = Date.now() - Date.parse(lastAt)
  const windowMs = cooldownSec * 1000
  if (elapsed >= windowMs) return { allow: true, remainingMs: 0 }
  return { allow: false, remainingMs: windowMs - elapsed }
}

export async function recordConnectorCooldown(
  db: Firestore,
  userId: string,
  connectorName: string,
  source: string,
  nowIso: string
): Promise<void> {
  await db
    .collection(PA_COLLECTIONS.users)
    .doc(userId)
    .collection("connector-cooldowns")
    .doc(connectorName)
    .set({ lastInvokedAt: nowIso, source, connectorName }, { merge: true })
}
