import { createHash, randomUUID } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"
import type { Session, AgentInputItem } from "@openai/agents"
import { PA_COLLECTIONS, type ChatMessage } from "@pa/core-types"
import { stripLeadingIsoTimestamp } from "./messages.js"

/**
 * Phase 10.5 T2 — Firestore-backed `Session` for the OpenAI Agents SDK.
 *
 * Acts as a thin adapter between the SDK's per-turn `AgentInputItem[]`
 * shape and our durable `pa-messages` Firestore collection. The SDK never
 * imports `firebase-admin`; it only sees the `Session` interface (A2/A7).
 *
 * Important boundaries:
 *  - History reads use the same query shape as `loadRecentMessages`
 *    (where + sort-in-memory) so we don't depend on Firestore composite
 *    indexes that don't exist today.
 *  - `clearSession` is a *soft* delete. Hard deletion of a user's
 *    transcript is reserved for `__PA_RESET__` (A6). The SDK must never
 *    be able to wipe history.
 *  - `addItems` persists assistant output only. The orchestrator is the
 *    source of truth for user transcript rows; SDK user items are model
 *    inputs and may contain synthetic routing instructions rather than
 *    candidate-visible text.
 *  - `addItems` is idempotent on retry. We hash `(sessionId, role, body)`
 *    and short-circuit on collision so the orchestrator's own
 *    assistant transcript write isn't double-written by the SDK persisting
 *    the same assistant turn back through `addItems`.
 *  - All `.set(...)` writes filter `undefined` fields per the Phase 10
 *    `appendAuditEvent`/`runConnector` pattern (Firestore rejects `undefined`).
 */
export type FirestoreSessionDeps = {
  db: Firestore
  sessionId: string
  /** Optional user id — recorded on rows the SDK creates so dashboard queries by user still work. */
  userId?: string
  /** Optional cap on items returned to the SDK (default 40). */
  historyLimit?: number
  /** Override clock for tests. */
  nowIso?: () => string
  /** Override logger for tests. */
  log?: (...args: unknown[]) => void
}

const DEFAULT_HISTORY_LIMIT = 40

function defaultLog(..._args: unknown[]): void {
  /* swallow by default */
}

/**
 * The agent's reply reaches us as the SDK's structured-output wrapper — a JSON string
 * `{"messages":["bubble one","bubble two"]}` (ClaireReplySchema). That envelope must NEVER be
 * persisted or replayed: `pa-messages` is both the user-visible transcript and the history the
 * model re-reads, so a stored envelope teaches the model its own serialization format is dialogue
 * (measured live 2026-07-25: 224/1889 assistant rows in 24h, every one written by `addItems`).
 *
 * Returns the flattened prose (possibly `""` when the array is empty — a tool-delivered turn with
 * no text) when `body` IS a wrapper, and `null` when it is not, so callers can tell "envelope with
 * nothing in it" from "ordinary prose". Cheap guard first, parse only on a candidate; any parse
 * error → `null` (treat as ordinary text — we append the model's plain text, never a JSON blob).
 */
export function structuredOutputText(body: unknown): string | null {
  if (typeof body !== "string") return null
  const trimmed = body.trim()
  if (!trimmed.startsWith("{") || !trimmed.includes('"messages"')) return null
  try {
    const parsed = JSON.parse(trimmed) as { messages?: unknown }
    if (!Array.isArray(parsed.messages)) return null
    return parsed.messages
      .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      .join("\n\n")
      .trim()
  } catch {
    return null
  }
}

/**
 * Read-side repair for rows written before the `addItems` fix below (and any other writer that
 * still lands an envelope). Flattens the wrapper back to the prose that was actually sent.
 *
 * ASSISTANT ONLY. The wrapper is the agent's own reply; a USER who happens to paste JSON is
 * sending us their real message and must never be rewritten.
 */
export function unwrapStructuredOutputRow<T extends { role?: string; body?: string }>(row: T): T {
  if (row?.role !== "assistant") return row
  const text = structuredOutputText(row?.body)
  // `null` → not a wrapper, leave alone. `""` → an empty envelope; blank the body so the
  // empty-assistant filter in getItems drops it instead of replaying `{"messages":[]}`.
  return text === null ? row : { ...row, body: text }
}

/** Normalize for duplicate comparison — the wrapper and the delivered bubble differ in whitespace. */
function dupeKey(body: string): string {
  return body.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160)
}

/**
 * Collapse an assistant sentence that appears more than once in the window.
 *
 * The same turn lands twice — once via `addItems` (the wrapper, now unwrapped above) and once as
 * the delivered bubble — so without this the model sees every one of its own replies duplicated.
 * Measured live 2026-07-25: 49 duplicate assistant rows in a single day.
 *
 * Only ASSISTANT rows are collapsed, and only against rows already seen in this window: a user
 * legitimately repeating themselves ("yes" … "yes") is real signal and must survive.
 */
function dedupeAdjacentAssistant<T extends { role?: string; body?: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const row of rows) {
    if (row?.role !== "assistant" || typeof row.body !== "string") {
      out.push(row)
      continue
    }
    const key = dupeKey(row.body)
    if (!key) {
      out.push(row)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

/**
 * Public helper so callers (orchestrator, tests) can produce the same
 * idempotency key the Session uses internally. Set this as the
 * `idempotencyKey` on rows you write directly so the SDK's
 * `addItems` short-circuit recognises them.
 */
export function deriveSessionMessageIdempotencyKey(
  sessionId: string,
  role: string,
  body: string
): string {
  return createHash("sha256").update(`${sessionId} ${role} ${body}`).digest("hex")
}

function deriveIdempotencyKey(sessionId: string, role: string, body: string): string {
  return deriveSessionMessageIdempotencyKey(sessionId, role, body)
}

function dropUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

function chatMessageToInputItem(message: ChatMessage): AgentInputItem | null {
  const text = stripLeadingIsoTimestamp(message.body ?? "")
  // Note: do NOT pass through message.id. The OpenAI Responses API rejects
  // any item whose `id` does not start with the server-assigned `msg_`
  // prefix. Our Firestore IDs are UUIDs and would 400. Letting the SDK
  // omit `id` is fine for replayed history because Responses API treats
  // such items as plain input messages without prior server identity.
  if (message.role === "user") {
    return {
      type: "message",
      role: "user",
      content: text,
    } as AgentInputItem
  }
  if (message.role === "assistant") {
    return {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    } as AgentInputItem
  }
  return null
}

function extractItemBody(item: AgentInputItem): { role: ChatMessage["role"]; body: string } | null {
  const anyItem = item as unknown as { role?: string; type?: string; content?: unknown }
  if (!anyItem || typeof anyItem !== "object") return null
  if (anyItem.role === "user") {
    const content = anyItem.content
    if (typeof content === "string") return { role: "user", body: content }
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part
          if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
            return (part as { text: string }).text
          }
          return ""
        })
        .filter(Boolean)
        .join("")
      return { role: "user", body: text }
    }
  }
  if (anyItem.role === "assistant") {
    const content = anyItem.content
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (part && typeof part === "object" && (part as { type?: string }).type === "output_text") {
            return String((part as { text?: string }).text ?? "")
          }
          if (part && typeof part === "object" && (part as { type?: string }).type === "refusal") {
            return String((part as { refusal?: string }).refusal ?? "")
          }
          return ""
        })
        .filter(Boolean)
        .join("")
      return { role: "assistant", body: text }
    }
  }
  if (anyItem.role === "system") {
    if (typeof anyItem.content === "string") return { role: "system", body: anyItem.content }
  }
  return null
}

export class FirestoreSession implements Session {
  private readonly db: Firestore
  private readonly sessionId: string
  private readonly userId?: string
  private readonly historyLimit: number
  private readonly nowIso: () => string
  private readonly log: (...args: unknown[]) => void

  constructor(deps: FirestoreSessionDeps) {
    this.db = deps.db
    this.sessionId = deps.sessionId
    this.userId = deps.userId
    this.historyLimit = deps.historyLimit ?? DEFAULT_HISTORY_LIMIT
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString())
    this.log = deps.log ?? defaultLog
  }

  async getSessionId(): Promise<string> {
    return this.sessionId
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const snap = await this.db
      .collection(PA_COLLECTIONS.messages)
      .where("sessionId", "==", this.sessionId)
      .limit(200)
      .get()
    const docs = snap.docs.map((d) => d.data() as ChatMessage)
    const live = docs.filter((d) => {
      const meta = d as ChatMessage & { cleared?: boolean; popped?: boolean }
      return meta.cleared !== true && meta.popped !== true
    })
    const sorted = live.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    // HISTORY HYGIENE (Adam 2026-07-25, measured on live data): 18% of today's assistant rows
    // (52/297) were the SDK's raw structured-output wrapper `{"messages":[...]}`, and 49 rows were
    // the SAME sentence stored twice — once as that wrapper by addItems, once as the delivered
    // bubble. The model re-reads all of it every turn, so ~a fifth of its context window was JSON
    // noise plus duplicates. That is what makes it misjudge WHICH message a short reply is
    // answering (live: it asked "did you mean OpenComment is your product?" one turn after itself
    // saying "Founder who shipped OpenComment").
    //
    // `isStructuredOutputWrapper` already existed in delivery.ts but was only used to exclude these
    // rows from the dedup set — never from the history the model actually reads.
    //
    // We UNWRAP rather than drop: the wrapper is the only copy when a turn produced text the
    // delivery layer did not separately persist, so dropping it would lose real conversation.
    const cleaned = dedupeAdjacentAssistant(
      sorted
        .map(unwrapStructuredOutputRow)
        // An assistant row with no text after unwrapping is a tool-delivered turn's empty envelope
        // (`{"messages":[]}` — 3 of the 10 most recent live samples). Nothing was ever said; replaying
        // it is pure noise.
        .filter((r) => r.role !== "assistant" || String(r.body ?? "").trim().length > 0),
    )
    const cap = limit ?? this.historyLimit
    const tail = cap > 0 ? cleaned.slice(-cap) : cleaned
    const items: AgentInputItem[] = []
    for (const row of tail) {
      const mapped = chatMessageToInputItem(row)
      if (mapped) items.push(mapped)
      else if (row.role !== "system") {
        this.log("[firestore-session] dropping non-replayable row", {
          sessionId: this.sessionId,
          messageId: row.id,
          role: row.role,
        })
      }
    }
    return items
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    for (const item of items) {
      const extracted = extractItemBody(item)
      if (!extracted) {
        this.log("[firestore-session] skipping unrecognized AgentInputItem", { item })
        continue
      }
      if (extracted.role === "system") continue
      if (extracted.role === "user") {
        this.log("[firestore-session] skipping sdk user input; orchestrator owns user transcript", {
          sessionId: this.sessionId,
        })
        continue
      }

      // ROOT CAUSE of the raw-envelope transcript rows (Adam 2026-07-25). `extracted.body` for an
      // agent with `outputType` is the model's serialized structured output — the literal
      // `{"messages":["…"]}` string — and this is the ONLY site that persisted it. Parse once here,
      // at the single write boundary every caller routes through, so the envelope can never reach
      // Firestore. Not a wrapper (or unparseable) → the plain text is written as-is; an EMPTY
      // envelope means the turn delivered via a tool and said nothing, so there is no row to write.
      const unwrapped = structuredOutputText(extracted.body)
      if (unwrapped !== null) {
        if (!unwrapped) continue
        extracted.body = unwrapped
      }

      const idempotencyKey = deriveIdempotencyKey(this.sessionId, extracted.role, extracted.body)
      const existing = await this.db
        .collection(PA_COLLECTIONS.messages)
        .where("idempotencyKey", "==", idempotencyKey)
        .limit(1)
        .get()
      if (!existing.empty) continue

      const sdkItemId =
        (item as unknown as { id?: unknown }).id && typeof (item as { id: unknown }).id === "string"
          ? ((item as { id: string }).id)
          : undefined
      const sdkItemType =
        (item as unknown as { type?: unknown }).type && typeof (item as { type: unknown }).type === "string"
          ? ((item as { type: string }).type)
          : undefined

      const id = sdkItemId ?? randomUUID()
      const createdAt = this.nowIso()
      const row: ChatMessage & Record<string, unknown> = {
        id,
        sessionId: this.sessionId,
        userId: this.userId ?? "",
        role: extracted.role,
        body: extracted.body,
        createdAt,
        idempotencyKey,
        rawMeta: dropUndefined({
          source: "agents_sdk_session",
          role: extracted.role,
          sdkItemType,
        }) as Record<string, unknown>,
      }
      await this.db.collection(PA_COLLECTIONS.messages).doc(id).set(dropUndefined(row))
    }
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const snap = await this.db
      .collection(PA_COLLECTIONS.messages)
      .where("sessionId", "==", this.sessionId)
      .limit(200)
      .get()
    const docs = snap.docs.map((d) => ({ ref: d.ref, data: d.data() as ChatMessage }))
    const live = docs.filter(({ data }) => {
      const meta = data as ChatMessage & { cleared?: boolean; popped?: boolean }
      return meta.cleared !== true && meta.popped !== true
    })
    if (live.length === 0) return undefined
    live.sort((a, b) => a.data.createdAt.localeCompare(b.data.createdAt))
    const newest = live[live.length - 1]!
    await newest.ref.set(
      dropUndefined({ popped: true, poppedAt: this.nowIso() }) as Record<string, unknown>,
      { merge: true }
    )
    return chatMessageToInputItem(newest.data) ?? undefined
  }

  async clearSession(): Promise<void> {
    const snap = await this.db
      .collection(PA_COLLECTIONS.messages)
      .where("sessionId", "==", this.sessionId)
      .limit(500)
      .get()
    const clearedAt = this.nowIso()
    for (const doc of snap.docs) {
      await doc.ref.set(
        dropUndefined({ cleared: true, clearedAt }) as Record<string, unknown>,
        { merge: true }
      )
    }
  }
}
