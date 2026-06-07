/**
 * Prescreen-NURTURE — Composer / context builder.
 *
 * Builds the structured facts that Claire's runtime uses to compose a natural,
 * personalized "still working on it" check-in. This module NEVER writes
 * candidate-visible copy — it only assembles facts (job title, company, where
 * in the pipeline, language). Claire composes the actual message in her voice
 * via the runtime-event-handoff path, so every nurture varies naturally and is
 * never a hardcoded template.
 *
 * Personalization comes from the per-session facts here: the actual job title +
 * company the candidate prescreened for, the nurture ordinal (so the 3rd
 * check-in can read differently from the 1st), and the pipeline stage. The
 * runtime instruction (built here) tells Claire to keep it brief + warm, make
 * NO promises, and emit `__NO_SEND__` if a check-in would be inappropriate.
 */

import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"

const PRESCREEN_SESSIONS = "pa-prescreen-sessions"
const MATCHING_JOBS = "matching-jobs"

/** Pipeline-stage label fed to Claire so the copy can reference where we are. */
export const NURTURE_PIPELINE_STAGE = "awaiting_wekruit_review"

export interface PrescreenNurtureContext {
  /** Structured facts for the runtime event — Claire composes from these. */
  eventKind: "prescreen_review_nurture_v1"
  candidateId: string
  jobId: string
  sessionId: string
  nurturingNumber: number
  pipelineStage: typeof NURTURE_PIPELINE_STAGE
  jobTitle?: string
  companyName?: string
  /** Best-effort candidate language hint (default "en"). */
  preferredLanguage: string
  /** Natural-language instruction the runtime hands to Claire. */
  instruction: string
}

export interface NurtureComposerStore {
  /** Job title + company for the opportunity. Empty fields if missing. */
  fetchJob(jobId: string): Promise<{ title?: string; company?: string }>
  /** Session score snapshot (unused in copy, kept for future tuning). */
  fetchSessionScore(sessionId: string): Promise<{ score?: number; scoreMax?: number }>
  /** Candidate's preferred language. undefined if unknown. */
  fetchPreferredLanguage(userId: string): Promise<string | undefined>
}

/**
 * Build the runtime instruction. Brief warmth update; explicitly NO promises;
 * varied wording (Claire owns the phrasing); allow `__NO_SEND__` escape.
 */
export function buildNurtureInstruction(args: {
  jobTitle?: string
  companyName?: string
  nurturingNumber: number
}): string {
  const role =
    args.jobTitle && args.companyName
      ? `the ${args.jobTitle} role at ${args.companyName}`
      : args.companyName
        ? `the role at ${args.companyName}`
        : args.jobTitle
          ? `the ${args.jobTitle} role`
          : "the role they interviewed for"
  return [
    `The candidate finished their first interview for ${role} and is waiting on us while we evaluate, pitch them to the hiring team, and connect with the hiring manager for feedback.`,
    `Send a brief, warm check-in (1-2 sentences) that reassures them we're still actively working on it — e.g. still evaluating, connecting with the hiring manager, expecting an update soon.`,
    `This is check-in #${args.nurturingNumber}; vary your wording naturally so it never sounds templated or repetitive.`,
    `Make NO promises about the outcome, timeline guarantees, or that they passed. Do not invent new information. Do not restate internal scores or system wording.`,
    `If a check-in would be inappropriate right now (e.g. nothing warm to say, or it would feel pushy), reply exactly __NO_SEND__.`,
  ].join(" ")
}

/**
 * Assemble the personalized context facts for a single nurture dispatch.
 * Fail-open: any failed read degrades to a less-specific (but still valid)
 * instruction rather than throwing.
 */
export async function buildPrescreenNurtureContext(
  store: NurtureComposerStore,
  args: { candidateId: string; jobId: string; sessionId: string; nurturingNumber: number }
): Promise<PrescreenNurtureContext> {
  let title: string | undefined
  let company: string | undefined
  try {
    const job = await store.fetchJob(args.jobId)
    title = job.title
    company = job.company
  } catch {
    /* fail-open: less-specific instruction */
  }

  let preferredLanguage = "en"
  try {
    const lang = await store.fetchPreferredLanguage(args.candidateId)
    if (lang && lang.trim()) preferredLanguage = lang.trim()
  } catch {
    /* default en */
  }

  // Read but do not surface raw score in copy (kept for future tuning / audit).
  try {
    await store.fetchSessionScore(args.sessionId)
  } catch {
    /* optional */
  }

  return {
    eventKind: "prescreen_review_nurture_v1",
    candidateId: args.candidateId,
    jobId: args.jobId,
    sessionId: args.sessionId,
    nurturingNumber: args.nurturingNumber,
    pipelineStage: NURTURE_PIPELINE_STAGE,
    ...(title ? { jobTitle: title } : {}),
    ...(company ? { companyName: company } : {}),
    preferredLanguage,
    instruction: buildNurtureInstruction({
      jobTitle: title,
      companyName: company,
      nurturingNumber: args.nurturingNumber,
    }),
  }
}

// ---------------------------------------------------------------------------
// Firestore-backed composer store
// ---------------------------------------------------------------------------

function cleanStr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const t = value.trim()
  return t ? t : undefined
}

export function createFirestoreNurtureComposerStore(db: Firestore): NurtureComposerStore {
  return {
    async fetchJob(jobId) {
      // Matching opportunity lives in matching-jobs; fall back to pa-jobs.
      for (const col of [MATCHING_JOBS, PA_COLLECTIONS.jobs]) {
        try {
          const snap = await db.collection(col).doc(jobId).get()
          if (!snap.exists) continue
          const data = (snap.data() ?? {}) as Record<string, unknown>
          const title =
            cleanStr(data.title) ?? cleanStr(data.jobTitle) ?? cleanStr(data.roleTitle)
          const company =
            cleanStr(data.company) ??
            cleanStr(data.companyName) ??
            cleanStr(data.employer) ??
            cleanStr(data.employerName)
          if (title || company) return { title, company }
        } catch {
          /* try next collection */
        }
      }
      return {}
    },

    async fetchSessionScore(sessionId) {
      const snap = await db.collection(PRESCREEN_SESSIONS).doc(sessionId).get()
      if (!snap.exists) return {}
      const data = (snap.data() ?? {}) as Record<string, unknown>
      return {
        score: typeof data.score === "number" ? data.score : undefined,
        scoreMax: typeof data.scoreMax === "number" ? data.scoreMax : undefined,
      }
    },

    async fetchPreferredLanguage(userId) {
      const snap = await db.collection(PA_COLLECTIONS.users).doc(userId).get()
      if (!snap.exists) return undefined
      const data = (snap.data() ?? {}) as Record<string, unknown>
      return cleanStr(data.preferredLanguage) ?? cleanStr(data.language)
    },
  }
}
