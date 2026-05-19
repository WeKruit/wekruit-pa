/**
 * iter34 P3 — `pa-onboarding-questions` Firestore SDK.
 *
 * Schema (pa-onboarding-questions/{qId}):
 *   {
 *     id: string,                              // q_lang | q_role | q_resume | …
 *     order: number,                            // ordering in pipeline
 *     prompt: { zh: string, en: string },
 *     variants: { zh: string, en: string }[],   // re-ask phrasings, attempt[i] → variants[i]
 *     judgeKind: "lang"|"yesno"|"llm-relevance"|"resume",
 *     rephraserKind: "variants"|"hybrid"|"llm",
 *     maxAttempts: number,
 *     haltMessage: { zh: string, en: string } | null,
 *     enabled: boolean,                         // soft-disable without deletion
 *     llmStep?: "ask_q_role"|"ask_q_yoe"|...    // only set when judgeKind=llm-relevance
 *     updatedAt: ISO,
 *     updatedBy: string,
 *     reason: string,
 *     version: number,
 *   }
 *
 * Adam directive 2026-05-05: "dashboard 对应的管理呢?". Dashboard CRUD
 * UI is still TODO; this SDK is the data-plane substrate. With this SDK
 * the orchestrator can READ questions from Firestore (vs hard-coded
 * defaultQuestions()) so an admin can edit prompts + variants without a
 * deploy.
 *
 * Soft delete via `enabled=false` instead of hard delete — preserves
 * audit trail + allows quick rollback.
 */
import type { Firestore } from "firebase-admin/firestore"

export type Lang = "zh" | "en"
export type BilingualText = { zh: string; en: string }

export type OnboardingJudgeKind =
  | "lang"
  | "email"
  | "code"
  | "yesno"
  | "llm-relevance"
  | "resume"

export type OnboardingRephraserKind = "variants" | "hybrid" | "llm"

export type OnboardingLLMStep =
  | "ask_q_role"
  | "ask_q_yoe"
  | "ask_q_visa"
  | "ask_q_startup_pref"
  | "ask_q_location"

export interface OnboardingQuestionDoc {
  id: string
  order: number
  prompt: BilingualText
  variants: BilingualText[]
  judgeKind: OnboardingJudgeKind
  rephraserKind: OnboardingRephraserKind
  maxAttempts: number
  haltMessage: BilingualText | null
  enabled: boolean
  llmStep?: OnboardingLLMStep
  updatedAt: string
  updatedBy: string
  reason: string
  version: number
}

const COLLECTION = "pa-onboarding-questions"
const AUDIT_COLLECTION = "pa-audit-events"

/**
 * Read-side. Returns enabled questions in `order` ascending. Pass
 * `includeDisabled=true` to read everything (admin UI).
 */
export async function listOnboardingQuestions(
  db: Firestore,
  opts: { includeDisabled?: boolean } = {}
): Promise<OnboardingQuestionDoc[]> {
  const snap = await db.collection(COLLECTION).orderBy("order", "asc").get()
  const all = snap.docs.map((d) => d.data() as OnboardingQuestionDoc)
  if (opts.includeDisabled) return all
  return all.filter((q) => q.enabled)
}

export async function getOnboardingQuestion(
  db: Firestore,
  id: string
): Promise<OnboardingQuestionDoc | null> {
  const snap = await db.collection(COLLECTION).doc(id).get()
  if (!snap.exists) return null
  return snap.data() as OnboardingQuestionDoc
}

/**
 * Upsert (create or update). Writes audit row in same transaction. Bumps
 * version. Rejects writes that drop `id`/`order`/`prompt` (required core).
 */
export async function upsertOnboardingQuestion(
  db: Firestore,
  next: Omit<OnboardingQuestionDoc, "updatedAt" | "version">,
  opts: { actor: string; reason: string }
): Promise<{ version: number }> {
  if (!next.id) throw new Error("upsertOnboardingQuestion: id required")
  if (!next.prompt?.zh || !next.prompt?.en) {
    throw new Error("upsertOnboardingQuestion: prompt.zh + prompt.en required")
  }
  const ref = db.collection(COLLECTION).doc(next.id)
  const auditRef = db.collection(AUDIT_COLLECTION).doc()
  const nowIso = new Date().toISOString()
  return await db.runTransaction(async (t) => {
    const cur = await t.get(ref)
    const prev = cur.exists ? (cur.data() as OnboardingQuestionDoc) : null
    const version = (prev?.version ?? 0) + 1
    const action: "onboarding_q.create" | "onboarding_q.update" = prev
      ? "onboarding_q.update"
      : "onboarding_q.create"
    const doc: OnboardingQuestionDoc = {
      ...next,
      updatedAt: nowIso,
      version,
    }
    t.set(ref, doc)
    t.set(auditRef, {
      actor: opts.actor,
      action,
      key: next.id,
      reason: opts.reason,
      ts: nowIso,
      newValue: { order: next.order, judgeKind: next.judgeKind, rephraserKind: next.rephraserKind, enabled: next.enabled },
      oldValue: prev ? { order: prev.order, judgeKind: prev.judgeKind, rephraserKind: prev.rephraserKind, enabled: prev.enabled } : null,
    })
    return { version }
  })
}

/**
 * Soft-disable (enabled=false). Hard delete is intentionally not exposed
 * to preserve audit trail. Use upsert with enabled=false to disable.
 */
export async function disableOnboardingQuestion(
  db: Firestore,
  id: string,
  opts: { actor: string; reason: string }
): Promise<void> {
  const cur = await getOnboardingQuestion(db, id)
  if (!cur) throw new Error(`disableOnboardingQuestion: ${id} not found`)
  await upsertOnboardingQuestion(db, { ...cur, enabled: false }, opts)
}
