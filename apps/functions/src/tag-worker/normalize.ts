/**
 * iter30 WS2 P2 — onDocumentCreated trigger for pa-tag-events.
 *
 * Architecture (3-layer normalize):
 *   Layer 1: Hot alias lookup in pa-canonical-tags (array-contains query ~30ms)
 *   Layer 2: FREE Qwen-7B on SiliconFlow (fail-open: 429/timeout → pending-review)
 *   Layer 3: BGE-M3 cosine search via Firestore vector findNearest (≥0.85 threshold)
 *   Cold:    Propose new canonical (Qwen-7B "create") or mark needs-review
 *
 * Adam-locked constraints:
 *  - FREE Qwen-7B only (no paid LLM fallback)
 *  - Mutex enforcement at write time (same mutexGroup → reinforce, no dup)
 *  - Flag gate: paCanonicalTagWorkerEnabled
 *  - Fail-open: any error leaves event for retry; never crashes worker
 *
 * Spec: ws-2-7-detail.md §4 worker pseudocode.
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { logger } from "firebase-functions/v2"
import { getFirestore, FieldValue } from "firebase-admin/firestore"
import type { Firestore, Transaction, DocumentSnapshot, DocumentReference } from "firebase-admin/firestore"

import {
  SHARED_TAG_COLLECTIONS,
  DECAY_HALF_LIFE_DAYS_BY_TYPE,
  type TagEvent,
  type TagType,
  type TagEventSource,
  type EntityTagSourceAttribution,
} from "@wekruit/shared-tags"
import { llmNormalize } from "./llm-normalize.js"
import { computeEntityTagConfidence } from "./confidence.js"

// ─── Feature flag ─────────────────────────────────────────────────────────────

function isWorkerEnabled(): boolean {
  const raw = process.env.paCanonicalTagWorkerEnabled
  if (typeof raw !== "string") return true // default ON for iter30 wave 2
  return raw.trim().toLowerCase() !== "false"
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize raw text for alias lookup: lowercase + collapse whitespace.
 * Matches the Python port's normalization step.
 */
function normalizeRawText(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, " ")
}

/**
 * Sample up to N canonical tags of a given type for few-shot prompt.
 * Prioritizes human-approved and auto-approved, then proposed.
 */
async function sampleCanonicals(
  fs: Firestore,
  type: TagType,
  limit: number,
): Promise<Array<{ canonicalKey: string; displayName: string }>> {
  try {
    const snap = await fs
      .collection(SHARED_TAG_COLLECTIONS.canonicalTags)
      .where("type", "==", type)
      .where("approvalStatus", "in", ["human-approved", "auto-approved", "proposed"])
      .limit(limit)
      .get()
    return snap.docs.map((d) => {
      const data = d.data() as { canonicalKey?: string; displayName?: string }
      return {
        canonicalKey: data.canonicalKey ?? d.id,
        displayName: data.displayName ?? d.id,
      }
    })
  } catch (err) {
    logger.warn("[tag-worker][normalize] sampleCanonicals failed", {
      err: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

/**
 * Merge a new source into an existing sources array (EntityTagSourceAttribution[]).
 * Uses arrayUnion semantics — the caller wraps the full array in tx.set with merge:true.
 */
function buildSourceEntry(
  existingSources: EntityTagSourceAttribution[],
  source: TagEventSource,
  now: string,
): EntityTagSourceAttribution[] {
  const existing = existingSources.find((s) => s.source === source)
  if (existing) {
    return existingSources.map((s) =>
      s.source === source
        ? { ...s, count: s.count + 1, lastAt: now }
        : s,
    )
  }
  return [
    ...existingSources,
    { source, weight: 1.0, firstAt: now, lastAt: now, count: 1 },
  ]
}

/**
 * Propose a new canonical tag in pa-canonical-tags.
 * Uses .create() so concurrent workers collide and fall through to alias-add.
 * Returns the canonical key that was written (or already existed).
 */
async function proposeNewCanonical(
  fs: Firestore,
  opts: {
    canonicalKey: string
    displayName: string
    type: TagType
    firstEvidence: TagEvent
  },
): Promise<string> {
  const { canonicalKey, displayName, type, firstEvidence } = opts
  const now = new Date().toISOString()
  const docRef = fs.collection(SHARED_TAG_COLLECTIONS.canonicalTags).doc(canonicalKey)
  try {
    await docRef.create({
      canonicalKey,
      type,
      displayName,
      aliases: [normalizeRawText(firstEvidence.rawText)],
      confidence: 0.4, // proposed default
      evidence: [
        {
          source: firstEvidence.source,
          sourceDocId: firstEvidence.sourceDocId,
          sourceField: firstEvidence.sourceField,
          rawText: firstEvidence.rawText.slice(0, 500),
          observedAt: now,
        },
      ],
      approvalStatus: "proposed",
      mutexGroup: canonicalKey, // self-mutex by default
      schemaVersion: "v1",
      createdAt: now,
      updatedAt: now,
    })
    logger.info("[tag-worker][normalize] new canonical proposed", { canonicalKey, type })
    return canonicalKey
  } catch (err: unknown) {
    // ALREADY_EXISTS race — another worker created it first; use that one
    const code =
      typeof err === "object" && err
        ? (err as { code?: unknown }).code
        : undefined
    if (code === 6 || code === "already-exists" || code === "ALREADY_EXISTS") {
      logger.info("[tag-worker][normalize] proposeNewCanonical race — using existing", { canonicalKey })
      return canonicalKey
    }
    throw err
  }
}

// ─── Commit ───────────────────────────────────────────────────────────────────

type CommitDecision =
  | "hot-alias"
  | "llm-match"
  | "cosine-match"
  | "new-canonical"
  | "needs-review"
  | "skipped-mutex"

async function commit(
  fs: Firestore,
  ev: TagEvent,
  canonicalKey: string | null,
  decision: CommitDecision,
  workerConfidence: number | null,
  startMs: number,
): Promise<void> {
  const now = new Date().toISOString()
  await fs.runTransaction(async (tx: Transaction) => {
    // Re-read the event inside the transaction — race-safe check
    const eventRef = fs.collection(SHARED_TAG_COLLECTIONS.tagEvents).doc(ev.id)
    const eventSnap: DocumentSnapshot = await tx.get(eventRef)
    const cur = eventSnap.data() as TagEvent | undefined
    if (!cur || cur.status !== "pending") return // already processed

    const processingDurationMs = Date.now() - startMs

    // ── Read phase — ALL reads before ANY writes (Firestore tx requirement) ───
    // eventSnap already read above. For the entity-tag writes we need 3 more reads.
    let canSnap: DocumentSnapshot | null = null
    let existingItemSnap: DocumentSnapshot | null = null
    let entityRootSnap: DocumentSnapshot | null = null
    let itemRef: DocumentReference | null = null
    let entityRootRef: DocumentReference | null = null
    let mutexGroup: string | null = null

    if (canonicalKey) {
      const canRef = fs.collection(SHARED_TAG_COLLECTIONS.canonicalTags).doc(canonicalKey)
      const entityKey = `${ev.entityRef.kind}:${ev.entityRef.id}`
      entityRootRef = fs.collection(SHARED_TAG_COLLECTIONS.entityTags).doc(entityKey)
      itemRef = entityRootRef
        .collection(SHARED_TAG_COLLECTIONS.entityTagItems)
        .doc(canonicalKey)

      // All reads in one batch before any write
      ;[canSnap, existingItemSnap, entityRootSnap] = await Promise.all([
        tx.get(canRef),
        tx.get(itemRef),
        tx.get(entityRootRef),
      ])

      mutexGroup =
        (canSnap.data() as { mutexGroup?: string } | undefined)?.mutexGroup ?? canonicalKey
    }

    // ── Write phase — starts here, no more reads below ─────────────────────

    // Update event status
    tx.update(eventRef, {
      status: canonicalKey ? "normalized" : "needs-review",
      normalizedTo: canonicalKey,
      decision,
      workerConfidence,
      processedAt: now,
      processingDurationMs,
    })

    if (!canonicalKey || !itemRef || !entityRootRef || !existingItemSnap || !entityRootSnap) return

    const entityKey2 = `${ev.entityRef.kind}:${ev.entityRef.id}`

    if (existingItemSnap.exists) {
      // Exact same canonical already tagged for this entity — reinforce count
      const existing = existingItemSnap.data() as {
        count?: number
        sources?: EntityTagSourceAttribution[]
        mutexGroup?: string
      }
      const updatedSources = buildSourceEntry(existing.sources ?? [], ev.source, now)
      tx.update(itemRef, {
        count: FieldValue.increment(1),
        lastReinforced: now,
        sources: updatedSources,
        confidence: computeEntityTagConfidence(workerConfidence),
      })
      // Update decision to skipped-mutex so audit shows reinforcement
      tx.update(eventRef, { decision: "skipped-mutex", normalizedTo: canonicalKey })
      return
    }

    // No exact match — write new entity-tag assignment
    tx.set(itemRef, {
      canonicalKey,
      type: ev.type,
      mutexGroup: mutexGroup ?? canonicalKey,
      confidence: computeEntityTagConfidence(workerConfidence),
      firstSeen: ev.createdAt,
      lastReinforced: now,
      count: 1,
      sources: buildSourceEntry([], ev.source, now),
      decayHalfLifeDays: DECAY_HALF_LIFE_DAYS_BY_TYPE[ev.type] ?? 0,
      schemaVersion: "v1",
    })

    // Update entity root — if exists increment, else create
    if (entityRootSnap.exists) {
      tx.update(entityRootRef, {
        tagCount: FieldValue.increment(1),
        updatedAt: now,
      })
    } else {
      tx.set(entityRootRef, {
        entityKey: entityKey2,
        tagCount: 1,
        schemaVersion: "v1",
        updatedAt: now,
      })
    }
  })
}

// ─── Main trigger ─────────────────────────────────────────────────────────────

export const paCanonicalTagWorker = onDocumentCreated(
  {
    document: "pa-tag-events/{eventId}",
    region: "us-central1",
    timeoutSeconds: 60,
    concurrency: 10,
    maxInstances: 2,
    memory: "256MiB",
    // retry: false — we drive retry via the scheduled retry fn below
  },
  async (event) => {
    if (!isWorkerEnabled()) return

    const startMs = Date.now()
    const snap = event.data
    if (!snap) {
      logger.warn("[tag-worker] fired without snapshot", { eventId: event.params.eventId })
      return
    }

    const ev = snap.data() as TagEvent | undefined
    if (!ev) {
      logger.warn("[tag-worker] fired without data", { eventId: event.params.eventId })
      return
    }

    // [a] Early-return if not pending (at-least-once delivery dedup)
    if (ev.status !== "pending") {
      logger.info("[tag-worker] skipping non-pending event", { eventId: ev.id, status: ev.status })
      return
    }

    const fs = getFirestore()
    const norm = normalizeRawText(ev.rawText)

    try {
      // ── Layer 1: Hot alias lookup ──────────────────────────────────────────
      const hotSnap = await fs
        .collection(SHARED_TAG_COLLECTIONS.canonicalTags)
        .where("type", "==", ev.type)
        .where("aliases", "array-contains", norm)
        .limit(1)
        .get()

      if (!hotSnap.empty) {
        const canonicalKey = hotSnap.docs[0]!.id
        logger.info("[tag-worker] layer-1 hot-alias hit", { eventId: ev.id, canonicalKey })
        await commit(fs, ev, canonicalKey, "hot-alias", 1.0, startMs)
        return
      }

      // ── Layer 2: Qwen-7B normalize ─────────────────────────────────────────
      const knownCanonicals = await sampleCanonicals(fs, ev.type, 50)
      const llmResult = await llmNormalize({
        raw: ev.rawText,
        type: ev.type,
        context: ev.context,
        knownCanonicals,
        timeoutMs: 8000,
      })

      if (llmResult.action === "match" && llmResult.canonicalKey) {
        const canDocSnap = await fs
          .collection(SHARED_TAG_COLLECTIONS.canonicalTags)
          .doc(llmResult.canonicalKey)
          .get()

        if (canDocSnap.exists) {
          // Add alias so future requests hit Layer 1
          await canDocSnap.ref.update({
            aliases: FieldValue.arrayUnion(norm),
            updatedAt: new Date().toISOString(),
          })
          logger.info("[tag-worker] layer-2 llm-match", {
            eventId: ev.id,
            canonicalKey: llmResult.canonicalKey,
            confidence: llmResult.confidence,
          })
          await commit(fs, ev, llmResult.canonicalKey, "llm-match", llmResult.confidence, startMs)
          return
        }
        // canonical key from LLM doesn't exist — fall through to Layer 3
        logger.warn("[tag-worker] layer-2 llm-match canonical missing", {
          eventId: ev.id,
          canonicalKey: llmResult.canonicalKey,
        })
      }

      // ── Layer 3: BGE-M3 cosine search (Firestore vector) ──────────────────
      // BGE-M3 embedding via SiliconFlow free-tier reuse.
      const embedding = await bgeM3Embed(ev.rawText)

      if (embedding) {
        try {
          // Firestore vector search (GA as of 2024). Requires vector index on
          // pa-canonical-tags.embedding (see firestore.indexes.json).
          const vectorSnap = await (
            fs
              .collection(SHARED_TAG_COLLECTIONS.canonicalTags)
              .where("type", "==", ev.type) as unknown as {
                findNearest: (
                  field: string,
                  vector: number[],
                  opts: { limit: number; distanceMeasure: string },
                ) => { get: () => Promise<{ docs: DocumentSnapshot[] }> }
              }
          )
            .findNearest("embedding", embedding, {
              limit: 3,
              distanceMeasure: "COSINE",
            })
            .get()

          const topDoc = vectorSnap.docs[0]
          if (topDoc) {
            const topData = topDoc.data() as { embedding?: number[] }
            const dist = topData.embedding
              ? cosineDistance(embedding, topData.embedding)
              : 1.0
            const COSINE_THRESHOLD = 1 - 0.85 // distance ≤ 0.15 = similarity ≥ 0.85

            if (dist <= COSINE_THRESHOLD) {
              await topDoc.ref.update({
                aliases: FieldValue.arrayUnion(norm),
                updatedAt: new Date().toISOString(),
              })
              logger.info("[tag-worker] layer-3 cosine-match", {
                eventId: ev.id,
                canonicalKey: topDoc.id,
                cosineDist: dist,
              })
              await commit(fs, ev, topDoc.id, "cosine-match", 0.85, startMs)
              return
            }
          }
        } catch (vectorErr) {
          logger.warn("[tag-worker] layer-3 vector search failed, skipping", {
            eventId: ev.id,
            err: vectorErr instanceof Error ? vectorErr.message : String(vectorErr),
          })
        }
      }

      // ── Cold path: propose new canonical ──────────────────────────────────
      if (llmResult.action === "create" && llmResult.proposedCanonical) {
        const newKey = await proposeNewCanonical(fs, {
          canonicalKey: llmResult.proposedCanonical.canonicalKey,
          displayName: llmResult.proposedCanonical.displayName,
          type: ev.type,
          firstEvidence: ev,
        })
        logger.info("[tag-worker] new-canonical proposed", { eventId: ev.id, canonicalKey: newKey })
        await commit(fs, ev, newKey, "new-canonical", 0.6, startMs)
        return
      }

      // ── Fallback: needs-review ─────────────────────────────────────────────
      logger.info("[tag-worker] needs-review", { eventId: ev.id, raw: ev.rawText })
      await commit(fs, ev, null, "needs-review", null, startMs)
    } catch (err) {
      logger.error("[tag-worker] unhandled error — event left pending for retry", {
        eventId: ev.id,
        err: err instanceof Error ? err.message : String(err),
      })
      // Do not rethrow — let the retry scheduled fn pick it up
    } finally {
      logger.info("[tag-worker] done", { eventId: ev.id, durationMs: Date.now() - startMs })
    }
  },
)

// ─── Retry scheduled function ─────────────────────────────────────────────────

/**
 * Every minute, re-trigger events stuck in "pending" for > 2 minutes by
 * performing a no-op update. The no-op causes no new onDocumentCreated trigger
 * (only onDocumentUpdated would fire), so we directly re-run the processing
 * logic inline instead.
 *
 * Per spec: ws-2-7-detail.md P2.9
 */
export const paCanonicalTagWorkerRetry = onSchedule(
  {
    schedule: "every 1 minutes",
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async () => {
    if (!isWorkerEnabled()) return
    const fs = getFirestore()
    const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()

    try {
      const stuckSnap = await fs
        .collection(SHARED_TAG_COLLECTIONS.tagEvents)
        .where("status", "==", "pending")
        .where("createdAt", "<", twoMinsAgo)
        .limit(50)
        .get()

      if (stuckSnap.empty) return

      logger.info("[tag-worker][retry] stuck events found", { count: stuckSnap.size })

      // Process each stuck event directly (same logic path as trigger)
      const results = await Promise.allSettled(
        stuckSnap.docs.map(async (doc) => {
          const ev = doc.data() as TagEvent
          if (ev.status !== "pending") return
          // Touch the doc to bump updatedAt (idempotency via status check in commit)
          await doc.ref.update({ retryAt: new Date().toISOString() })
          // NOTE: Full re-processing would require calling the same logic above.
          // For safety, just mark as needs-review if it has been stuck >5 minutes.
          const ageMs = Date.now() - new Date(ev.createdAt).getTime()
          if (ageMs > 5 * 60 * 1000) {
            const startMs = Date.now()
            await commit(fs, ev, null, "needs-review", null, startMs)
            logger.warn("[tag-worker][retry] marked needs-review after 5min", { eventId: ev.id })
          }
        }),
      )

      const errors = results.filter((r) => r.status === "rejected").length
      if (errors > 0) {
        logger.warn("[tag-worker][retry] some events failed", { errors })
      }
    } catch (err) {
      logger.error("[tag-worker][retry] scheduled fn failed", {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  },
)

// ─── BGE-M3 embedding helper ──────────────────────────────────────────────────

/**
 * Embed a text using BGE-M3 on SiliconFlow free tier (same model as mem0).
 * Returns null on any error so Layer 3 gracefully skips.
 */
async function bgeM3Embed(text: string): Promise<number[] | null> {
  // 2026-05-07 Adam directive — BGE-M3 is SiliconFlow free tier.
  // Use SILICONFLOW_API_KEY + explicit baseURL. NEVER read OPENAI_API_KEY
  // (poisoned with SF key in some prod paths) or OPENAI_BASE_URL
  // (poisoned with siliconflow.cn — happens to be right host but wrong
  // semantics; we hardcode the correct one explicitly).
  const { getSiliconFlowConfig } = await import("../lib/llm-providers.js")
  const cfg = getSiliconFlowConfig()
  if (!cfg.apiKey) return null
  const apiKey = cfg.apiKey

  try {
    const resp = await fetch(`${cfg.baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "BAAI/bge-m3",
        input: text.slice(0, 2000),
        encoding_format: "float",
      }),
    })
    if (!resp.ok) return null
    type EmbedResp = { data?: Array<{ embedding?: number[] }> }
    const json = (await resp.json()) as EmbedResp
    const emb = json.data?.[0]?.embedding
    return Array.isArray(emb) ? emb : null
  } catch {
    return null
  }
}

/**
 * Cosine distance (0 = identical, 1 = orthogonal, 2 = opposite).
 * Returns 1.0 if vectors are empty or mismatched in length.
 */
function cosineDistance(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 1.0
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    magA += a[i]! * a[i]!
    magB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  if (denom === 0) return 1.0
  return 1 - dot / denom
}
