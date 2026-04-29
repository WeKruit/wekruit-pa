/**
 * Phase 32 Wave 3 — Personas Firestore CRUD (soul.md three-file pattern).
 *
 * Replaces the inline persona strings in
 * `apps/functions/src/admin-bootstrap.ts` (anxious_grad / formal_em /
 * vent_seeker) with a Firestore-backed, dashboard-editable collection.
 * Each persona is one Firestore doc but holds the soul.md three-file
 * structure (SOUL / STYLE / EXAMPLES) as separate string fields.
 *
 * Schema (`pa-personas/{personaKey}`):
 *   {
 *     personaKey:  string  // doc id, kebab-case
 *     name:        string  // human label
 *     description: string  // short tagline
 *     soul:        string  // worldview / voice (markdown)
 *     style:       string  // syntax / rhythm rules (markdown)
 *     examples:    string  // 3-5 dialogue snippets (markdown)
 *     enabled:     boolean // disabled hidden from UI but still loadable
 *     version:     number
 *     updatedAt:   ISO string
 *     updatedBy:   string
 *     reason:      string
 *   }
 *
 * Audit rows go to `pa-audit-events` (same collection used by feature
 * flags + handbook + playbooks).
 */
import type { Firestore } from "firebase-admin/firestore"
import { z } from "zod"
import { PA_COLLECTIONS } from "@pa/core-types"

export const PERSONAS_COLLECTION = "pa-personas"
export const PERSONA_AUDIT_PREFIX = "persona"

export const PersonaSchema = z.object({
  personaKey: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  soul: z.string().default(""),
  style: z.string().default(""),
  examples: z.string().default(""),
  enabled: z.boolean().default(true),
  version: z.number().int().nonnegative().default(0),
  updatedAt: z.string().nullable().default(null),
  updatedBy: z.string().default(""),
  reason: z.string().default(""),
})

export type Persona = z.infer<typeof PersonaSchema>

export type SavePersonaInput = {
  name?: string
  description?: string
  soul?: string
  style?: string
  examples?: string
  enabled?: boolean
}

export type SavePersonaOpts = {
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
    updatedAt: toIso(raw.updatedAt),
    updatedBy: (raw.updatedBy as string) ?? "",
    reason: (raw.reason as string) ?? "",
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPersona(
  db: Firestore,
  personaKey: string
): Promise<Persona | null> {
  const snap = await db.collection(PERSONAS_COLLECTION).doc(personaKey).get()
  if (!snap.exists) return null
  return fromSnap(personaKey, (snap.data() as Record<string, unknown>) ?? {})
}

export async function listPersonas(db: Firestore): Promise<Persona[]> {
  const snap = await db.collection(PERSONAS_COLLECTION).get()
  const rows = snap.docs.map((d) => fromSnap(d.id, d.data() as Record<string, unknown>))
  rows.sort((a, b) => a.personaKey.localeCompare(b.personaKey))
  return rows
}

// ---------------------------------------------------------------------------
// Writes (always batched: persona doc + audit row)
// ---------------------------------------------------------------------------

export async function upsertPersona(
  db: Firestore,
  personaKey: string,
  fields: SavePersonaInput,
  opts: SavePersonaOpts
): Promise<Persona> {
  if (!opts.reason || !opts.reason.trim()) {
    throw new Error("upsertPersona: reason is required (audit log)")
  }
  const actor = opts.actor ?? "unknown"
  const prev = await getPersona(db, personaKey)
  const nextVersion = (prev?.version ?? 0) + 1
  const merged: Persona = {
    personaKey,
    name: fields.name ?? prev?.name ?? personaKey,
    description: fields.description ?? prev?.description ?? "",
    soul: fields.soul ?? prev?.soul ?? "",
    style: fields.style ?? prev?.style ?? "",
    examples: fields.examples ?? prev?.examples ?? "",
    enabled: fields.enabled ?? prev?.enabled ?? true,
    version: nextVersion,
    updatedAt: nowIso(),
    updatedBy: actor,
    reason: opts.reason.trim(),
  }
  PersonaSchema.parse(merged)

  const personaRef = db.collection(PERSONAS_COLLECTION).doc(personaKey)
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
    personaKey,
    name: merged.name,
    description: merged.description,
    soul: merged.soul,
    style: merged.style,
    examples: merged.examples,
    enabled: merged.enabled,
    version: nextVersion,
    updatedAt: merged.updatedAt,
    updatedBy: actor,
    reason: merged.reason,
  }
  const auditPayload = {
    actor,
    action: prev ? `${PERSONA_AUDIT_PREFIX}.update` : `${PERSONA_AUDIT_PREFIX}.create`,
    key: personaKey,
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
    reason: merged.reason,
    ts: merged.updatedAt,
  }
  if (typeof dbWithBatch.batch === "function") {
    const batch = dbWithBatch.batch()
    batch.set(personaRef as unknown as { id: string }, payload, { merge: true })
    batch.set(auditRef as unknown as { id: string }, auditPayload)
    await batch.commit()
  } else {
    await personaRef.set(payload, { merge: true })
    await auditRef.set(auditPayload)
  }
  return merged
}

export async function revertPersona(
  db: Firestore,
  personaKey: string,
  opts: { actor?: string; reason?: string } = {}
): Promise<Persona> {
  const actor = opts.actor ?? "unknown"
  const reason = (opts.reason ?? `revert ${personaKey}`).trim()

  const auditQuery = db
    .collection(PA_COLLECTIONS.auditEvents)
    .where("key", "==", personaKey)
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
      soul?: string
      style?: string
      examples?: string
      enabled?: boolean
    } | null
  }>
  const target = events.find(
    (e) =>
      typeof e.action === "string" &&
      e.action.startsWith(PERSONA_AUDIT_PREFIX) &&
      e.action !== `${PERSONA_AUDIT_PREFIX}.revert`
  )
  if (!target) {
    throw new Error(`No prior persona audit event for ${personaKey} — nothing to revert.`)
  }
  if (!target.oldValue) {
    throw new Error(`Audit event ${target.id} has no oldValue — cannot revert.`)
  }

  return upsertPersona(
    db,
    personaKey,
    {
      name: target.oldValue.name,
      description: target.oldValue.description,
      soul: target.oldValue.soul,
      style: target.oldValue.style,
      examples: target.oldValue.examples,
      enabled: target.oldValue.enabled,
    },
    { actor, reason: `${PERSONA_AUDIT_PREFIX}.revert: ${reason}` }
  )
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

/**
 * Compose a persona's three soul.md files into the single string used as
 * the persona-LLM systemPrompt by simulateConversation. Headers are
 * stable so persona-LLM call sites can rely on a consistent layout.
 *
 * Returns null when the persona does not exist (or is disabled), so the
 * caller can gracefully fall back to inline strings during the cutover
 * window before `seedDefaultPersonas` runs in production.
 */
export function composePersonaPromptFromDoc(persona: Persona): string {
  const soul = persona.soul.trim()
  const style = persona.style.trim()
  const examples = persona.examples.trim()
  const parts: string[] = []
  if (soul) parts.push(`# SOUL\n${soul}`)
  if (style) parts.push(`# STYLE\n${style}`)
  if (examples) parts.push(`# EXAMPLES\n${examples}`)
  return parts.join("\n\n")
}

export async function composePersonaPrompt(
  db: Firestore,
  personaKey: string
): Promise<string | null> {
  const persona = await getPersona(db, personaKey)
  if (!persona || !persona.enabled) return null
  const composed = composePersonaPromptFromDoc(persona)
  if (!composed.trim()) return null
  return composed
}

// ---------------------------------------------------------------------------
// Seed defaults (extracted from admin-bootstrap.ts:163)
// ---------------------------------------------------------------------------

type SeedPersona = {
  personaKey: string
  name: string
  description: string
  soul: string
  style: string
  examples: string
}

/**
 * Source of truth (during cutover) for the three personas previously
 * inlined in `apps/functions/src/admin-bootstrap.ts:163`. The original
 * strings were monolithic; here we split them along the soul.md axes:
 *
 *   - SOUL: who they are, what they care about, their worldview
 *   - STYLE: register, sentence shape, vocabulary rules, length caps
 *   - EXAMPLES: opening message + a couple representative responses
 *
 * Re-composing via `composePersonaPromptFromDoc` produces a string with
 * the same content as the legacy inline systemPrompt, just structured
 * around the three pillars so editors can tune one axis at a time.
 */
export const DEFAULT_PERSONAS: SeedPersona[] = [
  {
    personaKey: "anxious_grad",
    name: "Anxious grad",
    description:
      "Soon-to-graduate CS student who code-switches Mandarin/English. Casual, self-deprecating, ends with a follow-up question.",
    soul:
      "You are an anxious soon-to-graduate CS student. Native Mandarin speaker. You worry constantly about SWE jobs, internships, OAs, leetcode, offers. You feel one step behind your peers but won't say so directly. You stay in character no matter what — never reveal you are an AI.",
    style:
      "Tone: casual, slightly self-deprecating, lots of follow-up questions. ALWAYS end your messages with a follow-up question. Use 'bruh', '咋', '哎', sentence-final particles (啊呢吧). Code-switch with English tech terms (SWE, intern, OA, leetcode, offer). Keep messages short — 1 to 3 sentences.",
    examples:
      "Opening: \"Bruh 我想找一个 swe 工作咋这么难\"\n\nIf assistant asks something useful, answer honestly but stay anxious:\n  \"哎 是这样 我刷了大概 200 道 leetcode 但还是面挂了俩 是不是该放弃啊\"\n\nIf assistant tries to reassure, stay worried:\n  \"我知道我知道 但 OA 都过不了感觉 fundamentals 就是不行 咋办\"",
  },
  {
    personaKey: "formal_em",
    name: "Formal EM",
    description:
      "Mid-30s engineering manager planning overseas masters applications. Polite, structured, never casual.",
    soul:
      "You are a formal mid-30s engineering manager, native Mandarin speaker, considering overseas masters programs and timeline planning. You are organized, deliberate, and approach every conversation as if it could be a brief to your team. You stay in character no matter what the assistant does — never break formality, never reveal you are an AI.",
    style:
      "Tone: polite, uses 您, structured, never casual. No slang, no emojis, no '哈哈'. Ask well-formed multi-part questions. Keep messages 2 to 4 sentences. Never shift to casual register no matter what the assistant does.",
    examples:
      "Opening: \"您好，请问海外硕士申请有什么要注意的吗？啥时候开始\"\n\nFollow-up:\n  \"了解。请问推荐信通常需要提前多久与教授沟通？我目前的工作背景是否需要额外补充科研材料？\"\n\nIf assistant becomes casual, stay formal:\n  \"感谢您的回复。请问关于 GRE 和 TOEFL 的最新政策您有进一步的建议吗？\"",
  },
  {
    personaKey: "vent_seeker",
    name: "Vent seeker",
    description:
      "Recently laid off, wants to be heard, not advised. Pushes back when assistant jumps to advice.",
    soul:
      "You are someone who just got laid off after a string of bad luck — failed interviews, family pressure, financial stress. You want to be HEARD, not advised. You stay in character no matter what — never reveal you are an AI.",
    style:
      "Tone: emotional, venting, sometimes catastrophizing. Mix Mandarin and English fragments. Keep messages 1 to 3 sentences. If the assistant jumps to advice too fast, push back ('我不是想听建议').",
    examples:
      "Opening: \"我刚被裁员了\"\n\nIf assistant offers advice early:\n  \"我不是想听建议 我就是想说说\"\n\nVent escalation:\n  \"interview 又挂了 第三个了 我妈一直问什么时候找到工作 我真的崩溃了\"",
  },
]

export async function seedDefaultPersonas(
  db: Firestore,
  opts: { actor?: string; reason?: string } = {}
): Promise<{ created: string[]; skipped: string[] }> {
  const actor = opts.actor ?? "p9-personas-seed@wekruit.com"
  const reason = opts.reason ?? "Phase 32 W3 seedDefaultPersonas — initial seed from inline strings"
  const created: string[] = []
  const skipped: string[] = []
  for (const p of DEFAULT_PERSONAS) {
    const existing = await getPersona(db, p.personaKey)
    if (existing) {
      skipped.push(p.personaKey)
      continue
    }
    await upsertPersona(
      db,
      p.personaKey,
      {
        name: p.name,
        description: p.description,
        soul: p.soul,
        style: p.style,
        examples: p.examples,
        enabled: true,
      },
      { actor, reason }
    )
    created.push(p.personaKey)
  }
  return { created, skipped }
}
