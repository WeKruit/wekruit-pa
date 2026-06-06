/**
 * merge-resume-confirm.ts — confirm-first MERGE (not overwrite) for a NEW/additional résumé.
 *
 * Adam-LOCKED principle: "LinkedIn enrich + résumé is a MERGE, NOT an overwrite. A second/additional
 * résumé must NEVER replace/overwrite the existing profile — it MERGES, and the LLM decides how."
 *
 * THE BUG this replaces: the H3 "second-CV OVERWRITE UX" (cv-ingest.ts) staged a new parsed résumé as
 * pending-to-REPLACE and emitted a `resume_overwrite_pending` runtime event that NOTHING repitched, so a
 * LinkedIn-then-résumé candidate (whose Coresignal mirror already wrote a parsedCandidateResumes row)
 * got a confused "wait no — latest resume is live" reply instead of a merge + repitch.
 *
 * THE FIX (this module + cutover wiring + the cv-ingest:2397 canary guard):
 *   1. DETECT an additional résumé on an EXISTING profile (a prior non-archived parsedCandidateResumes
 *      row already exists) → instead of parsing-and-staging-a-replace, send a MERGE-framed confirm bubble
 *      and STAGE the pending résumé (mediaUrl only) in `pa-cv-merge-pending/{userId}`.
 *   2. On ACCEPT (LLM-intent, no regex) → fire the EXISTING `ingestCv` → which (with the canary H3 guard
 *      off) takes the normal write path → `runUserTagsMerge` MERGES LinkedIn experiences + existing tags
 *      + the new résumé → emits `resume_parse_completed` → the existing cv-parsed re-entry repitches with
 *      the MERGED profile. NEVER a replace. NO tombstone. NO promotePendingCv.
 *
 * This module owns ONLY: the pending-doc reducer state (`awaiting_confirm` → `accepted`/`declined`) and
 * the LLM accept/decline/unclear classifier. The merge engine + repitch are REUSED unchanged from
 * cv-ingest.ts (runUserTagsMerge) + cutover.ts (cvParsedReentry → composePitchTurn). Single user-tag
 * writer (D8) preserved: only runUserTagsMerge writes tags. No-regex intent (json_schema STRICT).
 * Reducer owns state; LLM owns only the intent enum + the words.
 */
import type { Firestore } from "firebase-admin/firestore"

/** The merge-pending staging collection. Separate from `pa-cv-pending` (the H3 staged-parse contract). */
export const MERGE_PENDING_COLLECTION = "pa-cv-merge-pending"
const PARSED_RESUMES_COLLECTION = "parsedCandidateResumes"

/** Confirm-first window: a stale awaiting_confirm is dropped (NOT auto-merged) past this. */
export const MERGE_PENDING_TTL_MS = 24 * 60 * 60 * 1000

export type MergePendingStatus = "awaiting_confirm" | "accepted" | "declined"

export interface MergePendingDoc {
  userId: string
  mediaUrl: string
  sessionId: string | null
  status: MergePendingStatus
  createdAt: string
  expireAt: string
}

// Deterministic, reducer-owned copy (NOT LLM-authored). Adam-LOCKED 2026-06-05: when a file arrives and we
// ALREADY have their info, CHECK existing + ASK to merge (never "overwrite"/"replace").
export const MERGE_CONFIRM_BUBBLE =
  "got your résumé 📄 — i already have your experience from LinkedIn on file. want me to read this in and merge it with your profile? 🙌"
/** Deterministic reading-framed ACK for a FIRST résumé (no prior on file) — Adam: "let me read what you send". */
export const MERGE_ACCEPT_ACK =
  "got it — let me read through what you sent 📄, one sec!"
/** Deterministic copy when the candidate DECLINES the merge. */
export const MERGE_DECLINE_REPLY = "all good — keeping your current profile 👍"

/**
 * Does the candidate ALREADY have a prior (non-archived) parsed résumé? If so, a NEW résumé is an
 * ADDITIONAL one → the confirm-first MERGE path (not the zero-friction first-résumé path).
 *
 * A Coresignal/LinkedIn enrich writes a parsedCandidateResumes row (source:"coresignal_collect_v2"), so
 * a LinkedIn-bound candidate who then drops a real résumé returns TRUE here — exactly the case the H3
 * overwrite path used to mis-handle. Fail-CLOSED to `false` (treat as first résumé → no confirm gate) on
 * any read error, so a transient Firestore miss degrades to today's zero-friction behavior, never a wall.
 */
export async function hasPriorParsedResume(db: Firestore, userId: string): Promise<boolean> {
  type DocLike = { id: string; data(): Record<string, unknown> | undefined }
  type SnapLike = { docs: DocLike[] }
  let snap: SnapLike
  try {
    const q = db
      .collection(PARSED_RESUMES_COLLECTION)
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(5)
    snap = (await (q as unknown as { get: () => Promise<SnapLike> }).get()) as SnapLike
  } catch {
    // Index-missing fallback — coarse scan (small N per user). Mirrors defaultFindExistingResume.
    try {
      const q = db.collection(PARSED_RESUMES_COLLECTION).where("userId", "==", userId).limit(20)
      snap = (await (q as unknown as { get: () => Promise<SnapLike> }).get()) as SnapLike
    } catch {
      return false
    }
  }
  for (const d of snap.docs) {
    const data = d.data() ?? {}
    if (data["archived"] === true) continue
    return true
  }
  return false
}

/** Stage the pending résumé awaiting confirm. Best-effort write; overwrites any prior pending for this user. */
export async function stageMergePending(
  db: Firestore,
  args: { userId: string; mediaUrl: string; sessionId: string | null; nowIso: string },
): Promise<void> {
  const expireAt = new Date(new Date(args.nowIso).getTime() + MERGE_PENDING_TTL_MS).toISOString()
  const doc: MergePendingDoc = {
    userId: args.userId,
    mediaUrl: args.mediaUrl,
    sessionId: args.sessionId,
    status: "awaiting_confirm",
    createdAt: args.nowIso,
    expireAt,
  }
  await db.collection(MERGE_PENDING_COLLECTION).doc(args.userId).set(doc, { merge: false })
}

/**
 * Read the OPEN (awaiting_confirm + not expired) merge-pending for this user, or null.
 * A stale awaiting_confirm (past TTL) returns null — confirm-first means a timeout NEVER auto-merges.
 */
export async function readOpenMergePending(
  db: Firestore,
  userId: string,
  now: number = Date.now(),
): Promise<MergePendingDoc | null> {
  try {
    const snap = await db.collection(MERGE_PENDING_COLLECTION).doc(userId).get()
    if (!snap.exists) return null
    const d = (snap.data() ?? {}) as Record<string, unknown>
    if (d.status !== "awaiting_confirm") return null
    const mediaUrl = typeof d.mediaUrl === "string" ? d.mediaUrl : ""
    if (!mediaUrl) return null
    const expireAtRaw = typeof d.expireAt === "string" ? d.expireAt : null
    if (expireAtRaw) {
      const expireAt = Date.parse(expireAtRaw)
      if (Number.isFinite(expireAt) && now > expireAt) return null // stale → ignore (no auto-merge)
    }
    return {
      userId,
      mediaUrl,
      sessionId: typeof d.sessionId === "string" ? d.sessionId : null,
      status: "awaiting_confirm",
      createdAt: typeof d.createdAt === "string" ? d.createdAt : "",
      expireAt: expireAtRaw ?? "",
    }
  } catch {
    return null
  }
}

/** Move the pending to a terminal status. Best-effort. */
export async function setMergePendingStatus(
  db: Firestore,
  userId: string,
  status: "accepted" | "declined",
  nowIso: string,
): Promise<void> {
  try {
    await db
      .collection(MERGE_PENDING_COLLECTION)
      .doc(userId)
      .set(
        { status, [status === "accepted" ? "acceptedAt" : "declinedAt"]: nowIso },
        { merge: true },
      )
  } catch {
    /* best-effort — a stuck pending self-heals via TTL on the next inbound */
  }
}

export type MergeConfirmIntent = "accept_merge" | "decline_merge" | "unclear"

export interface MergeConfirmClassification {
  intent: MergeConfirmIntent
  confidence: number
}

/** Test seam: swap the LLM classifier. Production default hits gpt-5.4-mini json_schema STRICT. */
export type MergeConfirmClassifier = (text: string) => Promise<MergeConfirmClassification>

const MERGE_CONFIRM_SYSTEM = [
  "You classify a single candidate reply to ONE question: Claire just asked 'want me to fold your new résumé into your profile and re-pitch you?'.",
  "Decide the candidate's intent toward that merge offer. Output STRICT JSON: { intent, confidence }.",
  "intent is EXACTLY one of:",
  "  accept_merge  — they say yes / go ahead / sure / do it / fold it in / please / sounds good / 好的.",
  "  decline_merge — they say no / don't / leave it / keep what I have / not now / actually no.",
  "  unclear       — anything else: a question, an unrelated message, a new preference, small talk, or ambiguous.",
  "confidence is 0..1 (your certainty in the chosen intent).",
  "Judge MEANING, not keywords. 'yeah do that' = accept_merge; 'what's the salary?' = unclear; 'nah keep it' = decline_merge.",
].join("\n")

/**
 * The production classifier — a single gpt-5.4-mini call with json_schema STRICT. No regex (LLM picks an
 * enum, which the no-regex rule explicitly allows). Fail-open to `{ unclear, 0 }` on any error so a model
 * miss degrades to normal triage (the agent answers naturally; the pending stays open until TTL) — it
 * NEVER auto-merges and NEVER auto-declines.
 */
export const defaultMergeConfirmClassifier: MergeConfirmClassifier = async (text) => {
  const fallback: MergeConfirmClassification = { intent: "unclear", confidence: 0 }
  try {
    const { getOpenAIConfig } = await import("../lib/llm-providers.js")
    const cfg = getOpenAIConfig()
    if (!cfg.apiKey) return fallback
    const baseURL = process.env.PA_OPENAI_AGENT_BASE_URL?.trim() || cfg.baseURL
    const { default: OpenAI } = (await import("openai")) as unknown as {
      default: new (init: { apiKey: string; baseURL?: string }) => {
        responses: {
          create: (req: Record<string, unknown>) => Promise<{
            output_text?: string
            output?: Array<{ content?: Array<{ text?: string }> }>
          }>
        }
      }
    }
    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL })
    const resp = await client.responses.create({
      model: "gpt-5.4-mini",
      input: [
        { role: "system", content: MERGE_CONFIRM_SYSTEM },
        { role: "user", content: text },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "merge_confirm",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              intent: { type: "string", enum: ["accept_merge", "decline_merge", "unclear"] },
              confidence: { type: "number" },
            },
            required: ["intent", "confidence"],
          },
        },
      },
    })
    const raw =
      typeof resp.output_text === "string" && resp.output_text.trim()
        ? resp.output_text.trim()
        : Array.isArray(resp.output) && resp.output[0]?.content?.[0]?.text
          ? resp.output[0]!.content![0]!.text!.trim()
          : ""
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as { intent?: unknown; confidence?: unknown }
    const intent =
      parsed.intent === "accept_merge" || parsed.intent === "decline_merge" ? parsed.intent : "unclear"
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0
    return { intent, confidence }
  } catch {
    return fallback
  }
}

/** Accept threshold: below this, an `accept_merge` is treated as unclear (fall through to triage). */
export const MERGE_ACCEPT_CONFIDENCE = 0.6
