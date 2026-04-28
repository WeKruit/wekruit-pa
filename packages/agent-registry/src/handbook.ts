/**
 * Phase 29 — Agent Handbook (Bible-as-data).
 *
 * Stores the Bible as a structured collection of sections in Firestore
 * (`pa-handbook-sections/{sectionKey}`) instead of a single inline
 * `systemPrompt` string on the agent doc. Sections are composed at
 * runtime by the orchestrator into the same shape Voice v1 expects.
 *
 * Schema (`pa-handbook-sections/{sectionKey}`):
 *   {
 *     sectionKey:  string  // doc id, kebab-case
 *     title:       string  // human header (matches `# IDENTITY` style)
 *     body:        string  // markdown body (no leading `# title`)
 *     order:       number  // compose order, ascending
 *     version:     number  // monotonic, incremented per save
 *     enabled:     boolean // disabled sections excluded from compose
 *     updatedAt:   string  // ISO
 *     updatedBy:   string  // actor email / id
 *     reason:      string  // audit reason
 *   }
 *
 * Audit rows are written to `pa-audit-events` with the same shape used
 * by Phase 24.5 feature flags so the dashboard's audit/revert pattern
 * carries over directly.
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

export const HANDBOOK_SECTIONS_COLLECTION = "pa-handbook-sections"

export const HANDBOOK_AUDIT_PREFIX = "handbook"

/**
 * Canonical compose order for Bible v7.0 sections. The migration writes
 * these in the same sequence they appear in the live systemPrompt so
 * runtime composition is byte-identical to the inline string.
 */
export const HANDBOOK_DEFAULT_ORDER: ReadonlyArray<{
  sectionKey: string
  title: string
}> = [
  { sectionKey: "identity", title: "IDENTITY" },
  { sectionKey: "one-rule", title: "THE ONE RULE (every turn, no exceptions)" },
  { sectionKey: "default-posture", title: "DEFAULT POSTURE (apply before any turn-mode flavor)" },
  { sectionKey: "nevers", title: "5 NEVERs (global, override everything else)" },
  { sectionKey: "escape-hatch", title: "ESCAPE HATCH — only one" },
  { sectionKey: "tone-flavors", title: "TONE FLAVORS (color, not new rulesets — base = THE ONE RULE)" },
  { sectionKey: "human-tells", title: "HUMAN TELLS (sparingly, ≤ 1 per turn — stacking = AI fishing)" },
  { sectionKey: "code-switch", title: "CODE-SWITCH + EMOJI" },
  { sectionKey: "vocab", title: "VOCAB (use, never name back)" },
  { sectionKey: "roommate", title: "ROOMMATE" },
] as const

export type HandbookSection = {
  sectionKey: string
  title: string
  body: string
  order: number
  version: number
  enabled: boolean
  updatedAt: string | null
  updatedBy: string
  reason: string
}

export type SaveSectionInput = {
  title?: string
  body?: string
  order?: number
  enabled?: boolean
}

export type SaveSectionOpts = {
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

function fromSnap(id: string, raw: Record<string, unknown>): HandbookSection {
  return {
    sectionKey: (raw.sectionKey as string) ?? id,
    title: (raw.title as string) ?? id,
    body: (raw.body as string) ?? "",
    order: typeof raw.order === "number" ? raw.order : 0,
    version: typeof raw.version === "number" ? raw.version : 0,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    updatedAt: toIso(raw.updatedAt),
    updatedBy: (raw.updatedBy as string) ?? "",
    reason: (raw.reason as string) ?? "",
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadHandbook(db: Firestore): Promise<HandbookSection[]> {
  const snap = await db.collection(HANDBOOK_SECTIONS_COLLECTION).get()
  const rows = snap.docs.map((d) => fromSnap(d.id, d.data() as Record<string, unknown>))
  rows.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    return a.sectionKey.localeCompare(b.sectionKey)
  })
  return rows
}

/**
 * Compose enabled sections in `order` ascending into the canonical
 * single-string systemPrompt. Disabled sections excluded entirely.
 *
 * Output format mirrors the original Bible v7.0 layout:
 *   `# {TITLE}\n{body}\n\n# {NEXT_TITLE}\n{body}\n\n…`
 */
export function composeSystemPrompt(sections: HandbookSection[]): string {
  const ordered = [...sections]
    .filter((s) => s.enabled)
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order
      return a.sectionKey.localeCompare(b.sectionKey)
    })
  const parts: string[] = []
  for (const s of ordered) {
    const title = s.title.trim()
    const body = s.body.replace(/^\n+/, "").replace(/\n+$/, "")
    if (!title && !body) continue
    parts.push(title ? `# ${title}\n${body}` : body)
  }
  return parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// Writes (always batched: section doc + audit row)
// ---------------------------------------------------------------------------

async function readSection(
  db: Firestore,
  sectionKey: string
): Promise<HandbookSection | null> {
  const snap = await db.collection(HANDBOOK_SECTIONS_COLLECTION).doc(sectionKey).get()
  if (!snap.exists) return null
  return fromSnap(sectionKey, (snap.data() as Record<string, unknown>) ?? {})
}

export async function saveSection(
  db: Firestore,
  sectionKey: string,
  fields: SaveSectionInput,
  opts: SaveSectionOpts
): Promise<HandbookSection> {
  if (!opts.reason || !opts.reason.trim()) {
    throw new Error("saveSection: reason is required (audit log)")
  }
  const actor = opts.actor ?? "unknown"
  const prev = await readSection(db, sectionKey)
  const nextVersion = (prev?.version ?? 0) + 1
  const merged: HandbookSection = {
    sectionKey,
    title: fields.title ?? prev?.title ?? sectionKey,
    body: fields.body ?? prev?.body ?? "",
    order: fields.order ?? prev?.order ?? 0,
    enabled: fields.enabled ?? prev?.enabled ?? true,
    version: nextVersion,
    updatedAt: nowIso(),
    updatedBy: actor,
    reason: opts.reason.trim(),
  }

  const sectionRef = db.collection(HANDBOOK_SECTIONS_COLLECTION).doc(sectionKey)
  const auditRef = db.collection(PA_COLLECTIONS.auditEvents).doc()

  // Use a batch when the underlying Firestore supports it; otherwise
  // fall back to two sequential writes (test fakes).
  type BatchLike = {
    set: (
      ref: { id: string },
      data: Record<string, unknown>,
      opts?: { merge?: boolean }
    ) => BatchLike
    commit: () => Promise<unknown>
  }
  const dbWithBatch = db as unknown as { batch?: () => BatchLike }
  if (typeof dbWithBatch.batch === "function") {
    const batch = dbWithBatch.batch()
    batch.set(
      sectionRef as unknown as { id: string },
      {
        sectionKey,
        title: merged.title,
        body: merged.body,
        order: merged.order,
        enabled: merged.enabled,
        version: nextVersion,
        updatedAt: merged.updatedAt,
        updatedBy: actor,
        reason: merged.reason,
      },
      { merge: true }
    )
    batch.set(auditRef as unknown as { id: string }, {
      actor,
      action: prev ? `${HANDBOOK_AUDIT_PREFIX}.update` : `${HANDBOOK_AUDIT_PREFIX}.create`,
      key: sectionKey,
      oldValue: prev ? { body: prev.body, enabled: prev.enabled, order: prev.order, title: prev.title } : null,
      newValue: { body: merged.body, enabled: merged.enabled, order: merged.order, title: merged.title },
      reason: merged.reason,
      ts: merged.updatedAt,
    })
    await batch.commit()
  } else {
    await sectionRef.set(
      {
        sectionKey,
        title: merged.title,
        body: merged.body,
        order: merged.order,
        enabled: merged.enabled,
        version: nextVersion,
        updatedAt: merged.updatedAt,
        updatedBy: actor,
        reason: merged.reason,
      },
      { merge: true }
    )
    await auditRef.set({
      actor,
      action: prev ? `${HANDBOOK_AUDIT_PREFIX}.update` : `${HANDBOOK_AUDIT_PREFIX}.create`,
      key: sectionKey,
      oldValue: prev ? { body: prev.body, enabled: prev.enabled, order: prev.order, title: prev.title } : null,
      newValue: { body: merged.body, enabled: merged.enabled, order: merged.order, title: merged.title },
      reason: merged.reason,
      ts: merged.updatedAt,
    })
  }

  return merged
}

/**
 * Mirrors Phase 24.5 flag revert: read the most recent non-revert audit
 * row for this sectionKey, restore its `oldValue.body` (and other fields
 * if present), record a `handbook.revert` audit event.
 */
export async function revertSection(
  db: Firestore,
  sectionKey: string,
  opts: { actor?: string; reason?: string } = {}
): Promise<HandbookSection> {
  const actor = opts.actor ?? "unknown"
  const reason = (opts.reason ?? `revert ${sectionKey}`).trim()

  const auditQuery = db
    .collection(PA_COLLECTIONS.auditEvents)
    .where("key", "==", sectionKey)
    .orderBy("ts", "desc")
    .limit(20)
  const auditSnap = await auditQuery.get()
  const events = auditSnap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Record<string, unknown>),
  })) as Array<{
    id: string
    action?: string
    oldValue?: { body?: string; enabled?: boolean; order?: number; title?: string } | null
    newValue?: { body?: string; enabled?: boolean; order?: number; title?: string } | null
  }>
  const target = events.find(
    (e) =>
      typeof e.action === "string" &&
      e.action.startsWith(HANDBOOK_AUDIT_PREFIX) &&
      e.action !== `${HANDBOOK_AUDIT_PREFIX}.revert`
  )
  if (!target) {
    throw new Error(`No prior handbook audit event for ${sectionKey} — nothing to revert.`)
  }
  if (!target.oldValue) {
    throw new Error(`Audit event ${target.id} has no oldValue — cannot revert.`)
  }

  return saveSection(
    db,
    sectionKey,
    {
      title: target.oldValue.title,
      body: target.oldValue.body,
      order: target.oldValue.order,
      enabled: target.oldValue.enabled,
    },
    { actor, reason: `${HANDBOOK_AUDIT_PREFIX}.revert: ${reason}` }
  )
}

// ---------------------------------------------------------------------------
// Migration: parse Bible v7.0 single-string systemPrompt into sections
// ---------------------------------------------------------------------------

/**
 * Parse a Bible-style `# HEADER\n…` markdown blob into ordered sections.
 *
 * Strategy: scan line-by-line. Each line that matches `^# (.+)` opens a
 * new section; intermediate lines are accumulated as the body. Subheaders
 * (`## …`) are treated as body content (not new sections). The known
 * section headers (HANDBOOK_DEFAULT_ORDER) provide the canonical
 * sectionKey mapping when titles match (case + whitespace tolerant).
 */
export function parseBibleV7(systemPrompt: string): HandbookSection[] {
  const lines = systemPrompt.replace(/\r\n/g, "\n").split("\n")
  type Draft = { title: string; bodyLines: string[]; order: number }
  const drafts: Draft[] = []
  let current: Draft | null = null
  let order = 0
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line)
    if (m) {
      if (current) drafts.push(current)
      current = { title: m[1]!.trim(), bodyLines: [], order: order++ }
      continue
    }
    if (current) {
      current.bodyLines.push(line)
    }
  }
  if (current) drafts.push(current)

  // Build sectionKey by matching against canonical defaults, falling
  // back to a slug derived from the title.
  function slug(title: string): string {
    const base = title.split(/[\s—:(–]/)[0] ?? title
    return base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  }
  function resolveKey(title: string): string {
    const norm = title.trim().toLowerCase()
    for (const d of HANDBOOK_DEFAULT_ORDER) {
      if (d.title.toLowerCase() === norm) return d.sectionKey
      // Fuzzy: match on first significant word (e.g. "IDENTITY" -> "identity").
      const firstWord = norm.split(/\s+/)[0]?.replace(/[^a-z0-9]/g, "")
      const dFirst = d.title.toLowerCase().split(/\s+/)[0]?.replace(/[^a-z0-9]/g, "")
      if (firstWord && dFirst && firstWord === dFirst) return d.sectionKey
    }
    // "5 NEVERs" -> first word "5" — special-case "nevers".
    if (/never/i.test(title)) return "nevers"
    if (/escape/i.test(title)) return "escape-hatch"
    if (/tone/i.test(title)) return "tone-flavors"
    if (/human/i.test(title)) return "human-tells"
    if (/code/i.test(title) || /emoji/i.test(title)) return "code-switch"
    if (/posture/i.test(title)) return "default-posture"
    if (/one\s*rule/i.test(title)) return "one-rule"
    return slug(title)
  }

  const out: HandbookSection[] = []
  for (const d of drafts) {
    const body = d.bodyLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "")
    out.push({
      sectionKey: resolveKey(d.title),
      title: d.title,
      body,
      order: d.order,
      version: 1,
      enabled: true,
      updatedAt: null,
      updatedBy: "",
      reason: "",
    })
  }
  return out
}

/**
 * Live migration entry point. Reads `pa-agents/default.systemPrompt`,
 * parses it via {@link parseBibleV7}, and writes each section through
 * {@link saveSection} (so audit rows + version bump happen normally).
 *
 * Idempotent: re-running just bumps versions on existing sections;
 * compose output stays identical until Adam edits.
 *
 * Returns the count of sections written.
 */
export async function migrateBibleV7(
  db: Firestore,
  opts: { agentId?: string; actor?: string; reason?: string } = {}
): Promise<{ written: number; sectionKeys: string[] }> {
  const agentId = opts.agentId ?? "default"
  const actor = opts.actor ?? "p9-handbook-migrate@wekruit.com"
  const reason = opts.reason ?? "Phase 29 migrateBibleV7 — initial seed from inline systemPrompt"

  const agentSnap = await db.collection(PA_COLLECTIONS.agents).doc(agentId).get()
  if (!agentSnap.exists) {
    throw new Error(`migrateBibleV7: agent ${agentId} not found`)
  }
  const data = agentSnap.data() as Record<string, unknown> | undefined
  const systemPrompt = (data?.systemPrompt as string | undefined) ?? ""
  if (!systemPrompt.trim()) {
    throw new Error(`migrateBibleV7: agent ${agentId} has no systemPrompt`)
  }
  const parsed = parseBibleV7(systemPrompt)
  const written: string[] = []
  for (const s of parsed) {
    await saveSection(
      db,
      s.sectionKey,
      { title: s.title, body: s.body, order: s.order, enabled: s.enabled },
      { actor, reason }
    )
    written.push(s.sectionKey)
  }
  return { written: written.length, sectionKeys: written }
}
