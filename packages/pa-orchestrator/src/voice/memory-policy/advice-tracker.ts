/**
 * Phase 38 — Advice tracker SDK.
 *
 * Cross-session extension of Phase 35 F4 in-session window:
 *   pa-advice-tracker/{userId}/items/{turnId}
 *
 * Operations:
 * - `trackAdvice(userId, claireReply, turnId, deps)` — fire-and-forget
 *   Firestore write of an `AdviceTrackerEntry` (with BGE-M3 embedding
 *   when API key present)
 * - `recentAdvice(userId, n=3, deps)` — read last N entries oldest-first
 * - `repeatScore(reply, recent, deps)` — BGE-M3 cos-sim of new reply vs
 *   stored embeddings; threshold 0.85 (PA_MEMORY_REPEAT_THRESHOLD)
 *
 * Algorithm parity with Phase 35 F4:
 * - `cosineSim` re-imported from `../detectors/f4-advice-repeat.js`
 * - Same env-var resolution chain
 *   (`SILICONFLOW_API_KEY` → `PA_OPENAI_AGENT_API_KEY` → `PA_SILICONFLOW_API_KEY`)
 * - Same model id `BAAI/bge-m3`, same base URL, same LRU cache (200)
 *
 * Graceful degrade (D-38-7):
 * - Missing API key → `repeatScore` returns
 *   `{ triggered: false, maxSim: null, reason: "skipped: no embed api key" }`.
 *   `trackAdvice` still writes the entry with `embedding: null`.
 * - Network error / non-200 → similar skip with `reason` text. NEVER throws.
 * - Missing `deps.db` → `trackAdvice` is a no-op (logs); `recentAdvice`
 *   returns []. NEVER throws.
 *
 * Latency: warm path < 5ms via LRU cache (D-38-7).
 */

import type { Firestore } from "firebase-admin/firestore"
import { cosineSim } from "../detectors/f4-advice-repeat.js"
import type {
  AdviceTrackerDeps,
  AdviceTrackerEntry,
  RepeatScoreResult,
} from "./types.js"

const DEFAULT_THRESHOLD = 0.85
const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
const DEFAULT_MODEL = "BAAI/bge-m3"
const DEFAULT_DIMS = 1024
const CACHE_LIMIT = 200
const ADVICE_COLLECTION = "pa-advice-tracker"

// LRU cache (separate from F4 detector cache — different module rootDir).
const _cache = new Map<string, Float32Array>()

// Test hook — override fetch impl + reset cache.
let _fetchImpl: typeof fetch | null = null
export function _setEmbedFetchImpl(fn: typeof fetch | null): void {
  _fetchImpl = fn
}
export function _resetEmbedCache(): void {
  _cache.clear()
}

function readEnvThreshold(): number {
  const raw = process.env.PA_MEMORY_REPEAT_THRESHOLD?.trim()
  if (!raw) return DEFAULT_THRESHOLD
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_THRESHOLD
  return n
}

function getApiKey(): string | null {
  const k =
    process.env.SILICONFLOW_API_KEY?.trim() ||
    process.env.PA_OPENAI_AGENT_API_KEY?.trim() ||
    process.env.PA_SILICONFLOW_API_KEY?.trim() ||
    ""
  return k.length > 0 ? k : null
}

function getBaseUrl(): string {
  const u =
    process.env.SILICONFLOW_BASE_URL?.trim() ||
    process.env.PA_OPENAI_AGENT_BASE_URL?.trim() ||
    DEFAULT_BASE_URL
  return u.replace(/\/+$/, "")
}

function lruGet(key: string): Float32Array | null {
  if (!_cache.has(key)) return null
  const v = _cache.get(key) as Float32Array
  _cache.delete(key)
  _cache.set(key, v)
  return v
}

function lruSet(key: string, value: Float32Array): void {
  if (_cache.has(key)) _cache.delete(key)
  _cache.set(key, value)
  while (_cache.size > CACHE_LIMIT) {
    const firstKey = _cache.keys().next().value
    if (firstKey === undefined) break
    _cache.delete(firstKey)
  }
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>
}

async function postEmbeddings(input: string[]): Promise<Float32Array[] | null> {
  const apiKey = getApiKey()
  if (!apiKey) return null
  const fetchFn = _fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== "function") {
    throw new Error("memory-policy/advice-tracker: fetch unavailable")
  }
  const url = `${getBaseUrl()}/embeddings`
  const body = {
    model: process.env.PA_EMBED_MODEL?.trim() || DEFAULT_MODEL,
    input,
  }
  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`SiliconFlow ${resp.status} ${resp.statusText} — ${text.slice(0, 200)}`)
  }
  const json = (await resp.json()) as EmbeddingResponse
  if (!Array.isArray(json.data)) {
    throw new Error("malformed response (no .data array)")
  }
  return json.data
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => Float32Array.from(d.embedding ?? []))
}

/**
 * Default BGE-M3 batch embed function. Returns `null` array when API key
 * absent for ALL un-cached inputs (caller branches on null).
 */
export async function _defaultEmbedFn(
  texts: string[]
): Promise<(Float32Array | null)[] | null> {
  if (!Array.isArray(texts) || texts.length === 0) return []
  const out: (Float32Array | null)[] = new Array(texts.length).fill(null)
  const missingIdx: number[] = []
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]
    if (typeof t !== "string" || t.length === 0) {
      out[i] = Float32Array.from(new Array(DEFAULT_DIMS).fill(0))
      continue
    }
    const cached = lruGet(t)
    if (cached) out[i] = cached
    else missingIdx.push(i)
  }
  if (missingIdx.length === 0) return out
  const apiKey = getApiKey()
  if (!apiKey) return null
  const inputs = missingIdx.map((i) => texts[i])
  const arr = await postEmbeddings(inputs)
  if (!arr) return null
  for (let k = 0; k < missingIdx.length; k++) {
    const idx = missingIdx[k]
    const v = arr[k]
    if (v) {
      lruSet(texts[idx], v)
      out[idx] = v
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Language detection (mirrors Phase 35 F3 + Phase 33 detectLang algorithm).
// ---------------------------------------------------------------------------

const CJK_RE = /[\u3400-\u9fff]/g
const ASCII_LETTER_RE = /[A-Za-z]/g

export function detectReplyLang(text: string): "zh" | "en" | "mixed" {
  if (!text) return "en"
  const cjk = (text.match(CJK_RE) ?? []).length
  const ascii = (text.match(ASCII_LETTER_RE) ?? []).length
  if (cjk === 0 && ascii === 0) return "en"
  if (cjk > 0 && ascii === 0) return "zh"
  if (ascii > 0 && cjk === 0) return "en"
  // Both present → "mixed" only when minority share >= 20%
  const total = cjk + ascii
  const minorityShare = Math.min(cjk, ascii) / total
  if (minorityShare >= 0.2) return "mixed"
  return cjk > ascii ? "zh" : "en"
}

// ---------------------------------------------------------------------------
// trackAdvice — Firestore writer
// ---------------------------------------------------------------------------

export interface TrackAdviceOpts {
  /** FSM-inferred ESConv strategy from Phase 37 (null pre-FSM-wire-in). */
  strategy?: string | null
  /** FSM ux state from Phase 37 (null pre-FSM-wire-in). */
  uxState?: string | null
  /** Override default lang detection. */
  lang?: "zh" | "en" | "mixed"
}

/**
 * Persist one advice tracker entry to
 * `pa-advice-tracker/{userId}/items/{turnId}`.
 *
 * Fire-and-forget — never throws; errors logged via `console.log`.
 * Embedding written when BGE-M3 API key present, else `null` field.
 */
export async function trackAdvice(
  userId: string,
  claireReply: string,
  turnId: string,
  deps: AdviceTrackerDeps = {},
  opts: TrackAdviceOpts = {}
): Promise<void> {
  if (!userId || !claireReply || !turnId) {
    console.log("[memory-policy/track] noop: missing required field", {
      userId: !!userId,
      claireReply: !!claireReply,
      turnId: !!turnId,
    })
    return
  }
  const db = deps.db
  if (!db) {
    // No-op when Firestore absent (e.g. tests not exercising persistence).
    return
  }
  const embedFn = deps.embedFn ?? _defaultEmbedFn
  const lang = opts.lang ?? detectReplyLang(claireReply)

  let embedding: number[] | null = null
  let embeddedAt: string | null = null
  try {
    const arr = await embedFn([claireReply])
    if (arr && arr[0]) {
      embedding = Array.from(arr[0])
      embeddedAt = new Date().toISOString()
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    // Log but continue — text-only persistence is still useful.
    console.log("[memory-policy/track] embed failed (text-only persistence)", { msg })
  }

  const entry: AdviceTrackerEntry = {
    userId,
    turnId,
    text: claireReply,
    lang,
    embedding,
    embeddedAt,
    strategy: opts.strategy ?? null,
    uxState: opts.uxState ?? null,
    ts: new Date().toISOString(),
    schemaVersion: 1,
  }

  try {
    await db
      .collection(ADVICE_COLLECTION)
      .doc(userId)
      .collection("items")
      .doc(turnId)
      .set(entry as unknown as Record<string, unknown>)
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.log("[memory-policy/track] firestore write failed", { msg, userId, turnId })
  }
}

// ---------------------------------------------------------------------------
// recentAdvice — Firestore reader
// ---------------------------------------------------------------------------

/**
 * Read last N advice entries for `userId` from
 * `pa-advice-tracker/{userId}/items` ordered by `ts DESC`. Returns
 * oldest-first (sorted asc after fetch — F4 + memory-policy expect that
 * direction for cos-sim window semantics).
 *
 * Empty array when:
 *   - `deps.db` absent
 *   - subcollection empty
 *   - Firestore query throws (logged)
 */
export async function recentAdvice(
  userId: string,
  n: number,
  deps: AdviceTrackerDeps = {}
): Promise<AdviceTrackerEntry[]> {
  if (!userId || n <= 0) return []
  const db = deps.db
  if (!db) return []
  try {
    const snap = await db
      .collection(ADVICE_COLLECTION)
      .doc(userId)
      .collection("items")
      .orderBy("ts", "desc")
      .limit(n)
      .get()
    const docs = snap.docs ?? []
    const items: AdviceTrackerEntry[] = []
    for (const d of docs) {
      const raw = d.data() as Record<string, unknown> | undefined
      if (!raw) continue
      items.push({
        userId: (raw.userId as string) ?? userId,
        turnId: (raw.turnId as string) ?? d.id,
        text: (raw.text as string) ?? "",
        lang: ((raw.lang as string) ?? "en") as AdviceTrackerEntry["lang"],
        embedding: Array.isArray(raw.embedding)
          ? (raw.embedding as number[])
          : null,
        embeddedAt: (raw.embeddedAt as string) ?? null,
        strategy: (raw.strategy as string) ?? null,
        uxState: (raw.uxState as string) ?? null,
        ts: (raw.ts as string) ?? "",
        schemaVersion: (raw.schemaVersion as 1) ?? 1,
      })
    }
    // Reverse — orderBy desc returns most-recent-first; downstream consumers
    // expect oldest-first for sliding-window semantics.
    return items.reverse()
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.log("[memory-policy/recent] firestore query failed", { msg, userId })
    return []
  }
}

// ---------------------------------------------------------------------------
// repeatScore — BGE-M3 cos-sim of new reply vs recent embeddings
// ---------------------------------------------------------------------------

function entryEmbeddingToFloat32(e: AdviceTrackerEntry): Float32Array | null {
  if (!Array.isArray(e.embedding) || e.embedding.length === 0) return null
  return Float32Array.from(e.embedding)
}

/**
 * Compute max cos-sim of `reply` against `recent[]` stored embeddings.
 *
 * Optimization: prefer stored embeddings when present (no network call);
 * fall back to embedding both when reply OR any history embedding is missing.
 *
 * Graceful degrade:
 * - Missing API key + missing stored embeddings → `maxSim: null`
 * - Empty history → `maxSim: 0, reason: "no_history"` (NOT triggered)
 * - Empty reply → `maxSim: 0, reason: "no_input"`
 */
export async function repeatScore(
  reply: string,
  recent: AdviceTrackerEntry[],
  deps: AdviceTrackerDeps = {}
): Promise<RepeatScoreResult> {
  const start = performance.now()
  const threshold = readEnvThreshold()

  if (!reply || reply.length === 0) {
    return {
      triggered: false,
      maxSim: 0,
      mostSimilarIdx: -1,
      sims: [],
      threshold,
      reason: "no_input",
      latencyMs: performance.now() - start,
    }
  }

  if (!Array.isArray(recent) || recent.length === 0) {
    return {
      triggered: false,
      maxSim: 0,
      mostSimilarIdx: -1,
      sims: [],
      threshold,
      reason: "no_history",
      latencyMs: performance.now() - start,
    }
  }

  const embedFn = deps.embedFn ?? _defaultEmbedFn

  // Determine which texts need embedding (reply always; history items only
  // when their stored embedding is missing).
  const needEmbed: string[] = [reply]
  const replyIdxInBatch = 0
  const historyEmbedSlots: (Float32Array | null)[] = recent.map(
    entryEmbeddingToFloat32
  )
  const missingHistoryIdx: number[] = []
  for (let i = 0; i < recent.length; i++) {
    if (historyEmbedSlots[i] === null) {
      missingHistoryIdx.push(i)
      needEmbed.push(recent[i].text)
    }
  }

  let embedded: (Float32Array | null)[] | null = null
  try {
    embedded = await embedFn(needEmbed)
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.log("[memory-policy/repeat] embed network error", { msg })
    return {
      triggered: false,
      maxSim: null,
      mostSimilarIdx: -1,
      sims: [],
      threshold,
      reason: `skipped: embed network error: ${msg}`,
      latencyMs: performance.now() - start,
    }
  }

  if (embedded === null) {
    return {
      triggered: false,
      maxSim: null,
      mostSimilarIdx: -1,
      sims: [],
      threshold,
      reason: "skipped: no embed api key",
      latencyMs: performance.now() - start,
    }
  }

  const replyVec = embedded[replyIdxInBatch]
  if (!replyVec) {
    return {
      triggered: false,
      maxSim: null,
      mostSimilarIdx: -1,
      sims: [],
      threshold,
      reason: "skipped: empty reply embedding",
      latencyMs: performance.now() - start,
    }
  }

  // Fill in missing history slots from the embedding result.
  for (let k = 0; k < missingHistoryIdx.length; k++) {
    const histIdx = missingHistoryIdx[k]
    historyEmbedSlots[histIdx] = embedded[k + 1] ?? null
  }

  let maxSim = 0
  let mostSimilarIdx = -1
  const sims: number[] = []
  for (let i = 0; i < historyEmbedSlots.length; i++) {
    const v = historyEmbedSlots[i]
    if (!v) {
      sims.push(0)
      continue
    }
    const s = cosineSim(replyVec, v)
    sims.push(s)
    if (s > maxSim) {
      maxSim = s
      mostSimilarIdx = i
    }
  }

  const triggered = maxSim >= threshold

  return {
    triggered,
    maxSim,
    mostSimilarIdx,
    sims,
    threshold,
    reason: triggered
      ? `cos_sim_${maxSim.toFixed(3)}_>=_${threshold.toFixed(3)}`
      : `cos_sim_${maxSim.toFixed(3)}_<_${threshold.toFixed(3)}`,
    latencyMs: performance.now() - start,
  }
}

/** Re-export for parity with Phase 35 F4 (and convenience for callers). */
export { cosineSim } from "../detectors/f4-advice-repeat.js"

/** Exposed for tests + smoke that need to inspect collection name. */
export const ADVICE_TRACKER_COLLECTION = ADVICE_COLLECTION
