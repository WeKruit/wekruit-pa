import type { Firestore } from "firebase-admin/firestore"
import { normalizeForIMessage } from "./output-normalizer.js"
import { isHumanizeRuntimeEnabled } from "./voice/llm-rewriter.js"
import { injectImperfection, resolveArm } from "./voice/imperfection-injector/index.js"

export type TemplateHumanizeInput = {
  body: string
  userId: string
  turnId: string
  db?: Firestore
  maxLength?: number
}

/** Phase A — template SMS gets normalize + optional imperfection when humanize is on. */
export async function applyTemplateOutboundHumanize(
  input: TemplateHumanizeInput
): Promise<{ text: string; humanizeApplied: boolean }> {
  const maxLength = input.maxLength ?? 600
  let text = input.body
  let humanizeApplied = false

  const humanizeOn = await isHumanizeRuntimeEnabled(input.db, input.userId)
  if (humanizeOn && process.env.PA_IMPERFECTION_INJECTOR_ENABLED !== "false") {
    const arm = resolveArm(input.userId)
    if (arm !== "off") {
      const inj = injectImperfection({ text, arm, userId: input.userId })
      if (inj.applied) {
        text = inj.injected
        humanizeApplied = true
      }
    }
  }

  const { text: safe } = normalizeForIMessage(text, { maxLength })
  return { text: safe, humanizeApplied }
}
