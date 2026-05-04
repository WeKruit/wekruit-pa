/**
 * iter30/WS8 Wave 2 — Firestore wrapper for `pa-match-weight-tables` + audit.
 *
 * Mirrors `playbooks-api.ts` shape:
 *   - Direct Firestore client SDK reads/writes under signed-in user
 *   - All mutations batched with paired audit row in PA_COLLECTIONS.auditEvents
 *   - Optimistic ts→ISO normalization; never returns a Firestore Timestamp
 *
 * Wire format (matches BoostCalculator in `apps/job-rec/src/boost-calculator.ts`):
 *   pa-match-weight-tables/{tableKey}              — table metadata
 *   pa-match-weight-tables/{tableKey}/items/{key}  — one row per skill weight
 *
 * Every write bumps `tableRef.version` so explainer caches keyed on
 * `__v{N}` invalidate within 30s of the orchestrator's next read.
 */
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  orderBy,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "firebase/firestore"
import { auth, db } from "./firebase.js"

export const WEIGHT_TABLES_COLLECTION = "pa-match-weight-tables"
export const WEIGHT_ITEMS_SUBCOLLECTION = "items"
export const WEIGHT_AUDIT_PREFIX = "match-weight"

export type MatchWeightCategory = "core" | "supporting" | "generic"

export type MatchWeightTableMeta = {
  tableKey: string
  name: string
  description: string
  active: boolean
  defaultForRoles: string[]
  rowCount: number
  /** Bumped on any item write — used for explainer cache invalidation. */
  version: number
  updatedAt: string | null
  updatedBy: string
}

export type MatchWeightRow = {
  /** Stable doc id (e.g. "rag", "tool-calling"). */
  skillKey: string
  /** Lower-cased substring matched against required-skills + CV-skills. */
  skill: string
  skillCanonical: string | null
  weight: number
  category: MatchWeightCategory
  market: string
  updatedAt: string | null
  updatedBy: string
  reason: string
}

export type SaveMatchWeightRowInput = {
  tableKey: string
  /** Used as doc id when creating; immutable on update. */
  skillKey: string
  skill: string
  weight: number
  category: MatchWeightCategory
  reason: string
}

export type MatchWeightAuditAction =
  | "match-weight.create"
  | "match-weight.update"
  | "match-weight.delete"
  | "match-weight.seed"

type MatchWeightAuditPayload = Partial<
  Pick<MatchWeightRow, "skill" | "weight" | "category">
> & { rowCount?: number }

export type MatchWeightAuditEvent = {
  id: string
  actor: string
  action: MatchWeightAuditAction
  /** `${tableKey}/${skillKey}` for row-level events; `${tableKey}` for seed. */
  key: string
  oldValue: MatchWeightAuditPayload | null
  newValue: MatchWeightAuditPayload | null
  reason: string
  ts: string | null
}

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

function tableFromSnap(id: string, raw: Record<string, unknown>): MatchWeightTableMeta {
  return {
    tableKey: (raw.tableKey as string) ?? id,
    name: (raw.name as string) ?? id,
    description: (raw.description as string) ?? "",
    active: raw.active === undefined ? true : Boolean(raw.active),
    defaultForRoles: Array.isArray(raw.defaultForRoles)
      ? (raw.defaultForRoles as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    rowCount: typeof raw.rowCount === "number" ? raw.rowCount : 0,
    version: typeof raw.version === "number" ? raw.version : 1,
    updatedAt: tsToIso(raw.updatedAt),
    updatedBy: (raw.updatedBy as string) ?? "",
  }
}

function rowFromSnap(id: string, raw: Record<string, unknown>): MatchWeightRow {
  const cat = raw.category
  const category: MatchWeightCategory =
    cat === "core" || cat === "supporting" || cat === "generic" ? cat : "supporting"
  return {
    skillKey: id,
    skill: (raw.skill as string) ?? id,
    skillCanonical: typeof raw.skillCanonical === "string" ? raw.skillCanonical : null,
    weight: typeof raw.weight === "number" ? raw.weight : 1.0,
    category,
    market: (raw.market as string) ?? "",
    updatedAt: tsToIso(raw.updatedAt),
    updatedBy: (raw.updatedBy as string) ?? "",
    reason: (raw.reason as string) ?? "",
  }
}

function skillToKey(skill: string): string {
  return skill.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]+/g, "")
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listWeightTables(): Promise<MatchWeightTableMeta[]> {
  const snap = await getDocs(collection(db(), WEIGHT_TABLES_COLLECTION))
  const rows = snap.docs.map((d) =>
    tableFromSnap(d.id, d.data() as Record<string, unknown>)
  )
  rows.sort((a, b) => a.tableKey.localeCompare(b.tableKey))
  return rows
}

export async function getWeightTable(
  tableKey: string
): Promise<MatchWeightTableMeta | null> {
  const ref = doc(db(), WEIGHT_TABLES_COLLECTION, tableKey)
  const snap = await getDoc(ref)
  if (!snap.exists()) return null
  return tableFromSnap(snap.id, snap.data() as Record<string, unknown>)
}

export async function listRows(tableKey: string): Promise<MatchWeightRow[]> {
  const snap = await getDocs(
    collection(db(), WEIGHT_TABLES_COLLECTION, tableKey, WEIGHT_ITEMS_SUBCOLLECTION)
  )
  const rows = snap.docs.map((d) => rowFromSnap(d.id, d.data() as Record<string, unknown>))
  // Default sort: weight desc within category, core > supporting > generic
  const catRank: Record<MatchWeightCategory, number> = {
    core: 0,
    supporting: 1,
    generic: 2,
  }
  rows.sort((a, b) => {
    if (catRank[a.category] !== catRank[b.category]) {
      return catRank[a.category] - catRank[b.category]
    }
    if (a.weight !== b.weight) return b.weight - a.weight
    return a.skill.localeCompare(b.skill)
  })
  return rows
}

export async function listAuditForTable(
  tableKey: string,
  max = 50
): Promise<MatchWeightAuditEvent[]> {
  // Audit keys: `${tableKey}/${skillKey}` and `${tableKey}` (seed). We grab
  // all that startWith `${tableKey}` via two precise queries to keep the
  // index requirement minimal.
  const events = new Map<string, MatchWeightAuditEvent>()

  for (const exactKey of [tableKey]) {
    const snap = await getDocs(
      query(
        collection(db(), PA_COLLECTIONS.auditEvents),
        where("key", "==", exactKey),
        orderBy("ts", "desc"),
        limit(max)
      )
    )
    for (const d of snap.docs) {
      const raw = d.data() as Record<string, unknown>
      const action = (raw.action as string) ?? ""
      if (!action.startsWith(WEIGHT_AUDIT_PREFIX)) continue
      events.set(d.id, {
        id: d.id,
        actor: (raw.actor as string) ?? "unknown",
        action: action as MatchWeightAuditAction,
        key: (raw.key as string) ?? exactKey,
        oldValue: (raw.oldValue as MatchWeightAuditPayload | null) ?? null,
        newValue: (raw.newValue as MatchWeightAuditPayload | null) ?? null,
        reason: (raw.reason as string) ?? "",
        ts: tsToIso(raw.ts),
      })
    }
  }

  // Row-level events use composite key `${tableKey}/${skillKey}`. We use
  // a range scan via array-contains-any-style trick; simplest is a `where >=`
  // pair, but that needs an index. Instead, rely on per-row callers using
  // `listAuditForRow` for drill-in. This top-level pull stays intentionally
  // light to keep the demo fast.
  return [...events.values()].sort((a, b) =>
    (b.ts ?? "").localeCompare(a.ts ?? "")
  )
}

export async function listAuditForRow(
  tableKey: string,
  skillKey: string,
  max = 20
): Promise<MatchWeightAuditEvent[]> {
  const compositeKey = `${tableKey}/${skillKey}`
  const snap = await getDocs(
    query(
      collection(db(), PA_COLLECTIONS.auditEvents),
      where("key", "==", compositeKey),
      orderBy("ts", "desc"),
      limit(max)
    )
  )
  return snap.docs
    .map((d) => {
      const raw = d.data() as Record<string, unknown>
      const action = (raw.action as string) ?? ""
      if (!action.startsWith(WEIGHT_AUDIT_PREFIX)) return null
      return {
        id: d.id,
        actor: (raw.actor as string) ?? "unknown",
        action: action as MatchWeightAuditAction,
        key: (raw.key as string) ?? compositeKey,
        oldValue: (raw.oldValue as MatchWeightAuditPayload | null) ?? null,
        newValue: (raw.newValue as MatchWeightAuditPayload | null) ?? null,
        reason: (raw.reason as string) ?? "",
        ts: tsToIso(raw.ts),
      }
    })
    .filter((e): e is MatchWeightAuditEvent => e !== null)
}

// ---------------------------------------------------------------------------
// Writes — always batched (row + audit + table.version bump)
// ---------------------------------------------------------------------------

export async function saveRow(input: SaveMatchWeightRowInput): Promise<void> {
  if (!input.reason.trim()) {
    throw new Error("Reason is required (audit log)")
  }
  if (!input.skill.trim()) {
    throw new Error("Skill is required")
  }
  if (
    !Number.isFinite(input.weight) ||
    input.weight < 0 ||
    input.weight > 5
  ) {
    throw new Error("Weight must be between 0 and 5")
  }

  const actor = currentActor()
  const skillKey = input.skillKey || skillToKey(input.skill)
  if (!skillKey) throw new Error("Could not derive skillKey from skill")

  const tableRef = doc(db(), WEIGHT_TABLES_COLLECTION, input.tableKey)
  const itemRef = doc(
    db(),
    WEIGHT_TABLES_COLLECTION,
    input.tableKey,
    WEIGHT_ITEMS_SUBCOLLECTION,
    skillKey
  )
  const existing = await getDoc(itemRef)
  const prev = existing.exists()
    ? rowFromSnap(existing.id, existing.data() as Record<string, unknown>)
    : null

  const batch = writeBatch(db())
  batch.set(
    itemRef,
    {
      skill: input.skill.trim(),
      skillCanonical: prev?.skillCanonical ?? null,
      weight: input.weight,
      category: input.category,
      market: input.tableKey,
      updatedAt: serverTimestamp(),
      updatedBy: actor,
      reason: input.reason.trim(),
    },
    { merge: true }
  )

  // Bump table version so explainer cache invalidates downstream.
  batch.set(
    tableRef,
    {
      version: increment(1),
      updatedAt: serverTimestamp(),
      updatedBy: actor,
      ...(prev ? {} : { rowCount: increment(1) }),
    },
    { merge: true }
  )

  const auditRef = doc(collection(db(), PA_COLLECTIONS.auditEvents))
  batch.set(auditRef, {
    actor,
    action: prev ? "match-weight.update" : "match-weight.create",
    key: `${input.tableKey}/${skillKey}`,
    oldValue: prev
      ? { skill: prev.skill, weight: prev.weight, category: prev.category }
      : null,
    newValue: {
      skill: input.skill.trim(),
      weight: input.weight,
      category: input.category,
    },
    reason: input.reason.trim(),
    ts: serverTimestamp(),
  })

  await batch.commit()
}

export async function deleteRow(
  tableKey: string,
  skillKey: string,
  reason: string
): Promise<void> {
  if (!reason.trim()) throw new Error("Reason is required (audit log)")

  const actor = currentActor()
  const tableRef = doc(db(), WEIGHT_TABLES_COLLECTION, tableKey)
  const itemRef = doc(
    db(),
    WEIGHT_TABLES_COLLECTION,
    tableKey,
    WEIGHT_ITEMS_SUBCOLLECTION,
    skillKey
  )
  const existing = await getDoc(itemRef)
  if (!existing.exists()) {
    throw new Error(`Row ${skillKey} not found in ${tableKey}`)
  }
  const prev = rowFromSnap(existing.id, existing.data() as Record<string, unknown>)

  const batch = writeBatch(db())
  batch.delete(itemRef)
  batch.set(
    tableRef,
    {
      version: increment(1),
      rowCount: increment(-1),
      updatedAt: serverTimestamp(),
      updatedBy: actor,
    },
    { merge: true }
  )
  const auditRef = doc(collection(db(), PA_COLLECTIONS.auditEvents))
  batch.set(auditRef, {
    actor,
    action: "match-weight.delete",
    key: `${tableKey}/${skillKey}`,
    oldValue: { skill: prev.skill, weight: prev.weight, category: prev.category },
    newValue: null,
    reason: reason.trim(),
    ts: serverTimestamp(),
  })

  await batch.commit()
}

/**
 * Pure browser-side implementation of computeWeightedMatchScore — mirrors
 * `apps/job-rec/src/match-weights.ts:142-164` byte-for-byte. Used by
 * `/match/weights/test` for 0-latency dry-run feedback.
 */
export type DryRunResult = {
  jobId: string
  baseScore: number
  boostMult: number
  finalScore: number
  matched: Array<{ skill: string; weight: number; category: MatchWeightCategory }>
  coreMissing: Array<{ skill: string; weight: number; category: MatchWeightCategory }>
}

const BOOST_STRONG = 1.2
const BOOST_LEAN = 1.05
const BOOST_WEAK = 0.85
const BOOST_NEUTRAL = 1.0

function lower(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase().trim() : ""
}

function userHas(userSkills: readonly string[], weightSkill: string): boolean {
  const ws = weightSkill.toLowerCase()
  for (const us of userSkills) {
    const u = lower(us)
    if (!u) continue
    if (u === ws) return true
    if (u.includes(ws)) return true
    if (ws.includes(u) && u.length >= 3) return true
  }
  return false
}

export function dryRunBoost(
  cvSkills: string[],
  jobs: Array<{ id: string; requiredSkills: string[] }>,
  rows: MatchWeightRow[]
): DryRunResult[] {
  return jobs.map((j) => {
    const matched: DryRunResult["matched"] = []
    const coreMissing: DryRunResult["coreMissing"] = []
    let matchedSum = 0
    let applicableSum = 0
    for (const r of rows) {
      if (!userHas(j.requiredSkills, r.skill)) continue
      applicableSum += r.weight
      if (userHas(cvSkills, r.skill)) {
        matched.push({ skill: r.skill, weight: r.weight, category: r.category })
        matchedSum += r.weight
      } else if (r.category === "core") {
        coreMissing.push({ skill: r.skill, weight: r.weight, category: r.category })
      }
    }
    const score = applicableSum > 0 ? matchedSum / applicableSum : 1.0
    let mult = BOOST_NEUTRAL
    if (matched.length > 0 || coreMissing.length > 0) {
      if (score >= 0.66) mult = BOOST_STRONG
      else if (score >= 0.33) mult = BOOST_LEAN
      else mult = BOOST_WEAK
    }
    return {
      jobId: j.id,
      baseScore: 1.0,
      boostMult: mult,
      finalScore: 1.0 * mult,
      matched,
      coreMissing,
    }
  })
}
