/**
 * Phase 32 W3 — Firestore wrapper for `pa-personas` (soul.md three-file
 * pattern) + audit rows.
 *
 * Same client-side direct-Firestore pattern as handbook-api.ts +
 * playbooks-api.ts. Server-side SDK in `@pa/agent-registry` owns the
 * canonical schema.
 */
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "firebase/firestore"
import { auth, db } from "./firebase.js"

export const PERSONAS_COLLECTION = "pa-personas"
export const PERSONA_AUDIT_PREFIX = "persona"

export type Persona = {
  personaKey: string
  name: string
  description: string
  soul: string
  style: string
  examples: string
  enabled: boolean
  version: number
  updatedAt: string | null
  updatedBy: string
  reason: string
}

export type PersonaAuditAction =
  | "persona.create"
  | "persona.update"
  | "persona.revert"

type PersonaAuditPayload = Partial<
  Pick<Persona, "name" | "description" | "soul" | "style" | "examples" | "enabled">
>

export type PersonaAuditEvent = {
  id: string
  actor: string
  action: PersonaAuditAction
  key: string
  oldValue: PersonaAuditPayload | null
  newValue: PersonaAuditPayload | null
  reason: string
  ts: string | null
}

function tsToIso(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Timestamp) return value.toDate().toISOString()
  if (typeof value === "string") return value
  if (
    typeof value === "object" &&
    value !== null &&
    "seconds" in (value as Record<string, unknown>)
  ) {
    const seconds = Number((value as { seconds: unknown }).seconds)
    if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString()
  }
  return null
}

function currentActor(): string {
  const u = auth().currentUser
  return u?.email ?? u?.uid ?? "unknown"
}

function fromSnap(id: string, raw: Record<string, unknown>): Persona {
  return {
    personaKey: (raw.personaKey as string) ?? id,
    name: (raw.name as string) ?? id,
    description: (raw.description as string) ?? "",
    soul: (raw.soul as string) ?? "",
    style: (raw.style as string) ?? "",
    examples: (raw.examples as string) ?? "",
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    version: typeof raw.version === "number" ? raw.version : 0,
    updatedAt: tsToIso(raw.updatedAt),
    updatedBy: (raw.updatedBy as string) ?? "",
    reason: (raw.reason as string) ?? "",
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listPersonas(): Promise<Persona[]> {
  const snap = await getDocs(collection(db(), PERSONAS_COLLECTION))
  const rows = snap.docs.map((d) => fromSnap(d.id, d.data() as Record<string, unknown>))
  rows.sort((a, b) => a.personaKey.localeCompare(b.personaKey))
  return rows
}

export async function listAuditForPersona(
  personaKey: string,
  max = 20
): Promise<PersonaAuditEvent[]> {
  const snap = await getDocs(
    query(
      collection(db(), PA_COLLECTIONS.auditEvents),
      where("key", "==", personaKey),
      orderBy("ts", "desc"),
      limit(max)
    )
  )
  const rows: PersonaAuditEvent[] = []
  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>
    const action = (raw.action as string) ?? ""
    if (!action.startsWith(PERSONA_AUDIT_PREFIX)) continue
    rows.push({
      id: d.id,
      actor: (raw.actor as string) ?? "unknown",
      action: action as PersonaAuditAction,
      key: (raw.key as string) ?? personaKey,
      oldValue: (raw.oldValue as PersonaAuditPayload | null) ?? null,
      newValue: (raw.newValue as PersonaAuditPayload | null) ?? null,
      reason: (raw.reason as string) ?? "",
      ts: tsToIso(raw.ts),
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Writes (always batched: persona doc + audit row)
// ---------------------------------------------------------------------------

export type SavePersonaInput = {
  personaKey: string
  name?: string
  description?: string
  soul?: string
  style?: string
  examples?: string
  enabled?: boolean
  reason: string
}

export async function savePersona(input: SavePersonaInput): Promise<void> {
  if (!input.reason.trim()) {
    throw new Error("Reason is required (audit log)")
  }
  const actor = currentActor()
  const personaRef = doc(db(), PERSONAS_COLLECTION, input.personaKey)
  const existing = await getDoc(personaRef)
  const prev = existing.exists()
    ? fromSnap(existing.id, existing.data() as Record<string, unknown>)
    : null

  const merged = {
    personaKey: input.personaKey,
    name: input.name ?? prev?.name ?? input.personaKey,
    description: input.description ?? prev?.description ?? "",
    soul: input.soul ?? prev?.soul ?? "",
    style: input.style ?? prev?.style ?? "",
    examples: input.examples ?? prev?.examples ?? "",
    enabled: input.enabled ?? prev?.enabled ?? true,
    version: (prev?.version ?? 0) + 1,
  }

  const batch = writeBatch(db())
  batch.set(
    personaRef,
    {
      ...merged,
      updatedAt: serverTimestamp(),
      updatedBy: actor,
      reason: input.reason.trim(),
    },
    { merge: true }
  )

  const auditRef = doc(collection(db(), PA_COLLECTIONS.auditEvents))
  batch.set(auditRef, {
    actor,
    action: prev ? "persona.update" : "persona.create",
    key: input.personaKey,
    oldValue: prev
      ? {
          name: prev.name,
          description: prev.description,
          soul: prev.soul,
          style: prev.style,
          examples: prev.examples,
          enabled: prev.enabled,
        }
      : null,
    newValue: {
      name: merged.name,
      description: merged.description,
      soul: merged.soul,
      style: merged.style,
      examples: merged.examples,
      enabled: merged.enabled,
    },
    reason: input.reason.trim(),
    ts: serverTimestamp(),
  })

  await batch.commit()
}

export async function revertPersona(personaKey: string, reason: string): Promise<void> {
  const events = await listAuditForPersona(personaKey, 20)
  const target = events.find(
    (e) => e.action !== "persona.revert" && e.oldValue
  )
  if (!target || !target.oldValue) {
    throw new Error(
      `No prior persona audit event with oldValue for ${personaKey} — nothing to revert.`
    )
  }
  const restore = target.oldValue
  await savePersona({
    personaKey,
    name: restore.name,
    description: restore.description,
    soul: restore.soul,
    style: restore.style,
    examples: restore.examples,
    enabled: restore.enabled,
    reason: `persona.revert: ${reason}`,
  })
}

// ---------------------------------------------------------------------------
// Compose preview (local-only)
// ---------------------------------------------------------------------------

/**
 * Mirror of `composePersonaPromptFromDoc` in @pa/agent-registry — returns
 * the SOUL/STYLE/EXAMPLES three-file concat string. Used by the dashboard
 * "Preview compose" button so editors see exactly what the persona-LLM
 * receives.
 */
export function composePersonaPreview(p: Persona): string {
  const parts: string[] = []
  const soul = p.soul.trim()
  const style = p.style.trim()
  const examples = p.examples.trim()
  if (soul) parts.push(`# SOUL\n${soul}`)
  if (style) parts.push(`# STYLE\n${style}`)
  if (examples) parts.push(`# EXAMPLES\n${examples}`)
  return parts.join("\n\n")
}
