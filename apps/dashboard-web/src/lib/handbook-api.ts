/**
 * Phase 29 T3 — Firestore wrapper for `pa-handbook-sections` + audit rows.
 *
 * Mirrors the Phase 24.5 `flags-api.ts` pattern: client-side direct Firestore
 * read/write under the dashboard's signed-in user, audit row written in the
 * same batch as the section doc. The server-side SDK (@pa/agent-registry's
 * `saveSection` / `revertSection`) is the source of truth for the schema —
 * this file just exists so the dashboard can compose the same shape without
 * pulling firebase-admin into the browser bundle.
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

export const HANDBOOK_SECTIONS_COLLECTION = "pa-handbook-sections"
export const HANDBOOK_AUDIT_PREFIX = "handbook"

export type HandbookSection = {
  sectionKey: string
  title: string
  body: string
  order: number
  enabled: boolean
  version: number
  updatedAt: string | null
  updatedBy: string
  reason: string
}

export type HandbookAuditAction =
  | "handbook.create"
  | "handbook.update"
  | "handbook.revert"

export type HandbookAuditEvent = {
  id: string
  actor: string
  action: HandbookAuditAction
  key: string
  oldValue: Partial<Pick<HandbookSection, "body" | "enabled" | "order" | "title">> | null
  newValue: Partial<Pick<HandbookSection, "body" | "enabled" | "order" | "title">> | null
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

function fromSnap(id: string, raw: Record<string, unknown>): HandbookSection {
  return {
    sectionKey: (raw.sectionKey as string) ?? id,
    title: (raw.title as string) ?? id,
    body: (raw.body as string) ?? "",
    order: typeof raw.order === "number" ? raw.order : 0,
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

export async function listSections(): Promise<HandbookSection[]> {
  const snap = await getDocs(collection(db(), HANDBOOK_SECTIONS_COLLECTION))
  const rows = snap.docs.map((d) => fromSnap(d.id, d.data() as Record<string, unknown>))
  rows.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    return a.sectionKey.localeCompare(b.sectionKey)
  })
  return rows
}

export async function listAuditForSection(
  sectionKey: string,
  max = 20
): Promise<HandbookAuditEvent[]> {
  const snap = await getDocs(
    query(
      collection(db(), PA_COLLECTIONS.auditEvents),
      where("key", "==", sectionKey),
      orderBy("ts", "desc"),
      limit(max)
    )
  )
  const rows: HandbookAuditEvent[] = []
  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>
    const action = (raw.action as string) ?? ""
    if (!action.startsWith(HANDBOOK_AUDIT_PREFIX)) continue
    rows.push({
      id: d.id,
      actor: (raw.actor as string) ?? "unknown",
      action: action as HandbookAuditAction,
      key: (raw.key as string) ?? sectionKey,
      oldValue:
        (raw.oldValue as HandbookAuditEvent["oldValue"] | null) ?? null,
      newValue:
        (raw.newValue as HandbookAuditEvent["newValue"] | null) ?? null,
      reason: (raw.reason as string) ?? "",
      ts: tsToIso(raw.ts),
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Writes (always batched: section doc + audit row)
// ---------------------------------------------------------------------------

export type SaveSectionInput = {
  sectionKey: string
  title?: string
  body?: string
  order?: number
  enabled?: boolean
  reason: string
}

export async function saveSection(input: SaveSectionInput): Promise<void> {
  if (!input.reason.trim()) {
    throw new Error("Reason is required (audit log)")
  }
  const actor = currentActor()
  const sectionRef = doc(db(), HANDBOOK_SECTIONS_COLLECTION, input.sectionKey)
  const existing = await getDoc(sectionRef)
  const prev = existing.exists()
    ? fromSnap(existing.id, existing.data() as Record<string, unknown>)
    : null

  const merged = {
    sectionKey: input.sectionKey,
    title: input.title ?? prev?.title ?? input.sectionKey,
    body: input.body ?? prev?.body ?? "",
    order: input.order ?? prev?.order ?? 0,
    enabled: input.enabled ?? prev?.enabled ?? true,
    version: (prev?.version ?? 0) + 1,
  }

  const batch = writeBatch(db())
  batch.set(
    sectionRef,
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
    action: prev ? "handbook.update" : "handbook.create",
    key: input.sectionKey,
    oldValue: prev
      ? { body: prev.body, enabled: prev.enabled, order: prev.order, title: prev.title }
      : null,
    newValue: {
      body: merged.body,
      enabled: merged.enabled,
      order: merged.order,
      title: merged.title,
    },
    reason: input.reason.trim(),
    ts: serverTimestamp(),
  })

  await batch.commit()
}

export async function revertSection(sectionKey: string, reason: string): Promise<void> {
  const events = await listAuditForSection(sectionKey, 20)
  const target = events.find(
    (e) => e.action !== "handbook.revert" && e.oldValue
  )
  if (!target || !target.oldValue) {
    throw new Error(
      `No prior handbook audit event with oldValue for ${sectionKey} — nothing to revert.`
    )
  }
  const restore = target.oldValue
  await saveSection({
    sectionKey,
    title: restore.title,
    body: restore.body,
    order: restore.order,
    enabled: restore.enabled,
    reason: `handbook.revert: ${reason}`,
  })
}
