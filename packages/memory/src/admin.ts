import type { Firestore } from "firebase-admin/firestore"
import { FieldValue } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

// iter30 WS2 tag-pipeline collection names. Hard-coded here (rather than
// importing `@wekruit/shared-tags`) to avoid a circular dep — `@pa/memory`
// is consumed by far more than the tag layer, and `shared-tags` may be
// extracted to a separate repo (GH Packages publish in iter30 W2).
const PA_TAG_EVENTS = "pa-tag-events"
const PA_ENTITY_TAGS = "pa-entity-tags"
/** EntityRef.kind for PA users — matches `@wekruit/shared-tags` types.ts. */
const ENTITY_KIND_PA_USER = "pa-user"

// iter30 closure (Adam directive 2026-05-04 "只能删 pa- 的, 不能删了别的本身
// 的 user 的"): resume-related Firestore surfaces in the pa-* namespace.
// `pa-cv-pending` is the PA-owned stage-and-confirm overwrite holding bay
// (CV_PENDING_COLLECTION in apps/functions/src/cv-ingest/cv-ingest.ts:240).
//
// 2026-05-06 P9 update (Adam directive iter23 + bug-fix-2 spec):
//   `parsedCandidateResumes` IS now also cleared on full reset (keepMessages
//   = false). Rationale: __PA_RESET__ is gated upstream to testMode users +
//   admin allowlist (orchestrator's maybeHandleResetCommand checks before
//   calling clearUserMemory). Production users never trigger the magic
//   string. The cross-product concern from iter30 was about deleting OTHER
//   users' rows — `where("userId", "==", userId)` only touches this user's
//   resumes. The Adam-acknowledged win: re-onboarding biz tests no longer
//   leak "我已经看过你两份简历了" (quota_exhausted) from prior runs.
const PA_CV_PENDING = "pa-cv-pending"
const PARSED_CANDIDATE_RESUMES = "parsedCandidateResumes"

/**
 * Single source of truth for clearing all PA memory belonging to one user.
 * Consumed by:
 *   - `scripts/pa-clear-user.mjs` (CLI for harness re-runs)
 *   - `pa-orchestrator` (in-band magic-string trigger for test users)
 *   - Phase 3 Memory Admin dashboard (HTTP wrapper)
 *
 * Always clears (memory plane):
 *   - Qdrant `pa-memory` (semantic memory)
 *   - `pa-memory-facts`, `pa-memory-actions`, `pa-memory-events`
 *   - iter30 v2 surfaces: `pa-memory-profiles`, `pa-memory-evolution-events`,
 *     `pa-conversation-summaries`, `pa-message-archives`, `pa-surprise-events`
 *   - iter30 WS2 tag pipeline: `pa-tag-events` (where userId), and
 *     `pa-entity-tags/pa-user:{userId}` doc + `items` subcollection
 *
 * With `keepMessages: false` (default) also clears `pa-messages`,
 * `pa-agent-turns`, `pa-turns`.
 *
 * User-record reset (iter30 closure — Adam directive 2026-05-03 "我们 __PA_RESET__
 * 也需要清楚相关tag等memory包括mem0所有的"):
 *   When `keepMessages` is false (full reset path), also resets these
 *   `pa-users/{userId}` fields so the next inbound re-runs onboarding cleanly:
 *     - onboardingState → "pending"
 *     - statedPreferences → cleared
 *     - resumeAccepted → cleared
 *     - resumeId → cleared
 *     - 2026-05-06 P9 additions:
 *       - tags → cleared (else stale preferredLang / industrySector /
 *         skills leak into a fresh onboarding session — the bilingual
 *         leak Adam saw "English in q_lang but bot replied in 中文")
 *       - resumeParseCount + resumeParseLastAt → cleared (else CV quota
 *         counter from prior session triggers quota_exhausted reject on
 *         the FIRST resume of the new session — the "我已经看过你两份
 *         简历了" leak)
 *
 * Collection wipe (2026-05-06 P9 addition):
 *   On full reset, also batch-deletes every `parsedCandidateResumes`
 *   doc where `userId == ${userId}`. Upstream gate (testMode/admin
 *   allowlist in maybeHandleResetCommand) ensures only PA-test-user
 *   rows are affected — never the cross-product main hiring data.
 *
 * Never touches: `pa-sessions`, `pa-inbound-events`, `pa-outbound`. The
 * user record + session id are preserved so the next iMessage from the
 * same handle reuses the same Firestore identity.
 */
export type ClearUserMemoryDeps = {
  db: Firestore
  qdrantUrl: string
  qdrantApiKey: string
  qdrantCollection?: string
  /** Override fetch (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch
  logger?: (...args: unknown[]) => void
}

export type ClearUserMemoryOptions = {
  /** When true, leave pa_messages and turn collections alone. */
  keepMessages?: boolean
  /** When true, count what would be deleted but write nothing. */
  dryRun?: boolean
  /**
   * Phase 11.3 — Mem0/Qdrant partition key. When supplied, the Qdrant
   * filter `user_id` uses this value instead of `userId`. Firestore
   * deletes ALWAYS scope on `userId` (Firestore is the canonical
   * `userId`-keyed surface; see 11-IDENTITY-CONTRACT.md §3.1).
   *
   * Pass `resolveMem0PartitionKey(user)` from `@pa/memory` — never read
   * `User.mem0UserId` directly.
   *
   * When omitted, behavior is byte-identical to pre-11.3
   * (`user_id == userId`), which is correct for backfilled users.
   */
  mem0PartitionKey?: string
}

export type ClearUserMemoryResult = {
  userId: string
  dryRun: boolean
  qdrant: { collection: string; matched: number; deleted: boolean }
  firestore: Record<string, number>
  /**
   * 2026-05-06 P9 — user-doc field reset markers. Surfaced in
   * summarizeClearResult so operators can see what fields were cleared
   * (vs collection deletion counts in `firestore`). Empty on dryRun.
   */
  userDocReset?: {
    tags: boolean
    resumeParseCount: boolean
    onboardingState: boolean
    pipelineState?: boolean
  }
}

// mem0/Qdrant convention — snake_case. Live Qdrant collection is
// `pa_memory`; Firestore (separate system) uses kebab. Do NOT change
// without migrating Qdrant points.
const DEFAULT_QDRANT_COLLECTION = "pa_memory"

function noop() {}

async function clearQdrantForUser(
  userId: string,
  deps: ClearUserMemoryDeps,
  dryRun: boolean,
  partitionKey?: string
): Promise<{ collection: string; matched: number; deleted: boolean }> {
  const collection = deps.qdrantCollection ?? DEFAULT_QDRANT_COLLECTION
  const url = deps.qdrantUrl.replace(/\/+$/, "")
  const fetchFn = deps.fetch ?? fetch
  // Phase 11.3: when caller supplies a non-empty partition key, use it for
  // the Qdrant filter. Otherwise fall back to userId (legacy / byte-identical).
  const qdrantKey =
    typeof partitionKey === "string" && partitionKey.trim().length > 0
      ? partitionKey.trim()
      : userId
  const filter = { must: [{ key: "user_id", match: { value: qdrantKey } }] }
  const headers = { "api-key": deps.qdrantApiKey, "content-type": "application/json" }

  const countResp = await fetchFn(`${url}/collections/${collection}/points/count`, {
    method: "POST",
    headers,
    body: JSON.stringify({ filter, exact: true }),
  })
  if (!countResp.ok) {
    throw new Error(`Qdrant count failed: ${countResp.status} ${await countResp.text()}`)
  }
  const countJson = (await countResp.json()) as { result?: { count?: number } }
  const matched = countJson.result?.count ?? 0
  if (dryRun || matched === 0) return { collection, matched, deleted: false }

  const delResp = await fetchFn(`${url}/collections/${collection}/points/delete?wait=true`, {
    method: "POST",
    headers,
    body: JSON.stringify({ filter }),
  })
  if (!delResp.ok) {
    throw new Error(`Qdrant delete failed: ${delResp.status} ${await delResp.text()}`)
  }
  return { collection, matched, deleted: true }
}

async function clearFirestoreCollection(
  db: Firestore,
  collection: string,
  userId: string,
  dryRun: boolean,
  alsoMatchPhone?: string
): Promise<number> {
  // Primary: docs with userId stamped.
  const seen = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>()
  const primary = await db.collection(collection).where("userId", "==", userId).get()
  for (const d of primary.docs) seen.set(d.id, d)

  // 2026-05-07 — defensive secondary sweep keyed on phone. Some legacy
  // synthetic events (paMessageCoalescer pre-iter32) wrote `from` /
  // `externalChatId` BEFORE userId resolution, leaving stale inbound docs
  // with userId unset. Adam reset on 2026-05-07 hit this: 4 stale events
  // from 2026-05-04 survived `where userId == X`, then a fresh "Agree"
  // turn collided on idempotencyKey `coalesced-{userId}-{turnSeq}` and the
  // broker returned the stale succeeded doc → orchestrator skipped → no
  // reply. Catch-all by phone here closes that hole.
  if (alsoMatchPhone) {
    for (const field of ["from", "externalChatId"]) {
      try {
        const sec = await db.collection(collection).where(field, "==", alsoMatchPhone).get()
        for (const d of sec.docs) if (!seen.has(d.id)) seen.set(d.id, d)
      } catch {
        /* missing index for one field is not fatal — userId path still works */
      }
    }
    // rawPayload.participant covers some old shapes
    try {
      const sec = await db.collection(collection).where("rawPayload.participant", "==", alsoMatchPhone).get()
      for (const d of sec.docs) if (!seen.has(d.id)) seen.set(d.id, d)
    } catch {
      /* index optional */
    }
  }

  const docs = Array.from(seen.values())
  if (dryRun || docs.length === 0) return docs.length
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch()
    for (const doc of docs.slice(i, i + 400)) batch.delete(doc.ref)
    await batch.commit()
  }
  return docs.length
}

/**
 * iter30 WS2 — clear a user's entity-tags root doc + `items` subcollection.
 *
 * Keyed on `pa-entity-tags/pa-user:{userId}` per shared-tags entityKey
 * convention. Returns the count of items deleted (root doc not counted).
 */
async function clearEntityTagsForUser(
  db: Firestore,
  userId: string,
  dryRun: boolean
): Promise<number> {
  const entityKey = `${ENTITY_KIND_PA_USER}:${userId}`
  const rootRef = db.collection(PA_ENTITY_TAGS).doc(entityKey)
  const itemsSnap = await rootRef.collection("items").get()
  if (dryRun) return itemsSnap.size
  if (!itemsSnap.empty) {
    for (let i = 0; i < itemsSnap.docs.length; i += 400) {
      const batch = db.batch()
      for (const doc of itemsSnap.docs.slice(i, i + 400)) batch.delete(doc.ref)
      await batch.commit()
    }
  }
  // Best-effort root-doc delete. .delete() is a no-op on missing doc.
  try {
    await rootRef.delete()
  } catch {
    /* swallow — root doc may not exist when the user never produced tags */
  }
  return itemsSnap.size
}

/**
 * iter30 closure — reset onboarding + resume state on the user record so
 * the next inbound after a `__PA_RESET__` re-runs the 5-question probe
 * cleanly (Adam directive 2026-05-03).
 *
 * Never throws — wrapped in caller try/catch and logged. Skipped on dryRun.
 */
async function resetUserOnboardingState(
  db: Firestore,
  userId: string,
  dryRun: boolean
): Promise<{ reset: boolean }> {
  if (dryRun) return { reset: false }
  await db
    .collection(PA_COLLECTIONS.users)
    .doc(userId)
    .set(
      {
        onboardingState: "pending",
        onboardingStep: FieldValue.delete(),
        statedPreferences: FieldValue.delete(),
        resumeAccepted: FieldValue.delete(),
        resumeId: FieldValue.delete(),
        lastAssistantTurnAskedResume: FieldValue.delete(),
        // iter34 P0.6 closure (Adam directive 2026-05-05) — reset must also
        // clear the per-probe attempt counter and onboarding-related
        // systemFlags. Otherwise:
        //   1. probe attempts persist across reset → user halts on attempt
        //      3-4 of next walkthrough instead of 5
        //   2. systemFlags.onboardingHalted=true persists → user is
        //      permanently stuck even after admin reset
        // The only writers to systemFlags are the onboarding probe re-ask
        // path (irrelevant-pattern + halted), so nuking the whole subdoc
        // is safe today. If new non-onboarding flags get added later, switch
        // to .update() with field-path FieldValue.delete().
        onboardingProbeAttempts: FieldValue.delete(),
        systemFlags: FieldValue.delete(),
        // 2026-05-07 onboarding-refactor reset bug — the Q-as-class
        // pipeline stores its own cursor separately from legacy
        // onboardingState. If this survives reset, the next "first" message
        // resumes at the old currentQId (e.g. q_tos) even though
        // onboardingState is back to pending.
        pipelineState: FieldValue.delete(),
        // 2026-05-06 P9 — full reset must also clear:
        //   - tags (D8 unified-tag store, prevents preferredLang / skills /
        //     industrySector leakage into a fresh re-onboarding session)
        //   - resumeParseCount + resumeParseLastAt (CV quota counter — else
        //     biz-test re-uploads hit quota_exhausted and Claire rejects
        //     with "我已经看过你两份简历了 / I've read two of your resumes"
        //     even though parsedCandidateResumes was just nuked)
        //   - preferredLang (top-level field; legacy users had this before
        //     Phase 52 moved it under `tags`)
        tags: FieldValue.delete(),
        resumeParseCount: FieldValue.delete(),
        resumeParseLastAt: FieldValue.delete(),
        preferredLang: FieldValue.delete(),
        // 2026-05-07 — Adam reset live test surfaced 4 more leakers. Must clear:
        //   - onboardedAt (timestamp — leaving it makes orchestrator skip
        //     onboarding scenes thinking user already done)
        //   - onboardingStatus ("active"|"completed" → leaves user stuck in
        //     post-onboarding flow even after onboardingState="pending")
        //   - tosAcceptance (bot skips terms-agreement step → user reset
        //     wasn't truly fresh)
        //   - voiceStylePreference (emoji_tolerance / zh_en_mix / register
        //     persisted from prior session, biases new conversation tone)
        //   - lastAssistantTurnAt + coalesceLastFiredAt + coalesceTurnSeq
        //     (turn-counters, otherwise post-reset turn 1 looks like turn 85)
        onboardedAt: FieldValue.delete(),
        onboardingStatus: FieldValue.delete(),
        tosAcceptance: FieldValue.delete(),
        voiceStylePreference: FieldValue.delete(),
        lastAssistantTurnAt: FieldValue.delete(),
        coalesceLastFiredAt: FieldValue.delete(),
        coalesceTurnSeq: FieldValue.delete(),
        emailVerification: FieldValue.delete(),
        "emailVerification.attempts": FieldValue.delete(),
        // 2026-05-07 Bug A fix — bump resetEpoch so any future synthetic
        // inbound event after this reset uses a fresh idempotencyKey
        // namespace (`coalesced-{userId}-e{epoch}-{turnSeq}` vs the old
        // collision-prone `coalesced-{userId}-{turnSeq}`). Stale succeeded
        // synthetic docs from prior session will never intercept new turns.
        resetEpoch: FieldValue.increment(1),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    )
  return { reset: true }
}

export async function clearUserMemory(
  userId: string,
  deps: ClearUserMemoryDeps,
  options: ClearUserMemoryOptions = {}
): Promise<ClearUserMemoryResult> {
  const log = deps.logger ?? noop
  const dryRun = options.dryRun === true
  const keepMessages = options.keepMessages === true
  log(`[clear-user] userId=${userId} dryRun=${dryRun} keepMessages=${keepMessages}`)

  const qdrant = await clearQdrantForUser(userId, deps, dryRun, options.mem0PartitionKey)
  log(`[clear-user] qdrant matched=${qdrant.matched} deleted=${qdrant.deleted}`)

  const firestore: Record<string, number> = {}
  // Memory plane — always cleared. iter30 closure (Adam directive
  // 2026-05-04 "这个 clear 要 clear 完, 要不然我们测试 biz test 不能测") —
  // every PA-namespaced collection with a userId field gets cleared so a
  // reset user is a true blank slate for biz testing.
  //
  // SCOPE: only pa-* prefixed collections are cleared. The cross-product
  // shared `parsedCandidateResumes` (NO pa- prefix) is NOT cleared because
  // deleting from it would clobber non-PA candidate rows owned by the
  // main hiring product.
  const memoryCollections = [
    PA_COLLECTIONS.memoryFacts,
    PA_COLLECTIONS.memoryActions,
    PA_COLLECTIONS.memoryEvents,
    PA_COLLECTIONS.memoryProfiles,
    PA_COLLECTIONS.memoryEvolutionEvents,
    PA_COLLECTIONS.conversationSummaries,
    PA_COLLECTIONS.messageArchives,
    PA_COLLECTIONS.surpriseEvents,
    // iter30 WS2 — tag pipeline events (entity-tags is a subcollection,
    // handled separately below).
    PA_TAG_EVENTS,
    // iter30 closure — PA-owned resume surface (pending overwrite holding
    // bay). Original PDF blob lives in Sendblue's storage (external).
    PA_CV_PENDING,
    // iter30 closure — biz-test isolation surfaces (every pa-* collection
    // with a userId field). Without these, a reset user retains stale
    // abuse-events / rate-limits / job-rec output / tapback history,
    // which contaminates biz E2E runs.
    "pa-abuse-events",
    "pa-rate-limits",
    "pa-job-profiles",
    "pa-job-rec-explanations",
    "pa-tapback-events",
    "pa-scheduled-jobs",
    "pa-tool-calls",
  ]
  for (const c of memoryCollections) {
    firestore[c] = await clearFirestoreCollection(deps.db, c, userId, dryRun)
    log(`[clear-user] firestore ${c}: ${firestore[c]}`)
  }
  // iter30 WS2 — entity-tags `pa-entity-tags/pa-user:{userId}/items/*`.
  // Different shape (subcollection under per-entity root doc), so it gets
  // its own helper. Bucketed under PA_ENTITY_TAGS in the result for
  // operator visibility.
  firestore[PA_ENTITY_TAGS] = await clearEntityTagsForUser(deps.db, userId, dryRun)
  log(`[clear-user] firestore ${PA_ENTITY_TAGS}: ${firestore[PA_ENTITY_TAGS]} items`)

  let userDocReset: ClearUserMemoryResult["userDocReset"] | undefined
  if (!keepMessages) {
    // Full transcript wipe — biz test must see a clean conversation
    // history. Inbound + outbound queues are cleared as part of this
    // bucket because the dashboard surfaces them as "conversation history"
    // for the operator.
    const transcriptCollections = [
      PA_COLLECTIONS.messages,
      PA_COLLECTIONS.agentTurns,
      PA_COLLECTIONS.turns,
      PA_COLLECTIONS.inboundEvents,
      PA_COLLECTIONS.outbound,
    ]
    // Resolve user phoneE164 once — used for defensive sweep on inbound /
    // outbound (catches stale legacy synthetic docs that lack userId).
    let userPhone: string | undefined
    try {
      const u = await deps.db.collection(PA_COLLECTIONS.users).doc(userId).get()
      const p = u.data()?.phoneE164 || u.data()?.phone
      if (typeof p === "string" && p.length > 0) userPhone = p
    } catch {
      /* pre-existence check optional */
    }
    for (const c of transcriptCollections) {
      const usePhone =
        c === PA_COLLECTIONS.inboundEvents || c === PA_COLLECTIONS.outbound
          ? userPhone
          : undefined
      firestore[c] = await clearFirestoreCollection(deps.db, c, userId, dryRun, usePhone)
      log(`[clear-user] firestore ${c}: ${firestore[c]}`)
    }
    // 2026-05-06 P9 — parsedCandidateResumes wipe (Adam directive: full
    // reset must clear CV records so re-onboarding doesn't see "我已经看
    // 过你两份简历了 / quota_exhausted" stale state). Scoped via
    // `where("userId", "==", userId)` — never touches OTHER users' rows.
    // Upstream gate (maybeHandleResetCommand testMode/admin allowlist)
    // already ensures only test/admin users reach this code path.
    firestore[PARSED_CANDIDATE_RESUMES] = await clearFirestoreCollection(
      deps.db,
      PARSED_CANDIDATE_RESUMES,
      userId,
      dryRun
    )
    log(
      `[clear-user] firestore ${PARSED_CANDIDATE_RESUMES}: ${firestore[PARSED_CANDIDATE_RESUMES]}`
    )
    // iter30 closure — full reset re-arms onboarding probe so the next
    // inbound triggers the 5Q chain again (Adam: 我们 __PA_RESET__ 也需要
    // 清楚相关tag等memory包括mem0所有的, 主动问简历).
    //
    // 2026-05-06 P9 — also clears `tags`, `resumeParseCount`,
    // `resumeParseLastAt`, top-level `preferredLang`. See
    // resetUserOnboardingState for the field list.
    try {
      const r = await resetUserOnboardingState(deps.db, userId, dryRun)
      log(`[clear-user] user-record onboarding reset: ${r.reset}`)
      if (r.reset) {
        userDocReset = {
          tags: true,
          resumeParseCount: true,
          onboardingState: true,
          pipelineState: true,
        }
      }
    } catch (err) {
      log(`[clear-user] user-record reset FAILED: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { userId, dryRun, qdrant, firestore, userDocReset }
}

/**
 * Magic-string trigger detection. When a test user (user.testMode === true)
 * sends one of these patterns as their entire message, the orchestrator
 * should run `clearUserMemory` and reply with a confirmation instead of
 * routing to the LLM.
 *
 * Patterns are intentionally redundant: ASCII admin form, slash form, and
 * Chinese verbatim. Match is full-string after trim, case-insensitive for
 * the ASCII forms.
 */
export const RESET_PATTERNS = ["__PA_RESET__", "/pa-reset", "重置我的记忆"] as const

export function isResetCommand(body: string): boolean {
  const trimmed = body.trim()
  if (trimmed.length === 0) return false
  for (const p of RESET_PATTERNS) {
    if (trimmed === p) return true
    // ASCII patterns also accept upper-cased variants
    if (/^[\x00-\x7F]+$/.test(p) && trimmed.toLowerCase() === p.toLowerCase()) return true
  }
  return false
}

/** Operator-facing summary, included in the reply outbound. */
export function summarizeClearResult(r: ClearUserMemoryResult): string {
  const fsParts = Object.entries(r.firestore)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${c}=${n}`)
    .join(", ")
  const fsBlock = fsParts.length > 0 ? fsParts : "all empty"
  const qd = `${r.qdrant.collection}=${r.qdrant.matched}`
  // 2026-05-06 P9 — surface user-doc field resets so operators see the
  // tags/quota wipe explicitly. e.g. "tags=cleared, quota=cleared".
  let userDocBlock = ""
  if (r.userDocReset) {
    const parts: string[] = []
    if (r.userDocReset.tags) parts.push("tags=cleared")
    if (r.userDocReset.resumeParseCount) parts.push("quota=cleared")
    if (r.userDocReset.onboardingState) parts.push("onboarding=reset")
    if (r.userDocReset.pipelineState) parts.push("pipeline=reset")
    if (parts.length > 0) userDocBlock = `; user-doc ${parts.join(", ")}`
  }
  return r.dryRun
    ? `[DRY-RUN] would clear: qdrant ${qd}; firestore ${fsBlock}${userDocBlock}`
    : `✓ 测试记忆已清空 — qdrant ${qd}; firestore ${fsBlock}${userDocBlock}`
}
