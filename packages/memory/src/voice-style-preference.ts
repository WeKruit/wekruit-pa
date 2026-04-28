/**
 * Phase 19 ADAPT-03 — long-term voice style preference store.
 *
 * D-06 says "Long-term preferences live in mem0, surfaced via persona
 * card extension. Not a new collection." Phase 19 deviation note: this
 * impl persists the structured preference on the EXISTING `pa-users`
 * Firestore doc under a `voiceStylePreference` field — i.e. it extends
 * an existing doc, NOT a new collection. mem0's free-text + semantic
 * search surface is unreliable for round-tripping a 4-field structured
 * preference; the doc-extension approach honors the "no new collection"
 * clause while giving deterministic read/write semantics. See SUMMARY.
 *
 * Public API is dependency-injectable so tests run without Firestore.
 *  - `readStylePreference(userId)` → `Promise<VoiceStylePreference | null>`
 *  - `writeStylePreference(userId, snapshot)` → `Promise<void>`
 *  - `setVoiceStyleStore(store)` swaps the default Firestore-backed store
 *    for an in-memory test fake (or a future mem0-backed impl).
 *
 * Bucketing thresholds (kept in sync with PLAN §Task 4):
 *  - register: ≥ 0.7 → formal; ≥ 0.4 → casual; else slangy.
 *  - zh_en_mix: ≥ 0.7 zh → zh_dominant; ≤ 0.3 zh → en_dominant; else balanced.
 *  - emoji_tolerance: 0 → none; ≤ 1.5 → sparse; else expressive.
 *
 * Drift gate: if the existing preference's three buckets match the new
 * derivation, the write is a no-op (avoids mem0/Firestore churn).
 */
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

/**
 * Structural mirror of `pa-orchestrator/src/voice/style-analyzer.ts`
 * StyleSnapshot — duplicated here so @pa/memory does not depend on
 * @pa/pa-orchestrator (would create a cycle: orchestrator already
 * imports memory). The two interfaces MUST stay in shape-sync; if
 * StyleSnapshot grows a field in pa-orchestrator, mirror it here.
 *
 * D-10 caps at 5 features so this duplication is bounded and safe.
 */
export interface StyleSnapshot {
  register_score: number
  zh_char_ratio: number
  emoji_freq: number
  avg_sentence_len: number
  slang_hits: number
  sample_size: number
}

export interface VoiceStylePreference {
  user_id: string
  preferred_register: "formal" | "casual" | "slangy"
  zh_en_mix: "zh_dominant" | "en_dominant" | "balanced"
  emoji_tolerance: "none" | "sparse" | "expressive"
  updated_at: string
  observed_turns: number
}

export interface VoiceStyleStore {
  read(userId: string): Promise<VoiceStylePreference | null>
  write(pref: VoiceStylePreference): Promise<void>
}

/** Reset store after each test if you swap it. */
let activeStore: VoiceStyleStore | null = null

export function setVoiceStyleStore(store: VoiceStyleStore | null): void {
  activeStore = store
}

/** In-memory test store — NOT used in production. */
export function createInMemoryVoiceStyleStore(): VoiceStyleStore & {
  _dump(): Map<string, VoiceStylePreference>
} {
  const map = new Map<string, VoiceStylePreference>()
  return {
    async read(userId) {
      return map.get(userId) ?? null
    },
    async write(pref) {
      map.set(pref.user_id, pref)
    },
    _dump() {
      return map
    },
  }
}

/** Firestore-backed default. Stores under pa_users/{userId}.voiceStylePreference. */
export function createFirestoreVoiceStyleStore(db: Firestore): VoiceStyleStore {
  return {
    async read(userId) {
      const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      if (!snap.exists) return null
      const raw = (snap.data() as { voiceStylePreference?: VoiceStylePreference } | undefined)
        ?.voiceStylePreference
      if (!raw) return null
      return raw
    },
    async write(pref) {
      await db
        .collection(PA_COLLECTIONS.users)
        .doc(pref.user_id)
        .set({ voiceStylePreference: pref, updatedAt: pref.updated_at }, { merge: true })
    },
  }
}

function getStore(): VoiceStyleStore {
  if (!activeStore) {
    throw new Error(
      "voice-style-preference: no store configured. Call setVoiceStyleStore() at process boot " +
        "(production: createFirestoreVoiceStyleStore(db); tests: createInMemoryVoiceStyleStore())."
    )
  }
  return activeStore
}

export function deriveRegister(score: number): VoiceStylePreference["preferred_register"] {
  if (score >= 0.7) return "formal"
  if (score >= 0.4) return "casual"
  return "slangy"
}

export function deriveMix(zhRatio: number): VoiceStylePreference["zh_en_mix"] {
  if (zhRatio >= 0.7) return "zh_dominant"
  if (zhRatio <= 0.3) return "en_dominant"
  return "balanced"
}

export function deriveEmojiTolerance(
  freq: number
): VoiceStylePreference["emoji_tolerance"] {
  if (freq === 0) return "none"
  if (freq <= 1.5) return "sparse"
  return "expressive"
}

export function snapshotToPreference(
  userId: string,
  snapshot: StyleSnapshot,
  nowIso: string = new Date().toISOString()
): VoiceStylePreference {
  return {
    user_id: userId,
    preferred_register: deriveRegister(snapshot.register_score),
    zh_en_mix: deriveMix(snapshot.zh_char_ratio),
    emoji_tolerance: deriveEmojiTolerance(snapshot.emoji_freq),
    updated_at: nowIso,
    observed_turns: snapshot.sample_size,
  }
}

function bucketsEqual(a: VoiceStylePreference, b: VoiceStylePreference): boolean {
  return (
    a.preferred_register === b.preferred_register &&
    a.zh_en_mix === b.zh_en_mix &&
    a.emoji_tolerance === b.emoji_tolerance
  )
}

export async function readStylePreference(
  userId: string
): Promise<VoiceStylePreference | null> {
  return getStore().read(userId)
}

export async function writeStylePreference(
  userId: string,
  snapshot: StyleSnapshot,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  if (!snapshot || snapshot.sample_size === 0) return
  const store = getStore()
  const next = snapshotToPreference(userId, snapshot, nowIso)
  const existing = await store.read(userId)
  if (existing && bucketsEqual(existing, next)) return // drift-gate: no-op
  await store.write(next)
}

/**
 * Phase 19 ADAPT-03 — persona card extension.
 *
 * Returns a single Tendera-style "facts as voice" line describing the
 * stored preference, or `null` if no preference. Caller (persona-card.ts)
 * appends this verbatim to its existing card output. When `null`, the
 * persona card is byte-identical to its pre-Phase-19 output (regression
 * safety per PLAN Task 4 behavior).
 */
export function renderStylePreferenceLine(
  pref: VoiceStylePreference | null
): string | null {
  if (!pref) return null
  const reg = {
    formal: "偏 formal",
    casual: "偏 casual",
    slangy: "偏 slangy",
  }[pref.preferred_register]
  const mix = {
    zh_dominant: "中文为主",
    en_dominant: "English-leaning",
    balanced: "zh-en code-switch 自然",
  }[pref.zh_en_mix]
  const emoji = {
    none: "几乎不用 emoji",
    sparse: "偶尔 emoji",
    expressive: "emoji 表达性强",
  }[pref.emoji_tolerance]
  return `用户跟 Claire 聊天 ${reg}，${mix}，${emoji}。`
}
