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
import type { ExtractEmailIntentFn } from "./judges/email.js"
import { CodeJudge } from "./judges/code.js"
import { EmailJudge } from "./judges/email.js"
import { LangJudge, type LangPref } from "./judges/lang.js"
import {
  LLMRelevanceJudge,
  type ExtractIntentFn,
} from "./judges/llm-relevance.js"
import { ResumeJudge, type ResumeAttachment } from "./judges/resume.js"
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
  /** LLM email intent extractor (typo / declined / unclear). */
  extractEmailIntent?: ExtractEmailIntentFn
  /**
   * Hook fired when q_email is accepted. Concretely: send Mailgun
   * verification email + write the codeHash to pa-users/{id}.emailVerification.
   * Pipeline expects this to be wired by the runtime.
   */
  onEmailAccepted?: (
    email: string,
    ctx: AcceptedCtx
  ) => Promise<void>
  /** Hook fired when q_email_verify accepts (writes contactEmailVerifiedAt). */
  onEmailCodeVerified?: (code: string, ctx: AcceptedCtx) => Promise<void>
  /** Hook fired when q_resume accepts (kicks cv-ingest worker). */
  onResumeAccepted?: (
    attachments: ResumeAttachment[],
    ctx: AcceptedCtx
  ) => Promise<void>
  /** Hook fired when q_lang accepts (writes preferredLang to user doc + adjusts pipeline state). */
  onLangAccepted?: (lang: LangPref, ctx: AcceptedCtx) => Promise<void>
  /**
   * iter34 hotfix 2026-05-05 — Adam directive "为什么还在用 regex??".
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
  /** LLM email intent extractor (typo / declined / unclear). */
  extractEmailIntent?: ExtractEmailIntentFn
  onEmailAccepted?: (
    email: string,
    ctx: AcceptedCtx
  ) => Promise<void>
  onEmailCodeVerified?: (code: string, ctx: AcceptedCtx) => Promise<void>
  onResumeAccepted?: (
    attachments: ResumeAttachment[],
    ctx: AcceptedCtx
  ) => Promise<void>
  onLangAccepted?: (lang: LangPref, ctx: AcceptedCtx) => Promise<void>
}

const HALT_DEFAULT: BilingualText = {
  zh: "请联系 admin1@wekruit.com 解决问题. 你现在连续失败了五次, 请不要继续",
  en: "please contact admin1@wekruit.com — you've failed 5 times in a row, please stop",
}

function makeClosedQuestions(deps: ClosedQuestionsDeps): {
  langQ: Question<LangPref>
  emailQ: Question<string>
  emailVerifyQ: Question<string>
  tosQ: Question<boolean>
  resumeQ: Question<ResumeAttachment[]>
} {
  const langQ: Question<LangPref> = makeQuestion({
    id: "q_lang",
    prompt: {
      zh: "在呢. 用啥语聊比较顺? 中文 / 英文 / 中英混着说都行",
      en: "Here. What language works for you? Chinese / English / both mixed?",
    },
    judge: new LangJudge(),
    rephraser: new StaticVariantsRephraser([
      {
        zh: "选一种就行: 中文 / 英文 / 还是混着说?",
        en: "just pick one: Chinese / English / or mixed?",
      },
      {
        zh: "再问一遍 — 你聊起来更顺手的是中文还是英文? '混' 也行",
        en: "let me ask again — chinese, english, or mixed-ok?",
      },
      {
        zh: "中文 / 英文 / 混 — 三选一",
        en: "chinese / english / mixed — pick one",
      },
      {
        zh: "一个词就行: zh / en / mixed",
        en: "one word works: zh / en / mixed",
      },
    ]),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onLangAccepted,
  })

  const emailQ: Question<string> = makeQuestion({
    id: "q_email",
    prompt: {
      zh: "对了, 平时邮箱用啥? 后面如果你不在线我直接发邮件给你",
      en: "btw — what email should I send stuff to when you're afk? roughly fine",
    },
    judge: new EmailJudge({ extractEmailIntent: deps.extractEmailIntent }),
    rephraser: new StaticVariantsRephraser([
      {
        zh: "没看到邮箱地址哎, 直接发个 email 给我就行 (像 you@example.com 这种)",
        en: "didn't catch an email there — just paste the address (like you@example.com)",
      },
      {
        zh: "再发一次邮箱就行 — 我会发 6 位验证码确认是你的",
        en: "drop your email again — i'll send a 6-digit code to confirm it's yours",
      },
      {
        zh: "邮箱长这样: 用户名@域名.com, 比如 alex@gmail.com",
        en: "email shape: name@domain.com, like alex@gmail.com",
      },
      {
        zh: "邮箱地址给我就行, 后面验证只要几秒",
        en: "just need an email address — verify takes a few secs",
      },
    ]),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onEmailAccepted,
  })

  const emailVerifyQ: Question<string> = makeQuestion({
    id: "q_email_verify",
    prompt: {
      zh: "已经发了一个 6 位验证码到你邮箱了, 收到回我一下就行 (30 分钟有效)",
      en: "just sent a 6-digit code to your email — text it back to me and we're set (good for 30 mins)",
    },
    judge: new CodeJudge(),
    rephraser: new HybridRephraser({
      variants: [
        {
          zh: "等你把邮箱里的 6 位验证码发我",
          en: "still waiting on that 6-digit code from your email",
        },
        {
          zh: "看下邮箱 — 6 位数字回我就行",
          en: "check your inbox — 6 digits back to me",
        },
        {
          zh: "可能在垃圾邮件里? 6 位数字 — 找到回我",
          en: "maybe in spam? 6-digit code — text it back",
        },
        {
          zh: "实在收不到我重新发, 你回 'resend'",
          en: "if it never arrived, reply 'resend' and i'll re-issue",
        },
      ],
      fallback: {
        zh: "6 位验证码 — 看下邮箱回我",
        en: "6-digit code — check email and text it back",
      },
    }),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onEmailCodeVerified,
  })

  const tosQ: Question<boolean> = makeQuestion({
    id: "q_tos",
    prompt: {
      zh: "开聊前先说一下: 我会记一些咱聊天的事来给你推工作 / 找内推. 隐私 + 用户协议在这: https://wekruit-pa-landing.web.app/legal — 同意就回个 \"同意\" 我们继续",
      en: 'before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply "agree" if cool with that and we keep going',
    },
    judge: new YesNoJudge(),
    rephraser: new StaticVariantsRephraser([
      {
        zh: '刚那个隐私 + 用户协议你看一下哦, 同意就回 "同意" — 不同意我们也能继续聊但不会保存',
        en: 'just need a quick "agree" on the privacy + terms above — or "no" and we can chat without me saving anything',
      },
      {
        zh: "回 '同意' 或者 '不同意' 都行 — 看你",
        en: "either 'agree' or 'no' works — your call",
      },
      {
        zh: "同意保存咱聊天的事 → 回 '同意'. 不想保存 → 回 '不'",
        en: "agree to save chat memory → 'agree'. don't want it → 'no'",
      },
      {
        zh: "需要你的明确回复 — '同意' or '不'",
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
      zh: "对了, 简历方便发我一份不? 后面帮你看 JD / 内推都准多了",
      en: "btw — can you send me your resume? makes JD review and referrals way more on-point",
    },
    judge: new ResumeJudge(),
    rephraser: new StaticVariantsRephraser([
      {
        zh: "等你发简历过来哦, iMessage 里直接附件就行",
        en: "just waiting on the resume — send it as an iMessage attachment whenever",
      },
      {
        zh: "把简历当附件发到 iMessage 这里就行 — pdf / docx 都行",
        en: "drop the resume as an iMessage attachment — pdf / docx, either works",
      },
      {
        zh: "实在没简历回 'no resume' 也行, 我们靠对话也能帮你",
        en: "no resume? reply 'no resume' and we'll work with chat alone",
      },
      {
        zh: "再发一次 — iMessage 附件, pdf 最好",
        en: "try again — iMessage attachment, pdf preferred",
      },
    ]),
    haltMessage: {
      zh: "暂时跳过简历, 后面想发再说就行",
      en: "skipping resume for now — drop it whenever",
    },
    onAccepted: deps.onResumeAccepted,
    onDeclined: async () => ({ advance: true }),
  })

  return { langQ, emailQ, emailVerifyQ, tosQ, resumeQ }
}

export function defaultQuestions(deps: DefaultQuestionsDeps): Question<unknown>[] {
  const langQ: Question<LangPref> = makeQuestion({
    id: "q_lang",
    prompt: {
      zh: "在呢. 用啥语聊比较顺? 中文 / 英文 / 中英混着说都行",
      en: "Here. What language works for you? Chinese / English / both mixed?",
    },
    judge: new LangJudge(),
    rephraser: new StaticVariantsRephraser([
      {
        zh: "选一种就行: 中文 / 英文 / 还是混着说?",
        en: "just pick one: Chinese / English / or mixed?",
      },
      {
        zh: "再问一遍 — 你聊起来更顺手的是中文还是英文? '混' 也行",
        en: "let me ask again — chinese, english, or mixed-ok?",
      },
      {
        zh: "中文 / 英文 / 混 — 三选一",
        en: "chinese / english / mixed — pick one",
      },
      {
        zh: "一个词就行: zh / en / mixed",
        en: "one word works: zh / en / mixed",
      },
    ]),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onLangAccepted,
  })

  const emailQ: Question<string> = makeQuestion({
    id: "q_email",
    prompt: {
      zh: "对了, 平时邮箱用啥? 后面如果你不在线我直接发邮件给你",
      en: "btw — what email should I send stuff to when you're afk? roughly fine",
    },
    judge: new EmailJudge({ extractEmailIntent: deps.extractEmailIntent }),
    rephraser: new StaticVariantsRephraser([
      {
        zh: "没看到邮箱地址哎, 直接发个 email 给我就行 (像 you@example.com 这种)",
        en: "didn't catch an email there — just paste the address (like you@example.com)",
      },
      {
        zh: "再发一次邮箱就行 — 我会发 6 位验证码确认是你的",
        en: "drop your email again — i'll send a 6-digit code to confirm it's yours",
      },
      {
        zh: "邮箱长这样: 用户名@域名.com, 比如 alex@gmail.com",
        en: "email shape: name@domain.com, like alex@gmail.com",
      },
      {
        zh: "邮箱地址给我就行, 后面验证只要几秒",
        en: "just need an email address — verify takes a few secs",
      },
    ]),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onEmailAccepted,
  })

  const emailVerifyQ: Question<string> = makeQuestion({
    id: "q_email_verify",
    prompt: {
      zh: "已经发了一个 6 位验证码到你邮箱了, 收到回我一下就行 (30 分钟有效)",
      en: "just sent a 6-digit code to your email — text it back to me and we're set (good for 30 mins)",
    },
    judge: new CodeJudge(),
    rephraser: new HybridRephraser({
      variants: [
        {
          zh: "等你把邮箱里的 6 位验证码发我",
          en: "still waiting on that 6-digit code from your email",
        },
        {
          zh: "看下邮箱 — 6 位数字回我就行",
          en: "check your inbox — 6 digits back to me",
        },
        {
          zh: "可能在垃圾邮件里? 6 位数字 — 找到回我",
          en: "maybe in spam? 6-digit code — text it back",
        },
        {
          zh: "实在收不到我重新发, 你回 'resend'",
          en: "if it never arrived, reply 'resend' and i'll re-issue",
        },
      ],
      fallback: {
        zh: "6 位验证码 — 看下邮箱回我",
        en: "6-digit code — check email and text it back",
      },
    }),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onEmailCodeVerified,
  })

  const tosQ: Question<boolean> = makeQuestion({
    id: "q_tos",
    prompt: {
      zh: "开聊前先说一下: 我会记一些咱聊天的事来给你推工作 / 找内推. 隐私 + 用户协议在这: https://wekruit-pa-landing.web.app/legal — 同意就回个 \"同意\" 我们继续",
      en: 'before we get into it — heads up i remember bits of our chat to surface jobs + referrals for you. privacy + terms here: https://wekruit-pa-landing.web.app/legal — reply "agree" if cool with that and we keep going',
    },
    judge: new YesNoJudge(),
    rephraser: new StaticVariantsRephraser([
      {
        zh: '刚那个隐私 + 用户协议你看一下哦, 同意就回 "同意" — 不同意我们也能继续聊但不会保存',
        en: 'just need a quick "agree" on the privacy + terms above — or "no" and we can chat without me saving anything',
      },
      {
        zh: "回 '同意' 或者 '不同意' 都行 — 看你",
        en: "either 'agree' or 'no' works — your call",
      },
      {
        zh: "同意保存咱聊天的事 → 回 '同意'. 不想保存 → 回 '不'",
        en: "agree to save chat memory → 'agree'. don't want it → 'no'",
      },
      {
        zh: "需要你的明确回复 — '同意' or '不'",
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
      zh: "下面这几个是我必须了解清楚的, 不然不好帮你 — 那你大概想找啥方向的活? 比如做产品、做工程、还是做研究 — 给我个大致就行",
      en: "heads up — i need to nail down these next few before I can actually help you — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
    },
    judge: new LLMRelevanceJudge({
      step: "ask_q_role",
      extractIntent: deps.extractAnswerIntent,
    }),
    rephraser: probeRephraserOpts(
      [
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
      {
        zh: "swe / pm / 研究 / 设计 — 给我一个就行",
        en: "swe / pm / research / design — one works",
      }
    ),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onRoleAccepted,
  })

  const yoeQ: Question<unknown> = makeQuestion({
    id: "q_yoe",
    prompt: {
      zh: "你工作几年了? 还是刚毕业找新人岗?",
      en: "how many years you been working? or fresh outta school?",
    },
    judge: new LLMRelevanceJudge({
      step: "ask_q_yoe",
      extractIntent: deps.extractAnswerIntent,
    }),
    rephraser: probeRephraserOpts(
      [
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
      {
        zh: "几年? 数字就行",
        en: "how many years? a number works",
      }
    ),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onYoeAccepted,
  })

  const visaQ: Question<unknown> = makeQuestion({
    id: "q_visa",
    prompt: {
      zh: "那你有身份不? 公民/绿卡/OPT/还是要 sponsor?",
      en: "got work auth sorted? citizen / GC / OPT / need sponsorship?",
    },
    judge: new LLMRelevanceJudge({
      step: "ask_q_visa",
      extractIntent: deps.extractAnswerIntent,
    }),
    rephraser: probeRephraserOpts(
      [
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
      {
        zh: "citizen / opt / h1b / sponsor — 选一个",
        en: "citizen / opt / h1b / sponsor — pick one",
      }
    ),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onVisaAccepted,
  })

  const startupPrefQ: Question<unknown> = makeQuestion({
    id: "q_startup_pref",
    prompt: {
      zh: "你更想去 startup 那种小而拼的, 还是大厂稳一点?",
      en: "more into startup hustle vibe or stable big-co?",
    },
    judge: new LLMRelevanceJudge({
      step: "ask_q_startup_pref",
      extractIntent: deps.extractAnswerIntent,
    }),
    rephraser: probeRephraserOpts(
      [
        {
          zh: "startup / 大厂 / 都行 三选一",
          en: "startup / bigtech / either — pick one",
        },
        {
          // iter34 hotfix 2026-05-05 — mirror legacy fix; was off-theme drift.
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
      zh: "想找哪边的工作? 湾区、纽约、还是看远程?",
      en: "where you wanna be? SF / NYC / remote ok?",
    },
    judge: new LLMRelevanceJudge({
      step: "ask_q_location",
      extractIntent: deps.extractAnswerIntent,
    }),
    rephraser: probeRephraserOpts(
      [
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
      {
        zh: "城市或 'remote' 就行",
        en: "city or 'remote' is fine",
      }
    ),
    haltMessage: HALT_DEFAULT,
    onAccepted: deps.onLocationAccepted,
  })

  const resumeQ: Question<ResumeAttachment[]> = makeQuestion({
    id: "q_resume",
    prompt: {
      zh: "对了, 简历方便发我一份不? 后面帮你看 JD / 内推都准多了",
      en: "btw — can you send me your resume? makes JD review and referrals way more on-point",
    },
    judge: new ResumeJudge(),
    rephraser: new StaticVariantsRephraser([
      {
        zh: "等你发简历过来哦, iMessage 里直接附件就行",
        en: "just waiting on the resume — send it as an iMessage attachment whenever",
      },
      {
        zh: "把简历当附件发到 iMessage 这里就行 — pdf / docx 都行",
        en: "drop the resume as an iMessage attachment — pdf / docx, either works",
      },
      {
        zh: "实在没简历回 'no resume' 也行, 我们靠对话也能帮你",
        en: "no resume? reply 'no resume' and we'll work with chat alone",
      },
      {
        zh: "再发一次 — iMessage 附件, pdf 最好",
        en: "try again — iMessage attachment, pdf preferred",
      },
    ]),
    haltMessage: {
      zh: "暂时跳过简历, 后面想发再说就行",
      en: "skipping resume for now — drop it whenever",
    },
    onAccepted: deps.onResumeAccepted,
    // resume decline = skip, not halt.
    onDeclined: async () => ({ advance: true }),
  })

  return [
    langQ as Question<unknown>,
    emailQ as Question<unknown>,
    emailVerifyQ as Question<unknown>,
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
      zh: "下面这几个是我必须了解清楚的, 不然不好帮你 — 那你大概想找啥方向的活? 比如做产品、做工程、还是做研究 — 给我个大致就行",
      en: "heads up — i need to nail down these next few before I can actually help you — what kinda role you eyeing? eng / pm / research / design? roughly is fine",
    },
    judge: new GuidedOpenJudge<RoleAnswer>({
      questionLabel: "target job role",
      hints: ["swe", "pm", "research", "design", "data", "ml", "ops", "marketing", "founder"],
      examples: [
        { reply: "Software Engineer", value: ["swe"], confidence: 0.95 },
        { reply: "Swe / pm", value: ["swe", "pm"], confidence: 0.9 },
        { reply: "PM for fintech", value: ["pm"], confidence: 0.9 },
        { reply: "我做 ml infra 的", value: ["ml"], confidence: 0.9 },
        { reply: "designer", value: ["design"], confidence: 0.95 },
      ],
      parseValue: parseRoleValue,
      ...(llmCallFactory ? { llmCallFactory } : {}),
    }),
    rephraser: new HybridRephraser({
      variants: [
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
      fallback: {
        zh: "swe / pm / 研究 / 设计 — 给我一个就行",
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
    t.includes("刚毕业") ||
    t.includes("应届")
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
      zh: "你工作几年了? 还是刚毕业找新人岗?",
      en: "how many years you been working? or fresh outta school?",
    },
    judge: new GuidedOpenJudge<YoeAnswer>({
      questionLabel: "years of experience",
      hints: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "10", "fresh"],
      examples: [
        { reply: "2years", value: 2, confidence: 1.0 },
        { reply: "2 years", value: 2, confidence: 1.0 },
        { reply: "5y", value: 5, confidence: 0.95 },
        { reply: "三年", value: 3, confidence: 0.95 },
        { reply: "3-5 years", value: 4, confidence: 0.9 },
        { reply: "fresh grad", value: "fresh", confidence: 1.0 },
        { reply: "刚毕业", value: "fresh", confidence: 1.0 },
      ],
      parseValue: parseYoeValue,
      ...(llmCallFactory ? { llmCallFactory } : {}),
    }),
    rephraser: new HybridRephraser({
      variants: [
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
      fallback: {
        zh: "几年? 数字就行",
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
    t.includes("any") ||
    t.includes("flexible") ||
    t.includes("open to either") ||
    (t.includes("startup") && (t.includes("bigtech") || t.includes("big tech") || t.includes("big-co"))) ||
    t.includes("都行") ||
    t.includes("都可以") ||
    t.includes("无所谓") ||
    t.includes("看具体")
  ) return "either"
  if (t === "startup") return "startup"
  if (
    t.includes("startup") ||
    t.includes("start-up") ||
    t.includes("early-stage") ||
    t.includes("early stage") ||
    t.includes("fast-moving") ||
    t.includes("fast moving") ||
    t.includes("创业")
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
    t.includes("大厂")
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
      zh: "你更想去 startup 那种小而拼的, 还是大厂稳一点?",
      en: "more into startup hustle vibe or stable big-co?",
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
        { reply: "都行", value: "either", confidence: 0.95 },
        { reply: "Either", value: "either", confidence: 1.0 },
        { reply: "看具体团队", value: "either", confidence: 0.8 },
      ],
      bloomRegex: [
        {
          pattern: /\b(either|both|any|flexible|open to either|depends|team-dependent)\b|(\bstartup\b|\bstart-up\b|\bearly[-\s]?stage\b|\bfast[-\s]?moving\b|创业).*(\bbigtech\b|\bbig tech\b|\bbig[-\s]?company\b|\blarge company\b|\benterprise\b|\bstable\b|大厂)|(\bbigtech\b|\bbig tech\b|\bbig[-\s]?company\b|\blarge company\b|\benterprise\b|\bstable\b|大厂).*(\bstartup\b|\bstart-up\b|\bearly[-\s]?stage\b|\bfast[-\s]?moving\b|创业)|都行|都可以|无所谓|看具体/i,
          value: "either",
        },
        {
          pattern: /\bstartup\b|\bstart-up\b|\bearly[-\s]?stage\b|\bfast[-\s]?moving\b|\bfounding\b|创业/i,
          value: "startup",
        },
        {
          pattern: /\bbigtech\b|\bbig tech\b|\bbig[-\s]?company\b|\blarge company\b|\benterprise\b|\bstable\b|大厂/i,
          value: "bigtech",
        },
      ],
      parseValue: parseStartupPrefValue,
      ...(llmCallFactory ? { llmCallFactory } : {}),
    }),
    rephraser: new HybridRephraser({
      variants: [
        {
          zh: "我想给你打个偏好标签: 更偏 startup, 大厂, 还是都可以?",
          en: "I just need the preference tag: more startup, big-company, or flexible?",
        },
        {
          zh: "可以讲细一点, 但结论帮我带上: startup / 大厂 / 都行 哪个更接近?",
          en: "You can add nuance, just include the closest label: startup / big-company / flexible.",
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
 *   - "USA" / "美国"           → "usa"
 *   - "中国" / "PRC"          → "china"
 *   - "Anywhere" / "无所谓"   → "anywhere"
 *   - "in north america"      → ["usa", "canada"] (multi)
 *   - "either USA or China"   → ["usa", "china"] (multi)
 *   - "based in europe but ok with us" (multi-country)
 */
const COUNTRY_EXAMPLES: GuidedOpenJudgeSpec<CountryAnswer>["examples"] = [
  { reply: "USA", value: ["usa"], confidence: 1.0 },
  { reply: "美国", value: ["usa"], confidence: 1.0 },
  { reply: "中国", value: ["china"], confidence: 1.0 },
  { reply: "Anywhere is fine", value: ["anywhere"], confidence: 1.0 },
  { reply: "无所谓", value: ["anywhere"], confidence: 0.95 },
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
    zh: "想找哪个国家/地区的工作? 美国 / 中国 / 加拿大 / 欧洲 / 都行 — 多选也行",
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
        zh: "国家选一下哦: 美国 / 中国 / 加拿大 / 欧洲 / 都行",
        en: "pick a country: USA / China / Canada / Europe / anywhere",
      },
      {
        zh: "再问一遍 — 主要看哪个国家? 一个或多个都行",
        en: "let me ask again — which country are you targeting? one or multiple is fine",
      },
      {
        zh: "美国 / 中国 / 都行 — 给我一个就行",
        en: "USA / China / anywhere — pick one and we move on",
      },
      {
        zh: "你想去哪个国家工作? 写一两个就行",
        en: "what country do you wanna work in? one or two is plenty",
      },
    ],
    fallback: {
      zh: "国家就行: 美国 / 中国 / 都行",
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
 * ("Bay Area", "sfran or nYC works", "Everywhere is fine", "都行").
 */
const LOCATION_EXAMPLES: GuidedOpenJudgeSpec<LocationAnswer>["examples"] = [
  { reply: "Bay Area", value: ["sf", "bay_area"], confidence: 0.95 },
  { reply: "sfran or nYC works", value: ["sf", "nyc"], confidence: 0.9 },
  { reply: "Everywhere is fine", value: ["anywhere"], confidence: 1.0 },
  { reply: "都行", value: ["anywhere"], confidence: 1.0 },
  { reply: "remote", value: ["remote"], confidence: 1.0 },
  { reply: "上海或北京", value: ["shanghai", "beijing"], confidence: 0.95 },
  { reply: "NYC, Boston, or remote", value: ["nyc", "boston", "remote"], confidence: 0.9 },
  { reply: "杭州", value: ["hangzhou"], confidence: 1.0 },
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
            zh: "OK, 在中国的话, 有具体城市或 remote 偏好吗? 上海 / 北京 / 杭州 / 深圳 / 广州 / 都行",
            en: "ok, in China, any city or remote preference? Shanghai / Beijing / Hangzhou / Shenzhen / Guangzhou / anywhere",
          },
          reAsks: [
            {
              zh: "城市说一下: 上海 / 北京 / 杭州 / 深圳 — 一个或多个",
              en: "city please: Shanghai / Beijing / Hangzhou / Shenzhen — one or more",
            },
            {
              zh: "再问一遍 — 哪个城市? '都行' 也可以",
              en: "let me ask again — which city? 'anywhere' works too",
            },
            {
              zh: "一个城市就行, 比如 '上海' / '北京' / '都行'",
              en: "one city is fine, like 'Shanghai' / 'Beijing' / 'anywhere'",
            },
          ],
        }
      : Array.isArray(country) && country.length === 1 && country[0] === "usa"
      ? {
          prompt: {
            zh: "OK, 在美国的话, 有具体城市或 remote 偏好吗? 湾区 / NYC / Seattle / LA / Boston / Chicago / Austin / 都行",
            en: "ok, in the US, any city or remote preference? Bay Area / NYC / Seattle / LA / Boston / Chicago / Austin / anywhere",
          },
          reAsks: [
            {
              zh: "城市说一下: 湾区 / NYC / Seattle / Boston — 一个或多个都行",
              en: "city please: Bay Area / NYC / Seattle / Boston — one or more",
            },
            {
              zh: "再问一遍 — 美国哪边? remote 或 'anywhere' 也行",
              en: "let me ask again — where in the US? remote or 'anywhere' is fine",
            },
            {
              zh: "一个城市就行, 比如 'sf' / 'nyc' / 'remote'",
              en: "one city works, like 'sf' / 'nyc' / 'remote'",
            },
          ],
        }
      : {
          prompt: {
            zh: "OK, 这些国家/地区里有具体城市或 remote 偏好吗? 城市/地区或者 'remote' / '都行' 都行",
            en: "ok, within that country/region, any city or remote preference? a city / region / 'remote' / 'anywhere' all work",
          },
          reAsks: [
            {
              zh: "城市/地区或者 'remote' 都行",
              en: "city / region / or just 'remote' is fine",
            },
            {
              zh: "再问一遍 — 城市 + remote 偏好, 比如 'sf' / '上海' / 'remote'",
              en: "let me ask again — city + remote pref, like 'sf' / 'shanghai' / 'remote'",
            },
            {
              zh: "一个地点就行: 'bay area' / '上海' / 'remote' / 'anywhere'",
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
    }),
    rephraser: new HybridRephraser({
      variants: promptVariants.reAsks,
      fallback: {
        zh: "城市或 'remote' 就行",
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
 *   OPT / CPT / H1B / "需要签证" → sponsorship_needed (per D4)
 *   green card / GC / 绿卡           → permanent_resident
 *   citizen / 公民                   → citizen
 *   "我在美国但身份特殊"             → other
 */
const VISA_EXAMPLES: GuidedOpenJudgeSpec<VisaAnswer>["examples"] = [
  { reply: "citizen", value: "citizen", confidence: 1.0 },
  { reply: "公民", value: "citizen", confidence: 1.0 },
  { reply: "GC", value: "permanent_resident", confidence: 1.0 },
  { reply: "绿卡", value: "permanent_resident", confidence: 1.0 },
  { reply: "I have OPT", value: "sponsorship_needed", confidence: 0.95 },
  { reply: "on H1B", value: "sponsorship_needed", confidence: 0.95 },
  { reply: "CPT student", value: "sponsorship_needed", confidence: 0.9 },
  { reply: "需要 sponsor", value: "sponsorship_needed", confidence: 1.0 },
  { reply: "need sponsorship", value: "sponsorship_needed", confidence: 1.0 },
  { reply: "其他特殊情况", value: "other", confidence: 0.8 },
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

/**
 * Q_VISA — V2 prompt drops "OPT" listing per D4. Internally OPT/CPT/H1B
 * all canonicalize to `sponsorship_needed`, but the prompt asks the
 * three-way (citizen / GC / need sponsorship) so the user isn't
 * confused that "OPT" is a separate visa bucket.
 */
export const Q_VISA: Question<VisaAnswer> = makeQuestion<VisaAnswer>({
  id: "q_visa",
  prompt: {
    zh: "那你工作身份是? 公民 / 绿卡 / 需要 sponsor (含 OPT/CPT/H1B)",
    en: "what's your work auth? citizen / GC / need sponsorship (incl. OPT/CPT/H1B)",
  },
  judge: new GuidedOpenJudge<VisaAnswer>({
    questionLabel: "US work authorization status",
    hints: VISA_HINTS,
    examples: VISA_EXAMPLES,
    parseValue: parseVisaValue,
  }),
  rephraser: new HybridRephraser({
    variants: [
      {
        zh: "选一个就行: 公民 / 绿卡 / 需要 sponsor",
        en: "pick one: citizen / GC / need sponsorship",
      },
      {
        zh: "签证状态大概是哪种? 我列下: 公民、绿卡、要 sponsor (OPT/CPT/H1B 都算这种)",
        en: "what's your status — citizen, GC, or need sponsorship? (OPT/CPT/H1B all count as need sponsorship)",
      },
      {
        zh: "你能在美国合法工作吗? 是哪种身份 — 公民 / 绿卡 / 还是要 sponsor?",
        en: "are you eligible to work in the US? citizen / GC / or need sponsorship?",
      },
      {
        zh: "一个词答下身份吧, 比如 'citizen' / 'gc' / 'need sponsor'",
        en: "one word on your auth — 'citizen' / 'gc' / 'need sponsor'",
      },
    ],
    fallback: {
      zh: "citizen / gc / sponsor — 选一个",
      en: "citizen / gc / sponsor — pick one",
    },
  }),
  haltMessage: HALT_DEFAULT,
})

// ─── ONBOARDING_QUESTIONS_V2 ────────────────────────────────────────────────

/**
 * Deps shape for `defaultQuestionsV2`. Mirrors `DefaultQuestionsDeps` but
 * adds `onCountryAccepted` and reuses the existing accept hooks for
 * email / verify / tos / role / yoe / startup_pref / resume.
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
 *   q_lang → q_email → q_email_verify → q_tos
 *   → q_role → q_yoe → q_visa → q_startup_pref
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
  const { langQ, emailQ, emailVerifyQ, tosQ, resumeQ } = makeClosedQuestions(deps)

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
    langQ,
    emailQ,
    emailVerifyQ,
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
