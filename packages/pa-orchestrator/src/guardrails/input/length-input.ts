/**
 * IG-4: lengthInputCheck — HARD block on >4000 char input.
 *
 * Detail-plan ws-3-6-detail.md §5.1 IG-4. Prevents abuse from inputs that
 * would balloon LLM cost or memory writes. 4001 chars trip; 4000 pass.
 */
import { pickLangForSafety } from "@pa/pa-safety"
import type { InputGuardrail } from "../types.js"
import { recordGuardrailHit } from "../types.js"

export const INPUT_LENGTH_CAP = 4000

const CANNED = {
  zh: "that's too long for one message — please split it up.",
  en: "that's too long for one message — please split it up.",
}

export const lengthInputGuardrail: InputGuardrail = {
  name: "lengthInputCheck",
  runInParallel: false,
  execute: ({ input, ctx }) => {
    const t0 = Date.now()
    const text = input ?? ""
    const length = text.length
    const tripped = length > INPUT_LENGTH_CAP
    const lang = pickLangForSafety(text)
    const cannedReply = tripped ? CANNED[lang] : undefined
    const metadata = { length, cap: INPUT_LENGTH_CAP, lang }
    recordGuardrailHit(ctx, {
      name: "lengthInputCheck",
      type: "input",
      tripped,
      metadata,
      latencyMs: Date.now() - t0,
    })
    return {
      tripwireTriggered: tripped,
      outputInfo: { ...metadata, cannedReply },
    }
  },
}
