/**
 * Layer 2 sim test shared helpers.
 *
 * Adam directive (P7-6): walk the OnboardingPipeline through full conversation
 * segments. State machine + re-ask rotation + Question instances are REAL;
 * only the LLM is stubbed.
 *
 * What this module provides:
 *   - `buildPipeline(opts)` — factory wiring real V2 questions + InMemory state
 *     + caller-controlled stub LLMs (via deps closures).
 *   - `stubGuidedOpenJSON(value)` — emits the JSON shape `GuidedOpenJudge`'s
 *     `llmCall` is contracted to return.
 *   - `stubGuidedOpenUnclear(question)` — same, but degrades to {intent:unclear}.
 *
 * Re-ask rotation note:
 *   `HybridRephraser.rephrase(args)` returns variants[args.attemptNum-1] for
 *   attempt 1..variants.length, then llmClarifyingQuestion if present, else
 *   fallback. So with no clarifyingQuestion (default LLMRelevanceJudge irrelevant
 *   path), the first 4 attempts cycle through 4 distinct variants — that's
 *   what we assert as "≥3 distinct phrasings".
 */
import {
  OnboardingPipeline,
  type RunTurnInput,
  type TurnEmitKind,
} from "../../pipeline.js"
import { InMemoryPipelineStateProvider } from "../../state-memory.js"
import {
  defaultQuestionsV2,
  Q_COUNTRY,
  Q_ROLE,
  Q_STARTUP_PREF,
  Q_VISA,
  Q_YOE,
  type DefaultQuestionsV2Deps,
} from "../../questions.js"
import type { ExtractIntentFn, IntentResult } from "../../judges/llm-relevance.js"
import type { LangPref } from "../../judges/lang.js"
import type { LlmCallFn, GuidedOpenJudgeSpec } from "../../judges/guided-open.js"
import type { Question } from "../../question.js"

export interface EmittedEvent {
  text: string
  qId: string | null
  kind: TurnEmitKind
}

export interface BuildPipelineOpts {
  /**
   * onLangAccepted hook — pipeline writes `state.lang` directly via the
   * default behavior, but the question-level hook is invoked here so tests
   * can confirm captured value. Default: no-op.
   *
   * IMPORTANT: pipeline does NOT auto-mirror q_lang's accepted value into
   * `state.lang`. Tests that rely on lang flipping mid-flow must mutate
   * state.lang via the state provider (or pass an explicit hook here).
   */
  onLangAccepted?: DefaultQuestionsV2Deps["onLangAccepted"]
  /** Override accepts / hooks for any individual Q. */
  onCountryAccepted?: DefaultQuestionsV2Deps["onCountryAccepted"]
  onLocationAccepted?: DefaultQuestionsV2Deps["onLocationAccepted"]
  onVisaAccepted?: DefaultQuestionsV2Deps["onVisaAccepted"]
  /**
   * Replaces the V2 question list entirely. Use for sim tests focused on
   * a subset of Qs (e.g. country-then-location).
   */
  questionsOverride?: Question<unknown>[]
  /** postCollect hook — fires once last Q is accepted. */
  postCollect?: (collected: Record<string, unknown>) => void | Promise<void>
}

export interface BuiltPipeline {
  pipeline: OnboardingPipeline
  state: InMemoryPipelineStateProvider
  emitted: EmittedEvent[]
  /** Convenience: send a turn for a fixed user. */
  send(reply: string, rawPayload?: unknown): Promise<EmittedEvent | undefined>
  /** Helper: peek at the user's current pipeline state. */
  peekState(userId?: string): ReturnType<InMemoryPipelineStateProvider["peek"]>
}

const HALT = {
  zh: "please contact admin1@wekruit.com — you've failed 5 times in a row, please stop",
  en: "please contact admin1@wekruit.com — you've failed 5 times in a row, please stop",
}

export const TEST_USER = "u_sim"

/**
 * Build a pipeline wired with real V2 questions + InMemory state. Tests
 * pass stub LLM functions via `opts`; everything else uses production wiring.
 *
 * IMPORTANT: V2 questions for `q_country / q_location / q_visa` rely on
 * `GuidedOpenJudge` whose `llmCallFactory` is set at construction time.
 * Since `defaultQuestionsV2(deps)` constructs Q_COUNTRY etc with default
 * factories (which try real network), we MUST inject `llmCallFactory`
 * indirectly: tests using V2 chains must instead call
 * `buildPipelineWithGuidedOpenStub` below.
 *
 * For tests that don't traverse V2 GuidedOpen Qs, the simpler
 * `buildPipeline` is fine.
 */
export function buildPipeline(opts: BuildPipelineOpts = {}): BuiltPipeline {
  const state = new InMemoryPipelineStateProvider()
  const emitted: EmittedEvent[] = []

  const deps: DefaultQuestionsV2Deps = {
    onLangAccepted: opts.onLangAccepted,
    onCountryAccepted: opts.onCountryAccepted,
    onLocationAccepted: opts.onLocationAccepted,
    onVisaAccepted: opts.onVisaAccepted,
  }

  const questions = opts.questionsOverride ?? defaultQuestionsV2(deps)

  const pipeline = new OnboardingPipeline({
    questions,
    state,
    haltMessageDefault: HALT,
    emit: async (text, meta) => {
      emitted.push({ text, qId: meta.qId, kind: meta.kind })
    },
    postCollect: opts.postCollect
      ? async (collected) => {
          await opts.postCollect!(collected)
        }
      : undefined,
  })

  let turnSeq = 0
  const send: BuiltPipeline["send"] = async (reply, rawPayload) => {
    turnSeq++
    const beforeLen = emitted.length
    const input: RunTurnInput = {
      userId: TEST_USER,
      turnId: `t-${turnSeq}`,
      reply,
      rawPayload,
    }
    await pipeline.startTurn(input)
    return emitted[beforeLen]
  }

  return {
    pipeline,
    state,
    emitted,
    send,
    peekState: (userId = TEST_USER) => state.peek(userId),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GuidedOpenJudge stubbing — tests that walk through V2 country / location /
// visa questions need their LLMs canned. We replace the affected Qs by
// rebuilding them via questions-table factories with `llmCallFactory` injected.
// ─────────────────────────────────────────────────────────────────────────────

import { GuidedOpenJudge } from "../../judges/guided-open.js"
import { HybridRephraser } from "../../rephrasers/hybrid.js"
import { makeQuestion } from "../../question.js"
import { makeLocationQuestion } from "../../questions.js"

/** Build a JSON string mimicking a `provided` LLM intent. */
export function stubGuidedOpenProvided(
  value: unknown,
  confidence = 0.95
): string {
  return JSON.stringify({ intent: "provided", value, confidence })
}

/** Build a JSON string mimicking an `unclear` LLM intent. */
export function stubGuidedOpenUnclear(clarifyingQuestion = "could you clarify?"): string {
  return JSON.stringify({ intent: "unclear", clarifyingQuestion })
}

/** Build a JSON string mimicking a `declined` LLM intent. */
export function stubGuidedOpenDeclined(): string {
  return JSON.stringify({ intent: "declined" })
}

/**
 * Test helper — build an LlmCallFn that picks JSON from a substring map.
 * Callers pass in `{ "USA": stubGuidedOpenProvided("usa") }` and the helper
 * returns the matching JSON for the first key whose substring appears in the
 * userPrompt. If no key matches, returns "unclear" by default.
 */
export function stubGuidedOpenLLM(map: Record<string, string>): LlmCallFn {
  return async ({ userPrompt }) => {
    for (const [needle, json] of Object.entries(map)) {
      if (userPrompt.toLowerCase().includes(needle.toLowerCase())) {
        return json
      }
    }
    return stubGuidedOpenUnclear()
  }
}

/**
 * Wrapper around `defaultQuestionsV2` that swaps Q_COUNTRY / Q_VISA / Q_LOCATION
 * for stubbed-LLM equivalents. Returns a complete list ready to feed
 * into `buildPipeline({questionsOverride})`.
 */
export interface StubbedV2Opts extends BuildPipelineOpts {
  /** stub LlmCallFn for q_country */
  countryLlm?: LlmCallFn
  /** stub LlmCallFn for q_role */
  roleLlm?: LlmCallFn
  /** stub LlmCallFn for q_yoe */
  yoeLlm?: LlmCallFn
  /** stub LlmCallFn for q_startup_pref */
  startupPrefLlm?: LlmCallFn
  /** stub LlmCallFn for q_location (default-anywhere variant). */
  locationLlm?: LlmCallFn
  /** stub LlmCallFn for q_visa. */
  visaLlm?: LlmCallFn
}

export function buildV2QuestionsWithStubs(opts: StubbedV2Opts): Question<unknown>[] {
  const deps: DefaultQuestionsV2Deps = {
    onLangAccepted: opts.onLangAccepted,
    onCountryAccepted: opts.onCountryAccepted,
    onLocationAccepted: opts.onLocationAccepted,
    onVisaAccepted: opts.onVisaAccepted,
  }
  const baseList = defaultQuestionsV2(deps)
  const byId = new Map(baseList.map((q) => [q.id, q]))

  if (opts.roleLlm) {
    byId.set("q_role", makeQuestion<unknown>({
      ...(Q_ROLE as Question<unknown>),
      judge: new GuidedOpenJudge<unknown>({
        questionLabel: "target job role",
        hints: ["swe", "pm", "research", "design", "data", "ml"],
        examples: [],
        parseValue: (raw): unknown => {
          const values = Array.isArray(raw) ? raw : [raw]
          const out = values
            .filter((v): v is string => typeof v === "string")
            .flatMap((v) => v.split("/").flatMap((s) => s.split(",")).flatMap((s) => s.split("|")))
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean)
          return out.length > 0 ? out : null
        },
        llmCallFactory: () => opts.roleLlm!,
      }),
    }))
  }

  if (opts.yoeLlm) {
    byId.set("q_yoe", makeQuestion<unknown>({
      ...(Q_YOE as Question<unknown>),
      judge: new GuidedOpenJudge<unknown>({
        questionLabel: "years of experience",
        hints: ["0", "1", "2", "3", "5", "10", "fresh"],
        examples: [],
        parseValue: (raw): unknown => {
          if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.round(raw)
          if (typeof raw !== "string") return null
          const t = raw.trim().toLowerCase()
          if (t === "fresh") return "fresh"
          const n = Number(t)
          return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
        },
        llmCallFactory: () => opts.yoeLlm!,
      }),
    }))
  }

  if (opts.startupPrefLlm) {
    byId.set("q_startup_pref", makeQuestion<unknown>({
      ...(Q_STARTUP_PREF as Question<unknown>),
      judge: new GuidedOpenJudge<unknown>({
        questionLabel: "startup vs bigtech preference",
        hints: ["startup", "bigtech", "either"],
        examples: [],
        parseValue: (raw): unknown => {
          if (typeof raw !== "string") return null
          const t = raw.trim().toLowerCase()
          if (t.includes("either") || t.includes("both") || t.includes("any")) return "either"
          if (t.includes("startup") && (t.includes("bigtech") || t.includes("big tech"))) return "either"
          if (t.includes("startup")) return "startup"
          if (t.includes("bigtech") || t.includes("big tech") || t.includes("big company")) return "bigtech"
          return t === "startup" || t === "bigtech" || t === "either" ? t : null
        },
        llmCallFactory: () => opts.startupPrefLlm!,
      }),
    }))
  }

  // Replace q_country with one that uses the stub LLM.
  const countryStub = opts.countryLlm
  if (countryStub) {
    const countryQ = makeQuestion<unknown>({
      ...(Q_COUNTRY as Question<unknown>),
      onAccepted: opts.onCountryAccepted as Question<unknown>["onAccepted"],
      judge: new GuidedOpenJudge({
        questionLabel: "target country / region",
        hints: ["usa", "china", "canada", "europe", "anywhere"],
        examples: [],
        parseValue: (raw): unknown => {
          const values = Array.isArray(raw) ? raw : [raw]
          const out = values
            .filter((v): v is string => typeof v === "string")
            .flatMap((v) => v.split("/").flatMap((s) => s.split(",")).flatMap((s) => s.split("|")))
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean)
          return out.length > 0 ? out : null
        },
        llmCallFactory: () => countryStub,
      }),
    })
    byId.set("q_country", countryQ)
  }

  // Replace q_location with stub-backed version (default-anywhere hint pool).
  const locationStub = opts.locationLlm
  if (locationStub) {
    // `makeLocationQuestion(undefined, ...)` returns a Question with
    // GuidedOpenJudge pre-configured for the anywhere superset. We rebuild it
    // with our stub LLM injected.
    const baseLoc = makeLocationQuestion(undefined, opts.onLocationAccepted)
    const locQ = makeQuestion<unknown>({
      ...(baseLoc as Question<unknown>),
      judge: new GuidedOpenJudge<unknown>({
        questionLabel: "target work city / region",
        hints: ["sf", "nyc", "remote", "anywhere"],
        examples: [],
        parseValue: (raw): unknown => {
          if (typeof raw === "string" && raw.trim()) return [raw.trim().toLowerCase()]
          if (Array.isArray(raw)) {
            const items = raw
              .filter((x): x is string => typeof x === "string")
              .map((s) => s.trim().toLowerCase())
              .filter((s) => s.length > 0)
            return items.length > 0 ? items : null
          }
          return null
        },
        llmCallFactory: () => locationStub,
      }),
    })
    byId.set("q_location", locQ)
  }

  // Replace q_visa with stub-backed version.
  const visaStub = opts.visaLlm
  if (visaStub) {
    const visaQ = makeQuestion<unknown>({
      ...(Q_VISA as Question<unknown>),
      onAccepted: opts.onVisaAccepted as Question<unknown>["onAccepted"],
      judge: new GuidedOpenJudge<unknown>({
        questionLabel: "US work authorization status",
        hints: ["citizen", "permanent_resident", "sponsorship_needed", "other"],
        examples: [],
        parseValue: (raw): unknown => {
          if (typeof raw !== "string") return null
          const t = raw.trim().toLowerCase()
          return t.length > 0 ? t : null
        },
        llmCallFactory: () => visaStub,
      }),
    })
    byId.set("q_visa", visaQ)
  }

  // Preserve the V2 ordering (tos → role → yoe → visa → startup_pref
  // → country → location → resume).
  return [
    byId.get("q_tos")!,
    byId.get("q_role")!,
    byId.get("q_yoe")!,
    byId.get("q_visa")!,
    byId.get("q_startup_pref")!,
    byId.get("q_country")!,
    byId.get("q_location")!,
    byId.get("q_resume")!,
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// extractIntent stubs — for LLMRelevanceJudge probes (q_role/q_yoe/q_startup_pref)
// ─────────────────────────────────────────────────────────────────────────────

export interface StubProbeRow {
  /** Substring (lowercase) to match against reply. First-match-wins. */
  match: string
  step?: "ask_q_role" | "ask_q_yoe" | "ask_q_visa" | "ask_q_startup_pref" | "ask_q_location"
  intent: "provided" | "unclear"
  value?: unknown
  confidence?: number
  clarifyingQuestion?: string
}

/**
 * Build an `extractAnswerIntent` stub. Iterates the rule list, returns the
 * first row whose `step` matches AND `match` substring is in the reply.
 * If nothing matches → returns null (judge degrades to `irrelevant`).
 */
export function stubExtractIntent(rules: StubProbeRow[]): ExtractIntentFn {
  return async (step, reply) => {
    const t = reply.toLowerCase()
    for (const r of rules) {
      if (r.step && r.step !== step) continue
      if (!t.includes(r.match.toLowerCase())) continue
      if (r.intent === "provided") {
        return {
          intent: "provided",
          value: r.value,
          confidence: r.confidence ?? 0.95,
        } as IntentResult<unknown>
      }
      if (r.intent === "unclear") {
        return {
          intent: "unclear",
          clarifyingQuestion: r.clarifyingQuestion ?? "could you clarify?",
        }
      }
    }
    return null
  }
}

/** Quick sugar: every reply at every step → provided + given canonical value. */
export function alwaysProvided(value: unknown): ExtractIntentFn {
  return async () => ({
    intent: "provided",
    value,
    confidence: 1.0,
  }) as IntentResult<unknown>
}

/** Quick sugar: every reply → unclear. */
export function alwaysUnclear(): ExtractIntentFn {
  return async () => ({
    intent: "unclear",
    clarifyingQuestion: "could you clarify?",
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Misc test sugar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filter emitted events by kind. Useful: `reasksOf("q_role", emitted)`.
 */
export function reasksOf(qId: string, emitted: EmittedEvent[]): string[] {
  return emitted.filter((e) => e.kind === "reask" && e.qId === qId).map((e) => e.text)
}

/** Filter "first_prompt" events (initial Q prompts shown after advance). */
export function firstPromptsOf(emitted: EmittedEvent[]): EmittedEvent[] {
  return emitted.filter((e) => e.kind === "first_prompt")
}

/** Force a state mutation — pipeline does not auto-mirror q_lang accepted value. */
export async function forceLang(
  state: InMemoryPipelineStateProvider,
  lang: LangPref
): Promise<void> {
  if (lang === "mixed") return // pipeline state is en|zh; mixed maps to en runtime
  const s = await state.load(TEST_USER)
  s.lang = lang === "zh" ? "zh" : "en"
  await state.save(TEST_USER, s)
}
