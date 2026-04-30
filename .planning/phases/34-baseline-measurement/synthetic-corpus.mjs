// Phase 34 — synthetic 50-turn drift chains.
//
// Real production scenarios are 1-3 turns each. Drift surfaces at 50-turn
// windows. This builds programmatic echo chains by repeating user-prompt
// patterns from existing smoke fixtures with mock-Claire responses that
// represent CURRENT BIBLE BEHAVIOR baseline (verb-mirror tendency,
// length-escalation tendency under user pressure).
//
// Synthetic = deterministic, no LLM cost. Numbers are baseline preview;
// follow-up T4 (post-Adam-approval) replays against real Bible v7.4 via
// pairwise-runner.mjs to validate.

const ZH_PERSONAS = [
  {
    id: "anxious-grad-zh-50turn",
    persona: "anxious_grad_zh",
    userTemplate: [
      "今天面试又翻车了, 真的好累",
      "我又焦虑了, 想吐",
      "为什么我连 onsite 都过不了",
      "再帮我想想怎么改简历",
      "面试官问我 system design 我直接卡壳",
      "我是不是不该做这行",
      "spring 还有 3 个月就毕业了",
      "GPA 不到 3.5 怎么办",
      "STEM-OPT 申请要不要找律师",
      "今天又被 reject 了",
    ],
    // Mock current-Bible Claire: tends to verb-mirror + repeat advice
    assistantPattern: [
      "听起来真的累炸. 今天能歇就歇.",
      "唉. 焦虑的时候先停一下.",
      "onsite 过不了不是你不行. 多准备 system design.",
      "简历改这几点: 量化结果 + 删冗余 + 加 keyword.",
      "卡壳很正常. 多刷 LeetCode 高频. 多说出声.",
      "你不是不该做这行. 行业本来就累.",
      "3 个月够了. 每天刷 1 道 medium + 1 个 system design.",
      "GPA 不到 3.5 可以靠项目补. 突出 impact.",
      "STEM-OPT 自己填就行. 律师没必要.",
      "Reject 不是你的问题. 多投, 概率游戏.",
    ],
  },
  {
    id: "venting-zh-50turn",
    persona: "venting_zh",
    userTemplate: [
      "心累了, 不想说话",
      "今天又被老板骂",
      "明天还要加班到深夜",
      "我室友又在吵",
      "工资发了一半",
      "组里换了 PM, 又要重做",
      "面试通知来了, 但日子撞了",
      "周末加班赶 deadline",
      "想辞职但不敢",
      "今天连水都没喝",
    ],
    // Mock current-Bible: empathy-heavy but tends to advice-repeat
    assistantPattern: [
      "嗯, 那就先安静一下.",
      "被骂太烦了. 老板的事先放放.",
      "深夜加班. 先吃饭再说.",
      "室友吵. 戴耳机或者出门走走.",
      "工资一半? 找 HR 问清楚.",
      "PM 换了又重做. 真的烦.",
      "时间撞了. 看哪个更重要.",
      "周末赶 deadline. 周一晚上能补觉.",
      "辞职怕断现金流可以. 先骑驴找马.",
      "连水都没喝. 现在去倒一杯.",
    ],
  },
  {
    id: "tech-deep-en-50turn",
    persona: "tech_deep_en",
    userTemplate: [
      "how does an OPT to H1B transition actually work",
      "what's the H1B lottery timeline this year",
      "should I take the offer at startup A or big-tech B",
      "salary negotiation tips for L4 SWE",
      "how to ask for sponsorship in interview",
      "is FAANG worth it right now",
      "TPM vs SWE which has better growth",
      "remote work in Seattle vs NYC trade-off",
      "how to prep for system design at staff level",
      "behavioral interview red flags to avoid",
    ],
    assistantPattern: [
      "OPT runs 12 months, STEM-OPT adds 24. H1B lottery in March. Sponsorship before OPT clock runs out.",
      "Lottery registration mid-March, results late March. Cap-subject petitions due April-June.",
      "Startup vs big-tech: equity upside vs stability. Look at runway, not just title.",
      "L4 SWE base $180k-220k bay. Negotiate equity refresh + sign-on harder than base.",
      "Ask in screen call: 'what's your sponsorship track record?' Don't wait until offer stage.",
      "FAANG worth it for resume + comp + scope. Burn rate matters more.",
      "TPM = breadth, SWE = depth. Growth depends on org, not title.",
      "Seattle = no state tax + lower cost. NYC = higher base + denser network.",
      "Staff system design: cross-team trade-offs, ROI framing, escalation paths.",
      "Behavioral red flags: 'we're a family', 'wear many hats', 'flat structure no titles'.",
    ],
  },
]

/**
 * Build a 50-turn chain by tiling the 10-turn pattern 5x.
 * The repetition is the POINT — surfaces verb-mirror and advice-repeat
 * tendencies of CURRENT bible behavior.
 */
function tile50(persona) {
  const out = []
  for (let cycle = 0; cycle < 5; cycle += 1) {
    for (let i = 0; i < persona.userTemplate.length; i += 1) {
      out.push({
        user: persona.userTemplate[i],
        assistant: persona.assistantPattern[i],
        cycle,
        baseIdx: i,
      })
    }
  }
  return out
}

export function buildSyntheticCorpus() {
  return ZH_PERSONAS.map((p) => ({
    id: p.id,
    persona: p.persona,
    turns: tile50(p),
    note: "Synthetic 50-turn chain via 10-turn pattern × 5 cycles. Mock-Claire = current Bible v7.4 behavior preview, NOT real LLM output.",
  }))
}

export const SYNTHETIC_PERSONA_COUNT = ZH_PERSONAS.length

if (import.meta.url === `file://${process.argv[1]}`) {
  const corpus = buildSyntheticCorpus()
  console.log(`Synthetic corpus: ${corpus.length} personas, ${corpus.reduce((s, p) => s + p.turns.length, 0)} turns total`)
  for (const p of corpus) {
    console.log(`  ${p.id}: ${p.turns.length} turns`)
  }
}
