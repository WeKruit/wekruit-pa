/**
 * guardrails.ts — WS-guardrail owns this file.
 *
 * KEYSTONE: guardrails are SAFETY tripwires, NOT voice/business logic. Voice
 * lives in the prompt + few-shot. We keep exactly ONE output post-processor
 * (`normalizeForIMessage`, wrapped by `normalizeReply`) and ONE lightweight
 * voice-drift outputGuardrail (flags only, never a hard gate). Everything else
 * that used to live in voice/ is deleted — replaced by prompt + few-shot.
 *
 * - inputGuardrail "safety": `detectCrisisInInput` (@pa/pa-safety crisis bank)
 *   OR a prompt-injection check → tripwire. The tripwire bypasses the agent
 *   (mirrors poc-v3 D: `InputGuardrailTripwireTriggered` is thrown by `run()`).
 *   The caller catches the tripwire and appends the crisis hotline / blocks the
 *   injection — this guardrail only needs to TRIP, not handle.
 * - outputGuardrail "voice-drift": a lightweight long-context regression
 *   detector (markdown leakage, "scratch that," self-correction artifact,
 *   AI/robotic disclosure, excessive length). It FLAGS (returns `outputInfo`
 *   with the drift signals) but NEVER trips for style — `tripwireTriggered`
 *   stays `false` so it can never block a normal reply.
 * - normalizer: `normalizeForIMessage` (@pa/pa-orchestrator) — the ONE kept
 *   post-processor (markdown/code-fence/UTM strip + iMessage length).
 */
import type {
  AgentsSdkInputGuardrail as InputGuardrail,
  AgentsSdkOutputGuardrail as OutputGuardrail,
} from "@pa/agent-runtime"
import { checkPromptInjection, detectCrisisInInput } from "@pa/pa-safety"
import { normalizeForIMessage } from "@pa/pa-orchestrator"

// ---------------------------------------------------------------------------
// Prompt-injection bank.
//
// We REUSE the central `checkPromptInjection` regex bank from @pa/pa-safety
// (D15: do not add a parallel taxonomy / second regex source) and layer a few
// thin jailbreak-specific patterns the orchestrator bank does not cover but
// poc-v3 D expects ("you are now …", a bare "system prompt" mention,
// "jailbreak"/"DAN" framing). Keeping these here (not in pa-safety) avoids
// touching a file outside this workstream's write scope.
// ---------------------------------------------------------------------------
const EXTRA_INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\byou are now\b/i,
  /\bsystem prompt\b/i,
  /\bdeveloper (?:prompt|mode)\b/i,
  /\bjailbreak\b/i,
  /\bDAN mode\b/i,
  /\bact as (?:an? )?(?:unrestricted|jailbroken|uncensored)\b/i,
  /\bignore (?:all |the )?(?:your )?(?:previous |prior |above )?(?:instructions|rules|guidelines)\b/i,
  /\bpretend (?:you are|to be) (?:an? )?(?:unrestricted|different|evil)\b/i,
]

/** Pattern-source ids for a detected injection (audit; never raw user text). */
function detectInjection(text: string): string[] {
  const decision = checkPromptInjection(text)
  const signals = decision.allow ? [] : [...(decision.signals ?? [])]
  for (const p of EXTRA_INJECTION_PATTERNS) {
    if (p.test(text)) signals.push(`extra:${p.source}`)
  }
  return signals
}

function inputText(input: unknown): string {
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

// ---------------------------------------------------------------------------
// Voice-drift signals — lightweight long-context regression detectors. FLAG
// only, never trip. These mirror the kinds of artifacts that leak when the
// model drifts in a long thread; the prompt + few-shot are the real fix, this
// is observability so we can SEE drift (it never blocks a reply).
// ---------------------------------------------------------------------------
const VOICE_DRIFT_DEFAULT_MAX_LENGTH = 900

const VOICE_DRIFT_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  // markdown leakage (bold/italic emphasis, headings, fenced/inline code, list markers)
  { id: "markdown_emphasis", re: /(\*\*[^*]+\*\*|__[^_]+__)/ },
  { id: "markdown_heading", re: /^#{1,6}\s/m },
  { id: "code_fence", re: /```/ },
  { id: "inline_code", re: /`[^`]+`/ },
  { id: "markdown_list", re: /^\s*(?:[-*]\s+|\d+[.)]\s+)/m },
  { id: "markdown_link", re: /\[[^\]]+\]\([^)]+\)/ },
  // the self-correction "scratch that," artifact (long-context retraction tic)
  { id: "scratch_that", re: /\bscratch that\b/i },
  // robotic / AI self-disclosure (Claire never says she's an AI)
  { id: "ai_disclosure", re: /\b(?:as an ai|i am an ai|i'?m an ai|language model|as a (?:language|ai) model)\b/i },
  { id: "robotic_assist", re: /\b(?:how (?:may|can) i assist you|is there anything else i can help)\b/i },
]

export interface VoiceDriftResult {
  /** true iff any drift signal fired (style only — NEVER a safety tripwire). */
  flagged: boolean
  /** pattern ids that fired, plus `excessive_length` when over the soft cap. */
  signals: string[]
  length: number
}

/**
 * Pure voice-drift detector. Exported so the eval can assert it directly and
 * Wave B can reuse it. Returns flags; the guardrail wraps it and ALWAYS reports
 * `tripwireTriggered: false`.
 */
export function detectVoiceDrift(
  text: string,
  opts?: { maxLength?: number },
): VoiceDriftResult {
  const t = typeof text === "string" ? text : ""
  const maxLength = opts?.maxLength ?? VOICE_DRIFT_DEFAULT_MAX_LENGTH
  const signals: string[] = []
  for (const { id, re } of VOICE_DRIFT_PATTERNS) {
    if (re.test(t)) signals.push(id)
  }
  if (t.length > maxLength) signals.push("excessive_length")
  return { flagged: signals.length > 0, signals, length: t.length }
}

/**
 * Build the SDK-shaped guardrail arrays for the Claire Agent.
 *
 * Return shape matches the @openai/agents `Agent` constructor fields
 * `inputGuardrails` / `outputGuardrails`:
 *   - input  guardrail: `{ name, async execute({ input }) => { outputInfo, tripwireTriggered } }`
 *   - output guardrail: `{ name, async execute({ agentOutput }) => { outputInfo, tripwireTriggered } }`
 *
 * Wave B wires `.input → new Agent({ inputGuardrails })` and
 * `.output → new Agent({ outputGuardrails })`.
 */
export function buildClaireGuardrails(): {
  input: InputGuardrail[]
  output: OutputGuardrail[]
} {
  const safety: InputGuardrail = {
    name: "safety",
    async execute({ input }) {
      const text = inputText(input)
      const crisis = detectCrisisInInput(text)
      const injectionSignals = detectInjection(text)
      const injection = injectionSignals.length > 0
      const tripwireTriggered = crisis.detected || injection
      return {
        tripwireTriggered,
        outputInfo: {
          kind: tripwireTriggered ? (crisis.detected ? "crisis" : "injection") : "clean",
          crisis: {
            detected: crisis.detected,
            confidence: crisis.confidence,
            language: crisis.language,
            // pattern-source ids only — detectCrisisInInput never returns raw text
            signals: crisis.signals,
          },
          injection: { detected: injection, signals: injectionSignals },
        },
      }
    },
  }

  const voiceDrift: OutputGuardrail = {
    name: "voice-drift",
    async execute({ agentOutput }) {
      // agentOutput is the resolved agent output. For a text agent this is the
      // reply string; coerce defensively for structured outputs.
      const text = typeof agentOutput === "string" ? agentOutput : inputText(agentOutput)
      const drift = detectVoiceDrift(text)
      // NEVER a hard gate. Style drift FLAGS for telemetry, never blocks.
      return {
        tripwireTriggered: false,
        outputInfo: { flagged: drift.flagged, signals: drift.signals, length: drift.length },
      }
    },
  }

  return { input: [safety], output: [voiceDrift] }
}

/** iMessage soft length cap (matches the orchestrator's `maxLength: 600`). */
export const CLAIRE_REPLY_MAX_LENGTH = 600

/**
 * The ONE kept post-processor: strips markdown / code fences / UTM params /
 * bare-url cruft and enforces iMessage length, via `normalizeForIMessage`.
 *
 * Contract: returns the normalized SINGLE reply text. We pass
 * `forceSingleMessage: true` so the result is guaranteed `<= maxLength`
 * (a clean short string is returned unchanged; an over-length string is
 * hard-truncated with an ellipsis). This differs from the orchestrator's
 * default multi-bubble path (which can return a `chunks[]` joined into
 * `.text`); thin Claire emits ONE reply per turn, so a single bounded text is
 * the honest contract. If we ever want true multi-bubble chunking, the
 * transport — not this normalizer — should own the split.
 */
export function normalizeReply(text: string): string {
  return normalizeForIMessage(text, {
    maxLength: CLAIRE_REPLY_MAX_LENGTH,
    forceSingleMessage: true,
  }).text
}
