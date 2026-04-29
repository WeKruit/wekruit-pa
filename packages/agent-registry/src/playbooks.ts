/**
 * Phase 32 Wave 3 — Playbooks Firestore CRUD.
 *
 * Replaces the inline `HEADHUNTER_TRIGGER_RE` constant + addendum string in
 * `packages/pa-orchestrator/src/index.ts` with a Firestore-backed,
 * dashboard-editable collection. Each playbook doc lives at
 * `pa-playbooks/{playbookKey}` and stores:
 *
 *   {
 *     playbookKey:    string  // doc id, kebab-case
 *     name:           string  // human label
 *     description:    string  // what triggers it / what it does
 *     regexTriggers:  string[]// regex source strings (compiled at runtime)
 *     addendum:       string  // markdown body, injected into systemPrompt
 *     enabled:        boolean // disabled playbooks never match
 *     version:        number
 *     updatedAt:      string ISO
 *     updatedBy:      string
 *     reason:         string  // audit reason
 *   }
 *
 * Audit rows go to `pa-audit-events` (the same collection feature flags +
 * handbook use). The orchestrator reads playbooks via a 30s in-memory cache
 * (see `packages/pa-orchestrator/src/playbook-cache.ts`).
 */
import type { Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import { PA_COLLECTIONS } from "@pa/core-types"

export const PLAYBOOKS_COLLECTION = "pa-playbooks"
export const PLAYBOOK_AUDIT_PREFIX = "playbook"

export const PlaybookSchema = z.object({
  playbookKey: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  regexTriggers: z.array(z.string()).default([]),
  addendum: z.string().default(""),
  enabled: z.boolean().default(true),
  version: z.number().int().nonnegative().default(0),
  updatedAt: z.string().nullable().default(null),
  updatedBy: z.string().default(""),
  reason: z.string().default(""),
})

export type Playbook = z.infer<typeof PlaybookSchema>

export type SavePlaybookInput = {
  name?: string
  description?: string
  regexTriggers?: string[]
  addendum?: string
  enabled?: boolean
}

export type SavePlaybookOpts = {
  actor?: string
  reason: string
}

function nowIso() {
  return new Date().toISOString()
}

function toIso(value: unknown): string | null {
  if (!value) return null
  if (typeof value === "string") return value
  if (typeof value === "object" && value && "toDate" in (value as Record<string, unknown>)) {
    try {
      const d = (value as { toDate: () => Date }).toDate()
      return d.toISOString()
    } catch {
      return null
    }
  }
  if (typeof value === "object" && value && "seconds" in (value as Record<string, unknown>)) {
    const s = Number((value as { seconds: unknown }).seconds)
    if (Number.isFinite(s)) return new Date(s * 1000).toISOString()
  }
  return null
}

function fromSnap(id: string, raw: Record<string, unknown>): Playbook {
  return {
    playbookKey: (raw.playbookKey as string) ?? id,
    name: (raw.name as string) ?? id,
    description: (raw.description as string) ?? "",
    regexTriggers: Array.isArray(raw.regexTriggers)
      ? (raw.regexTriggers as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    addendum: (raw.addendum as string) ?? "",
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    version: typeof raw.version === "number" ? raw.version : 0,
    updatedAt: toIso(raw.updatedAt),
    updatedBy: (raw.updatedBy as string) ?? "",
    reason: (raw.reason as string) ?? "",
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPlaybook(
  db: Firestore,
  playbookKey: string
): Promise<Playbook | null> {
  const snap = await db.collection(PLAYBOOKS_COLLECTION).doc(playbookKey).get()
  if (!snap.exists) return null
  return fromSnap(playbookKey, (snap.data() as Record<string, unknown>) ?? {})
}

export async function listPlaybooks(db: Firestore): Promise<Playbook[]> {
  const snap = await db.collection(PLAYBOOKS_COLLECTION).get()
  const rows = snap.docs.map((d) => fromSnap(d.id, d.data() as Record<string, unknown>))
  rows.sort((a, b) => a.playbookKey.localeCompare(b.playbookKey))
  return rows
}

// ---------------------------------------------------------------------------
// Writes (always batched: playbook doc + audit row)
// ---------------------------------------------------------------------------

export async function upsertPlaybook(
  db: Firestore,
  playbookKey: string,
  fields: SavePlaybookInput,
  opts: SavePlaybookOpts
): Promise<Playbook> {
  if (!opts.reason || !opts.reason.trim()) {
    throw new Error("upsertPlaybook: reason is required (audit log)")
  }
  const actor = opts.actor ?? "unknown"
  const prev = await getPlaybook(db, playbookKey)
  const nextVersion = (prev?.version ?? 0) + 1
  const merged: Playbook = {
    playbookKey,
    name: fields.name ?? prev?.name ?? playbookKey,
    description: fields.description ?? prev?.description ?? "",
    regexTriggers: fields.regexTriggers ?? prev?.regexTriggers ?? [],
    addendum: fields.addendum ?? prev?.addendum ?? "",
    enabled: fields.enabled ?? prev?.enabled ?? true,
    version: nextVersion,
    updatedAt: nowIso(),
    updatedBy: actor,
    reason: opts.reason.trim(),
  }
  // Validate via Zod before write — surfaces schema drift loudly.
  PlaybookSchema.parse(merged)

  const playbookRef = db.collection(PLAYBOOKS_COLLECTION).doc(playbookKey)
  const auditRef = db.collection(PA_COLLECTIONS.auditEvents).doc()

  type BatchLike = {
    set: (
      ref: { id: string },
      data: Record<string, unknown>,
      opts?: { merge?: boolean }
    ) => BatchLike
    commit: () => Promise<unknown>
  }
  const dbWithBatch = db as unknown as { batch?: () => BatchLike }
  const payload = {
    playbookKey,
    name: merged.name,
    description: merged.description,
    regexTriggers: merged.regexTriggers,
    addendum: merged.addendum,
    enabled: merged.enabled,
    version: nextVersion,
    updatedAt: merged.updatedAt,
    updatedBy: actor,
    reason: merged.reason,
  }
  const auditPayload = {
    actor,
    action: prev ? `${PLAYBOOK_AUDIT_PREFIX}.update` : `${PLAYBOOK_AUDIT_PREFIX}.create`,
    key: playbookKey,
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
    reason: merged.reason,
    ts: merged.updatedAt,
  }
  if (typeof dbWithBatch.batch === "function") {
    const batch = dbWithBatch.batch()
    batch.set(playbookRef as unknown as { id: string }, payload, { merge: true })
    batch.set(auditRef as unknown as { id: string }, auditPayload)
    await batch.commit()
  } else {
    await playbookRef.set(payload, { merge: true })
    await auditRef.set(auditPayload)
  }
  return merged
}

export async function revertPlaybook(
  db: Firestore,
  playbookKey: string,
  opts: { actor?: string; reason?: string } = {}
): Promise<Playbook> {
  const actor = opts.actor ?? "unknown"
  const reason = (opts.reason ?? `revert ${playbookKey}`).trim()

  const auditQuery = db
    .collection(PA_COLLECTIONS.auditEvents)
    .where("key", "==", playbookKey)
    .orderBy("ts", "desc")
    .limit(20)
  const auditSnap = await auditQuery.get()
  const events = auditSnap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Record<string, unknown>),
  })) as Array<{
    id: string
    action?: string
    oldValue?: {
      name?: string
      description?: string
      regexTriggers?: string[]
      addendum?: string
      enabled?: boolean
    } | null
  }>
  const target = events.find(
    (e) =>
      typeof e.action === "string" &&
      e.action.startsWith(PLAYBOOK_AUDIT_PREFIX) &&
      e.action !== `${PLAYBOOK_AUDIT_PREFIX}.revert`
  )
  if (!target) {
    throw new Error(`No prior playbook audit event for ${playbookKey} — nothing to revert.`)
  }
  if (!target.oldValue) {
    throw new Error(`Audit event ${target.id} has no oldValue — cannot revert.`)
  }

  return upsertPlaybook(
    db,
    playbookKey,
    {
      name: target.oldValue.name,
      description: target.oldValue.description,
      regexTriggers: target.oldValue.regexTriggers,
      addendum: target.oldValue.addendum,
      enabled: target.oldValue.enabled,
    },
    { actor, reason: `${PLAYBOOK_AUDIT_PREFIX}.revert: ${reason}` }
  )
}

// ---------------------------------------------------------------------------
// Compose / match
// ---------------------------------------------------------------------------

/**
 * Compile a playbook's regex strings into RegExp objects, ignoring invalid
 * patterns (which would otherwise crash the orchestrator). Each pattern is
 * compiled with the `i` (case-insensitive) flag — matching the prior
 * `HEADHUNTER_TRIGGER_RE` behaviour.
 */
export function compileTriggers(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = []
  for (const p of patterns) {
    if (!p || typeof p !== "string") continue
    try {
      out.push(new RegExp(p, "i"))
    } catch {
      // Skip — admin UI does its own validation; runtime stays defensive.
    }
  }
  return out
}

/**
 * Given the raw inbound message body and a list of playbooks, return the
 * subset whose enabled triggers match. Order preserved from `playbooks`
 * input (caller controls priority by sort order).
 *
 * Disabled playbooks always return false.
 */
export function matchPlaybooks(
  messageBody: string,
  playbooks: readonly Playbook[]
): Playbook[] {
  if (!messageBody) return []
  const matched: Playbook[] = []
  for (const pb of playbooks) {
    if (!pb.enabled) continue
    if (pb.regexTriggers.length === 0) continue
    const compiled = compileTriggers(pb.regexTriggers)
    if (compiled.some((r) => r.test(messageBody))) {
      matched.push(pb)
    }
  }
  return matched
}

/**
 * Given an inbound message body, load all playbooks from Firestore and
 * return their concatenated addenda (matched, in stable order). Empty
 * string when nothing matches. Used by the orchestrator on the hot path —
 * production callers wrap this with a 30s cache (see playbook-cache.ts).
 */
export async function composePlaybooks(
  db: Firestore,
  messageBody: string
): Promise<{ matched: Playbook[]; addendum: string }> {
  const playbooks = await listPlaybooks(db)
  const matched = matchPlaybooks(messageBody, playbooks)
  const addendum = matched
    .map((p) => p.addendum)
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .join("\n\n")
  return { matched, addendum }
}

// ---------------------------------------------------------------------------
// Seed defaults
// ---------------------------------------------------------------------------

/**
 * Idempotent — seeds the default `headhunter` playbook (matching the
 * previous inline HEADHUNTER_TRIGGER_RE + addendum body) if the doc does
 * not already exist. Re-running just bumps version. Source of the addendum
 * body is the existing `packages/pa-orchestrator/src/playbooks/headhunter.ts`
 * file — kept as the canonical fallback during cutover.
 */
export const HEADHUNTER_DEFAULT_TRIGGERS: ReadonlyArray<string> = [
  "帮我",
  "想换",
  "在看工作",
  "在面",
  "简历",
  "offer",
] as const

export const HEADHUNTER_DEFAULT_ADDENDUM = `# PLAYBOOK MODE: HEADHUNTER (active)
你现在是帮朋友找工作的室友, NOT 正经猎头. 不推荐机会, 不分析, 不教.
GOAL: push 用户多说自己的感受/回忆, 不是给答案.

只用感受型探针, 一次问一个:
- 最近做的项目里你最爽的是哪段?
- 上次面试你最不爽的环节是啥?
- 你下一段想往哪边走/跑 (不是哪个 title)?
- 你那个 OOO 卡你多久了?
- 现在团队你处得最来的人是干啥的?

NEVER: "我来告诉你 X" / "我可以给你分析" / "你最需要确认的是" / 框架 / 八股 / 比 offer.
OK: "嗯 然后呢" / "卧 那段听着爽" / "诶 这个我想多听点" / 沉默式接住.

退出: 用户烦/转话题 → 立即切回 CO-VIBE, 不再 push.`

export async function seedDefaultPlaybooks(
  db: Firestore,
  opts: { actor?: string; reason?: string } = {}
): Promise<{ created: string[]; skipped: string[] }> {
  const actor = opts.actor ?? "p9-playbooks-seed@wekruit.com"
  const reason = opts.reason ?? "Phase 32 W3 seedDefaultPlaybooks — initial seed from inline regex"
  const created: string[] = []
  const skipped: string[] = []

  const existing = await getPlaybook(db, "headhunter")
  if (existing) {
    skipped.push("headhunter")
  } else {
    await upsertPlaybook(
      db,
      "headhunter",
      {
        name: "Headhunter",
        description:
          "Activates when user signals job search (regex on inbound body). Pushes Claire to ask feeling-probes instead of dispensing job advice.",
        regexTriggers: [...HEADHUNTER_DEFAULT_TRIGGERS],
        addendum: HEADHUNTER_DEFAULT_ADDENDUM,
        enabled: true,
      },
      { actor, reason }
    )
    created.push("headhunter")
  }
  return { created, skipped }
}
