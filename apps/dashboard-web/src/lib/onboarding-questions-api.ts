/**
 * iter34 P3+ — `pa-onboarding-questions` browser SDK.
 *
 * Read-side mirror of packages/pa-persistence/src/onboarding-questions.ts
 * for the dashboard. Client-side direct Firestore reads, no Cloud Function
 * round-trip. Schema kept in lockstep — the server SDK is source of truth.
 *
 * Adam directive 2026-05-05: "你现在把我们所有的这个 deterministic question
 * list 以及对应的所有信息都放在 dashboard 我可以直接看了吗？"
 */
import { collection, getDocs, orderBy, query } from "firebase/firestore"
import { db } from "./firebase.js"

export const ONBOARDING_QUESTIONS_COLLECTION = "pa-onboarding-questions"

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

export async function listAllOnboardingQuestions(): Promise<OnboardingQuestionDoc[]> {
  const q = query(
    collection(db(), ONBOARDING_QUESTIONS_COLLECTION),
    orderBy("order", "asc")
  )
  const snap = await getDocs(q)
  const out: OnboardingQuestionDoc[] = []
  snap.forEach((d) => {
    const data = d.data() as Record<string, unknown>
    out.push({
      id: (data.id as string) ?? d.id,
      order: Number(data.order ?? 0),
      prompt: (data.prompt as BilingualText) ?? { zh: "", en: "" },
      variants: (data.variants as BilingualText[]) ?? [],
      judgeKind: (data.judgeKind as OnboardingJudgeKind) ?? "lang",
      rephraserKind: (data.rephraserKind as OnboardingRephraserKind) ?? "variants",
      maxAttempts: Number(data.maxAttempts ?? 5),
      haltMessage: (data.haltMessage as BilingualText | null) ?? null,
      enabled: data.enabled !== false,
      llmStep: data.llmStep as OnboardingLLMStep | undefined,
      updatedAt: (data.updatedAt as string) ?? "",
      updatedBy: (data.updatedBy as string) ?? "",
      reason: (data.reason as string) ?? "",
      version: Number(data.version ?? 0),
    })
  })
  return out
}
