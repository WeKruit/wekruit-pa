#!/usr/bin/env node
/**
 * v1.9 — seed 4 Handshake-sourced jobs into pa-jobs with realistic
 * prescreenConfig + level1Reveal + publicVisible + descriptionMd.
 *
 * Source URLs (verified content):
 *   - hs_11005382  invoko.ai Product Designer       $80-120K  SF  1-3yr  visa-ok
 *   - hs_11005377  invoko.ai UI/UX Designer         $80-120K  SF  1-3yr  visa-ok
 *   - hs_11005308  paradigm.study GTM & Growth      $90-130K  SF  1-3yr  visa-ok
 *   - hs_10996795  invoko.ai Product Manager        $90-140K  SF  1-3yr  visa-ok
 *
 * Per-job design (PS2 lock + v1.9 hotfix):
 *   - 2 MUST_HAVE Qs each, matchThreshold 0.85 (real LLM rarely 1.0)
 *   - Single keyword per MUST_HAVE Q for clean LLM scoring
 *   - rich `hint` so LLM can disambiguate without aggregation dilution
 *
 * Run:  node scripts/v19-seed-handshake-jobs.mjs
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const PROJECT_ID = "wekruit-5f89b"
const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"))
const tokRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg.tokens.refresh_token,
    grant_type: "refresh_token",
  }),
})
const { access_token } = await tokRes.json()

function v(val) {
  if (val === null) return { nullValue: null }
  if (typeof val === "boolean") return { booleanValue: val }
  if (typeof val === "number") {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val }
  }
  if (typeof val === "string") return { stringValue: val }
  if (Array.isArray(val)) return { arrayValue: { values: val.map(v) } }
  if (typeof val === "object") {
    const out = {}
    for (const [k, vv] of Object.entries(val)) out[k] = v(vv)
    return { mapValue: { fields: out } }
  }
  throw new Error(`unsupported type: ${typeof val}`)
}

// ─────────────────────────────────────────────────────────────────────────
// Job definitions
// ─────────────────────────────────────────────────────────────────────────

const jobs = [
  {
    jobId: "hs-11005382-invoko-product-designer",
    title: "Product Designer",
    company: "invoko.ai",
    location: "San Francisco, CA (Remote-flexible)",
    descriptionMd: `**invoko.ai — Product Designer**
Full-time · California (Remote-flexible) · 1-3 Years Exp · $80-120K/yr

**About Invoko**
Invoko is building AI that connects with people on an emotional level — not another chat interface, not another productivity tool. Something closer to how it feels to get lost in a great game or a world you don't want to leave.

**What you'll own**
- Drive product design across core features — from concept to shippable UI
- Build interactive prototypes fast in Figma / Framer / AI-assisted tools (v0, Cursor, Lovable)
- Own and evolve Invoko's design system — components, tokens, patterns
- Map user journeys: onboarding, engagement hooks, emotional peaks, retention
- Apply game-design sensibility — progression, feedback, reward mechanics

**Who we're looking for**
- 1-3 years product design experience on consumer-facing apps
- Systems thinker with strong visual execution
- Fluent in Figma; excited about AI prototyping tools
- Strong interest in AI / human-AI interaction
- Background or interest in game design / interactive entertainment is a plus
- Ship-iterate mindset

US work authorization required · Visa sponsorship + OPT/CPT eligible`,
    prescreenConfig: {
      version: 1,
      jobTitle: "Product Designer",
      company: "invoko.ai",
      threshold: 0.65,
      confidenceThreshold: 0.7,
      maxClarifyRounds: 2,
      voiceMode: "professional_prescreen",
      level1Reveal: {
        applyUrl: "https://app.joinhandshake.com/public/jobs/11005382",
        salaryRange: "$80-120K/yr",
        nextStepEta: "within 5 business days",
      },
      questions: [
        {
          qId: "q_product_design_experience",
          type: "MUST_HAVE",
          weight: 2,
          matchThreshold: 0.85,
          prompt: {
            en: "Tell me about your product design work — what consumer-facing product have you shipped, and what role did you play?",
            zh: "请讲讲你的产品设计经验 — 你做过什么消费级产品, 担任什么角色?",
          },
          clarifyPrompt: {
            en: "Could you be more specific — which product, what scope of design did you own?",
            zh: "能否更具体 — 哪个产品, 你 own 了哪部分设计?",
          },
          keywords: [
            {
              keyword: "product_design_consumer",
              weight: 1,
              hint: "Has shipped product design (UI/visual/flow) for a real consumer-facing product. Internships count if real user-facing. Side projects only = weaker. Pure brand/print = does not match.",
            },
          ],
        },
        {
          qId: "q_figma_prototyping",
          type: "MUST_HAVE",
          weight: 1,
          matchThreshold: 0.85,
          prompt: {
            en: "How do you prototype your ideas? Comfortable with Figma + something like Framer / v0 / Cursor for interactive prototypes?",
            zh: "你用什么工具做原型? Figma + Framer / v0 / Cursor 这种交互原型工具熟悉吗?",
          },
          clarifyPrompt: {
            en: "What specific prototyping tools have you used end-to-end?",
            zh: "具体用过哪些原型工具完整跑过流程?",
          },
          keywords: [
            {
              keyword: "figma_or_modern_prototyping",
              weight: 1,
              hint: "Fluent in Figma OR modern AI-assisted prototyping (Framer, v0, Cursor, Lovable). Any one of these counts. Sketch/XD-only = weaker but acceptable signal. No interactive prototyping = does not match.",
            },
          ],
        },
      ],
    },
  },
  {
    jobId: "hs-11005377-invoko-ui-ux-designer",
    title: "UI/UX Designer",
    company: "invoko.ai",
    location: "San Francisco, CA (Remote-flexible)",
    descriptionMd: `**invoko.ai — UI/UX Designer**
Full-time · California (Remote-flexible) · 1-3 Years Exp · $80-120K/yr

**About Invoko**
Invoko is building AI that connects with people emotionally — experiences that don't feel like software, they feel alive. We sit at the intersection of entertainment, AI, and human connection, and design is at the absolute core of what makes us different.

**What we're looking for**
- 1-3 years UI/UX experience for consumer products
- Strong visual + interaction design taste
- Comfort with rapid iteration (no 40-slide brand books)
- Fluent in Figma + modern prototyping
- AI / consumer entertainment instincts

US work authorization required · Visa sponsorship + OPT/CPT eligible`,
    prescreenConfig: {
      version: 1,
      jobTitle: "UI/UX Designer",
      company: "invoko.ai",
      threshold: 0.65,
      confidenceThreshold: 0.7,
      maxClarifyRounds: 2,
      voiceMode: "professional_prescreen",
      level1Reveal: {
        applyUrl: "https://app.joinhandshake.com/public/jobs/11005377",
        salaryRange: "$80-120K/yr",
        nextStepEta: "within 5 business days",
      },
      questions: [
        {
          qId: "q_ui_ux_experience",
          type: "MUST_HAVE",
          weight: 2,
          matchThreshold: 0.85,
          prompt: {
            en: "Describe your UI/UX design work — what interface have you shipped for real users?",
            zh: "请讲讲你的 UI/UX 设计经验 — 上过线给真实用户用的界面是什么?",
          },
          clarifyPrompt: {
            en: "Which specific UI / UX projects? What surface did you own?",
            zh: "具体哪些 UI / UX 项目? 你 own 了什么界面?",
          },
          keywords: [
            {
              keyword: "ui_ux_shipped",
              weight: 1,
              hint: "Has shipped UI/UX work for a real product used by real users. Both visual design AND interaction flow count. Strong interaction-only or visual-only is acceptable. Pure illustration / branding without UI = does not match.",
            },
          ],
        },
        {
          qId: "q_rapid_iteration",
          type: "MUST_HAVE",
          weight: 1,
          matchThreshold: 0.85,
          prompt: {
            en: "What's your iteration cadence — comfortable shipping rough prototypes fast and refining vs. waiting for the perfect final design?",
            zh: "你的迭代节奏是? 习惯快速出粗原型再 refine 还是要等 perfect 最终稿?",
          },
          clarifyPrompt: {
            en: "Give a specific example of a fast-iteration workflow you ran.",
            zh: "举一个你跑过的快速迭代流程的例子.",
          },
          keywords: [
            {
              keyword: "rapid_iteration_mindset",
              weight: 1,
              hint: "Demonstrated bias-to-action: ships rough, learns, refines. Mentions short cycles, user feedback loops, willingness to throw work away. Pure 'perfect-from-first-draft' mindset = does not match.",
            },
          ],
        },
      ],
    },
  },
  {
    jobId: "hs-11005308-paradigm-gtm-growth",
    title: "GTM & Growth Marketing Manager",
    company: "paradigm.study",
    location: "San Francisco, CA (Remote-flexible)",
    descriptionMd: `**paradigm.study — GTM & Growth Marketing Manager**
Full-time · California (Remote-flexible) · 1-3 Years Exp · $90-130K/yr

**About Paradigm**
Paradigm is rethinking how people learn — and we need someone to make sure the world knows it. We're looking for a scrappy, digitally native marketer who can build awareness from the ground up: top-of-funnel strategy, social presence, community.

**What you'll own**
- Top-of-funnel awareness from zero to one
- Social media strategy + execution (TikTok, IG, X, threads, Reddit)
- Community building + content
- Paid + organic growth experimentation

**Who we're looking for**
- 1-3 years marketing / growth / content experience
- Scrappy zero-to-one builder (no inherited playbook)
- Digitally native — lives on the platforms you'll market on
- Data-informed but not data-paralyzed

US work authorization required · Visa sponsorship + OPT/CPT eligible`,
    prescreenConfig: {
      version: 1,
      jobTitle: "GTM & Growth Marketing Manager",
      company: "paradigm.study",
      threshold: 0.65,
      confidenceThreshold: 0.7,
      maxClarifyRounds: 2,
      voiceMode: "professional_prescreen",
      level1Reveal: {
        applyUrl: "https://app.joinhandshake.com/public/jobs/11005308",
        salaryRange: "$90-130K/yr",
        nextStepEta: "within 5 business days",
      },
      questions: [
        {
          qId: "q_growth_marketing_experience",
          type: "MUST_HAVE",
          weight: 2,
          matchThreshold: 0.85,
          prompt: {
            en: "Tell me about a growth or marketing campaign you owned — what was the channel, the audience, and what numbers did you move?",
            zh: "请讲一个你 own 过的增长或营销项目 — 用什么渠道, 面向什么用户, 推动了哪些数字?",
          },
          clarifyPrompt: {
            en: "Be more specific — which platform, what experiment, what result?",
            zh: "再具体一点 — 哪个平台, 什么实验, 什么结果?",
          },
          keywords: [
            {
              keyword: "growth_or_marketing_campaign",
              weight: 1,
              hint: "Owned end-to-end a growth/marketing campaign or channel with a measurable outcome. Internships count if real ownership. Social/content/paid/SEO/community all count. Pure 'I helped on a team' without ownership = weak.",
            },
          ],
        },
        {
          qId: "q_scrappy_zero_to_one",
          type: "MUST_HAVE",
          weight: 1,
          matchThreshold: 0.85,
          prompt: {
            en: "Have you ever built something from scratch with no playbook? What did you do when you had to write the playbook yourself?",
            zh: "你有没有过从零开始 build 一个东西, 没有现成 playbook 的经历? 当时怎么搞的?",
          },
          clarifyPrompt: {
            en: "Concrete example — a project where the path wasn't laid out.",
            zh: "举具体例子 — 一个没有现成路径的项目.",
          },
          keywords: [
            {
              keyword: "zero_to_one_builder",
              weight: 1,
              hint: "Has built or shipped something where no prior process / playbook existed. Founder, club president, side project, freelance — all count if it required defining process from scratch. Pure execution-within-rails = weak.",
            },
          ],
        },
      ],
    },
  },
  {
    jobId: "hs-10996795-invoko-product-manager",
    title: "Product Manager",
    company: "invoko.ai",
    location: "San Francisco, CA (Hybrid)",
    descriptionMd: `**invoko.ai — Product Manager (Consumer AI Experience)**
Full-time · California (Hybrid) · $90-140K/yr

**About**
Invoko is building AI that connects with people emotionally — the kind of experience that doesn't feel like a tool, it feels like a presence.

**What you'll own**
- Product strategy + roadmap for consumer AI features
- Tight loop with design + eng (no "write a PRD and hand off")
- User research + qualitative feedback synthesis
- Metric definition + experimentation

**Who we're looking for**
- Consumer product experience (any role — PM / design / eng) on a real consumer app
- Strong qualitative instincts + product taste
- Fluent communicator across design + engineering
- Excited about AI / human-AI interaction
- Ship-shape, no analysis paralysis

US work authorization required · Visa sponsorship + OPT/CPT eligible`,
    prescreenConfig: {
      version: 1,
      jobTitle: "Product Manager",
      company: "invoko.ai",
      threshold: 0.65,
      confidenceThreshold: 0.7,
      maxClarifyRounds: 2,
      voiceMode: "professional_prescreen",
      level1Reveal: {
        applyUrl: "https://app.joinhandshake.com/public/jobs/10996795",
        salaryRange: "$90-140K/yr",
        nextStepEta: "within 5 business days",
      },
      questions: [
        {
          qId: "q_consumer_product_experience",
          type: "MUST_HAVE",
          weight: 2,
          matchThreshold: 0.85,
          prompt: {
            en: "Tell me about consumer product work you've done — PM, design, or eng role on a real user-facing product. What did you ship and what feedback did it drive?",
            zh: "讲讲你在消费级产品上的经验 — PM / 设计 / 开发都行, 上过什么真实用户用的产品, 收到了什么反馈?",
          },
          clarifyPrompt: {
            en: "Which specific consumer product? What was your role and what feedback signal did you act on?",
            zh: "具体哪个消费级产品? 你的角色是什么, 根据什么反馈信号调整了产品?",
          },
          keywords: [
            {
              keyword: "consumer_product_shipping",
              weight: 1,
              hint: "Has shipped (any role) on a real consumer-facing product with real users. PM / design / eng all count. Strong qualitative-feedback signals are a plus. Pure B2B enterprise / internal tools = does not match.",
            },
          ],
        },
        {
          qId: "q_ship_taste",
          type: "MUST_HAVE",
          weight: 1,
          matchThreshold: 0.85,
          prompt: {
            en: "How do you decide what to ship next when you have more ideas than time? Walk me through your prioritization.",
            zh: "如果你想法多过时间, 怎么决定下个迭代 ship 什么? 讲讲你的取舍方法.",
          },
          clarifyPrompt: {
            en: "Specific framework or recent example you've used.",
            zh: "具体框架或最近你用过的例子.",
          },
          keywords: [
            {
              keyword: "prioritization_taste",
              weight: 1,
              hint: "Demonstrates judgment: combines user signal + business value + effort + product taste. Frameworks (RICE, value/effort, opportunity sizing) OR concrete past prioritization examples both count. Pure 'whatever the boss says' = does not match.",
            },
          ],
        },
      ],
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────
// Write each job
// ─────────────────────────────────────────────────────────────────────────

for (const job of jobs) {
  const body = {
    fields: v({
      publicVisible: true,
      title: job.title,
      company: job.company,
      location: job.location,
      descriptionMd: job.descriptionMd,
      prescreenConfig: job.prescreenConfig,
      sourceUrl: job.prescreenConfig.level1Reveal.applyUrl,
      sourcePlatform: "handshake",
      seededAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).mapValue.fields,
  }
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/pa-jobs/${job.jobId}`
  const res = await fetch(url, {
    method: "PATCH",
    headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    console.error(`FAIL ${job.jobId}:`, res.status, await res.text())
    process.exit(1)
  }
  console.log(`✓ ${job.jobId} — ${job.title} @ ${job.company}`)
}

console.log("\n📌 Public URLs:")
for (const j of jobs) {
  console.log(`   https://wekruit-pa.web.app/j/${j.jobId}`)
}
console.log("\n📌 SMS triggers (replace <userId>):")
for (const j of jobs) {
  console.log(`   WeKruit_${j.jobId}_<userId>_Job`)
}
