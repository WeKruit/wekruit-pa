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
}

const HALT_DEFAULT: BilingualText = {
  zh: "请联系 admin1@wekruit.com 解决问题. 你现在连续失败了五次, 请不要继续",
  en: "please contact admin1@wekruit.com — you've failed 5 times in a row, please stop",
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
          zh: "公司规模偏好? 早期 startup / 中型 / 大厂 — 哪个更合你?",
          en: "company size preference — early startup / mid / bigco — which fits?",
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
