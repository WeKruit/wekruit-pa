/**
 * Default question registry for Claire's onboarding flow.
 *
 * Order matters — pipeline asks Q[0] first, advances on accept to Q[1], etc.
 *
 * Each Q is constructed via factory because some judges/rephrasers need
 * runtime deps (LLM extractors, Firestore, etc.) injected at orchestrator
 * boot time.
 *
 * Adding a new question = appending one entry to the array. Re-ask UX,
 * attempt counting, halt-at-N, lang preservation — all handled by pipeline.
 */
import type { LangPref } from "./judges/lang.js"
import {
  LLMRelevanceJudge,
  type ExtractIntentFn,
} from "./judges/llm-relevance.js"
import {
  hasParsedResumeOnFile,
  ResumeJudge,
  type ResumeAttachment,
} from "./judges/resume.js"
import { YesNoJudge } from "./judges/yesno.js"
import { HybridRephraser } from "./rephrasers/hybrid.js"
import { StaticVariantsRephraser } from "./rephrasers/variants.js"
import {
  makeQuestion,
  type AcceptedCtx,
  type BilingualText,
  type Question,
} from "./question.js"

export interface DefaultQuestionsDeps {
  /** LLM intent extractor for the 5 probe Qs (q_role/yoe/visa/startup_pref/location). */
  extractAnswerIntent: ExtractIntentFn
  /** Hook fired when q_resume accepts (kicks cv-ingest worker). */
  onResumeAccepted?: (
    attachments: ResumeAttachment[],
    ctx: AcceptedCtx
  ) => Promise<void>
  /** Deprecated beta hook retained only for historical callers. Active onboarding no longer asks q_lang. */
  onLangAccepted?: (lang: LangPref, ctx: AcceptedCtx) => Promise<void>
  /**
   * iter34 hotfix 2026-05-05 — Adam directive "why still using regex??".
   * Hooks fired when each probe Q accepts. The judge produces canonical
   * values (e.g. "h1b" / "either"); the runtime hook persists them via
   * `parsedAnswer` (no regex re-parse).
   */
  onRoleAccepted?: (role: unknown, ctx: AcceptedCtx) => Promise<void>
  onYoeAccepted?: (yoe: unknown, ctx: AcceptedCtx) => Promise<void>
  onVisaAccepted?: (visa: unknown, ctx: AcceptedCtx) => Promise<void>
  onStartupPrefAccepted?: (pref: unknown, ctx: AcceptedCtx) => Promise<void>
  onLocationAccepted?: (loc: unknown, ctx: AcceptedCtx) => Promise<void>
}

export interface ClosedQuestionsDeps {
  onResumeAccepted?: (
    attachments: ResumeAttachment[],
    ctx: AcceptedCtx
  ) => Promise<void>
  onLangAccepted?: (lang: LangPref, ctx: AcceptedCtx) => Promise<void>
}

const HALT_DEFAULT: BilingualText = {
  zh: "please contact admin1@wekruit.com — you've failed 5 times in a row, please stop",
  en: "please contact admin1@wekruit.com — you've failed 5 times in a row, please stop",
}

function makeClosedQuestions(deps: ClosedQuestionsDeps): {
  tosQ: Question<boolean>
  resumeQ: Question<ResumeAttachment[]>
} {
  const tosQ: Question<boolean> = makeQuestion({
    id: "q_tos",
    prompt: {
      zh: 'before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply "agree" if cool with that and we keep going',
      en: 'before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply "agree" if cool with that and we keep going',
    },
    judge: new YesNoJudge(),
    rephraser: new StaticVariantsRephraser([
      {
        zh: 'just need a quick "agree" on the privacy + terms above — or "no" and we can chat without me saving anything',
        en: 'just need a quick "agree" on the privacy + terms above — or "no" and we can chat without me saving anything',
      },
      {
        zh: "either 'agree' or 'no' works — your call",
        en: "either 'agree' or 'no' works — your call",
      },
      {
        zh: "agree to save chat memory → 'agree'. don't want it → 'no'",
        en: "agree to save chat memory → 'agree'. don't want it → 'no'",
      },
      {
        zh: "need a yes/no — 'agree' or 'no'",
        en: "need a yes/no — 'agree' or 'no'",
      },
    ]),
    haltMessage: HALT_DEFAULT,
    onDeclined: async (ctx) => {
      ctx.log?.("pa.onboarding.tos.declined", { userId: ctx.userId })
      return { advance: true }
    },
  })

  const resumeQ: Question<ResumeAttachment[]> = makeQuestion({
    id: "q_resume",
    prompt: {
      zh: "btw — can you send me your resume? makes JD review and referrals way more on-point",
      en: "btw — can you send me your resume? makes JD review and referrals way more on-point",
    },
    judge: new ResumeJudge(),
    rephraser: new StaticVariantsRephraser([
      {
        zh: "just waiting on the resume — send it as an iMessage attachment whenever",
        en: "just waiting on the resume — send it as an iMessage attachment whenever",
      },
      {
        zh: "drop the resume as an iMessage attachment — pdf / docx, either works",
        en: "drop the resume as an iMessage attachment — pdf / docx, either works",
      },
      {
        zh: "no resume? reply 'no resume' and we'll work with chat alone",
        en: "no resume? reply 'no resume' and we'll work with chat alone",
      },
      {
        zh: "try again — iMessage attachment, pdf preferred",
        en: "try again — iMessage attachment, pdf preferred",
      },
    ]),
    haltMessage: {
      zh: "skipping resume for now — drop it whenever",
      en: "skipping resume for now — drop it whenever",
    },
    onEnter: async (ctx) => {
      const hasResume = await hasParsedResumeOnFile(ctx)
      ctx.log?.("pa.onboarding.resume.existing_on_enter", {
        userId: ctx.userId,
        turnId: ctx.turnId,
        hasResume,
      })
      if (!hasResume) return null
      return { accept: true, value: [], confidence: 0.95 }
    },
    onAccepted: deps.onResumeAccepted,
    suppressTerminalCompletionMessage: true,
    onDeclined: async () => ({ advance: true }),
  })

  return { tosQ, resumeQ }
}

export function defaultQuestions(deps: DefaultQuestionsDeps): Question<unknown>[] {
  const tosQ: Question<boolean> = makeQuestion({
    id: "q_tos",
    prompt: {
      zh: 'before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply "agree" if cool with that and we keep going',
      en: 'before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply "agree" if cool with that and we keep going',
    },
    judge: new YesNoJudge(),
    rephraser: new StaticVariantsRephraser([
      {
        zh: 'just need a quick "agree" on the privacy + terms above — or "no" and we can chat without me saving anything',
        en: 'just need a quick "agree" on the privacy + terms above — or "no" and we can chat without me saving anything',
      },
      {
        zh: "either 'agree' or 'no' works — your call",
        en: "either 'agree' or 'no' works — your call",
      },
      {
        zh: "agree to save chat memory → 'agree'. don't want it → 'no'",
        en: "agree to save chat memory → 'agree'. don't want it → 'no'",
      },
      {
        zh: "need a yes/no — 'agree' or 'no'",
        en: "need a yes/no — 'agree' or 'no'",
      },
    ]),
    haltMessage: HALT_DEFAULT,
    // q_tos: declining doesn't halt onboarding; it skips memory consent.
    onDeclined: async (ctx) => {
      ctx.log?.("pa.onboarding.tos.declined", { userId: ctx.userId })
      return { advance: true }
    },
  })

  const probeRephraserOpts = (variants: BilingualText[], fallback: BilingualText) =>
    new HybridRephraser({ variants, fallback })

  const roleQ: Question<unknown> = makeQuestion({
    id: "q_role",
    prompt: {
      zh: "heads up — i need to nail down these next few before I can actually help you — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
      en: "heads up — i need to nail down these next few before I can actually help you — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
    },
    judge: new LLMRelevanceJudge({
      step: "ask_q_role",
      extractIntent: deps.extractAnswerIntent,
    }),
    rephraser: probeRephraserOpts(
      [
        {
          zh: "didn't quite catch that — what role specifically? eng / pm / research / design — one or two words works",
          en: "didn't quite catch that — what role specifically? eng / pm / research / design — one or two words works",
        },
        {
          zh: "roughly which direction — eng / pm / research / design? just pick one",
          en: "roughly which direction — eng / pm / research / design? just pick one",
        },
        {
          zh: "let me try again — what's your role been? like 'frontend' / 'data' / 'pm' style",
          en: "let me try again — what's your role been? like 'frontend' / 'data' / 'pm' style",
        },
        {
          zh: "one word for what you do is fine — 'swe' / 'pm' / 'designer' / 'researcher'",
          en: "one word for what you do is fine — 'swe' / 'pm' / 'designer' / 'researcher'",
        },
      ],
      {
        zh: "swe / pm / research / design — one works",
        en: "swe / pm / research / design — one works",
      }
    ),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onRoleAccepted,
  })

  const yoeQ: Question<unknown> = makeQuestion({
    id: "q_yoe",
    prompt: {
      zh: "how many years have you been working? New grad is fine too.",
      en: "how many years have you been working? New grad is fine too.",
    },
    judge: new LLMRelevanceJudge({
      step: "ask_q_yoe",
      extractIntent: deps.extractAnswerIntent,
    }),
    rephraser: probeRephraserOpts(
      [
        {
          zh: "roughly a number works — '3 years' / '8 years' / or 'fresh grad'",
          en: "roughly a number works — '3 years' / '8 years' / or 'fresh grad'",
        },
        {
          zh: "ballpark is fine — 0 / 1 / 3 / 5 / 10 — closest one?",
          en: "ballpark is fine — 0 / 1 / 3 / 5 / 10 — closest one?",
        },
        {
          zh: "roughly how many years working? or still in school / new grad?",
          en: "roughly how many years working? or still in school / new grad?",
        },
        {
          zh: "just need a number, like '2 years' or 'fresh grad'",
          en: "just need a number, like '2 years' or 'fresh grad'",
        },
      ],
      {
        zh: "how many years? a number works",
        en: "how many years? a number works",
      }
    ),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onYoeAccepted,
  })

  const visaQ: Question<unknown> = makeQuestion({
    id: "q_visa",
    prompt: {
      zh: "got work auth sorted? citizen / GC / OPT / need sponsorship?",
      en: "got work auth sorted? citizen / GC / OPT / need sponsorship?",
    },
    judge: new LLMRelevanceJudge({
      step: "ask_q_visa",
      extractIntent: deps.extractAnswerIntent,
    }),
    rephraser: probeRephraserOpts(
      [
        {
          zh: "pick one: citizen / GC / OPT / H1B / need sponsorship",
          en: "pick one: citizen / GC / OPT / H1B / need sponsorship",
        },
        {
          zh: "what's your status — citizen, GC, OPT, H1B, or need sponsorship?",
          en: "what's your status — citizen, GC, OPT, H1B, or need sponsorship?",
        },
        {
          zh: "are you eligible to work in the US? which one — OPT / H1B / GC / citizen?",
          en: "are you eligible to work in the US? which one — OPT / H1B / GC / citizen?",
        },
        {
          zh: "one word on your auth — 'citizen' / 'opt' / 'h1b' / 'need sponsor'",
          en: "one word on your auth — 'citizen' / 'opt' / 'h1b' / 'need sponsor'",
        },
      ],
      {
        zh: "citizen / opt / h1b / sponsor — pick one",
        en: "citizen / opt / h1b / sponsor — pick one",
      }
    ),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onVisaAccepted,
  })

  const startupPrefQ: Question<unknown> = makeQuestion({
    id: "q_startup_pref",
    prompt: {
      zh: "do you prefer startups, bigger-company stability, or are you flexible?",
      en: "do you prefer startups, bigger-company stability, or are you flexible?",
    },
    judge: new LLMRelevanceJudge({
      step: "ask_q_startup_pref",
      extractIntent: deps.extractAnswerIntent,
    }),
    rephraser: probeRephraserOpts(
      [
        {
          zh: "startup / bigtech / either — pick one",
          en: "startup / bigtech / either — pick one",
        },
        {
          // iter34 hotfix 2026-05-05 — mirror legacy fix; was off-theme drift.
          zh: "if you had to pick — startup / bigtech / either? 'either' is fine",
          en: "if you had to pick — startup / bigtech / either? 'either' is fine",
        },
        {
          zh: "do you prefer startup pace or the stability of a bigger company?",
          en: "do you prefer startup pace or the stability of a bigger company?",
        },
        {
          zh: "one word works: 'startup' / 'bigtech' / 'either'",
          en: "one word works: 'startup' / 'bigtech' / 'either'",
        },
      ],
      {
        zh: "startup / bigtech / either",
        en: "startup / bigtech / either",
      }
    ),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onStartupPrefAccepted,
  })

  const locationQ: Question<unknown> = makeQuestion({
    id: "q_location",
    prompt: {
      zh: "where you wanna be? SF / NYC / remote ok?",
      en: "where you wanna be? SF / NYC / remote ok?",
    },
    judge: new LLMRelevanceJudge({
      step: "ask_q_location",
      extractIntent: deps.extractAnswerIntent,
    }),
    rephraser: probeRephraserOpts(
      [
        {
          zh: "city / region / or just 'remote' is fine",
          en: "city / region / or just 'remote' is fine",
        },
        {
          zh: "where you wanna be — SF / NYC / Seattle / China / remote? any of those",
          en: "where you wanna be — SF / NYC / Seattle / China / remote? any of those",
        },
        {
          zh: "let me ask again — city + remote pref, like 'sf' / 'nyc' / 'remote'",
          en: "let me ask again — city + remote pref, like 'sf' / 'nyc' / 'remote'",
        },
        {
          zh: "one location is fine — 'bay area' / 'shanghai' / 'remote'",
          en: "one location is fine — 'bay area' / 'shanghai' / 'remote'",
        },
      ],
      {
        zh: "city or 'remote' is fine",
        en: "city or 'remote' is fine",
      }
    ),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onLocationAccepted,
  })

  const resumeQ: Question<ResumeAttachment[]> = makeQuestion({
    id: "q_resume",
    prompt: {
      zh: "btw — can you send me your resume? makes JD review and referrals way more on-point",
      en: "btw — can you send me your resume? makes JD review and referrals way more on-point",
    },
    judge: new ResumeJudge(),
    rephraser: new StaticVariantsRephraser([
      {
        zh: "just waiting on the resume — send it as an iMessage attachment whenever",
        en: "just waiting on the resume — send it as an iMessage attachment whenever",
      },
      {
        zh: "drop the resume as an iMessage attachment — pdf / docx, either works",
        en: "drop the resume as an iMessage attachment — pdf / docx, either works",
      },
      {
        zh: "no resume? reply 'no resume' and we'll work with chat alone",
        en: "no resume? reply 'no resume' and we'll work with chat alone",
      },
      {
        zh: "try again — iMessage attachment, pdf preferred",
        en: "try again — iMessage attachment, pdf preferred",
      },
    ]),
    haltMessage: {
      zh: "skipping resume for now — drop it whenever",
      en: "skipping resume for now — drop it whenever",
    },
    onEnter: async (ctx) => {
      const hasResume = await hasParsedResumeOnFile(ctx)
      ctx.log?.("pa.onboarding.resume.existing_on_enter", {
        userId: ctx.userId,
        turnId: ctx.turnId,
        hasResume,
      })
      if (!hasResume) return null
      return { accept: true, value: [], confidence: 0.95 }
    },
    onAccepted: deps.onResumeAccepted,
    suppressTerminalCompletionMessage: true,
    // resume decline = skip, not halt.
    onDeclined: async () => ({ advance: true }),
  })

  return [
    tosQ as Question<unknown>,
    roleQ,
    yoeQ,
    visaQ,
    startupPrefQ,
    locationQ,
    resumeQ as Question<unknown>,
  ]
}

// ============================================================================
// V2 — GuidedOpenJudge-backed questions (iter34 P3 / GOAL-onboarding-refactor)
// ============================================================================
//
// Adam directive 2026-05-07: regex is bloom filter only, LLM is primary.
// Q_COUNTRY is split out of q_location (Adam yes #2). q_visa drops "OPT"
// as a separate option per CLAUDE.md D4 (OPT/CPT/H1B → sponsorship_needed).
//
// Each V2 question:
//   - judge = GuidedOpenJudge<TAnswer> with hints + few-shot examples
//   - bloom regex is OPTIMISTIC (skip LLM only on clean hits) — never blocks
//   - onAccepted writes BOTH statedPreferences AND tags via deps.* hooks
//     (per D8 single-source — runtime owns dual-write, this layer just
//     dispatches the canonical value)
//
// q_location can be scoped by `makeLocationQuestion(["usa"], deps)` /
// `makeLocationQuestion(["china"], deps)`, while the normal pipeline uses
// an open "within that country/region" prompt plus the anywhere superset.

import {
  GuidedOpenJudge,
  type GuidedOpenJudgeSpec,
} from "./judges/guided-open.js"

// ─── Type contracts ────────────────────────────────────────────────────────

/**
 * q_country canonical answer. Always an array so the interface matches
 * role/location multi-value preferences and writes directly into
 * statedPreferences.targetCountry / tags.targetCountry.
 */
export type CountryAnswer =
  string[]

/**
 * q_location canonical answer. Array of city/region tokens (e.g. ["sf",
 * "nyc"], ["shanghai"], or ["anywhere"]). Tokens come from shared-tags
 * `LOCATION_VOCAB` but the LLM is permitted to emit free-form strings
 * when no canonical token fits — downstream `applyToTags` re-canons.
 */
export type LocationAnswer = string[]

/**
 * q_visa canonical answer per CLAUDE.md D4. NOTE: OPT / CPT / H1B
 * collapse into `"sponsorship_needed"` — this is a deliberate product
 * decision (the visa prompt no longer lists OPT separately).
 */
export type VisaAnswer =
  | "citizen"
  | "permanent_resident"
  | "sponsorship_needed"
  | "other"

export type RoleAnswer = string[]
export type YoeAnswer = number | "fresh"
export type StartupPrefAnswer = "startup" | "bigtech" | "either"

// ─── Q_ROLE / Q_YOE / Q_STARTUP_PREF (V2 GuidedOpen) ───────────────────────

function normalizeRoleToken(raw: string): string | null {
  const t = raw.trim().toLowerCase()
  if (!t) return null
  return t
}

function parseRoleReply(reply: string): RoleAnswer | null {
  const t = reply.toLowerCase()
  const matched: string[] = []
  const add = (token: string, pattern: RegExp) => {
    if (pattern.test(t) && !matched.includes(token)) matched.push(token)
  }

  add("fullstack", /\bfull[-\s]?stack\b|\bfullstack\b/)
  add("frontend", /\bfront[-\s]?end\b|\bfrontend\b|\bfe\b/)
  add("backend", /\bback[-\s]?end\b|\bbackend\b|\bbe\b/)
  add("data", /\bdata\s+(scientist|analyst|engineer|science|analytics)\b/)
  add("ml", /\b(ml|ai)\s+engineer\b|machine\s+learning|deep\s+learning/)
  add("infra", /\b(platform|infra|infrastructure|devops|sre)\b/)
  add(
    "swe",
    /\b(swe|software\s+(engineer|engineering|developer|development)|product\s+engineer|product\s+engineering|engineer|engineering|developer|web\s+developer|mobile\s+developer|coder|cs)\b/,
  )
  add("pm", /\b(pm|product\s+manager|product\s+management|tpm)\b/)
  add("research", /\b(research|researcher|scientist)\b/)
  add("design", /\b(designer|product\s+designer|design\s+role|ux\s+designer|ui\s+designer)\b/)

  if (matched.length === 0) return null
  if (
    matched.includes("swe") &&
    matched.some((token) => ["fullstack", "frontend", "backend", "data", "ml", "infra"].includes(token))
  ) {
    return matched.filter((token) => token !== "swe")
  }
  return matched
}

function splitOpenListValue(raw: string): string[] {
  return raw
    .split("/")
    .flatMap((s) => s.split(","))
    .flatMap((s) => s.split("|"))
    .flatMap((s) => s.split(";"))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
}

function parseRoleValue(raw: unknown): RoleAnswer | null {
  const values = Array.isArray(raw) ? raw : [raw]
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== "string") continue
    for (const part of splitOpenListValue(value)) {
      const role = normalizeRoleToken(part)
      if (!role || seen.has(role)) continue
      seen.add(role)
      out.push(role)
    }
  }
  return out.length > 0 ? out : null
}

export function makeRoleQuestion(
  onAccepted?: (role: RoleAnswer, ctx: AcceptedCtx) => Promise<void>,
  llmCallFactory?: GuidedOpenJudgeSpec<RoleAnswer>["llmCallFactory"]
): Question<RoleAnswer> {
  return makeQuestion<RoleAnswer>({
    id: "q_role",
    prompt: {
      zh: "heads up — i need to nail down these next few before I can actually help you — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
      en: "heads up — i need to nail down these next few before I can actually help you — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
    },
    judge: new GuidedOpenJudge<RoleAnswer>({
      questionLabel: "target job role",
      hints: ["swe", "pm", "research", "design", "data", "ml", "ops", "marketing", "founder"],
      examples: [
        { reply: "Software Engineer", value: ["swe"], confidence: 0.95 },
        { reply: "Swe / pm", value: ["swe", "pm"], confidence: 0.9 },
        { reply: "PM for fintech", value: ["pm"], confidence: 0.9 },
        { reply: "i do ml infra", value: ["ml"], confidence: 0.9 },
        { reply: "designer", value: ["design"], confidence: 0.95 },
      ],
      parseValue: parseRoleValue,
      parseReply: parseRoleReply,
      ...(llmCallFactory ? { llmCallFactory } : {}),
    }),
    rephraser: new HybridRephraser({
      variants: [
        {
          zh: "didn't quite catch that — what role specifically? eng / pm / research / design — one or two words works",
          en: "didn't quite catch that — what role specifically? eng / pm / research / design — one or two words works",
        },
        {
          zh: "roughly which direction — eng / pm / research / design? just pick one",
          en: "roughly which direction — eng / pm / research / design? just pick one",
        },
        {
          zh: "let me try again — what's your role been? like 'frontend' / 'data' / 'pm' style",
          en: "let me try again — what's your role been? like 'frontend' / 'data' / 'pm' style",
        },
        {
          zh: "one word for what you do is fine — 'swe' / 'pm' / 'designer' / 'researcher'",
          en: "one word for what you do is fine — 'swe' / 'pm' / 'designer' / 'researcher'",
        },
      ],
      fallback: {
        zh: "swe / pm / research / design — one works",
        en: "swe / pm / research / design — one works",
      },
    }),
    haltMessage: HALT_DEFAULT,
    onAccepted,
  })
}

export const Q_ROLE: Question<RoleAnswer> = makeRoleQuestion()

function parseYoeValue(raw: unknown): YoeAnswer | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.round(raw)
  }
  if (typeof raw !== "string") return null
  const t = raw.trim().toLowerCase()
  if (!t) return null
  if (
    t.includes("fresh") ||
    t.includes("new grad") ||
    t.includes("new_grad") ||
    false
  ) {
    return "fresh"
  }
  const n = Number(t)
  if (Number.isFinite(n) && n >= 0) return Math.round(n)
  let digits = ""
  for (const ch of t) {
    if ((ch >= "0" && ch <= "9") || ch === ".") digits += ch
    else if (digits) break
  }
  if (digits) {
    const parsed = Number(digits)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed)
  }
  return null
}

export function makeYoeQuestion(
  onAccepted?: (yoe: YoeAnswer, ctx: AcceptedCtx) => Promise<void>,
  llmCallFactory?: GuidedOpenJudgeSpec<YoeAnswer>["llmCallFactory"]
): Question<YoeAnswer> {
  return makeQuestion<YoeAnswer>({
    id: "q_yoe",
    prompt: {
      zh: "how many years have you been working? New grad is fine too.",
      en: "how many years have you been working? New grad is fine too.",
    },
    judge: new GuidedOpenJudge<YoeAnswer>({
      questionLabel: "years of experience",
      hints: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "10", "fresh"],
      examples: [
        { reply: "2years", value: 2, confidence: 1.0 },
        { reply: "2 years", value: 2, confidence: 1.0 },
        { reply: "5y", value: 5, confidence: 0.95 },
        { reply: "3 years", value: 3, confidence: 0.95 },
        { reply: "3-5 years", value: 4, confidence: 0.9 },
        { reply: "fresh grad", value: "fresh", confidence: 1.0 },
        { reply: "just graduated", value: "fresh", confidence: 1.0 },
      ],
      parseValue: parseYoeValue,
      parseReply: parseYoeValue,
      ...(llmCallFactory ? { llmCallFactory } : {}),
    }),
    rephraser: new HybridRephraser({
      variants: [
        {
          zh: "roughly a number works — '3 years' / '8 years' / or 'fresh grad'",
          en: "roughly a number works — '3 years' / '8 years' / or 'fresh grad'",
        },
        {
          zh: "ballpark is fine — 0 / 1 / 3 / 5 / 10 — closest one?",
          en: "ballpark is fine — 0 / 1 / 3 / 5 / 10 — closest one?",
        },
        {
          zh: "roughly how many years working? or still in school / new grad?",
          en: "roughly how many years working? or still in school / new grad?",
        },
        {
          zh: "just need a number, like '2 years' or 'fresh grad'",
          en: "just need a number, like '2 years' or 'fresh grad'",
        },
      ],
      fallback: {
        zh: "how many years? a number works",
        en: "how many years? a number works",
      },
    }),
    haltMessage: HALT_DEFAULT,
    onAccepted,
  })
}

export const Q_YOE: Question<YoeAnswer> = makeYoeQuestion()

function parseStartupPrefValue(raw: unknown): StartupPrefAnswer | null {
  if (typeof raw !== "string") return null
  const t = raw.trim().toLowerCase()
  if (
    t.includes("either") ||
    t.includes("both") ||
    /\b(any|anything)\b/.test(t) ||
    t.includes("flexible") ||
    t.includes("open to either") ||
    (t.includes("startup") && (t.includes("bigtech") || t.includes("big tech") || t.includes("big-co"))) ||
    false
  ) return "either"
  if (t === "startup") return "startup"
  if (
    t.includes("startup") ||
    t.includes("start-up") ||
    t.includes("early-stage") ||
    t.includes("early stage") ||
    t.includes("fast-moving") ||
    t.includes("fast moving") ||
    false
  ) return "startup"
  if (
    t === "bigtech" ||
    t === "big_tech" ||
    t === "big tech" ||
    t.includes("big company") ||
    t.includes("big-co") ||
    t.includes("large company") ||
    t.includes("enterprise") ||
    t.includes("stable") ||
    false
  ) return "bigtech"
  return null
}

export function makeStartupPrefQuestion(
  onAccepted?: (pref: StartupPrefAnswer, ctx: AcceptedCtx) => Promise<void>,
  llmCallFactory?: GuidedOpenJudgeSpec<StartupPrefAnswer>["llmCallFactory"]
): Question<StartupPrefAnswer> {
  return makeQuestion<StartupPrefAnswer>({
    id: "q_startup_pref",
    prompt: {
      zh: "do you prefer startups, bigger-company stability, or are you flexible?",
      en: "do you prefer startups, bigger-company stability, or are you flexible?",
    },
    judge: new GuidedOpenJudge<StartupPrefAnswer>({
      questionLabel: "startup vs bigtech preference",
      hints: ["startup", "bigtech", "either"],
      examples: [
        { reply: "startup", value: "startup", confidence: 1.0 },
        {
          reply: "I lean startup or fast-moving early-stage teams, but still care about a solid manager",
          value: "startup",
          confidence: 0.95,
        },
        { reply: "big company stable", value: "bigtech", confidence: 0.9 },
        { reply: "either is fine", value: "either", confidence: 0.95 },
        { reply: "Either", value: "either", confidence: 1.0 },
        { reply: "depends on the team", value: "either", confidence: 0.8 },
      ],
      bloomRegex: [
        {
          pattern: /\b(either|both|any|flexible|open to either|depends|team-dependent)\b|(\bstartup\b|\bstart-up\b|\bearly[-\s]?stage\b|\bfast[-\s]?moving\b|founding).*(\bbigtech\b|\bbig tech\b|\bbig[-\s]?company\b|\blarge company\b|\benterprise\b|\bstable\b)|(\bbigtech\b|\bbig tech\b|\bbig[-\s]?company\b|\blarge company\b|\benterprise\b|\bstable\b).*(\bstartup\b|\bstart-up\b|\bearly[-\s]?stage\b|\bfast[-\s]?moving\b)/i,
          value: "either",
        },
        {
          pattern: /\bstartup\b|\bstart-up\b|\bearly[-\s]?stage\b|\bfast[-\s]?moving\b|\bfounding\b/i,
          value: "startup",
        },
        {
          pattern: /\bbigtech\b|\bbig tech\b|\bbig[-\s]?company\b|\blarge company\b|\benterprise\b|\bstable\b/i,
          value: "bigtech",
        },
      ],
      parseValue: parseStartupPrefValue,
      ...(llmCallFactory ? { llmCallFactory } : {}),
    }),
    rephraser: new HybridRephraser({
      variants: [
        {
          zh: "I just need the preference tag: more startup, big-company, or flexible?",
          en: "I just need the preference tag: more startup, big-company, or flexible?",
        },
        {
          zh: "You can add nuance, just include the closest label: startup / big-company / flexible.",
          en: "You can add nuance, just include the closest label: startup / big-company / flexible.",
        },
        {
          zh: "do you prefer startup pace or the stability of a bigger company?",
          en: "do you prefer startup pace or the stability of a bigger company?",
        },
        {
          zh: "one word works: 'startup' / 'bigtech' / 'either'",
          en: "one word works: 'startup' / 'bigtech' / 'either'",
        },
      ],
      fallback: {
        zh: "startup / bigtech / either",
        en: "startup / bigtech / either",
      },
    }),
    haltMessage: HALT_DEFAULT,
    onAccepted,
  })
}

export const Q_STARTUP_PREF: Question<StartupPrefAnswer> = makeStartupPrefQuestion()

// ─── Q_COUNTRY ──────────────────────────────────────────────────────────────

/**
 * Canonical country tokens recognized by the LLM. Anything outside the
 * top 5 returns as free-form (e.g. "australia") so we don't lose info.
 */
const COUNTRY_HINTS = ["usa", "china", "canada", "europe", "anywhere"] as const

/**
 * Few-shot table covering Adam-verified cases:
 *   - "USA"                   -> "usa"
 *   - "PRC"                   -> "china"
 *   - "Anywhere"              -> "anywhere"
 *   - "in north america"      → ["usa", "canada"] (multi)
 *   - "either USA or China"   → ["usa", "china"] (multi)
 *   - "based in europe but ok with us" (multi-country)
 */
const COUNTRY_EXAMPLES: GuidedOpenJudgeSpec<CountryAnswer>["examples"] = [
  { reply: "USA", value: ["usa"], confidence: 1.0 },
  { reply: "America", value: ["usa"], confidence: 1.0 },
  { reply: "China", value: ["china"], confidence: 1.0 },
  { reply: "Anywhere is fine", value: ["anywhere"], confidence: 1.0 },
  { reply: "doesn't matter", value: ["anywhere"], confidence: 0.95 },
  { reply: "in north america", value: ["usa", "canada"], confidence: 0.9 },
  { reply: "either USA or China", value: ["usa", "china"], confidence: 0.9 },
  { reply: "based in europe", value: ["europe"], confidence: 0.95 },
]

/**
 * `parseValue` for q_country. Accepts a single canonical string, an
 * array (multi-country), or any non-empty free-form. Empty / non-string
 * / non-array → null (judge degrades to "unclear").
 */
function parseCountryValue(raw: unknown): CountryAnswer | null {
  if (typeof raw === "string") {
    const items = splitOpenListValue(raw)
    if (items.length === 0) return null
    return items
  }
  if (Array.isArray(raw)) {
    const items = raw
      .filter((x): x is string => typeof x === "string")
      .flatMap((x) => splitOpenListValue(x))
    if (items.length === 0) return null
    return items
  }
  return null
}

/**
 * Bloom regex — optimistic short-circuit on the most common clean
 * one-word replies. Anything ambiguous falls through to the LLM.
 */
/**
 * Q_COUNTRY — top-level country/region pick. Asked BEFORE q_location so
 * the location follow-up can scope its hint pool to the chosen country.
 *
 * NOTE: this constant has NO `onAccepted`. Use `defaultQuestionsV2(deps)`
 * to spawn a pipeline-ready instance with `deps.onCountryAccepted` wired
 * for dual-write into statedPreferences + tags (per D8).
 */
export const Q_COUNTRY: Question<CountryAnswer> = makeQuestion<CountryAnswer>({
  id: "q_country",
  prompt: {
    zh: "which country/region you targeting? USA / China / Canada / Europe / anywhere — multi is fine",
    en: "which country/region you targeting? USA / China / Canada / Europe / anywhere — multi is fine",
  },
  judge: new GuidedOpenJudge<CountryAnswer>({
    questionLabel: "target country / region",
    hints: COUNTRY_HINTS,
    examples: COUNTRY_EXAMPLES,
    parseValue: parseCountryValue,
  }),
  rephraser: new HybridRephraser({
    variants: [
      {
        zh: "pick a country: USA / China / Canada / Europe / anywhere",
        en: "pick a country: USA / China / Canada / Europe / anywhere",
      },
      {
        zh: "let me ask again — which country are you targeting? one or multiple is fine",
        en: "let me ask again — which country are you targeting? one or multiple is fine",
      },
      {
        zh: "USA / China / anywhere — pick one and we move on",
        en: "USA / China / anywhere — pick one and we move on",
      },
      {
        zh: "what country do you wanna work in? one or two is plenty",
        en: "what country do you wanna work in? one or two is plenty",
      },
    ],
    fallback: {
      zh: "country only: USA / China / anywhere",
      en: "country only: USA / China / anywhere",
    },
  }),
  haltMessage: HALT_DEFAULT,
})

// ─── Q_LOCATION (V2 — country-aware factory) ────────────────────────────────

/** USA city pool (Adam directive 2026-05-07). */
const USA_LOCATION_HINTS = [
  "sf",
  "bay_area",
  "nyc",
  "seattle",
  "los_angeles",
  "boston",
  "chicago",
  "austin",
  "remote",
  "anywhere",
] as const

/** China city pool. */
const CHINA_LOCATION_HINTS = [
  "shanghai",
  "beijing",
  "hangzhou",
  "shenzhen",
  "guangzhou",
  "anywhere",
] as const

/** Default (country=anywhere) hint pool — superset of USA + China + Europe. */
const ANYWHERE_LOCATION_HINTS = [
  ...USA_LOCATION_HINTS,
  ...CHINA_LOCATION_HINTS,
  "london",
  "berlin",
  "paris",
  "amsterdam",
  "toronto",
  "vancouver",
] as const

/**
 * Few-shot fixtures — includes Adam-verified pain points
 * ("Bay Area", "sfran or nYC works", "Everywhere is fine").
 */
const LOCATION_EXAMPLES: GuidedOpenJudgeSpec<LocationAnswer>["examples"] = [
  { reply: "Bay Area", value: ["sf", "bay_area"], confidence: 0.95 },
  { reply: "sfran or nYC works", value: ["sf", "nyc"], confidence: 0.9 },
  { reply: "Everywhere is fine", value: ["anywhere"], confidence: 1.0 },
  { reply: "anywhere works", value: ["anywhere"], confidence: 1.0 },
  { reply: "remote", value: ["remote"], confidence: 1.0 },
  { reply: "Shanghai or Beijing", value: ["shanghai", "beijing"], confidence: 0.95 },
  { reply: "NYC, Boston, or remote", value: ["nyc", "boston", "remote"], confidence: 0.9 },
  { reply: "Hangzhou", value: ["hangzhou"], confidence: 1.0 },
]

/**
 * `parseValue` for q_location. Always returns string[]; tolerates the
 * LLM emitting either a single string or array. Empty → null.
 */
function parseLocationValue(raw: unknown): LocationAnswer | null {
  if (typeof raw === "string") {
    const items = splitOpenListValue(raw)
    return items.length > 0 ? items : null
  }
  if (Array.isArray(raw)) {
    const items = raw
      .filter((x): x is string => typeof x === "string")
      .flatMap((x) => splitOpenListValue(x))
    if (items.length === 0) return null
    return items
  }
  return null
}

const LOCATION_REPLY_PATTERNS: { value: string; patterns: RegExp[] }[] = [
  {
    value: "nyc",
    patterns: [/\bnyc\b/i, /\bnew\s+york(?:\s+city)?\b/i],
  },
  {
    value: "sf",
    patterns: [/\bsf\b/i, /\bs\.?\s*f\.?\b/i, /\bsan\s+francisco\b/i, /\bsfran\b/i],
  },
  {
    value: "bay_area",
    patterns: [/\bbay\s+area\b/i],
  },
  {
    value: "remote",
    patterns: [/\bremote\b/i, /\bwork\s+from\s+home\b/i],
  },
  {
    value: "anywhere",
    patterns: [/\banywhere\b/i, /\beverywhere\b/i, /\bopen\s+to\s+any\b/i, /\bany\s+location\b/i],
  },
  { value: "seattle", patterns: [/\bseattle\b/i] },
  {
    value: "los_angeles",
    patterns: [/\blos\s+angeles\b/i, /\bla\b/i],
  },
  { value: "boston", patterns: [/\bboston\b/i] },
  { value: "chicago", patterns: [/\bchicago\b/i] },
  { value: "austin", patterns: [/\baustin\b/i] },
  { value: "toronto", patterns: [/\btoronto\b/i] },
  { value: "vancouver", patterns: [/\bvancouver\b/i] },
  { value: "london", patterns: [/\blondon\b/i] },
  { value: "berlin", patterns: [/\bberlin\b/i] },
  { value: "paris", patterns: [/\bparis\b/i] },
  { value: "amsterdam", patterns: [/\bamsterdam\b/i] },
  { value: "shanghai", patterns: [/\bshanghai\b/i] },
  { value: "beijing", patterns: [/\bbeijing\b/i] },
  { value: "hangzhou", patterns: [/\bhangzhou\b/i] },
  { value: "shenzhen", patterns: [/\bshenzhen\b/i] },
  { value: "guangzhou", patterns: [/\bguangzhou\b/i] },
]

function parseLocationReply(reply: string): LocationAnswer | null {
  const text = reply
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return null

  const hits: { value: string; index: number }[] = []
  for (const entry of LOCATION_REPLY_PATTERNS) {
    let firstIndex: number | null = null
    for (const pattern of entry.patterns) {
      pattern.lastIndex = 0
      const match = pattern.exec(text)
      if (!match?.[0]) continue
      if (
        entry.value === "remote" &&
        /\b(no|not|never|don't|do not)\s+remote\b/i.test(text)
      ) {
        continue
      }
      const index = match.index
      firstIndex = firstIndex === null ? index : Math.min(firstIndex, index)
    }
    if (firstIndex !== null) hits.push({ value: entry.value, index: firstIndex })
  }

  if (hits.length === 0) return null
  const seen = new Set<string>()
  return hits
    .sort((a, b) => a.index - b.index)
    .map((hit) => hit.value)
    .filter((value) => {
      if (seen.has(value)) return false
      seen.add(value)
      return true
    })
}

/**
 * Bloom regex for the most common one-word location replies.
 * NEVER blocks — the LLM owns ambiguous cases.
 */
/**
 * Build a country-scoped Q_LOCATION.
 *
 * country=undefined or ["anywhere"] → ANYWHERE_LOCATION_HINTS (superset)
 * country=["usa"]                   → USA_LOCATION_HINTS
 * country=["china"]                 → CHINA_LOCATION_HINTS
 * country=other/multi free-form     → ANYWHERE_LOCATION_HINTS (let LLM canon)
 *
 * Use this in P7-4 dispatcher AFTER q_country is answered so the location
 * follow-up's hint pool is scoped correctly. The exported `Q_LOCATION`
 * constant uses the anywhere-default for static reference.
 */
export function makeLocationQuestion(
  country: CountryAnswer | undefined,
  onAccepted?: (loc: LocationAnswer, ctx: AcceptedCtx) => Promise<void>
): Question<LocationAnswer> {
  let hints: readonly string[] = ANYWHERE_LOCATION_HINTS
  if (Array.isArray(country) && country.length === 1 && country[0] === "usa") {
    hints = USA_LOCATION_HINTS
  } else if (Array.isArray(country) && country.length === 1 && country[0] === "china") {
    hints = CHINA_LOCATION_HINTS
  }
  // any other value (canada, europe, free-form, multi-country) → anywhere
  // superset; the LLM filters by user intent.

  const promptVariants: { prompt: BilingualText; reAsks: BilingualText[] } =
    Array.isArray(country) && country.length === 1 && country[0] === "china"
      ? {
          prompt: {
            zh: "ok, in China, any city or remote preference? Shanghai / Beijing / Hangzhou / Shenzhen / Guangzhou / anywhere",
            en: "ok, in China, any city or remote preference? Shanghai / Beijing / Hangzhou / Shenzhen / Guangzhou / anywhere",
          },
          reAsks: [
            {
              zh: "city please: Shanghai / Beijing / Hangzhou / Shenzhen — one or more",
              en: "city please: Shanghai / Beijing / Hangzhou / Shenzhen — one or more",
            },
            {
              zh: "let me ask again — which city? 'anywhere' works too",
              en: "let me ask again — which city? 'anywhere' works too",
            },
            {
              zh: "one city is fine, like 'Shanghai' / 'Beijing' / 'anywhere'",
              en: "one city is fine, like 'Shanghai' / 'Beijing' / 'anywhere'",
            },
          ],
        }
      : Array.isArray(country) && country.length === 1 && country[0] === "usa"
      ? {
          prompt: {
            zh: "ok, in the US, any city or remote preference? Bay Area / NYC / Seattle / LA / Boston / Chicago / Austin / anywhere",
            en: "ok, in the US, any city or remote preference? Bay Area / NYC / Seattle / LA / Boston / Chicago / Austin / anywhere",
          },
          reAsks: [
            {
              zh: "city please: Bay Area / NYC / Seattle / Boston — one or more",
              en: "city please: Bay Area / NYC / Seattle / Boston — one or more",
            },
            {
              zh: "let me ask again — where in the US? remote or 'anywhere' is fine",
              en: "let me ask again — where in the US? remote or 'anywhere' is fine",
            },
            {
              zh: "one city works, like 'sf' / 'nyc' / 'remote'",
              en: "one city works, like 'sf' / 'nyc' / 'remote'",
            },
          ],
        }
      : {
          prompt: {
            zh: "ok, within that country/region, any city or remote preference? a city / region / 'remote' / 'anywhere' all work",
            en: "ok, within that country/region, any city or remote preference? a city / region / 'remote' / 'anywhere' all work",
          },
          reAsks: [
            {
              zh: "city / region / or just 'remote' is fine",
              en: "city / region / or just 'remote' is fine",
            },
            {
              zh: "let me ask again — city + remote pref, like 'sf' / 'shanghai' / 'remote'",
              en: "let me ask again — city + remote pref, like 'sf' / 'shanghai' / 'remote'",
            },
            {
              zh: "one location is fine: 'bay area' / 'shanghai' / 'remote' / 'anywhere'",
              en: "one location is fine: 'bay area' / 'shanghai' / 'remote' / 'anywhere'",
            },
          ],
        }

  return makeQuestion<LocationAnswer>({
    id: "q_location",
    prompt: promptVariants.prompt,
    judge: new GuidedOpenJudge<LocationAnswer>({
      questionLabel: "target work city / region",
      hints,
      examples: LOCATION_EXAMPLES,
      parseValue: parseLocationValue,
      parseReply: parseLocationReply,
    }),
    rephraser: new HybridRephraser({
      variants: promptVariants.reAsks,
      fallback: {
        zh: "city or 'remote' is fine",
        en: "city or 'remote' is fine",
      },
    }),
    haltMessage: HALT_DEFAULT,
    onAccepted,
  })
}

/**
 * Default Q_LOCATION export — anywhere-superset hints. P7-4 dispatcher
 * SHOULD swap to `makeLocationQuestion(country, onAccepted)` once
 * q_country is answered, so the LLM gets a tighter answer space.
 */
export const Q_LOCATION: Question<LocationAnswer> = makeLocationQuestion(
  undefined,
  undefined
)

// ─── Q_VISA (V2 — drops OPT-as-separate per D4) ─────────────────────────────

/** Canonical visa tokens per CLAUDE.md D4. */
const VISA_HINTS = [
  "citizen",
  "permanent_resident",
  "sponsorship_needed",
  "other",
] as const

/**
 * Few-shot includes the Adam-verified collapse:
 *   OPT / CPT / H1B / "need a visa" -> sponsorship_needed (per D4)
 *   green card / GC               -> permanent_resident
 *   citizen                       -> citizen
 *   "in the US but special status" -> other
 */
const VISA_EXAMPLES: GuidedOpenJudgeSpec<VisaAnswer>["examples"] = [
  { reply: "citizen", value: "citizen", confidence: 1.0 },
  { reply: "citizen", value: "citizen", confidence: 1.0 },
  { reply: "GC", value: "permanent_resident", confidence: 1.0 },
  { reply: "green card holder", value: "permanent_resident", confidence: 1.0 },
  { reply: "I have OPT", value: "sponsorship_needed", confidence: 0.95 },
  { reply: "on H1B", value: "sponsorship_needed", confidence: 0.95 },
  { reply: "CPT student", value: "sponsorship_needed", confidence: 0.9 },
  { reply: "i need sponsor", value: "sponsorship_needed", confidence: 1.0 },
  { reply: "need sponsorship", value: "sponsorship_needed", confidence: 1.0 },
  { reply: "other special case", value: "other", confidence: 0.8 },
]

function parseVisaValue(raw: unknown): VisaAnswer | null {
  if (typeof raw !== "string") return null
  const t = raw.trim().toLowerCase()
  if (t === "citizen") return "citizen"
  if (
    t === "permanent_resident" ||
    t === "permanent-resident" ||
    t === "gc" ||
    t === "green_card"
  )
    return "permanent_resident"
  if (
    t === "sponsorship_needed" ||
    t === "sponsorship-needed" ||
    t === "sponsor_needed" ||
    t === "need_sponsorship" ||
    t === "opt" ||
    t === "cpt" ||
    t === "h1b" ||
    t === "h-1b"
  )
    return "sponsorship_needed"
  if (t === "other") return "other"
  return null
}

function parseVisaReply(reply: string): VisaAnswer | null {
  const t = reply
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
  if (!t) return null

  if (/\b(us|u\.s\.|american)?\s*citizen\b/.test(t)) {
    return "citizen"
  }
  if (/\b(gc|green card|permanent resident)\b/.test(t)) {
    return "permanent_resident"
  }
  if (
    /\b(f-?1|opt|cpt|h-?1b)\b/.test(t) ||
    /\b(would|will|do|does|did|i|we)?\s*(need|require|requires|required|needing)\b.{0,60}\b(sponsor|sponsorship)\b/.test(t) ||
    /\b(sponsor|sponsorship)\b.{0,60}\b(needed|required|future|h-?1b|transfer)\b/.test(t) ||
    false
  ) {
    return "sponsorship_needed"
  }

  return null
}

/**
 * Q_VISA — V2 prompt drops "OPT" listing per D4. Internally OPT/CPT/H1B
 * all canonicalize to `sponsorship_needed`, but the prompt asks the
 * three-way (citizen / GC / need sponsorship) so the user isn't
 * confused that "OPT" is a separate visa bucket.
 */
export const Q_VISA: Question<VisaAnswer> = makeQuestion<VisaAnswer>({
  id: "q_visa",
  prompt: {
    zh: "what's your work auth? citizen / GC / need sponsorship (incl. OPT/CPT/H1B)",
    en: "what's your work auth? citizen / GC / need sponsorship (incl. OPT/CPT/H1B)",
  },
  judge: new GuidedOpenJudge<VisaAnswer>({
    questionLabel: "US work authorization status",
    hints: VISA_HINTS,
    examples: VISA_EXAMPLES,
    parseValue: parseVisaValue,
    parseReply: parseVisaReply,
  }),
  rephraser: new HybridRephraser({
    variants: [
      {
        zh: "pick one: citizen / GC / need sponsorship",
        en: "pick one: citizen / GC / need sponsorship",
      },
      {
        zh: "what's your status — citizen, GC, or need sponsorship? (OPT/CPT/H1B all count as need sponsorship)",
        en: "what's your status — citizen, GC, or need sponsorship? (OPT/CPT/H1B all count as need sponsorship)",
      },
      {
        zh: "are you eligible to work in the US? citizen / GC / or need sponsorship?",
        en: "are you eligible to work in the US? citizen / GC / or need sponsorship?",
      },
      {
        zh: "one word on your auth — 'citizen' / 'gc' / 'need sponsor'",
        en: "one word on your auth — 'citizen' / 'gc' / 'need sponsor'",
      },
    ],
    fallback: {
      zh: "citizen / gc / sponsor — pick one",
      en: "citizen / gc / sponsor — pick one",
    },
  }),
  haltMessage: HALT_DEFAULT,
})

// ─── ONBOARDING_QUESTIONS_V2 ────────────────────────────────────────────────

/**
 * Deps shape for `defaultQuestionsV2`. Mirrors `DefaultQuestionsDeps` but
 * adds `onCountryAccepted` and reuses the existing accept hooks for
 * tos / role / yoe / startup_pref / resume.
 *
 * Per D8 — every onAccepted is expected to do dual-write
 * (statedPreferences + tags). Runtime owns that; this layer just
 * dispatches the canonical value.
 */
export interface DefaultQuestionsV2Deps extends ClosedQuestionsDeps {
  onRoleAccepted?: (role: RoleAnswer, ctx: AcceptedCtx) => Promise<void>
  onYoeAccepted?: (yoe: YoeAnswer, ctx: AcceptedCtx) => Promise<void>
  onVisaAccepted?: (visa: VisaAnswer, ctx: AcceptedCtx) => Promise<void>
  onStartupPrefAccepted?: (
    pref: StartupPrefAnswer,
    ctx: AcceptedCtx
  ) => Promise<void>
  onLocationAccepted?: (loc: LocationAnswer, ctx: AcceptedCtx) => Promise<void>
  /** Hook fired when q_country accepts. Writes targetCountry to prefs+tags. */
  onCountryAccepted?: (country: CountryAnswer, ctx: AcceptedCtx) => Promise<void>
}

/**
 * Static V2 question list — references the V2 GuidedOpen versions of role /
 * yoe / visa / startup / country / location.
 *
 * NOTE: this constant has NO onAccepted hooks wired (the country/location/
 * visa entries reuse the deps-less Q_COUNTRY/Q_LOCATION/Q_VISA constants).
 * Use `defaultQuestionsV2(deps)` to get a pipeline-ready list with hooks.
 *
 * Order (Adam directive 2026-05-07):
 *   q_tos → q_role → q_yoe → q_visa → q_startup_pref
 *   → q_country → q_location  (country BEFORE location)
 *   → q_resume
 */
export const ONBOARDING_QUESTIONS_V2: Question<unknown>[] = [
  Q_ROLE as Question<unknown>,
  Q_YOE as Question<unknown>,
  Q_VISA as Question<unknown>,
  Q_STARTUP_PREF as Question<unknown>,
  Q_COUNTRY as Question<unknown>,
  Q_LOCATION as Question<unknown>,
]

/**
 * Pipeline-ready V2 question list with deps wired into onAccepted hooks.
 * P7-4 dispatcher calls this at boot time.
 *
 * Order matches the directive above. q_country comes BEFORE q_location so
 * the dispatcher can swap `Q_LOCATION` for `makeLocationQuestion(country,
 * deps.onLocationAccepted)` once q_country is answered.
 */
export function defaultQuestionsV2(deps: DefaultQuestionsV2Deps): Question<unknown>[] {
  // V2 normal path owns its closed questions directly; it does not call the
  // legacy `defaultQuestions()` factory or require `extractAnswerIntent`.
  const { tosQ, resumeQ } = makeClosedQuestions(deps)

  const roleQ: Question<RoleAnswer> = {
    ...makeRoleQuestion(deps.onRoleAccepted),
  }
  const yoeQ: Question<YoeAnswer> = {
    ...Q_YOE,
    onAccepted: deps.onYoeAccepted as
      | ((v: YoeAnswer, ctx: AcceptedCtx) => Promise<void>)
      | undefined,
  }
  const startupPrefQ: Question<StartupPrefAnswer> = {
    ...makeStartupPrefQuestion(deps.onStartupPrefAccepted),
  }
  const countryQ: Question<CountryAnswer> = {
    ...Q_COUNTRY,
    onAccepted: deps.onCountryAccepted,
  }
  const locationQ = makeLocationQuestion(undefined, deps.onLocationAccepted)
  const visaQ: Question<VisaAnswer> = {
    ...Q_VISA,
    onAccepted: deps.onVisaAccepted as
      | ((v: VisaAnswer, ctx: AcceptedCtx) => Promise<void>)
      | undefined,
  }

  return [
    tosQ,
    roleQ,
    yoeQ,
    visaQ as Question<unknown>,
    startupPrefQ,
    countryQ as Question<unknown>,
    locationQ as Question<unknown>,
    resumeQ,
  ]
}
