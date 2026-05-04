/**
 * iter30 WS6 — guardrails barrel export.
 *
 * Detail-plan: `.planning/iter30/ws-3-6-detail.md` §5-7.
 *
 * Adam-locked chain ordering — see `run-input-chain.ts` and
 * `run-output-chain.ts`. Do NOT reorder without re-running iter25-29
 * normalizer regression tests + iter28-29 LLM-judge baselines.
 */
export type {
  GuardrailFunctionOutput,
  GuardrailOutputInfo,
  InputGuardrail,
  InputGuardrailArgs,
  InputGuardrailFn,
  OutputGuardrail,
  OutputGuardrailArgs,
  OutputGuardrailFn,
} from "./types.js"
export { recordGuardrailHit } from "./types.js"

// Input guardrails
export { crisisDetectorGuardrail } from "./input/crisis-detector.js"
export { promptInjectionDetectorGuardrail } from "./input/prompt-injection-detector.js"
export { piiScannerGuardrail } from "./input/pii-scanner.js"
export {
  lengthInputGuardrail,
  INPUT_LENGTH_CAP,
} from "./input/length-input.js"
export {
  createOpenaiModerationGuardrail,
  type ModerationGuardrailDeps,
} from "./input/openai-moderation.js"

// Output guardrails
export { lengthCapGuardrail } from "./output/length-cap.js"
export { abStripGuardrail } from "./output/ab-strip.js"
export { slangEnforcerGuardrail } from "./output/slang-enforcer.js"
export { adviceRepeatGuardrail } from "./output/advice-repeat.js"
export { crisisTrailerGuardrail } from "./output/crisis-trailer.js"
export { mirrorScoreGuardrail } from "./output/mirror-score.js"
export { outputNormalizerGuardrail } from "./output/output-normalizer.js"

// Chain runners
export {
  runInputChain,
  type InputChainResult,
  type RunInputChainOptions,
} from "./run-input-chain.js"
export {
  runOutputChain,
  type OutputChainResult,
  type RunOutputChainOptions,
} from "./run-output-chain.js"

// Pre-assembled chain orderings — the single source of truth for chain
// composition. Index.ts (and tests) should import from here.
import { crisisDetectorGuardrail } from "./input/crisis-detector.js"
import { promptInjectionDetectorGuardrail } from "./input/prompt-injection-detector.js"
import { piiScannerGuardrail } from "./input/pii-scanner.js"
import { lengthInputGuardrail } from "./input/length-input.js"
import type { InputGuardrail, OutputGuardrail } from "./types.js"
import { lengthCapGuardrail } from "./output/length-cap.js"
import { abStripGuardrail } from "./output/ab-strip.js"
import { slangEnforcerGuardrail } from "./output/slang-enforcer.js"
import { adviceRepeatGuardrail } from "./output/advice-repeat.js"
import { crisisTrailerGuardrail } from "./output/crisis-trailer.js"
import { mirrorScoreGuardrail } from "./output/mirror-score.js"
import { outputNormalizerGuardrail } from "./output/output-normalizer.js"

/** Detail-plan §6 input chain — moderation guardrail is appended by caller. */
export const INPUT_GUARDRAIL_CHAIN: InputGuardrail[] = [
  crisisDetectorGuardrail,
  promptInjectionDetectorGuardrail,
  piiScannerGuardrail,
  lengthInputGuardrail,
]

/** Detail-plan §6 output chain — single ordering, locked. */
export const OUTPUT_GUARDRAIL_CHAIN: OutputGuardrail[] = [
  lengthCapGuardrail,
  abStripGuardrail,
  slangEnforcerGuardrail,
  adviceRepeatGuardrail,
  crisisTrailerGuardrail,
  mirrorScoreGuardrail,
  outputNormalizerGuardrail,
]
