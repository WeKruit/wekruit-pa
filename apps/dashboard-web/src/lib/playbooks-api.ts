/**
 * Phase 32 W3 — Firestore wrapper for `pa-playbooks` + audit rows.
 *
 * Mirrors the handbook-api.ts pattern: client-side direct Firestore read
 * + write under the dashboard's signed-in user. The server-side SDK
 * (`@pa/agent-registry`) is the source of truth for the schema; this
 * file exists so the dashboard can compose the same shape without
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

export const PLAYBOOKS_COLLECTION = "pa-playbooks"
export const PLAYBOOK_AUDIT_PREFIX = "playbook"

export type RoutingHint = "no_chain" | "role_chain" | null

export type Playbook = {
  playbookKey: string
  name: string
  description: string
  regexTriggers: string[]
  addendum: string
  enabled: boolean
  /** iter27 — onboarding routing hint */
  routingHint: RoutingHint
  version: number
  updatedAt: string | null
  updatedBy: string
  reason: string
}

export type PlaybookAuditAction =
  | "playbook.create"
  | "playbook.update"
  | "playbook.revert"

type PlaybookAuditPayload = Partial<
  Pick<Playbook, "name" | "description" | "regexTriggers" | "addendum" | "enabled">
>

export type PlaybookAuditEvent = {
  id: string
  actor: string
  action: PlaybookAuditAction
  key: string
  oldValue: PlaybookAuditPayload | null
  newValue: PlaybookAuditPayload | null
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

function fromSnap(id: string, raw: Record<string, unknown>): Playbook {
  const rh = raw.routingHint
  const routingHint: RoutingHint =
    rh === "no_chain" || rh === "role_chain" ? rh : null
  return {
    playbookKey: (raw.playbookKey as string) ?? id,
    name: (raw.name as string) ?? id,
    description: (raw.description as string) ?? "",
    regexTriggers: Array.isArray(raw.regexTriggers)
      ? (raw.regexTriggers as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    addendum: (raw.addendum as string) ?? "",
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    routingHint,
    version: typeof raw.version === "number" ? raw.version : 0,
    updatedAt: tsToIso(raw.updatedAt),
    updatedBy: (raw.updatedBy as string) ?? "",
    reason: (raw.reason as string) ?? "",
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listPlaybooks(): Promise<Playbook[]> {
  const snap = await getDocs(collection(db(), PLAYBOOKS_COLLECTION))
  const rows = snap.docs.map((d) => fromSnap(d.id, d.data() as Record<string, unknown>))
  rows.sort((a, b) => a.playbookKey.localeCompare(b.playbookKey))
  return rows
}

export async function listAuditForPlaybook(
  playbookKey: string,
  max = 20
): Promise<PlaybookAuditEvent[]> {
  const snap = await getDocs(
    query(
      collection(db(), PA_COLLECTIONS.auditEvents),
      where("key", "==", playbookKey),
      orderBy("ts", "desc"),
      limit(max)
    )
  )
  const rows: PlaybookAuditEvent[] = []
  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>
    const action = (raw.action as string) ?? ""
    if (!action.startsWith(PLAYBOOK_AUDIT_PREFIX)) continue
    rows.push({
      id: d.id,
      actor: (raw.actor as string) ?? "unknown",
      action: action as PlaybookAuditAction,
      key: (raw.key as string) ?? playbookKey,
      oldValue: (raw.oldValue as PlaybookAuditPayload | null) ?? null,
      newValue: (raw.newValue as PlaybookAuditPayload | null) ?? null,
      reason: (raw.reason as string) ?? "",
      ts: tsToIso(raw.ts),
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Writes (always batched: playbook doc + audit row)
// ---------------------------------------------------------------------------

export type SavePlaybookInput = {
  playbookKey: string
  name?: string
  description?: string
  regexTriggers?: string[]
  addendum?: string
  enabled?: boolean
  routingHint?: RoutingHint
  reason: string
}

export async function savePlaybook(input: SavePlaybookInput): Promise<void> {
  if (!input.reason.trim()) {
    throw new Error("Reason is required (audit log)")
  }
  const actor = currentActor()
  const playbookRef = doc(db(), PLAYBOOKS_COLLECTION, input.playbookKey)
  const existing = await getDoc(playbookRef)
  const prev = existing.exists()
    ? fromSnap(existing.id, existing.data() as Record<string, unknown>)
    : null

  const merged = {
    playbookKey: input.playbookKey,
    name: input.name ?? prev?.name ?? input.playbookKey,
    description: input.description ?? prev?.description ?? "",
    regexTriggers: input.regexTriggers ?? prev?.regexTriggers ?? [],
    addendum: input.addendum ?? prev?.addendum ?? "",
    enabled: input.enabled ?? prev?.enabled ?? true,
    routingHint: input.routingHint !== undefined ? input.routingHint : prev?.routingHint ?? null,
    version: (prev?.version ?? 0) + 1,
  }

  const batch = writeBatch(db())
  batch.set(
    playbookRef,
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
    action: prev ? "playbook.update" : "playbook.create",
    key: input.playbookKey,
    oldValue: prev
      ? {
          name: prev.name,
          description: prev.description,
          regexTriggers: prev.regexTriggers,
          addendum: prev.addendum,
          enabled: prev.enabled,
        }
      : null,
    newValue: {
      name: merged.name,
      description: merged.description,
      regexTriggers: merged.regexTriggers,
      addendum: merged.addendum,
      enabled: merged.enabled,
    },
    reason: input.reason.trim(),
    ts: serverTimestamp(),
  })

  await batch.commit()
}

export async function revertPlaybook(playbookKey: string, reason: string): Promise<void> {
  const events = await listAuditForPlaybook(playbookKey, 20)
  const target = events.find(
    (e) => e.action !== "playbook.revert" && e.oldValue
  )
  if (!target || !target.oldValue) {
    throw new Error(
      `No prior playbook audit event with oldValue for ${playbookKey} — nothing to revert.`
    )
  }
  const restore = target.oldValue
  await savePlaybook({
    playbookKey,
    name: restore.name,
    description: restore.description,
    regexTriggers: restore.regexTriggers,
    addendum: restore.addendum,
    enabled: restore.enabled,
    reason: `playbook.revert: ${reason}`,
  })
}

// ---------------------------------------------------------------------------
// Trigger-tester helper (local-only — does not hit Firestore)
// ---------------------------------------------------------------------------

/**
 * Compile each playbook's regex triggers (case-insensitive) and return the
 * ones whose trigger fires on `messageBody`. Skips disabled playbooks and
 * silently ignores invalid regex sources (so the test UI can't crash).
 */
export function testTriggers(messageBody: string, playbooks: Playbook[]): Playbook[] {
  if (!messageBody.trim()) return []
  const matched: Playbook[] = []
  for (const pb of playbooks) {
    if (!pb.enabled) continue
    if (pb.regexTriggers.length === 0) continue
    for (const src of pb.regexTriggers) {
      try {
        const re = new RegExp(src, "i")
        if (re.test(messageBody)) {
          matched.push(pb)
          break
        }
      } catch {
        /* ignore invalid regex */
      }
    }
  }
  return matched
}
