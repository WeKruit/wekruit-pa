/**
 * Phase 29 T2 — dashboard wrapper for `pa-handbooks/{slug}` + immutable
 * `versions/{v}` sub-collection (P10-locked v2 schema).
 *
 * Mirrors the Phase 24.5 `flags-api.ts` pattern: client-side direct
 * Firestore read/write under the dashboard's signed-in user. Audit row
 * written in the same batch as the section save — same shape used by
 * `@pa/pa-persistence/handbook` server SDK so post-merge rules can rely
 * on a single audit collection.
 *
 * Schema mirrored verbatim from packages/pa-persistence/src/handbook.ts —
 * keep these two files in sync if the schema ever evolves.
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
  writeBatch,
} from "firebase/firestore"
import { auth, db } from "./firebase.js"

export const HANDBOOKS_COLLECTION = "pa-handbooks"
export const HANDBOOK_VERSIONS_SUBCOLLECTION = "versions"
export const HANDBOOK_AUDIT_PREFIX = "handbook"
export const DEFAULT_HANDBOOK_SLUG = "claire"

// ---------------------------------------------------------------------------
// Schema types — mirror @pa/pa-persistence
// ---------------------------------------------------------------------------

export type PlaybookSpec = {
  name: string
  trigger: string
  steps: string[]
  exitCondition: string
}

export type HandbookSections = {
  identity: string
  hard_rules: string[]
  default_posture: string
  never_5: string[]
  escape_hatch: string
  tone_flavors: Record<string, string>
  human_tells: string[]
  vocab: { allowed: string[]; banned: string[] }
  playbooks: Record<string, PlaybookSpec>
}

export type HandbookDoc = {
  slug: string
  version: number
  sections: HandbookSections
  updatedBy: string
  updatedAt: string | null
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
  reason: string
  ts: string | null
  oldValue: unknown
  newValue: unknown
  revertedToVersion?: number
}

// Locked render order — matches @pa/pa-persistence HANDBOOK_RENDER_ORDER.
export const HANDBOOK_RENDER_ORDER = [
  "identity",
  "hard_rules",
  "default_posture",
  "never_5",
  "escape_hatch",
  "vocab",
  "human_tells",
  "tone_flavors",
  "playbooks",
] as const
export type HandbookSectionKey = (typeof HANDBOOK_RENDER_ORDER)[number]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

export function emptyHandbookSections(): HandbookSections {
  return {
    identity: "",
    hard_rules: [],
    default_posture: "",
    never_5: [],
    escape_hatch: "",
    tone_flavors: {},
    human_tells: [],
    vocab: { allowed: [], banned: [] },
    playbooks: {},
  }
}

function ensureSections(raw: unknown): HandbookSections {
  if (!raw || typeof raw !== "object") return emptyHandbookSections()
  const r = raw as Record<string, unknown>
  const out = emptyHandbookSections()
  if (typeof r.identity === "string") out.identity = r.identity
  if (Array.isArray(r.hard_rules)) {
    out.hard_rules = r.hard_rules.map((v) => String(v))
  }
  if (typeof r.default_posture === "string") out.default_posture = r.default_posture
  if (Array.isArray(r.never_5)) out.never_5 = r.never_5.map((v) => String(v))
  if (typeof r.escape_hatch === "string") out.escape_hatch = r.escape_hatch
  if (r.tone_flavors && typeof r.tone_flavors === "object") {
    const m: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.tone_flavors as Record<string, unknown>)) {
      if (typeof v === "string") m[k] = v
    }
    out.tone_flavors = m
  }
  if (Array.isArray(r.human_tells)) out.human_tells = r.human_tells.map((v) => String(v))
  if (r.vocab && typeof r.vocab === "object") {
    const v = r.vocab as Record<string, unknown>
    out.vocab = {
      allowed: Array.isArray(v.allowed) ? v.allowed.map((x) => String(x)) : [],
      banned: Array.isArray(v.banned) ? v.banned.map((x) => String(x)) : [],
    }
  }
  if (r.playbooks && typeof r.playbooks === "object") {
    const m: Record<string, PlaybookSpec> = {}
    for (const [name, spec] of Object.entries(r.playbooks as Record<string, unknown>)) {
      if (!spec || typeof spec !== "object") continue
      const s = spec as Record<string, unknown>
      m[name] = {
        name: typeof s.name === "string" ? s.name : name,
        trigger: typeof s.trigger === "string" ? s.trigger : "",
        steps: Array.isArray(s.steps) ? (s.steps as unknown[]).map((v) => String(v)) : [],
        exitCondition: typeof s.exitCondition === "string" ? s.exitCondition : "",
      }
    }
    out.playbooks = m
  }
  return out
}

function fromSnap(slug: string, raw: Record<string, unknown>): HandbookDoc {
  return {
    slug: typeof raw.slug === "string" ? raw.slug : slug,
    version: typeof raw.version === "number" ? raw.version : 0,
    sections: ensureSections(raw.sections),
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : "",
    updatedAt: tsToIso(raw.updatedAt),
    reason: typeof raw.reason === "string" ? raw.reason : "",
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadHandbook(slug: string = DEFAULT_HANDBOOK_SLUG): Promise<HandbookDoc | null> {
  const snap = await getDoc(doc(db(), HANDBOOKS_COLLECTION, slug))
  if (!snap.exists()) return null
  return fromSnap(slug, snap.data() as Record<string, unknown>)
}

export async function listVersions(
  slug: string = DEFAULT_HANDBOOK_SLUG,
  max = 20
): Promise<HandbookDoc[]> {
  const snap = await getDocs(
    query(
      collection(db(), HANDBOOKS_COLLECTION, slug, HANDBOOK_VERSIONS_SUBCOLLECTION),
      orderBy("version", "desc"),
      limit(max)
    )
  )
  return snap.docs.map((d) => fromSnap(slug, d.data() as Record<string, unknown>))
}

export async function getVersion(slug: string, version: number): Promise<HandbookDoc | null> {
  const snap = await getDoc(
    doc(db(), HANDBOOKS_COLLECTION, slug, HANDBOOK_VERSIONS_SUBCOLLECTION, String(version))
  )
  if (!snap.exists()) return null
  return fromSnap(slug, snap.data() as Record<string, unknown>)
}

export async function listHandbookAudit(
  slug: string = DEFAULT_HANDBOOK_SLUG,
  max = 20
): Promise<HandbookAuditEvent[]> {
  const snap = await getDocs(
    query(
      collection(db(), PA_COLLECTIONS.auditEvents),
      orderBy("ts", "desc"),
      limit(max * 4)
    )
  )
  const out: HandbookAuditEvent[] = []
  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>
    const action = (raw.action as string) ?? ""
    if (!action.startsWith(HANDBOOK_AUDIT_PREFIX)) continue
    if ((raw.key as string) !== slug) continue
    out.push({
      id: d.id,
      actor: (raw.actor as string) ?? "unknown",
      action: action as HandbookAuditAction,
      key: (raw.key as string) ?? slug,
      reason: (raw.reason as string) ?? "",
      ts: tsToIso(raw.ts),
      oldValue: raw.oldValue ?? null,
      newValue: raw.newValue ?? null,
      revertedToVersion: typeof raw.revertedToVersion === "number"
        ? raw.revertedToVersion
        : undefined,
    })
    if (out.length >= max) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type SaveHandbookInput = {
  slug?: string
  sections: HandbookSections
  reason: string
  /**
   * Optimistic concurrency check. If supplied and current pointer doc has a
   * different version, the function throws — caller surfaces "stale, refresh".
   */
  expectedVersion?: number | null
}

/**
 * Write a new handbook version: writes pointer doc + immutable
 * `versions/{v+1}` snapshot + audit row in a single batch.
 *
 * NOTE: The browser firebase-js SDK does not support arbitrary `runTransaction`
 * with sub-collection writes the same way the server SDK does, but
 * `writeBatch` is sufficient because we read the pointer first; if the
 * `expectedVersion` check fails we abort before the batch commits. The race
 * window is narrow (read-then-batch); acceptable for an admin tool with a
 * single concurrent operator.
 */
export async function saveHandbook(input: SaveHandbookInput): Promise<HandbookDoc> {
  const slug = input.slug ?? DEFAULT_HANDBOOK_SLUG
  if (!input.reason.trim()) {
    throw new Error("Reason is required (audit log)")
  }
  const actor = currentActor()
  const sections = ensureSections(input.sections)
  const handbookRef = doc(db(), HANDBOOKS_COLLECTION, slug)
  const existing = await getDoc(handbookRef)
  const prev = existing.exists()
    ? fromSnap(slug, existing.data() as Record<string, unknown>)
    : null
  if (
    typeof input.expectedVersion === "number" &&
    prev &&
    prev.version !== input.expectedVersion
  ) {
    throw new Error(
      `stale version (expected ${input.expectedVersion}, live ${prev.version}). Refresh and retry.`
    )
  }
  const nextVersion = (prev?.version ?? 0) + 1
  const snapshot = {
    slug,
    version: nextVersion,
    sections,
    updatedBy: actor,
    reason: input.reason.trim(),
  }
  const batch = writeBatch(db())
  batch.set(handbookRef, { ...snapshot, updatedAt: serverTimestamp() })
  const versionRef = doc(
    db(),
    HANDBOOKS_COLLECTION,
    slug,
    HANDBOOK_VERSIONS_SUBCOLLECTION,
    String(nextVersion)
  )
  batch.set(versionRef, { ...snapshot, updatedAt: serverTimestamp() })
  const auditRef = doc(collection(db(), PA_COLLECTIONS.auditEvents))
  batch.set(auditRef, {
    actor,
    action: prev ? "handbook.update" : "handbook.create",
    key: slug,
    oldValue: prev ? { version: prev.version, sections: prev.sections } : null,
    newValue: { version: nextVersion, sections },
    reason: input.reason.trim(),
    ts: serverTimestamp(),
  })
  await batch.commit()
  return {
    ...snapshot,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Revert pointer doc to `versions/{targetVersion}` sections. Writes a NEW
 * version (`prev + 1`) carrying the target sections + reason "revert to v{N}: ...".
 */
export async function revertHandbook(
  slug: string,
  targetVersion: number,
  reason: string
): Promise<HandbookDoc> {
  const target = await getVersion(slug, targetVersion)
  if (!target) {
    throw new Error(`No version ${targetVersion} found for ${slug}`)
  }
  const actor = currentActor()
  const handbookRef = doc(db(), HANDBOOKS_COLLECTION, slug)
  const existing = await getDoc(handbookRef)
  const prev = existing.exists()
    ? fromSnap(slug, existing.data() as Record<string, unknown>)
    : null
  if (!prev) {
    throw new Error(`pointer doc for ${slug} missing — cannot revert`)
  }
  const nextVersion = prev.version + 1
  const auditReason = `revert to v${targetVersion}: ${reason.trim()}`.trim()
  const snapshot = {
    slug,
    version: nextVersion,
    sections: target.sections,
    updatedBy: actor,
    reason: auditReason,
  }
  const batch = writeBatch(db())
  batch.set(handbookRef, { ...snapshot, updatedAt: serverTimestamp() })
  const versionRef = doc(
    db(),
    HANDBOOKS_COLLECTION,
    slug,
    HANDBOOK_VERSIONS_SUBCOLLECTION,
    String(nextVersion)
  )
  batch.set(versionRef, { ...snapshot, updatedAt: serverTimestamp() })
  const auditRef = doc(collection(db(), PA_COLLECTIONS.auditEvents))
  batch.set(auditRef, {
    actor,
    action: "handbook.revert",
    key: slug,
    oldValue: { version: prev.version, sections: prev.sections },
    newValue: { version: nextVersion, sections: target.sections },
    reason: auditReason,
    ts: serverTimestamp(),
    revertedToVersion: targetVersion,
  })
  await batch.commit()
  return { ...snapshot, updatedAt: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// Section-level diff helper (used by VersionDiff component).
// Returns a flat list of {key, kind, before, after} suitable for table render.
// ---------------------------------------------------------------------------

export type SectionDiffRow = {
  key: HandbookSectionKey
  changed: boolean
  beforeText: string
  afterText: string
}

function sectionToString(key: HandbookSectionKey, sections: HandbookSections): string {
  switch (key) {
    case "identity":
      return sections.identity ?? ""
    case "hard_rules":
      return (sections.hard_rules ?? []).join("\n")
    case "default_posture":
      return sections.default_posture ?? ""
    case "never_5":
      return (sections.never_5 ?? []).join("\n")
    case "escape_hatch":
      return sections.escape_hatch ?? ""
    case "vocab":
      return JSON.stringify(sections.vocab ?? { allowed: [], banned: [] }, null, 2)
    case "human_tells":
      return (sections.human_tells ?? []).join("\n")
    case "tone_flavors":
      return JSON.stringify(sections.tone_flavors ?? {}, null, 2)
    case "playbooks":
      return JSON.stringify(sections.playbooks ?? {}, null, 2)
  }
}

export function diffSections(
  before: HandbookSections,
  after: HandbookSections
): SectionDiffRow[] {
  const rows: SectionDiffRow[] = []
  for (const key of HANDBOOK_RENDER_ORDER) {
    const b = sectionToString(key, before)
    const a = sectionToString(key, after)
    rows.push({ key, beforeText: b, afterText: a, changed: b !== a })
  }
  return rows
}
