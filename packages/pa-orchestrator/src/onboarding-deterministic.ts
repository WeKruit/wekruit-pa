/**
 * iter32 — Deterministic onboarding dispatcher.
 *
 * Adam directive 2026-05-04 ("we should have resume parsed before we start
 * agent runtime"): all pre-runtime onboarding turns dispatch a configured
 * phrase verbatim via sendMemoryReply. NO LLM, NO Voice v1 sandwich, NO
 * AB-probe-strip, NO langlock guard. Same friend-tone surface (the
 * configured zh/en strings ARE friend-tone), zero drift, ~7 LLM calls saved
 * per new user.
 *
 * Sequence (Adam-locked):
 *   1. send_first_mes        — verbatim greeting
 *   2. ask_q_tos             — privacy + terms link, must accept
 *   3. ask_q_role
 *   4. ask_q_yoe
 *   5. ask_q_visa
 *   6. ask_q_startup_pref
 *   7. ask_q_location
 *   8. ask_q_resume          — proactive CV ask
 *   9. CV-gate: WAIT for parsedCandidateResumes row before advancing
 *  10. ask_q_email
 *  11. ask_q_email_verify    — Mailgun fires; user texts back code
 *  12. email-verified-gate: WAIT for contactEmailVerifiedAt
 *  13. complete              → agent runtime (playbook-driven) activates
 *
 * Vent / distress mid-onboarding: state stays, send a short fixed empathy
 * ack ("嗯, 我在. 准备好继续就告诉我") + re-ask same step on next inbound.
 *
 * Crisis (suicide / self-harm) keywords: still routed through pa-safety's
 * deterministic crisis hotline reply (NOT the LLM-rewriter path) because
 * crisis safety supersedes onboarding flow.
 *
 * Config storage: pa-onboarding-config/v1 Firestore doc (operator-editable
 * via dashboard). DEFAULT_ONBOARDING_CONFIG below is the seed default; a
 * Firestore override merges field-by-field on read so operators can edit
 * one prompt without rewriting the whole config.
 */
import type { Firestore } from "firebase-admin/firestore"
import type { InboundEvent, AgentDef, OnboardingState } from "@pa/core-types"
import { PA_COLLECTIONS } from "@pa/core-types"
import {
  parseTosAnswer,
  parseEmailVerificationCode,
  parseUserAnswerForStep,
  userAnsweredStep,
  type OnboardingStep,
} from "./onboarding.js"
import {
  ONBOARDING_WORKFLOW,
  walkWorkflow,
  type WorkflowContext,
} from "./onboarding-workflow.js"

// ────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────

/**
 * iter34 hotfix 2026-05-05 — Adam directive "中英文混合的开头 onboarding
 * 还没有，我说 mix 他就 either 纯英或者纯中". OnboardingPrompt now
 * supports an optional `mixed` field (zh+en code-switch in the SAME
 * sentence). When user.statedPreferences.preferredLang === "mixed",
 * template selector picks `mixed` if present, falls back to `zh`.
 */
export type OnboardingPrompt = { zh: string; en: string; mixed?: string }

/**
 * iter34 hotfix 2026-05-05 — pick prompt text honoring "mixed" prefLang.
 * For "zh"|"en" path-through. For "mixed" use prompt.mixed when set,
 * else fall back to zh (zh has more natural en-keyword sprinkles).
 */
export function pickPromptText(
  p: OnboardingPrompt,
  lang: "zh" | "en" | "mixed"
): string {
  if (lang === "mixed") return p.mixed ?? p.zh
  return p[lang]
}

export type OnboardingStepConfig = {
  /** Phrase to dispatch verbatim via sendMemoryReply. */
  prompt: OnboardingPrompt
  /**
   * Reply when the user's answer doesn't parse (e.g. q_tos_asked +
   * "what does that mean?"). State stays; next inbound retries.
   */
  reaskPrompt?: OnboardingPrompt
  /**
   * iter34 P0.6.2 — multi-variant re-ask phrasing. Adam directive
   * 2026-05-05: "如果重新问, 可以换一种问法". When set, the probe re-ask
   * path picks variants[attemptCount-1] so each retry shows a DIFFERENT
   * phrasing (instead of the user seeing the same string 4×). Falls back
   * to `reaskPrompt` once the array is exhausted.
   *
   * Index mapping (attempt counter starts at 1):
   *   attempt 1 → variants[0]
   *   attempt 2 → variants[1]
   *   attempt 3 → variants[2]
   *   attempt 4 → variants[3]
   *   attempt ≥ 5 → halt (handled separately, never reaches here)
   *
   * Recommended size: 4 variants for probe Qs (covers attempts 1-4).
   */
  reaskPromptVariants?: OnboardingPrompt[]
  /**
   * Reply when the user actively declines (q_tos_asked + "no").
   */
  declinePrompt?: OnboardingPrompt
  /**
   * Reply emitted while we wait for an out-of-band side-effect to
   * complete — used for ask_q_resume after the user said yes but the
   * Sendblue attachment hasn't arrived yet, and ask_q_email_verify
   * after a wrong code.
   */
  waitingPrompt?: OnboardingPrompt
}

const FIRST_MES_ZH = "在呢. 今天找你聊点啥?"
const FIRST_MES_EN = "Here. What's on your mind today?"

/**
 * Default config — same Adam-locked phrasing that lived in onboarding.ts
 * Q_PROMPTS until iter31. Centralized here as data so a Firestore override
 * can replace single fields without changes to source.
 */
export const DEFAULT_ONBOARDING_CONFIG: Record<OnboardingStep, OnboardingStepConfig | undefined> = {
  send_first_mes: {
    prompt: {
      zh: FIRST_MES_ZH,
      en: FIRST_MES_EN,
      mixed: "在呢. today 想聊点啥?",
    },
  },
  ask_grounding_q: undefined, // legacy v1 — not used in deterministic path
  // iter33 P1 (Adam directive 2026-05-04 "问 你 prefer 中文、英文、中英文混合"):
  // explicit lang preference question. Fires after first_mes_sent. Reply
  // parsed by parseLangAnswer → preferredLang (zh / en / mixed). Default to
  // mixed when ambiguous so Claire keeps adapting.
  ask_q_lang: {
    // iter33 spec collapse 2026-05-05 — q_lang is now Claire's FIRST
    // outbound (no separate first_mes greeting). Prompt opens with a
    // short "在呢/Here" acknowledgment so it reads as a greeting + Q,
    // not a cold question.
    prompt: {
      zh: "在呢. 用啥语聊比较顺? 中文 / 英文 / 中英混着说都行",
      en: "Here. What language works for you? Chinese / English / both mixed?",
      mixed: "在呢. 用啥 lang 顺手聊? 中文 / English / 中英 mixed 都 OK",
    },
  },
  ask_q_tos: {
    prompt: {
      zh: "开聊前先说一下: 我会记一些咱聊天的事来给你推工作 / 找内推. 隐私 + 用户协议在这: https://wekruit-pa-landing.web.app/legal — 同意就回个 \"同意\" 我们继续",
      en: "before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply \"agree\" if cool with that and we keep going",
      mixed: "开聊前 heads up: 我会记一些 chat 内容来给你 push jobs / 找内推. 隐私 + ToS 在这: https://wekruit-pa-landing.web.app/legal — 同意就回 \"同意\" or \"yes\" 我们继续",
    },
    declinePrompt: {
      zh: "完全 ok, 你不同意我就不主动记你聊天的事. 想聊别的随时. 改主意了说一声",
      en: "totally ok — i won't store chat memory if you'd rather not. happy to keep chatting either way. lmk if you change your mind",
    },
    reaskPrompt: {
      zh: "刚那个隐私 + 用户协议你看一下哦, 同意就回 \"同意\" — 不同意我们也能继续聊但不会保存",
      en: "just need a quick \"agree\" on the privacy + terms above — or \"no\" and we can chat without me saving anything",
    },
  },
  ask_q_role: {
    prompt: {
      zh: "那你大概想找啥方向的活? 比如做产品、做工程、还是做研究 — 给我个大致就行",
      en: "btw — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
      mixed: "btw 想找啥 direction 的活儿? engineer / PM / research / design — 大致就行",
    },
    // iter34 P0.4 — escalating reask. Adam directive 2026-05-05:
    // deterministic Q 必答, 不可 skip. 换问法即可.
    reaskPrompt: {
      zh: "我没太 get 到 — 你具体是做啥的? swe / pm / 研究 / 设计 都行, 一两个词就行",
      en: "didn't quite catch that — what role specifically? eng / pm / research / design — one or two words works",
    },
    // iter34 P0.6.2 — rotating phrasings so the user doesn't see the
    // same line 4× when LLM extract returns null/low-confidence.
    reaskPromptVariants: [
      {
        zh: "我没太 get 到 — 你具体是做啥的? swe / pm / 研究 / 设计 都行, 一两个词就行",
        en: "didn't quite catch that — what role specifically? eng / pm / research / design — one or two words works",
      },
      {
        zh: "那大致偏哪个方向? 工程 / 产品 / 研究 / 设计 — 选一个就行",
        en: "roughly which direction — eng / pm / research / design? just pick one",
      },
      {
        zh: "再换个角度问 — 你之前/现在做的是啥岗? 比如 '前端' / '数据' / 'PM' 这种",
        en: "let me try again — what's your role been? like 'frontend' / 'data' / 'pm' style",
      },
      {
        zh: "一个词概括一下你做的活就行, 比如 'swe' / 'pm' / 'designer' / 'researcher'",
        en: "one word for what you do is fine — 'swe' / 'pm' / 'designer' / 'researcher'",
      },
    ],
  },
  ask_q_yoe: {
    prompt: {
      zh: "你工作几年了? 还是刚毕业找新人岗?",
      en: "how many years you been working? or fresh outta school?",
      mixed: "工作几年了? '3 years' / '8 years' / 还是 fresh grad?",
    },
    reaskPrompt: {
      zh: "数字大概多少年就行 — 比如 '3年' / '8年' / 或者 '刚毕业'",
      en: "roughly a number works — '3 years' / '8 years' / or 'fresh grad'",
    },
    reaskPromptVariants: [
      {
        zh: "数字大概多少年就行 — 比如 '3年' / '8年' / 或者 '刚毕业'",
        en: "roughly a number works — '3 years' / '8 years' / or 'fresh grad'",
      },
      {
        zh: "几年就好啦, 不用很精确 — 0 / 1 / 3 / 5 / 10 哪个差不多?",
        en: "ballpark is fine — 0 / 1 / 3 / 5 / 10 — closest one?",
      },
      {
        zh: "工作经验大概几年? 还是说还在读书 / 应届?",
        en: "roughly how many years working? or still in school / new grad?",
      },
      {
        zh: "给个数字就行哦, 比如 '2年' 或者 'fresh grad'",
        en: "just need a number, like '2 years' or 'fresh grad'",
      },
    ],
  },
  ask_q_visa: {
    prompt: {
      zh: "那你有身份不? 公民/绿卡/OPT/还是要 sponsor?",
      en: "got work auth sorted? citizen / GC / OPT / need sponsorship?",
      mixed: "签证 status 怎么样? citizen / GC / OPT / H1B / 还是 need sponsor?",
    },
    reaskPrompt: {
      zh: "选一个就行: 公民 / 绿卡 / OPT / H1B / 需要 sponsor",
      en: "pick one: citizen / GC / OPT / H1B / need sponsorship",
    },
    reaskPromptVariants: [
      {
        zh: "选一个就行: 公民 / 绿卡 / OPT / H1B / 需要 sponsor",
        en: "pick one: citizen / GC / OPT / H1B / need sponsorship",
      },
      {
        zh: "签证状态大概是哪种? 我列下: 公民、绿卡、OPT、H1B、要 sponsor",
        en: "what's your status — citizen, GC, OPT, H1B, or need sponsorship?",
      },
      {
        zh: "你能在美国合法工作吗? 是哪种身份? OPT / H1B / 绿卡 / 公民",
        en: "are you eligible to work in the US? which one — OPT / H1B / GC / citizen?",
      },
      {
        zh: "一个词答下身份吧, 比如 'citizen' / 'opt' / 'h1b' / 'need sponsor'",
        en: "one word on your auth — 'citizen' / 'opt' / 'h1b' / 'need sponsor'",
      },
    ],
  },
  ask_q_startup_pref: {
    prompt: {
      zh: "你更想去 startup 那种小而拼的, 还是大厂稳一点?",
      en: "more into startup hustle vibe or stable big-co?",
      mixed: "想去 startup 那种小而拼? 还是 bigtech 稳一点? '都行 / either' 也 OK",
    },
    reaskPrompt: {
      zh: "startup / 大厂 / 都行 三选一",
      en: "startup / bigtech / either — pick one",
    },
    reaskPromptVariants: [
      {
        zh: "startup / 大厂 / 都行 三选一",
        en: "startup / bigtech / either — pick one",
      },
      {
        // iter34 hotfix 2026-05-05 — was "公司规模偏好? 早期 startup / 中型 / 大厂"
        // which drifts off-theme (introduces "中型/公司规模" — concepts user
        // wasn't asked about). Keep variants ON-THEME for q_startup_pref:
        // strictly startup vs bigtech vs either.
        zh: "硬要选一个? startup / 大厂 / 都行 — 都可以的话回'都行'就好",
        en: "if you had to pick — startup / bigtech / either? 'either' is fine",
      },
      {
        zh: "你想要那种快节奏 startup 体验, 还是更看重稳定大厂?",
        en: "you want fast-paced startup energy or stability of a big company?",
      },
      {
        zh: "一个词就行: 'startup' / 'bigtech' / 'either'",
        en: "one word works: 'startup' / 'bigtech' / 'either'",
      },
    ],
  },
  ask_q_location: {
    prompt: {
      zh: "想找哪边的工作? 湾区、纽约、还是看远程?",
      en: "where you wanna be? SF / NYC / remote ok?",
      mixed: "想找哪边? 湾区 / NYC / Seattle / 上海 / remote — 任选, 'anywhere / 都行' 也 OK",
    },
    reaskPrompt: {
      zh: "城市/地区或者 '远程'",
      en: "city/region or 'remote'",
    },
    reaskPromptVariants: [
      {
        zh: "城市/地区或者 '远程' 都行",
        en: "city / region / or just 'remote' is fine",
      },
      {
        zh: "想在哪工作哦? 湾区 / NYC / Seattle / 上海 / 北京 / remote — 任选",
        en: "where you wanna be — SF / NYC / Seattle / China / remote? any of those",
      },
      {
        zh: "再问一遍: 城市 + remote 偏好 — 比如 'sf' / 'nyc' / 'remote'",
        en: "let me ask again — city + remote pref, like 'sf' / 'nyc' / 'remote'",
      },
      {
        zh: "一个地点就行, 比如 'bay area' / '上海' / 'remote'",
        en: "one location is fine — 'bay area' / 'shanghai' / 'remote'",
      },
    ],
  },
  ask_q_resume: {
    prompt: {
      zh: "对了, 简历方便发我一份不? 后面帮你看 JD / 内推都准多了",
      en: "btw — can you send me your resume? makes JD review and referrals way more on-point",
      mixed: "对了, 你 resume 方便发我一份不? 后面帮你看 JD / 内推都准多了",
    },
    waitingPrompt: {
      zh: "等你发简历过来哦, iMessage 里直接附件就行",
      en: "just waiting on the resume — send it as an iMessage attachment whenever",
      mixed: "等你 resume 过来哦, iMessage 直接附件就行",
    },
  },
  ask_q_email: {
    prompt: {
      zh: "对了, 平时邮箱用啥? 后面如果你不在线我直接发邮件给你",
      en: "btw — what email should I send stuff to when you're afk? roughly fine",
      mixed: "对了, 平时 email 用啥? 后面你要不在线我直接发邮件给你",
    },
    // iter33 Bug 10 fix 2026-05-05 (Adam: edge case — user replies "哈哈"
    // or any non-email text). Workflow's no_email edge re-asks; without a
    // distinct reaskPrompt the user sees the SAME prompt again and feels
    // unheard. Use a specific re-ask that acknowledges the parse failure.
    reaskPrompt: {
      zh: "没看到邮箱地址哎, 直接发个 email 给我就行 (像 you@example.com 这种)",
      en: "didn't catch an email there — just paste the address (like you@example.com)",
    },
  },
  ask_q_email_verify: {
    prompt: {
      zh: "已经发了一个 6 位验证码到你邮箱了, 收到回我一下就行 (30 分钟有效)",
      en: "just sent a 6-digit code to your email — text it back to me and we're set (good for 30 mins)",
      mixed: "已经发了 6 位 verify code 到你 email 了, 收到回我一下 (30 min 有效)",
    },
    waitingPrompt: {
      zh: "等你把邮箱里的 6 位验证码发我",
      en: "still waiting on that 6-digit code from your email",
      mixed: "等你 email 里的 6 位 verify code 发我",
    },
  },
  // iter33 P3 — send_cv_analysis is not a question step; the runner emits
  // ack + LLM-summary inline. Config slot present for completeness so a
  // Firestore override can replace the ack/fallback strings later.
  send_cv_analysis: {
    prompt: {
      zh: "OK 让我看一下你简历, 等我一下下",
      en: "ok — give me a sec to read your resume",
    },
  },
  complete: undefined,
  skip: undefined,
}

/** Vent ack — short, deterministic, friend-tone. State stays. */
const VENT_ACK: OnboardingPrompt = {
  zh: "嗯, 我在. 准备好继续就告诉我",
  en: "yeah, i'm here. lmk when you're ready to keep going",
}

/**
 * iter33 GAP 4 — env-only kill switch for the iter33 P1+P2 sequence.
 * Set `PA_ONBOARDING_V33_DISABLED=true` on the Cloud Function (or in
 * apps/functions/.env) to skip q_lang_asked + fall back to iter32
 * sequence (first_mes_sent → q_tos_asked → ...). Reading from env
 * each call (cheap) so an operator can flip without redeploying the
 * orchestrator package — only the Cloud Function bundle restart.
 */
export function isV33Disabled(): boolean {
  const v = (process.env.PA_ONBOARDING_V33_DISABLED ?? "").trim().toLowerCase()
  return v === "true" || v === "1" || v === "yes"
}

// ────────────────────────────────────────────────────────────────────
// Lang detect (mirrors onboarding.ts pickLang — kept local so the
// deterministic module has zero external coupling).
// ────────────────────────────────────────────────────────────────────
export function pickLang(
  userMessage: string | undefined,
  fallback: "zh" | "en" = "zh",
): "zh" | "en" {
  // iter32: strip email addresses + URLs before counting so a zh user
  // saying "我邮箱是 adam@wekruit.com" doesn't tip into EN due to the
  // ASCII-heavy email tail. Same for "看 https://example.com" etc.
  const raw = userMessage ?? ""
  const stripped = raw
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "")
    .replace(/https?:\/\/\S+/gi, "")
  const text = stripped.replace(/\s+/g, "")
  if (!text) {
    // iter33 Bug 7 + Bug 14 fix (Adam 2026-05-05 "后面的语言也不对啊"):
    // stripped text empty (msg was email/URL only) → use fallback.
    // Honors caller's preferredLang. CJK in raw still wins (covers
    // mixed inline like "我邮箱是 adam@x.com"; that branch reaches the
    // count-loop below, this branch only fires when raw == stripped).
    return fallback
  }
  // Count CJK + en letters. If text has CJK → standard ratio test. If
  // text has en letters (no CJK) → en. If neither (e.g. "654321" —
  // digits/punct only verify code) → fallback (preferredLang). This
  // is the second half of Bug 14: a zh user replying with the 6-digit
  // verify code "654321" used to get en templates because 0 CJK / 6
  // chars = 0 < 0.3 → en. Now we detect "no language signal at all"
  // and defer to preferredLang.
  let cjk = 0
  let enLetters = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++
    } else if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    ) {
      enLetters++
    }
  }
  if (cjk === 0 && enLetters === 0) {
    // Pure digits / punctuation / symbols — no language content.
    return fallback
  }
  const total = [...text].length
  return cjk / total >= 0.3 ? "zh" : "en"
}

// ────────────────────────────────────────────────────────────────────
// iter34 sprint A.7 — Interim "I'm reading your CV" ack.
//
// When the user sends a resume mid-onboarding, the CV-parser worker
// takes 1-2 minutes to return parsedCandidateResumes row. Without an
// interim ack the user stares at silence and assumes Claire ghosted.
//
// Adam directive iter34 A.7: send a SHORT, human, non-robot ack right
// after resume upload — "OK 让我看一下你简历, 等我一下下" style. NOT
// "tomorrow ~9am" (that's the agent-runtime morning-job-rec phrasing,
// totally wrong for resume ack). NOT "processing your resume,
// please wait..." (robot tone). Friend-tone, ≤60 zh chars / ≤80 en.
//
// Variant pool with deterministic round-robin via Math.random pick —
// Claire shouldn't repeat the same line every time.
// ────────────────────────────────────────────────────────────────────

const INTERIM_RESUME_ACK_VARIANTS: { zh: string[]; en: string[]; mixed: string[] } = {
  zh: [
    "OK 让我看一下你简历, 等我一下下",
    "稍等啊我快速过一下",
    "嗯 我读一下, 一两分钟的事",
    "好的 我先看看, 完了就给你推",
    "收到, 我扫一眼简历",
    "嗯嗯 给我一两分钟看下",
  ],
  en: [
    "ok lemme take a quick look at your resume, brb",
    "give me a sec to skim through",
    "hold on, reading now — a min or two",
    "alright lemme look at this real quick",
    "got it, scanning your resume now",
    "ok one sec, reading through",
  ],
  mixed: [
    "OK 让我 quick look 一下你简历 — 一两分钟",
    "稍等 lemme skim through",
    "好的 reading now, 完了推几个 jobs 给你",
    "嗯 give me a sec — 看完就来",
    "收到 scanning 一下, 一两分钟",
    "ok 让我 skim 一下简历, brb",
  ],
}

/**
 * Return a short, human, friend-tone interim ack to send right after
 * the user uploads their resume. Tells them Claire is reading; sets
 * expectation that a real reply is ~1-2 min away.
 *
 * Variant choice is randomized so Claire isn't a parrot — but the
 * variant pool is curated (no robot phrasing, no "tomorrow ~9am",
 * no emojis). Length ≤60 chars (zh/mixed) / ≤80 chars (en).
 *
 * iter 6 worker calls this from the resume-received branch of the
 * onboarding dispatcher; iter 8 worker handles the *post*-CV summary
 * (separate concern, separate file).
 *
 * @param lang — user's preferred lang. "mixed" returns a code-switch
 *   line containing both Chinese and English tokens.
 * @param rng — optional RNG injection point for tests
 *   (defaults to Math.random).
 */
export function composeInterimResumeAck(
  lang: "zh" | "en" | "mixed",
  rng: () => number = Math.random,
): string {
  const pool = INTERIM_RESUME_ACK_VARIANTS[lang]
  const i = Math.floor(rng() * pool.length)
  // Defensive: guard against pathological rng values (rng() === 1 →
  // i === pool.length → undefined).
  return pool[i] ?? pool[0]!
}

// ────────────────────────────────────────────────────────────────────
// Firestore override loader. Cache TTL=30s — operator dashboard edits
// take effect within 30s of save.
// ────────────────────────────────────────────────────────────────────
const CONFIG_CACHE_TTL_MS = 30 * 1000
let cachedConfig: typeof DEFAULT_ONBOARDING_CONFIG | null = null
let cachedAt = 0

export async function loadOnboardingConfig(
  db: Firestore | undefined
): Promise<typeof DEFAULT_ONBOARDING_CONFIG> {
  const now = Date.now()
  if (cachedConfig && now - cachedAt < CONFIG_CACHE_TTL_MS) {
    return cachedConfig
  }
  if (!db) {
    cachedConfig = DEFAULT_ONBOARDING_CONFIG
    cachedAt = now
    return cachedConfig
  }
  try {
    const snap = await db.collection("pa-onboarding-config").doc("v1").get()
    if (!snap.exists) {
      cachedConfig = DEFAULT_ONBOARDING_CONFIG
      cachedAt = now
      return cachedConfig
    }
    const override = snap.data() as Partial<typeof DEFAULT_ONBOARDING_CONFIG>
    // Field-by-field merge: operators can edit one prompt without
    // re-writing the rest. Keep the structural skeleton from DEFAULT.
    const merged = { ...DEFAULT_ONBOARDING_CONFIG }
    for (const [step, cfg] of Object.entries(override)) {
      if (!cfg || typeof cfg !== "object") continue
      const def = DEFAULT_ONBOARDING_CONFIG[step as OnboardingStep]
      if (!def) continue
      merged[step as OnboardingStep] = {
        ...def,
        ...(cfg as OnboardingStepConfig),
      }
    }
    cachedConfig = merged
    cachedAt = now
    return cachedConfig
  } catch {
    cachedConfig = DEFAULT_ONBOARDING_CONFIG
    cachedAt = now
    return cachedConfig
  }
}

/** Test helper — clear the cache so tests don't bleed config across cases. */
export function _resetOnboardingConfigCache() {
  cachedConfig = null
  cachedAt = 0
}

// ────────────────────────────────────────────────────────────────────
// Step resolver — same semantics as resolveOnboardingStep but emits
// gate-aware steps so the dispatcher can hold at the resume / email
// verify gates without advancing.
// ────────────────────────────────────────────────────────────────────

export type DeterministicTurnInput = {
  onboardingState: OnboardingState | undefined
  /** From cv-ingest pipeline. True = parsedCandidateResumes row exists. */
  cvParsed: boolean
  /** statedPreferences.contactEmailVerifiedAt is set. */
  emailVerified: boolean
  /** statedPreferences.contactEmail is set. */
  emailCaptured: boolean
}

export type DeterministicAction =
  | { kind: "send_first_mes" }
  | { kind: "ask_q_lang" }
  | { kind: "ask_q_tos" }
  | { kind: "ask_q_tos_decline" }
  | { kind: "ask_q_tos_reask" }
  | { kind: "ask_q_role" | "ask_q_yoe" | "ask_q_visa" | "ask_q_startup_pref" | "ask_q_location" }
  | { kind: "ask_q_resume" }
  | { kind: "wait_for_resume_upload" }
  | { kind: "ask_q_email" }
  | { kind: "ask_q_email_verify_start"; email: string } // need to fire Mailgun
  | { kind: "ask_q_email_verify_retry" } // wrong code branch
  | { kind: "ask_q_email_verify_reissue"; email: string } // expired/exhausted → re-fire Mailgun, stay
  | { kind: "verify_email_code"; candidate: string }
  | { kind: "vent_ack" } // user is venting mid-onboarding
  | { kind: "send_cv_analysis" } // iter33 P3 — Claire reads CV + sends ack + 2-sentence summary, advances to complete
  | { kind: "complete" }
  | { kind: "skip" } // already complete + all gates passed

export function resolveDeterministicAction(
  input: DeterministicTurnInput,
  userMessage: string
): DeterministicAction {
  const state = input.onboardingState

  // iter33 GAP 4 escape hatch — when V33 disabled, restore iter32
  // sequence: pending → send_first_mes → first_mes_sent → ask_q_tos
  // (skips the iter33 collapse + q_lang Q). Handled inline before graph
  // walk because it's an environmental short-circuit.
  if (isV33Disabled()) {
    if (state === undefined || state === "pending") {
      return { kind: "send_first_mes" }
    }
    if (state === "first_mes_sent") {
      return { kind: "ask_q_tos" }
    }
  }

  // iter33 spec collapse 2026-05-05 backward-compat — first_mes_sent state
  // was removed from the workflow graph (pending → q_lang_asked direct).
  // Any user with persisted onboardingState="first_mes_sent" from before
  // this ships hops cleanly to q_lang_asked on next inbound. New users
  // never enter first_mes_sent at all.
  if (state === "first_mes_sent") {
    return { kind: "ask_q_lang" }
  }

  // iter33 GAP 2 — graph executor. Build context from parsers + state,
  // walk ONBOARDING_WORKFLOW edges declaratively, return the action
  // attached to the matching edge (with payloads injected from the
  // parsed context).
  const ctx = buildWorkflowContext(input, userMessage)
  const edge = walkWorkflow(ONBOARDING_WORKFLOW, state, ctx)
  if (!edge) {
    // No edge matched — onboarding terminal (state=complete) or
    // unreachable. Either way, hand off to agent runtime.
    return { kind: "skip" }
  }
  return actionFromEdge(edge.action, ctx)
}

/**
 * iter33 GAP 2 — assemble the WorkflowContext for the graph walker.
 * All parser invocations happen here so the walker stays pure-data.
 */
function buildWorkflowContext(
  input: DeterministicTurnInput,
  userMessage: string
): WorkflowContext {
  const state = input.onboardingState
  const priorAskedStep = priorAskedStepFromState(state)
  const isVent = priorAskedStep ? isVentingMessage(userMessage) : false

  let tosDecision: "accept" | "decline" | "unclear" | undefined
  if (state === "q_tos_asked") {
    tosDecision = parseTosAnswer(userMessage)
  }

  let parsedEmail: string | undefined
  if (state === "q_email_asked") {
    const parsed = parseUserAnswerForStep("ask_q_email", userMessage)
    if (parsed.contactEmail) parsedEmail = parsed.contactEmail
  }

  let parsedCode: string | undefined
  if (state === "q_email_verifying") {
    const code = parseEmailVerificationCode(userMessage)
    if (code) parsedCode = code
  }

  let answered = false
  if (priorAskedStep) {
    // ask_q_role / ask_q_yoe / ask_q_visa / ask_q_startup_pref / ask_q_location
    if (
      priorAskedStep === "ask_q_role" ||
      priorAskedStep === "ask_q_yoe" ||
      priorAskedStep === "ask_q_visa" ||
      priorAskedStep === "ask_q_startup_pref" ||
      priorAskedStep === "ask_q_location"
    ) {
      answered = userAnsweredStep(priorAskedStep, userMessage)
    }
  }

  return {
    userMessage,
    cvParsed: input.cvParsed,
    emailCaptured: input.emailCaptured,
    emailVerified: input.emailVerified,
    v33Disabled: isV33Disabled(),
    isVent,
    tosDecision,
    parsedEmail,
    parsedCode,
    answered,
  }
}

/**
 * iter33 GAP 2 — convert an edge.action string + context into the
 * concrete DeterministicAction object. Edges with data-carrying actions
 * (ask_q_email_verify_start.email, verify_email_code.candidate) inject
 * the parsed payload from ctx.
 */
function actionFromEdge(
  actionKind: string,
  ctx: WorkflowContext
): DeterministicAction {
  switch (actionKind) {
    case "send_first_mes":
      return { kind: "send_first_mes" }
    case "ask_q_lang":
      return { kind: "ask_q_lang" }
    case "ask_q_tos":
      return { kind: "ask_q_tos" }
    case "ask_q_tos_decline":
      return { kind: "ask_q_tos_decline" }
    case "ask_q_tos_reask":
      return { kind: "ask_q_tos_reask" }
    case "ask_q_email":
      return { kind: "ask_q_email" }
    case "ask_q_email_verify_start":
      return { kind: "ask_q_email_verify_start", email: ctx.parsedEmail ?? "" }
    case "ask_q_email_verify_retry":
      return { kind: "ask_q_email_verify_retry" }
    case "verify_email_code":
      return { kind: "verify_email_code", candidate: ctx.parsedCode ?? "" }
    case "ask_q_role":
    case "ask_q_yoe":
    case "ask_q_visa":
    case "ask_q_startup_pref":
    case "ask_q_location":
      return { kind: actionKind }
    case "ask_q_resume":
      return { kind: "ask_q_resume" }
    case "wait_for_resume_upload":
      return { kind: "wait_for_resume_upload" }
    case "send_cv_analysis":
      return { kind: "send_cv_analysis" }
    case "vent_ack":
      return { kind: "vent_ack" }
    case "complete":
      return { kind: "complete" }
    default:
      return { kind: "skip" }
  }
}

// (iter33 GAP 2: legacy switch-based dispatcher REMOVED — see git
// history at PR #3 commit ce67358 for the original imperative version.
// Current dispatcher above walks ONBOARDING_WORKFLOW edges declaratively.)

function priorAskedStepFromState(state: OnboardingState | undefined): OnboardingStep | undefined {
  if (state === "q_lang_asked") return "ask_q_lang"
  if (state === "q_tos_asked") return "ask_q_tos"
  if (state === "q_role_asked") return "ask_q_role"
  if (state === "q_yoe_asked") return "ask_q_yoe"
  if (state === "q_visa_asked") return "ask_q_visa"
  if (state === "q_startup_pref_asked") return "ask_q_startup_pref"
  if (state === "q_location_asked") return "ask_q_location"
  if (state === "q_resume_asked") return "ask_q_resume"
  if (state === "q_email_asked") return "ask_q_email"
  if (state === "q_email_verifying") return "ask_q_email_verify"
  return undefined
}

/**
 * Lightweight vent / distress keyword bank. NOT crisis-level (those route
 * to pa-safety's hotline guard). These are mid-conversation distress
 * signals: "I just got laid off", "fuck this", "i give up", etc. Same
 * spirit as composeOnboardingInput's noChainIntents branch, just
 * regex-only (no LLM intent classifier).
 */
const VENT_KEYWORDS = [
  /\b(fuck|shit|hate|sucks|suck|exhausted|burn(ed|t)?\s*out|done with this)\b/i,
  /\b(i\s+(?:give\s+up|quit|can'?t|wanna\s+die|hate\s+life))/i,
  /\b(laid\s*off|fired|rejected|ghosted)\b/i,
  /(操|草|妈的|我服了|我不行了|累死|崩了|裂开|撑不住|心累|快疯了)/,
]
/**
 * iter34 hotfix 2026-05-05 — Adam directive "聊完以后我在哪看系统给我的 tag?".
 * Format canonical statedPreferences as a friend-tone reflection message
 * the user receives at end of onboarding. Returns "" when no signal yet.
 *
 * Output examples:
 *   zh: "我记的是: 方向 swe · 2 yoe · h1b · startup/大厂都行 · location 都行. 不对告诉我我改"
 *   en: "noted: swe · 2 yoe · h1b · startup/bigtech either · location open. lmk if any wrong"
 */
function formatStatedPreferencesForUser(
  prefs:
    | {
        targetRole?: string[]
        yoeRange?: [number, number] | null
        visaStatus?: string
        prefersStartup?: boolean | null
        targetLocations?: string[]
      }
    | undefined,
  lang: "zh" | "en"
): string {
  if (!prefs) return ""
  const parts: string[] = []
  // Role
  const role = prefs.targetRole?.[0]
  if (role) parts.push(lang === "zh" ? `方向 ${role}` : role)
  // YOE
  const yoe = prefs.yoeRange
  if (Array.isArray(yoe) && yoe.length === 2) {
    if (yoe[0] === 0 && yoe[1] <= 1) {
      parts.push(lang === "zh" ? "应届" : "fresh grad")
    } else if (yoe[0] === yoe[1]) {
      parts.push(lang === "zh" ? `${yoe[0]} yoe` : `${yoe[0]} yoe`)
    } else {
      parts.push(`${yoe[0]}-${yoe[1]} yoe`)
    }
  }
  // Visa
  const visa = prefs.visaStatus
  if (visa && visa !== "unknown") parts.push(visa)
  // Startup pref
  const startup = prefs.prefersStartup
  if (startup === true) parts.push(lang === "zh" ? "偏 startup" : "startup")
  else if (startup === false) parts.push(lang === "zh" ? "偏大厂" : "bigtech")
  else if (startup === null)
    parts.push(lang === "zh" ? "startup/大厂都行" : "startup/bigtech either")
  // Location
  const locs = prefs.targetLocations
  if (Array.isArray(locs) && locs.length > 0) {
    if (locs.includes("anywhere") || locs.includes("other")) {
      parts.push(lang === "zh" ? "location 都行" : "location open")
    } else {
      parts.push(lang === "zh" ? `location ${locs.join("/")}` : `loc ${locs.join("/")}`)
    }
  }
  if (parts.length === 0) return ""
  const head = lang === "zh" ? "我记的是: " : "noted: "
  const tail = lang === "zh" ? ". 不对告诉我我改" : ". lmk if any wrong"
  return head + parts.join(" · ") + tail
}

function isVentingMessage(text: string): boolean {
  if (!text) return false
  for (const re of VENT_KEYWORDS) {
    if (re.test(text)) return true
  }
  return false
}

// ────────────────────────────────────────────────────────────────────
// Reply composer — pure function, no LLM. Picks lang from inbound + the
// configured prompt for the action.
// ────────────────────────────────────────────────────────────────────
export function composeDeterministicReply(
  action: DeterministicAction,
  config: typeof DEFAULT_ONBOARDING_CONFIG,
  userMessage: string,
  // iter34 hotfix 2026-05-05 — widen langOverride to include "mixed" so
  // composer can return the zh+en code-switch prompt when prefLang ===
  // "mixed". Callers that pass "zh"|"en" still typecheck.
  langOverride?: "zh" | "en" | "mixed"
): string {
  const lang = langOverride ?? pickLang(userMessage)
  // VENT_ACK only has zh/en — demote mixed to zh for those non-Q strings.
  const langZhEn: "zh" | "en" = lang === "mixed" ? "zh" : lang

  if (action.kind === "vent_ack") return VENT_ACK[langZhEn]
  if (action.kind === "skip") return ""
  if (action.kind === "complete") return ""

  if (action.kind === "send_first_mes") {
    return pickPromptText(config.send_first_mes!.prompt, lang)
  }
  if (action.kind === "ask_q_lang") {
    return pickPromptText(config.ask_q_lang!.prompt, lang)
  }
  if (action.kind === "ask_q_tos") {
    return pickPromptText(config.ask_q_tos!.prompt, lang)
  }
  if (action.kind === "ask_q_tos_decline") {
    return pickPromptText(config.ask_q_tos!.declinePrompt!, lang)
  }
  if (action.kind === "ask_q_tos_reask") {
    return pickPromptText(config.ask_q_tos!.reaskPrompt!, lang)
  }
  if (
    action.kind === "ask_q_role" ||
    action.kind === "ask_q_yoe" ||
    action.kind === "ask_q_visa" ||
    action.kind === "ask_q_startup_pref" ||
    action.kind === "ask_q_location"
  ) {
    return pickPromptText(config[action.kind]!.prompt, lang)
  }
  if (action.kind === "ask_q_resume") {
    return pickPromptText(config.ask_q_resume!.prompt, lang)
  }
  if (action.kind === "wait_for_resume_upload") {
    return pickPromptText(config.ask_q_resume!.waitingPrompt!, lang)
  }
  if (action.kind === "ask_q_email") {
    return pickPromptText(config.ask_q_email!.prompt, lang)
  }
  if (action.kind === "ask_q_email_verify_start") {
    return pickPromptText(config.ask_q_email_verify!.prompt, lang)
  }
  if (action.kind === "ask_q_email_verify_retry") {
    return pickPromptText(config.ask_q_email_verify!.waitingPrompt!, lang)
  }
  if (action.kind === "verify_email_code") return ""
  return ""
}

/**
 * iter32 — feature flag for deterministic onboarding path. Default OFF
 * so the existing LLM-compose path stays as a rollback for one cycle.
 * Flip ON via `paOnboardingDeterministicEnabled` Firestore flag.
 */
export async function isDeterministicOnboardingEnabled(
  db: Firestore | undefined,
  userId: string | undefined
): Promise<boolean> {
  if (process.env.PA_ONBOARDING_DETERMINISTIC_DISABLED === "true") return false
  if (!db) return false
  try {
    const { getFlag } = await import("@pa/pa-persistence")
    const v = await getFlag(db, "paOnboardingDeterministicEnabled", {
      userId,
      env: process.env,
    })
    return v === true
  } catch {
    return false
  }
}

// ────────────────────────────────────────────────────────────────────
// Runner — dispatches one turn deterministically. Replaces the
// LLM-based composeOnboardingInput → runAgentTurn → langlock → AB-strip
// → crisis-guard chain entirely. ~7 LLM calls saved per new user.
//
// Returns:
//   { handled: true } — turn fully dispatched (reply enqueued, state
//                       advanced, log events fired). Caller must return
//                       from processInboundEvent.
//   { handled: false } — onboarding fully complete + CV parsed + email
//                       verified. Caller proceeds to agent runtime.
// ────────────────────────────────────────────────────────────────────

export type DeterministicRunnerStore = {
  appendMessage(msg: {
    sessionId: string
    userId: string
    role: "user" | "assistant" | "system"
    body: string
    createdAt: string
    idempotencyKey?: string
    rawMeta?: Record<string, unknown>
  }): Promise<void>
  enqueueOutbound(
    userId: string,
    toE164: string,
    body: string,
    input?: { sessionId?: string; role?: string; idempotencyKey?: string }
  ): Promise<void>
  applyOnboarding(
    userId: string,
    phoneE164: string,
    step: OnboardingStep,
    opts?: Record<string, unknown>
  ): Promise<void>
  getTosVersion?(): Promise<string>
  getUserEmailVerification?(userId: string): Promise<{
    codeHash: string
    email: string
    sentAt: string
    expiresAt: string
    attempts: number
  } | null>
  sendVerificationEmail?(email: string): Promise<{
    rawCode: string
    sentAt: string
    expiresAt: string
    providerMessageId?: string
  } | null>
  /**
   * iter33 P3 — produce a 1-2 sentence CV analysis blurb in the user's
   * preferred language. Reads parsedCandidateResumes for the user, calls
   * Qwen-7B (or test stub), and returns the summary. Returns null when
   * LLM is unconfigured / fails — caller falls back to a generic ack so
   * onboarding completes either way.
   */
  generateCvAnalysis?(
    userId: string,
    lang: "zh" | "en"
  ): Promise<{ summary: string } | null>
  /**
   * iter33 P4 — push a 2-job-rec message before complete. Returns null
   * when no recs are available yet (caller falls back to deferred-promise
   * line). recCount lets callers log/track delivered counts.
   */
  generateJobRecs?(
    userId: string,
    lang: "zh" | "en"
  ): Promise<{ message: string; recCount: number } | null>
  /**
   * iter34 P0 — LLM-fallback email intent extractor. See
   * OrchestratorStoreDeps.extractEmailIntent for full contract.
   */
  extractEmailIntent?(
    reply: string,
    lang: "zh" | "en"
  ): Promise<
    | { intent: "provided"; email: string; confidence: number }
    | { intent: "typo"; suggestion: string; original: string }
    | { intent: "declined" }
    | { intent: "unclear"; clarifyingQuestion: string }
    | null
  >
  /**
   * iter34 P0.2 — generic LLM-fallback for q_role / q_yoe / q_visa /
   * q_startup_pref / q_location. See OrchestratorStoreDeps for contract.
   */
  extractAnswerIntent?(
    step:
      | "ask_q_role"
      | "ask_q_yoe"
      | "ask_q_visa"
      | "ask_q_startup_pref"
      | "ask_q_location",
    reply: string,
    lang: "zh" | "en"
  ): Promise<
    | { intent: "provided"; value: string | number; confidence: number }
    | { intent: "unclear"; clarifyingQuestion: string }
    | null
  >
  log(event: string, payload?: Record<string, unknown>): void
  nowIso(): string
  db?: Firestore
}

export type RunDeterministicTurnInput = {
  event: InboundEvent
  store: DeterministicRunnerStore
  /**
   * iter34 P0.2 — tail-call lang preservation. When the dispatcher
   * recurses with an LLM-extracted canonical value as event.body
   * (e.g. "swe" / "h1b"), the inner runner's pickLang sees a short
   * ASCII string and would flip to "en". Setting this overrides
   * langFor to use the caller's resolved lang so the user's chosen
   * preferredLang carries through the recursion.
   */
  langOverride?: "zh" | "en"
  turnId: string
  onboardingUser: {
    id: string
    phoneE164: string
    onboardingState?: OnboardingState
    statedPreferences?: {
      contactEmail?: string
      contactEmailVerifiedAt?: string
      // iter33 Bug 7 — preferredLang as pickLang fallback when current msg
      // strips empty (email-only / URL-only). zh / en / mixed (mixed
      // demoted to zh fallback in runner — most conservative).
      preferredLang?: "zh" | "en" | "mixed"
      // iter34 hotfix 2026-05-05 — canonical fields read for tag-reflect
      // surface message ("我记的是: ...") at end of onboarding.
      targetRole?: string[]
      yoeRange?: [number, number] | null
      visaStatus?: string
      prefersStartup?: boolean | null
      targetLocations?: string[]
    }
  }
  cvParsed: boolean
  agent: AgentDef
  /** Whether to suppress outbound enqueue (test-harness flag). */
  suppressOutbound?: boolean
}

export type RunDeterministicTurnResult =
  | { handled: true; action: DeterministicAction }
  | { handled: false }

/**
 * iter32 — main dispatcher. Pure orchestrator: NO LLM hop. Composes a
 * configured phrase verbatim, advances onboarding state via
 * applyOnboarding, sends via sendMemoryReply pattern.
 */
export async function runDeterministicOnboardingTurn(
  input: RunDeterministicTurnInput
): Promise<RunDeterministicTurnResult> {
  const { event, store, turnId, onboardingUser, cvParsed } = input
  const config = await loadOnboardingConfig(store.db)
  // iter33 Bug 7 fix — when user msg is email-only / URL-only / empty,
  // pickLang has no signal and would otherwise default to "zh", flipping
  // en-speaking users into a zh template. Pass the user's stored
  // preferredLang as fallback so the verify-start prompt etc. honors
  // the lang they answered q_lang_asked with. "mixed" → "zh" (legacy
  // default; kept conservative). Helper keeps call sites compact.
  const prefLang = onboardingUser.statedPreferences?.preferredLang
  // iter34 hotfix 2026-05-05 — Adam directive "我说 mix 他就 either 纯英
  // 或者纯中". STRICT-LOCK lang choice when prefLang declared. Per-msg
  // pickLang detection only fires for users with no prefLang yet.
  // langFor returns ZH|EN for downstream (state advance, log meta etc).
  // promptLang returns "mixed" too, used ONLY for pickPromptText so the
  // mixed-style prompt fires when prefLang === "mixed".
  const langFallback: "zh" | "en" =
    prefLang === "zh" ? "zh" : prefLang === "en" ? "en" : "zh"
  const langFor = (msg: string | undefined): "zh" | "en" => {
    if (input.langOverride) return input.langOverride
    if (prefLang === "zh" || prefLang === "en") return prefLang
    if (prefLang === "mixed") return "zh"
    return pickLang(msg, langFallback)
  }
  const promptLang = (msg: string | undefined): "zh" | "en" | "mixed" => {
    if (input.langOverride) return input.langOverride
    if (prefLang === "zh" || prefLang === "en" || prefLang === "mixed") return prefLang
    return pickLang(msg, langFallback)
  }
  const action = resolveDeterministicAction(
    {
      onboardingState: onboardingUser.onboardingState,
      cvParsed,
      emailVerified: Boolean(onboardingUser.statedPreferences?.contactEmailVerifiedAt),
      emailCaptured: Boolean(onboardingUser.statedPreferences?.contactEmail),
    },
    event.body
  )
  store.log("pa.onboarding.deterministic.action", {
    userId: event.userId,
    turnId,
    eventId: event.id,
    state: onboardingUser.onboardingState,
    actionKind: action.kind,
    cvParsed,
  })

  // skip means agent runtime should activate. Caller handles.
  if (action.kind === "skip") return { handled: false }

  // verify_email_code: hash the candidate, compare to stored hash, route
  // to verified / miss / expired / exhausted.
  // iter32: expired or exhausted → re-issue Mailgun code in place, stay
  // at q_email_verifying (NOT bypass to complete — Adam directive: email
  // verify is mandatory before agent runtime activates, so the dispatcher
  // never lets the user past q_email_verifying without a verified code).
  // Verified → advance to q_role_asked (NOT complete — we still have to
  // run the role/yoe/visa/startup/location/resume probes before complete).
  if (action.kind === "verify_email_code") {
    const challenge = store.getUserEmailVerification
      ? await store.getUserEmailVerification(event.userId)
      : null
    if (!challenge) {
      // shouldn't happen — if we're at q_email_verifying the doc must
      // exist. Recover gracefully by re-asking.
      await sendDirect(input, config.ask_q_email_verify!.waitingPrompt![langFor(event.body)])
      return { handled: true, action }
    }
    const nowMs = Date.now()
    const expired = Date.parse(challenge.expiresAt) < nowMs
    const exhausted = challenge.attempts >= 5
    if (expired || exhausted) {
      // Re-issue: fresh code, fresh challenge, attempts reset to 0. Stay
      // at q_email_verifying. User retries with the new code from the
      // re-sent email. Edge case: if user supplied a typo'd email, the
      // re-issued code goes nowhere — operator can resolve via HITL pause
      // (paRuntimeMode) and manual user.runtimeMode override.
      let reissued: typeof challenge | null = null
      if (store.sendVerificationEmail) {
        try {
          const sent = await store.sendVerificationEmail(challenge.email)
          if (sent) {
            const { createHash } = await import("node:crypto")
            reissued = {
              codeHash: createHash("sha256").update(sent.rawCode).digest("hex"),
              email: challenge.email,
              sentAt: sent.sentAt,
              expiresAt: sent.expiresAt,
              attempts: 0,
            }
          }
        } catch (err) {
          store.log("pa.onboarding.deterministic.email_verify_reissue_error", {
            userId: event.userId,
            turnId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const lang = langFor(event.body)
      if (reissued) {
        // Persist via applyOnboarding with emailVerification opt — same
        // step (q_email_verifying), just refreshed challenge fields.
        await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_email_verify", {
          priorAskedStep: "ask_q_email_verify",
          priorUserReply: event.body,
          emailVerification: {
            codeHash: reissued.codeHash,
            email: reissued.email,
            sentAt: reissued.sentAt,
            expiresAt: reissued.expiresAt,
          },
        })
        const msg = expired
          ? lang === "zh"
            ? "验证码过期了, 我重新发了一个新的, 收到再回我"
            : "code expired — sent you a fresh one, text it back when you get it"
          : lang === "zh"
            ? "试错好几次了, 重新发了个新的, 仔细看一下"
            : "few wrong tries — sent a fresh code, double-check this one"
        await sendDirect(input, msg)
        store.log("pa.onboarding.deterministic.email_verify_reissued", {
          userId: event.userId,
          turnId,
          reason: expired ? "expired" : "exhausted",
        })
      } else {
        // Mailgun unavailable — fall back to a "still trying" reply, no
        // state change. Operator can intervene.
        const msg =
          lang === "zh"
            ? "邮件服务暂时有点问题, 我们等会再试 (或者发个新邮箱给我)"
            : "email service is having a moment — we'll retry (or share a new email if you prefer)"
        await sendDirect(input, msg)
        store.log("pa.onboarding.deterministic.email_verify_reissue_no_transport", {
          userId: event.userId,
          turnId,
        })
      }
      return { handled: true, action }
    }
    // Hash compare
    const { createHash } = await import("node:crypto")
    const candidateHash = createHash("sha256").update(action.candidate).digest("hex")
    const lang = langFor(event.body)
    if (candidateHash === challenge.codeHash) {
      // iter33 P2 — advance to q_tos_asked (NOT complete, NOT q_role).
      // Adam-locked sequence: email-verify clears → ToS gate is the next
      // step. Email is verified; stamp contactEmailVerifiedAt on
      // statedPreferences via emailVerificationVerified opt (Bug #5 fix
      // in applyOnboardingStep makes this stamp fire regardless of
      // nextState). Compose ack + ToS prompt joined.
      await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_tos", {
        priorAskedStep: "ask_q_email_verify",
        priorUserReply: event.body,
        emailVerificationVerified: true,
      })
      const verifiedAck = lang === "zh" ? "✓ 邮箱验过了" : "✓ email verified"
      const tosPhrase = config.ask_q_tos!.prompt[lang]
      await sendDirect(input, `${verifiedAck} — ${tosPhrase}`)
      store.log("pa.onboarding.deterministic.email_verify_verified", {
        userId: event.userId,
        turnId,
        email: challenge.email,
      })
      return { handled: true, action }
    }
    // Miss — bump attempts, stay
    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_email_verify", {
      emailVerificationFailed: true,
    })
    const remaining = Math.max(0, 5 - challenge.attempts - 1)
    const msg =
      lang === "zh"
        ? `验证码不对, 再试一次? 还剩 ${remaining} 次`
        : `code didn't match — try again? ${remaining} ${remaining === 1 ? "try" : "tries"} left`
    await sendDirect(input, msg)
    store.log("pa.onboarding.deterministic.email_verify_miss", {
      userId: event.userId,
      turnId,
      attempts: challenge.attempts + 1,
      remaining,
    })
    return { handled: true, action }
  }

  // ask_q_email_verify_start: fire Mailgun, persist hash, advance state.
  if (action.kind === "ask_q_email_verify_start") {
    if (!store.sendVerificationEmail) {
      // Mailgun not configured — skip verification. Email is captured
      // (we just saw it), state moves to complete WITHOUT verifiedAt.
      // Email-verified gate at outer layer will then re-trigger this if
      // it's required. For now, biz testers without Mailgun get a
      // graceful fallback: just thank them and move on.
      await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "complete", {
        priorAskedStep: "ask_q_email",
        priorUserReply: event.body,
      })
      const lang = langFor(event.body)
      const msg = lang === "zh" ? "收到, 邮箱记下了" : "got it — email saved"
      await sendDirect(input, msg)
      store.log("pa.onboarding.deterministic.email_verify_skipped_no_transport", {
        userId: event.userId,
        turnId,
        email: action.email,
      })
      return { handled: true, action }
    }
    let challenge:
      | {
          codeHash: string
          email: string
          sentAt: string
          expiresAt: string
          providerMessageId?: string
        }
      | undefined
    try {
      const sent = await store.sendVerificationEmail(action.email)
      if (sent) {
        const { createHash } = await import("node:crypto")
        challenge = {
          codeHash: createHash("sha256").update(sent.rawCode).digest("hex"),
          email: action.email,
          sentAt: sent.sentAt,
          expiresAt: sent.expiresAt,
          ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}),
        }
        store.log("pa.onboarding.deterministic.email_verify_sent", {
          userId: event.userId,
          turnId,
          email: action.email,
          providerMessageId: sent.providerMessageId,
        })
      }
    } catch (err) {
      store.log("pa.onboarding.deterministic.email_verify_send_error", {
        userId: event.userId,
        turnId,
        email: action.email,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (!challenge) {
      // Mailgun fired but failed; same fallback as no-transport.
      await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "complete", {
        priorAskedStep: "ask_q_email",
        priorUserReply: event.body,
      })
      const lang = langFor(event.body)
      const msg = lang === "zh" ? "收到, 邮箱记下了" : "got it — email saved"
      await sendDirect(input, msg)
      return { handled: true, action }
    }
    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_email_verify", {
      priorAskedStep: "ask_q_email",
      priorUserReply: event.body,
      emailVerification: challenge,
    })
    const phrase = config.ask_q_email_verify!.prompt[langFor(event.body)]
    await sendDirect(input, phrase)
    return { handled: true, action }
  }

  // iter33 P3 — q_resume_asked + cvParsed=true (or stuck at q_cv_analyzing
  // re-attempt) → send_cv_analysis. Two outbound messages in one turn:
  //   1. ack: "OK 让我看一下你简历"
  //   2. analysis: 1-2 sentence LLM summary of the CV (Qwen-7B). Falls
  //      back to a generic 'thanks for sending it through' line if the
  //      LLM hook is unavailable so onboarding still completes.
  // State advances to "complete" (P4 will interpose a job-rec push here).
  if (action.kind === "send_cv_analysis") {
    const lang = langFor(event.body)
    const ackMsg =
      lang === "zh"
        ? "OK 让我看一下你简历, 等我一下下"
        : "ok — give me a sec to read your resume"
    await sendDirect(input, ackMsg, "1-interim-ack")
    store.log("pa.onboarding.deterministic.cv_analysis_ack_sent", {
      userId: event.userId,
      turnId,
    })

    // LLM analysis. Fail-open to a generic line so onboarding always closes.
    let analysisMsg: string
    try {
      const result = store.generateCvAnalysis
        ? await store.generateCvAnalysis(event.userId, lang)
        : null
      if (result?.summary && result.summary.trim().length > 0) {
        analysisMsg = result.summary.trim()
      } else {
        analysisMsg =
          lang === "zh"
            ? "看下来你背景挺扎实的, 后面给你推岗位会贴着你的方向来"
            : "skimmed it — solid background, i'll lean recommendations toward your trajectory"
      }
    } catch (err) {
      store.log("pa.onboarding.deterministic.cv_analysis_error", {
        userId: event.userId,
        turnId,
        error: err instanceof Error ? err.message : String(err),
      })
      analysisMsg =
        lang === "zh"
          ? "看下来你背景挺扎实的, 后面给你推岗位会贴着你的方向来"
          : "skimmed it — solid background, i'll lean recommendations toward your trajectory"
    }
    await sendDirect(input, analysisMsg, "2-cv-analysis")

    // iter33 P4 — third outbound: 2-job-rec push (or deferred-promise
    // when no live matches yet). Adam-locked sequence: "推荐两个岗位.
    // onboard 结束". Fail-OPEN to deferred-promise so onboarding always
    // completes even if matching pipeline is offline.
    //
    // iter34 hotfix 2026-05-05 — Adam directive on phrasing:
    //   "应该是我们马上聊聊看然后帮你找找最近比较匹配的，如果不好我们就在
    //    找找看，然后之后每天都会有"
    // Old "tomorrow ~9am" robotic phrasing replaced with friend-tone:
    // "马上看看 / 不准就再找 / 之后每天会有".
    let jobRecMsg: string
    let recCount = 0
    const deferredFallback =
      lang === "zh"
        ? "我先帮你拉一批最近比较匹配的看看, 不准的话我们再找找; 之后每天会自动给你新的, 想换方向随时说"
        : "lemme pull some close matches now — if they don't fit we keep iterating; daily fresh batch from here on, ping me anytime to retune"
    try {
      const recs = store.generateJobRecs
        ? await store.generateJobRecs(event.userId, lang)
        : null
      if (recs?.message && recs.message.trim().length > 0) {
        jobRecMsg = recs.message.trim()
        recCount = recs.recCount
      } else {
        jobRecMsg = deferredFallback
      }
    } catch (err) {
      store.log("pa.onboarding.deterministic.job_recs_error", {
        userId: event.userId,
        turnId,
        error: err instanceof Error ? err.message : String(err),
      })
      jobRecMsg = deferredFallback
    }
    await sendDirect(input, jobRecMsg, "3-jobrec")

    // iter34 hotfix 2026-05-05 — Adam directive: "聊完以后我在哪看系统给我
    // 的 tag?". Surface canonical statedPreferences so user can verify +
    // correct ("不对告诉我"). Mirrors what's stored in pa-users doc.
    const tagSummary = formatStatedPreferencesForUser(
      onboardingUser.statedPreferences,
      lang
    )
    if (tagSummary) {
      await sendDirect(input, tagSummary, "4-tag-summary")
    }

    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "complete", {
      priorAskedStep: "ask_q_resume",
      priorUserReply: event.body,
    })
    store.log("pa.onboarding.deterministic.complete", {
      userId: event.userId,
      turnId,
      withCvAnalysis: true,
      jobRecCount: recCount,
      jobRecsLive: recCount > 0,
    })
    return { handled: true, action }
  }

  // ToS accept path (iter33 P2 reorder) → advance to q_role_asked +
  // write tosAcceptance audit. iter33 sequence: q_tos_asked accept now
  // gates the role-probe chain (email + verify already cleared upstream).
  if (action.kind === "ask_q_role" && onboardingUser.onboardingState === "q_tos_asked") {
    const tosVersion = store.getTosVersion ? await store.getTosVersion() : "v1.0"
    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_role", {
      priorAskedStep: "ask_q_tos",
      priorUserReply: event.body,
      tosAcceptedVersion: tosVersion,
    })
    // iter34 P0.6 — upfront framing before first probe Q. Adam directive
    // 2026-05-05 ("在开始问之前说这几个是我必须要了解清楚的信息要不然
    // 我不好帮助你"). Sets expectation that the next 5 Qs are MANDATORY
    // before agent runtime activates. Joined into the same outbound as
    // the q_role prompt so user sees it as a single contextual message.
    const lang = langFor(event.body)
    const framingLine =
      lang === "zh"
        ? "下面这几个是我必须了解清楚的, 不然不好帮你 —"
        : "heads up — i need to nail down these next few before I can actually help you —"
    const rolePrompt = config.ask_q_role!.prompt[lang]
    await sendDirect(input, `${framingLine} ${rolePrompt}`)
    store.log("pa.onboarding.deterministic.tos_accepted", {
      userId: event.userId,
      turnId,
      version: tosVersion,
    })
    return { handled: true, action }
  }

  // ToS decline path → record decline, stay at q_tos_asked.
  if (action.kind === "ask_q_tos_decline") {
    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_tos", {
      priorAskedStep: "ask_q_tos",
      priorUserReply: event.body,
      tosDeclined: true,
      suspendedForVent: true, // re-use suspension semantics: state stays
    })
    const phrase = config.ask_q_tos!.declinePrompt![langFor(event.body)]
    await sendDirect(input, phrase)
    store.log("pa.onboarding.deterministic.tos_declined", {
      userId: event.userId,
      turnId,
    })
    return { handled: true, action }
  }

  // ToS unclear → re-ask, stay.
  if (action.kind === "ask_q_tos_reask") {
    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_tos", {
      priorAskedStep: "ask_q_tos",
      priorUserReply: event.body,
      suspendedForVent: true,
    })
    const phrase = config.ask_q_tos!.reaskPrompt![langFor(event.body)]
    await sendDirect(input, phrase)
    return { handled: true, action }
  }

  // Vent / distress mid-onboarding — short ack + state stays.
  if (action.kind === "vent_ack") {
    await sendDirect(input, VENT_ACK[langFor(event.body)])
    store.log("pa.onboarding.deterministic.vent_suspended", {
      userId: event.userId,
      turnId,
      state: onboardingUser.onboardingState,
    })
    return { handled: true, action }
  }

  // wait_for_resume_upload — CV gate, send waitingPrompt, no advance.
  // 2026-05-07 Bug A — dedup: Adam saw "just waiting" twice in a row when
  // PDF arrived (one inbound for the attachment + cv-ingest synthetic
  // [cv-parsed] event, both hit q_resume_asked + cvParsed=false during
  // the cv-ingest async window). Skip the prompt if we sent it within 60s.
  if (action.kind === "wait_for_resume_upload") {
    const now = Date.now()
    // 2026-05-07 Bug A v2 — re-read user doc + use Firestore transaction so
    // two near-simultaneous attachment events serialize: only one wins the
    // "claim" and fires the prompt; the other reads the just-written
    // timestamp and dedups. The original snapshot-only check failed because
    // `onboardingUser` is read at turn-start; when event 2 enters this
    // function while event 1 is still in sendDirect, event 2 sees no
    // timestamp and both fire.
    let claimedFire = false
    if (store.db) {
      try {
        const ref = store.db.collection("pa-users").doc(event.userId)
        await store.db.runTransaction(async (tx) => {
          const snap = await tx.get(ref)
          const lastFire = (snap.data() as { cvWaitPromptLastFiredAt?: string } | undefined)
            ?.cvWaitPromptLastFiredAt
          if (lastFire) {
            const ageMs = now - Date.parse(lastFire)
            if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 60_000) {
              return // do not claim — leave dedup signal in place
            }
          }
          tx.set(ref, { cvWaitPromptLastFiredAt: new Date(now).toISOString() }, { merge: true })
          claimedFire = true
        })
      } catch {
        // tx failed — fall back to fire (best-effort dedup, prefer over silence)
        claimedFire = true
      }
    } else {
      claimedFire = true
    }
    if (!claimedFire) {
      store.log("pa.onboarding.deterministic.cv_wait_deduped", {
        userId: event.userId,
        turnId,
      })
      return { handled: true, action }
    }
    await sendDirect(input, config.ask_q_resume!.waitingPrompt![langFor(event.body)])
    store.log("pa.onboarding.deterministic.cv_wait", {
      userId: event.userId,
      turnId,
    })
    return { handled: true, action }
  }

  // ask_q_email_verify_retry — wrong code branch (no code parsed).
  if (action.kind === "ask_q_email_verify_retry") {
    await sendDirect(input, config.ask_q_email_verify!.waitingPrompt![langFor(event.body)])
    return { handled: true, action }
  }

  // iter33 Bug 10 fix 2026-05-05 (Adam: edge case "哈哈" reply at q_email).
  // When the dispatcher re-emits ask_q_email at the q_email_asked state
  // (workflow's no_email re-ask edge), use the dedicated reaskPrompt so
  // the user understands their reply didn't parse — not just see the
  // same Q again. State doesn't advance (q_email_asked → q_email_asked
  // self-loop), so suspendedForVent semantics keep STATE_ORDER happy.
  //
  // iter33 Bug 15 fix 2026-05-05 (Adam: typed gmal.com → no code received).
  // When the user DID type something email-shaped but with a known-typo
  // domain (gmal.com → gmail.com, yahooo.com → yahoo.com), surface the
  // typo back with a suggestion. parseEmailAnswer already returned {}
  // for typo'd domains so the workflow routes here; we re-detect on the
  // raw msg to extract the canonical suggestion.
  if (action.kind === "ask_q_email" && onboardingUser.onboardingState === "q_email_asked") {
    const lang = langFor(event.body)
    const { detectEmailDomainTypo } = await import("./onboarding.js")

    // iter34 P0 — LLM-fallback intent extraction (Adam directive 2026-05-05:
    // "edge case 处理应该是能 involve llm啊 ... 一个认证过程"). We invoke
    // the LLM ONLY when:
    //   • the reply has email-shape signal (contains "@" / "邮箱" / "email" /
    //     "send" — heuristic to avoid hitting LLM on pure noise like "哈哈")
    //   • the deterministic regex parser failed (which is why we're here)
    //   • the deterministic typo map didn't already match (cheap path wins)
    // LLM gives us 4 outcomes (provided / typo / declined / unclear). Each
    // routes to a different runner action. On LLM null/error we fall back
    // to the deterministic typo + generic re-ask path.
    const emailRegex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
    const rawMatch = event.body.match(emailRegex)
    const hasEmailIntent =
      Boolean(rawMatch) ||
      /邮箱|邮件|email|gmail|yahoo|outlook|hotmail|icloud|mail/i.test(event.body)

    // Cheap path: deterministic typo map first — saves an LLM call when
    // we already know the canonical domain.
    if (rawMatch) {
      const candidate = rawMatch[0].toLowerCase()
      const canonical = detectEmailDomainTypo(candidate)
      if (canonical) {
        await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_email", {
          priorAskedStep: "ask_q_email",
          priorUserReply: event.body,
          suspendedForVent: true,
        })
        const at = candidate.lastIndexOf("@")
        const local = candidate.slice(0, at)
        const suggested = `${local}@${canonical}`
        const reaskPhrase =
          lang === "zh"
            ? `${candidate} 这个域名我没找到, 你是不是想发到 ${suggested}? 帮我确认一下`
            : `${candidate} doesn't look right — did you mean ${suggested}? lemme know which`
        await sendDirect(input, reaskPhrase)
        store.log("pa.onboarding.deterministic.email_typo_suggested", {
          userId: event.userId,
          turnId,
          source: "static_map",
          original: candidate,
          suggested,
        })
        return { handled: true, action }
      }
    }

    // LLM path — only when there's signal worth spending an LLM call on.
    if (hasEmailIntent && store.extractEmailIntent) {
      try {
        const intent = await store.extractEmailIntent(event.body, lang)
        if (intent) {
          if (intent.intent === "provided") {
            // LLM extracted a clean email → save + advance to verify-start.
            // Re-emit the runner with a synthetic ask_q_email_verify_start
            // action; reuse the existing handler so Mailgun-fire + state
            // advance + verify-prompt all happen in one place.
            store.log("pa.onboarding.deterministic.email_llm_extracted", {
              userId: event.userId,
              turnId,
              email: intent.email,
              confidence: intent.confidence,
            })
            // Tail-call the verify-start handler with the LLM-extracted email.
            // langOverride preserves user's chosen lang across the recursion
            // (LLM-extracted "user@example.com" alone wouldn't preserve zh).
            return runDeterministicOnboardingTurn({
              ...input,
              event: { ...event, body: intent.email },
              langOverride: lang,
            })
          }
          if (intent.intent === "typo") {
            await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_email", {
              priorAskedStep: "ask_q_email",
              priorUserReply: event.body,
              suspendedForVent: true,
            })
            const reaskPhrase =
              lang === "zh"
                ? `${intent.original} 这个邮箱我打不通, 你是不是想发到 ${intent.suggestion}? 帮我确认一下`
                : `${intent.original} didn't look right — did you mean ${intent.suggestion}? lemme know which`
            await sendDirect(input, reaskPhrase)
            store.log("pa.onboarding.deterministic.email_typo_suggested", {
              userId: event.userId,
              turnId,
              source: "llm",
              original: intent.original,
              suggested: intent.suggestion,
            })
            return { handled: true, action }
          }
          if (intent.intent === "declined") {
            // User said no/skip → accept, advance with no contactEmail.
            await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "complete", {
              priorAskedStep: "ask_q_email",
              priorUserReply: event.body,
            })
            const ackMsg =
              lang === "zh" ? "好的, 不强求邮箱. 那我们继续聊吧" : "no worries — we can keep chatting without email"
            await sendDirect(input, ackMsg)
            store.log("pa.onboarding.deterministic.email_declined_via_llm", {
              userId: event.userId,
              turnId,
              reply: event.body,
            })
            return { handled: true, action }
          }
          if (intent.intent === "unclear") {
            // LLM provided a clarifying question — use that.
            await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_email", {
              priorAskedStep: "ask_q_email",
              priorUserReply: event.body,
              suspendedForVent: true,
            })
            await sendDirect(input, intent.clarifyingQuestion)
            store.log("pa.onboarding.deterministic.email_clarify_via_llm", {
              userId: event.userId,
              turnId,
              clarifyingQuestion: intent.clarifyingQuestion,
            })
            return { handled: true, action }
          }
        }
      } catch (err) {
        // LLM call threw — fall through to deterministic re-ask. Don't
        // block onboarding on a transient LLM failure.
        store.log("pa.onboarding.deterministic.email_llm_error", {
          userId: event.userId,
          turnId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Deterministic fallback re-ask (no email signal in reply, or LLM
    // unconfigured / failed / returned null).
    await store.applyOnboarding(event.userId, onboardingUser.phoneE164, "ask_q_email", {
      priorAskedStep: "ask_q_email",
      priorUserReply: event.body,
      suspendedForVent: true,
    })
    const reaskPhrase = config.ask_q_email!.reaskPrompt?.[lang] ?? config.ask_q_email!.prompt[lang]
    await sendDirect(input, reaskPhrase)
    store.log("pa.onboarding.deterministic.email_reask", {
      userId: event.userId,
      turnId,
      reply: event.body,
    })
    return { handled: true, action }
  }

  // iter34 P0.2 — generic LLM-fallback for the 5 non-email probe Q's.
  // Adam directive 2026-05-05 ("不只是 email, 包括所有一开始的
  // deterministic 的 question 都需要加这个"). Detection: action emits
  // ask_q_role/yoe/visa/startup_pref/location AND state matches that
  // step's "asked" variant — which is the workflow's default re-ask
  // self-loop (parser missed). Skip when action came from a prior-state
  // forward transition (e.g. q_tos_asked accept → ask_q_role); those
  // are fresh asks, not re-asks.
  const probeStepToState: Record<string, OnboardingState> = {
    ask_q_role: "q_role_asked",
    ask_q_yoe: "q_yoe_asked",
    ask_q_visa: "q_visa_asked",
    ask_q_startup_pref: "q_startup_pref_asked",
    ask_q_location: "q_location_asked",
  }
  const probeReaskState = probeStepToState[action.kind]
  // iter34 P0.6.2 (Adam directive 2026-05-05) — capture LLM clarifyingQuestion
  // here so the re-ask block below can use it as preferred phrasing for the
  // current attempt. Counter bumps only happen in the re-ask block (failure
  // path), so a successful "provided" extract doesn't burn an attempt.
  let llmClarifyingQuestion: string | undefined = undefined
  if (
    probeReaskState &&
    onboardingUser.onboardingState === probeReaskState &&
    store.extractAnswerIntent
  ) {
    // Cheap noise filter — skip LLM only on clearly empty/control
    // input. For probe Qs, almost any non-trivial reply could be a
    // valid edge ("什么都行" / "看机会" / "I dunno") and deserves LLM
    // intent extraction. Cost guard: ≥2 non-whitespace chars + has
    // letter/digit/CJK content (rules out pure punct like "??" / "...").
    const trimmed = event.body.trim()
    const hasMeaningfulContent =
      trimmed.length >= 2 &&
      /[A-Za-z0-9一-鿿]/.test(trimmed)
    if (hasMeaningfulContent) {
      // iter34 P0.2 — observability for the LLM probe path. Logs ALWAYS
      // fire on entry so prod-log inspection can diagnose silent fallback
      // (e.g. LLM unconfigured, threw, returned null, returned low-conf).
      store.log("pa.onboarding.deterministic.probe_llm_invoke", {
        userId: event.userId,
        turnId,
        step: action.kind,
        replyLen: trimmed.length,
      })
      try {
        const intent = await store.extractAnswerIntent(
          action.kind as
            | "ask_q_role"
            | "ask_q_yoe"
            | "ask_q_visa"
            | "ask_q_startup_pref"
            | "ask_q_location",
          event.body,
          langFor(event.body)
        )
        if (intent) {
          if (intent.intent === "provided" && intent.confidence >= 0.6) {
            // LLM extracted a usable answer → tail-call the runner with
            // the canonical value as the "user reply" so the deterministic
            // parser captures it on the second pass + advances to next state.
            //
            // Format the value to match each Q's parser regex so the
            // tail-call's parseUserAnswerForStep actually accepts it (raw
            // "ai infra" or "5" misses the role/yoe regex → would cause
            // infinite tail-call recursion).
            const v = intent.value
            let formatted: string
            if (action.kind === "ask_q_yoe") {
              if (v === "fresh" || v === 0) formatted = "fresh grad"
              else if (typeof v === "number") formatted = `${v} years`
              else formatted = String(v)
            } else if (action.kind === "ask_q_role") {
              // Append "engineer" suffix as a regex-friendly hint. The
              // role regex includes /engineer|developer|ml\b|design|.../
              // so "ai infra engineer" matches "engineer" reliably even
              // when the LLM emits a free-form role token.
              const s = String(v).toLowerCase()
              const regexHits = /(swe|pm\b|em\b|ic\b|staff|senior|junior|new\s*grad|应届|工程|产品|设计|研究|design|research|engineer|developer|前端|后端|算法|数据|machine\s*learning|ml\b)/i
              formatted = regexHits.test(s) ? s : `${s} engineer`
            } else {
              formatted = String(v)
            }
            store.log("pa.onboarding.deterministic.probe_llm_extracted", {
              userId: event.userId,
              turnId,
              step: action.kind,
              value: intent.value,
              formatted,
              confidence: intent.confidence,
            })
            return runDeterministicOnboardingTurn({
              ...input,
              event: { ...event, body: formatted },
              // Preserve user's chosen lang across tail-call (canonical
              // value like "swe" / "h1b" is too short for pickLang).
              langOverride: langFor(event.body),
            })
          }
          if (intent.intent === "unclear") {
            // iter34 P0.6.2 — capture clarifyingQuestion for use by the
            // re-ask block. Counter bump + halt check happen there, NOT
            // here (so LLM unclear cycles count toward the 5-attempt cap).
            llmClarifyingQuestion = intent.clarifyingQuestion
            store.log("pa.onboarding.deterministic.probe_llm_clarify", {
              userId: event.userId,
              turnId,
              step: action.kind,
              clarifyingQuestion: intent.clarifyingQuestion,
            })
          }
        }
      } catch (err) {
        store.log("pa.onboarding.deterministic.probe_llm_error", {
          userId: event.userId,
          turnId,
          step: action.kind,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // Fall through to deterministic re-ask block — counter bump + halt
    // check + variant rotation all happen there.
  }

  // iter34 P0.4 + P0.5 + P0.6 — probe re-ask UX upgrade + attempt counting.
  // Adam directive 2026-05-05 ("skip 是不能 skip 的, deterministic 的问题
  // 必须回答; 错误三次给系统标记; 满 5 次后请联系 admin1@wekruit.com").
  //
  // Pipeline (deterministic Q 必须答, 不可 skip):
  //   1. Increment per-step attempt counter (Firestore tx-safe)
  //   2. attempt == 3 → set systemFlags.onboardingIrrelevantPattern=true
  //   3. attempt >= 5 → HALT onboarding (NO advance, NO skip — Adam 锁定):
  //                     send "请联系 admin1@wekruit.com..." + set
  //                     systemFlags.onboardingHalted=true
  //   4. Else → escalating reaskPrompt (different wording, NO skip mention)
  if (probeReaskState && onboardingUser.onboardingState === probeReaskState) {
    const lang = langFor(event.body)
    const stepName = action.kind as OnboardingStep
    // (1) Increment attempt counter via Firestore tx (skip if no db, e.g. tests).
    let attemptCount = 1
    if (store.db) {
      try {
        const ref = store.db.collection("pa-users").doc(event.userId)
        attemptCount = await store.db.runTransaction(async (tx: any) => {
          const snap = await tx.get(ref)
          const data = (snap.data() ?? {}) as { onboardingProbeAttempts?: Record<string, number> }
          const map = { ...(data.onboardingProbeAttempts ?? {}) }
          map[stepName] = (map[stepName] ?? 0) + 1
          tx.set(ref, { onboardingProbeAttempts: map }, { merge: true })
          return map[stepName]
        })
      } catch (err) {
        store.log("pa.onboarding.deterministic.probe_attempt_tx_error", {
          userId: event.userId,
          turnId,
          step: stepName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // (2) Attempt 3 → set systemFlag (Adam: "错误三次就给系统标记").
    if (attemptCount === 3 && store.db) {
      try {
        const ref = store.db.collection("pa-users").doc(event.userId)
        await ref.set(
          {
            systemFlags: {
              onboardingIrrelevantPattern: true,
              onboardingIrrelevantStep: stepName,
              onboardingIrrelevantAt: store.nowIso(),
            },
          },
          { merge: true }
        )
        store.log("pa.onboarding.deterministic.probe_irrelevant_flag", {
          userId: event.userId,
          turnId,
          step: stepName,
          attempt: 3,
        })
      } catch (err) {
        store.log("pa.onboarding.deterministic.probe_flag_error", {
          userId: event.userId,
          turnId,
          step: stepName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // (3) Attempt >= 5 → HALT (Adam: "请联系 admin1@wekruit.com 解决问题,
    //     你现在连续失败了五次, 请不要继续"). NO skip, NO state advance.
    //     Set onboardingHalted flag so future inbounds get the same msg
    //     (downstream handler can short-circuit).
    if (attemptCount >= 5) {
      if (store.db) {
        try {
          const ref = store.db.collection("pa-users").doc(event.userId)
          await ref.set(
            {
              systemFlags: {
                onboardingHalted: true,
                onboardingHaltedStep: stepName,
                onboardingHaltedAt: store.nowIso(),
              },
            },
            { merge: true }
          )
        } catch (err) {
          store.log("pa.onboarding.deterministic.probe_halt_error", {
            userId: event.userId,
            turnId,
            step: stepName,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const haltMsg =
        lang === "zh"
          ? "请联系 admin1@wekruit.com 解决问题. 你现在连续失败了五次, 请不要继续"
          : "please contact admin1@wekruit.com — you've failed 5 times in a row, please stop"
      await sendDirect(input, haltMsg)
      store.log("pa.onboarding.deterministic.probe_halted", {
        userId: event.userId,
        turnId,
        step: stepName,
        attemptCount,
      })
      return { handled: true, action }
    }
    // (4) Pick the re-ask phrasing.
    //     Priority order (Adam directive 2026-05-05 "如果重新问, 可以换
    //     一种问法" → predictable rotation wins over LLM):
    //       a. reaskPromptVariants[attemptCount-1] — guaranteed rotation
    //       b. LLM clarifyingQuestion — smart but can repeat across attempts
    //          if model parrots prompt examples
    //       c. reaskPrompt (legacy single string)
    //       d. prompt (worst case — same string as the original Q)
    const variants = config[stepName]?.reaskPromptVariants
    const variantIdx = attemptCount - 1 // 1-indexed → 0-indexed
    const variantPhrase =
      variants && variantIdx >= 0 && variantIdx < variants.length
        ? variants[variantIdx]?.[lang]
        : undefined
    const reaskPhrase =
      variantPhrase ??
      llmClarifyingQuestion ??
      config[stepName]?.reaskPrompt?.[lang] ??
      config[stepName]?.prompt[lang] ??
      ""
    if (reaskPhrase) {
      await store.applyOnboarding(event.userId, onboardingUser.phoneE164, stepName, {
        priorAskedStep: stepName,
        priorUserReply: event.body,
        suspendedForVent: true,
      })
      await sendDirect(input, reaskPhrase)
      store.log("pa.onboarding.deterministic.probe_reask", {
        userId: event.userId,
        turnId,
        step: stepName,
        attempt: attemptCount,
      })
      return { handled: true, action }
    }
  }

  // Standard advance steps (send_first_mes, ask_q_tos, ask_q_yoe, etc.)
  const stepName = action.kind as OnboardingStep
  await store.applyOnboarding(event.userId, onboardingUser.phoneE164, stepName, {
    priorAskedStep: priorAskedStepFromState(onboardingUser.onboardingState),
    priorUserReply: event.body,
  })
  // iter34 hotfix 2026-05-05 — pass promptLang (zh|en|mixed) so the
  // composer picks the mixed-style template when prefLang === "mixed".
  const reply = composeDeterministicReply(action, config, event.body, promptLang(event.body))
  await sendDirect(input, reply)
  return { handled: true, action }
}

/**
 * Internal helper — appendMessage (assistant) + enqueueOutbound. Mirrors
 * the existing sendMemoryReply pattern from index.ts but lives here so
 * the deterministic module is self-contained for testing.
 *
 * iter34 followup D.1 — `tag` disambiguates multi-message bundles per
 * turn (e.g. send_cv_analysis fires 4 sendDirect's: interim ack +
 * cv-analysis + jobRec + tag-summary). Without a tag they all collapse
 * onto the same idempotencyKey `out-onboarding-${event.id}` and
 * appendMessage's dedup logic patches the single pa-messages row to
 * the LAST body — so dashboard / SDK history reads only see the final
 * message (real iMessage uses random docIds for pa-outbound and is
 * unaffected; users still receive all 4). Pass a short tag like
 * `interim-ack`, `cv-analysis`, `jobrec`, `tag-summary` so each
 * outbound gets its own unique idempotencyKey.
 *
 * Single-message branches (the dominant case) can omit `tag` and keep
 * the legacy unsuffixed key — replays / retries still dedup correctly.
 */
async function sendDirect(
  input: RunDeterministicTurnInput,
  body: string,
  tag?: string
): Promise<void> {
  if (!body) return
  const at = input.store.nowIso()
  const { event } = input
  const suffix = tag ? `-${tag}` : ""
  await input.store.appendMessage({
    sessionId: event.sessionId,
    userId: event.userId,
    role: "assistant",
    body,
    createdAt: at,
    idempotencyKey: `out-onboarding-${event.id}${suffix}`,
    rawMeta: {
      source: "pa_orchestrator",
      turnId: input.turnId,
      eventId: event.id,
      onboarding: "deterministic",
    },
  })
  if (input.suppressOutbound) return
  await input.store.enqueueOutbound(event.userId, event.from, body, {
    sessionId: event.sessionId,
    role: "assistant",
    idempotencyKey: `outbound-onboarding-${event.id}${suffix}`,
  })
}
