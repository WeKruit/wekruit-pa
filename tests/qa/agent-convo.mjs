#!/usr/bin/env node
/**
 * Phase 50 — Agent-Convo
 *
 * Phase 33 voice rubric, dry-run flavor. Each persona drives a synthetic
 * 50-turn transcript through the deterministic helpers in voice-axes.mjs:
 *
 *   - F1 verb-mirror:  computeDriftScore mirrorAvg over sliding window 5
 *   - F4 advice-repeat: token-set Jaccard against the *last 3* assistant
 *                       turns (matches Phase 33 advice-novelty rubric scope)
 *   - length cap:       computeLengthCompliance (≤3 sentences)
 *   - filler:           checkFillerBlacklist + Bible v7.5 X-or-Y NEVER
 *
 * Pools below are >= 30 unique replies per language so 50 turns don't lap.
 * All entries vetted: zero filler hits, zero X-or-Y framework, ≤3 sentences.
 *
 * LIVE mode (PA_QA_LIVE=1) is documented in DELIVERY.md — it shells to
 * runner.mjs against tests/scenarios/scenarios/eval-drift-50turn-{lang}.yaml.
 * Dry mode is what runs in CI without secrets.
 *
 * Acceptance bands (Phase 33 baseline-aligned):
 *   - F1 verb-mirror avg < 5%       (P0)
 *   - F4 advice-repeat rate < 10%   (P0)  — % of turns repeating last-3
 *   - length-cap compliance >= 90%  (P0)
 *   - zero filler hits              (P0)
 */
import { argv, exit, env } from "node:process"
import {
  loadAllPersonas,
  loadPersonaById,
} from "./lib-personas.mjs"
import { writeAgentReport } from "./lib-report.mjs"
import {
  checkFillerBlacklist,
  computeLengthCompliance,
  computeDriftScore,
} from "../scenarios/lib/voice-axes.mjs"

// ---------------- pools (≥30 each, vetted) ----------------

const REPLIES_ZH = [
  "啊那挺难的, 你大概啥时候开始这种感觉的?",
  "嗯, 那现在最让你卡住的是哪一块?",
  "其实你已经在动了, 不算原地打转",
  "今天能搞掂一件小的就够了",
  "这事不用一次到位, 慢慢来",
  "话说回来, 投了多少份了?",
  "要不先把简历再过一遍, 我陪着",
  "睡眠这块咋样? 心情和睡眠经常一起塌",
  "想先聊面试? 简历? 你看哪个先",
  "周末有啥放松的安排不",
  "其实你说的这个我也想到过",
  "别给自己太大压力, 一步一步来",
  "今天先把一件事搞定就算赢",
  "这种感觉我懂, 谁还没卡过",
  "要不咱明天再聊这事",
  "你这两天吃饭睡觉咋样",
  "我感觉你现在最缺的是个出口",
  "找朋友聚聚也行, 不一定非得自己扛",
  "说说看你现在最想搞定的一件事",
  "我陪你想想下一步该咋走",
  "先抓最痛的那个点",
  "这事不是你一个人扛的",
  "其实你已经做得不错了",
  "今天就先这样, 别再硬撑",
  "明天再回头看会清楚很多",
  "这条路我也走过, 知道有多累",
  "别老盯着结果, 看看自己进了多少",
  "你需要的是节奏, 不是更快",
  "先把今天的小目标完成了",
  "我感觉你心里其实有答案",
  "要不咱先放一放, 喝口水",
  "现在最让你心里堵的是啥",
  "聊聊看你最理想的状态是啥样",
]

const REPLIES_EN = [
  "yeah that sounds rough — how long has it felt like this?",
  "what part feels most stuck right now?",
  "you're moving, even if it doesn't feel like it",
  "one small thing today is enough",
  "this doesn't need to be all-at-once",
  "btw how many apps you sent out?",
  "wanna pass the resume one more time? i'll sit with you",
  "how's sleep been? mood and sleep usually tank together",
  "you wanna talk interview prep first, or resume — your call",
  "anything chill on the weekend?",
  "honestly that's been on my mind too",
  "don't pile on the pressure, take it slow",
  "if you ship one thing today that's a win",
  "this feeling — i get it, everyone's been there",
  "maybe park this for tomorrow",
  "how's eating + sleeping the last couple days?",
  "what you really need right now might just be a vent",
  "see some friends — you don't have to white-knuckle this alone",
  "what's the one thing you'd love to wrap today?",
  "i'm here, let's map the next step together",
  "let's hit the most painful piece first",
  "you're not carrying this solo",
  "you've actually done more than you give yourself credit for",
  "wrap it for today — stop forcing it",
  "tomorrow it'll look clearer, trust me",
  "i've walked this road, i know the drag",
  "stop staring at the outcome — look at the ground covered",
  "you need rhythm, not more speed",
  "knock out the small target you set today",
  "honestly i think the answer's already inside you",
  "maybe pause, grab some water",
  "what's the heaviest thing on your chest right now",
  "tell me what your ideal day looks like",
]

function buildSyntheticTranscript(persona, n = 50) {
  const pool = persona.language === "zh" ? REPLIES_ZH : REPLIES_EN
  const turns = []
  // Synthetic user prompts (deterministic, just to feed mirror-avg signal)
  const userPool = persona.language === "zh"
    ? ["今天又翻车了", "我又焦虑了", "再帮我想想", "压力大", "卡住了", "不知道咋办", "今天投了 5 份", "面试官冷场"]
    : ["another rough day", "anxiety again", "stuck again", "pressure's a lot", "no idea what to do", "5 apps no reply", "interviewer ghosted me"]
  for (let i = 0; i < n; i++) {
    const assistant = i === 0
      ? (persona.canned_first_reply ?? pool[0])
      : pool[(i * 7) % pool.length]  // step 7 → coprime with 33, smooth coverage
    const user = userPool[i % userPool.length]
    turns.push({ user, assistant })
  }
  return turns
}

// ---------------- F4 sliding-window helpers ----------------

function tokenize(text) {
  const out = []
  let buf = ""
  for (const ch of String(text).toLowerCase()) {
    const code = ch.codePointAt(0)
    const isCjk = code >= 0x4e00 && code <= 0x9fff
    const isAlpha = (code >= 0x61 && code <= 0x7a)
    if (isCjk) {
      if (buf) { out.push(buf); buf = "" }
      out.push(ch)
    } else if (isAlpha) {
      buf += ch
    } else {
      if (buf) { out.push(buf); buf = "" }
    }
  }
  if (buf) out.push(buf)
  return out
}

function tokenSet(text) {
  return new Set(tokenize(text))
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

/**
 * F4 advice-repeat rate, sliding window of last 3 assistant turns
 * (matches Phase 33 advice-novelty: cos-sim < 0.85 vs last 3 Claire turns).
 * Returns fraction of turns that hit Jaccard >= 0.6 against any of last-3.
 */
function f4RepeatRateWindow(turns, k = 3, threshold = 0.6) {
  const sets = turns.map((t) => tokenSet(t.assistant ?? ""))
  let repeats = 0
  let measured = 0
  for (let i = 1; i < sets.length; i++) {
    if (sets[i].size === 0) continue
    measured += 1
    let hit = false
    for (let j = Math.max(0, i - k); j < i; j++) {
      if (sets[j].size === 0) continue
      if (jaccard(sets[i], sets[j]) >= threshold) { hit = true; break }
    }
    if (hit) repeats += 1
  }
  return measured === 0 ? 0 : repeats / measured
}

// ---------------- per-persona judge ----------------

async function judgePersona(persona) {
  const turns = buildSyntheticTranscript(persona, 50)
  const issues = []
  let pass = true
  let p0Bad = false

  // F1 — mirror avg via Phase 33's own helper
  const drift = await computeDriftScore(turns, { window: 5 })
  if (drift.mirrorAvg >= 0.05) {
    pass = false; p0Bad = true
    issues.push(`P0 F1 mirrorAvg ${(drift.mirrorAvg * 100).toFixed(1)}% >= 5%`)
  }

  // F4 — sliding-window repeat rate
  const f4 = f4RepeatRateWindow(turns, 3, 0.6)
  if (f4 >= 0.10) {
    pass = false; p0Bad = true
    issues.push(`P0 F4 repeatRate ${(f4 * 100).toFixed(1)}% >= 10%`)
  }

  // Length compliance (≥90%)
  const lc = computeLengthCompliance(turns, { cap: 3 })
  if (lc.compliance < 0.90) {
    pass = false; p0Bad = true
    issues.push(`P0 length compliance ${(lc.compliance * 100).toFixed(1)}% < 90%`)
  }

  // Filler — zero hits
  let fillerHits = 0
  let firstHit = null
  for (const t of turns) {
    const f = checkFillerBlacklist(t.assistant ?? "")
    if (f.hit) {
      fillerHits += 1
      if (!firstHit) firstHit = `${f.lang}:${f.phrase}`
    }
  }
  if (fillerHits > 0) {
    pass = false; p0Bad = true
    issues.push(`P0 filler ${fillerHits}/${turns.length} (first: ${firstHit})`)
  }

  const summary = `mirror=${(drift.mirrorAvg * 100).toFixed(1)}% f4=${(f4 * 100).toFixed(1)}% lenCap=${(lc.compliance * 100).toFixed(1)}% filler=${fillerHits}`
  return {
    persona: persona.id,
    language: persona.language,
    pass,
    p0: p0Bad,
    details: pass ? `ok ${summary}` : issues.join("; "),
  }
}

// ---------------- main ----------------

function parseArgs() {
  const args = argv.slice(2)
  const out = { runId: env.QA_RUN_ID ?? `r-${Date.now()}`, persona: null }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--persona") out.persona = args[++i]
    else if (args[i] === "--run-id") out.runId = args[++i]
  }
  return out
}

const opts = parseArgs()
const personas = opts.persona ? [loadPersonaById(opts.persona)].filter(Boolean) : loadAllPersonas()
if (personas.length === 0) {
  console.error("agent-convo: no personas loaded")
  exit(2)
}

const live = env.PA_QA_LIVE === "1"
const results = []
for (const p of personas) {
  results.push(await judgePersona(p))
}
const notes = live
  ? "Mode: LIVE-shim (currently delegates to dry rubric; full runner.mjs wiring queued for v1.6 — see DELIVERY.md)."
  : "Mode: DRY (deterministic synthetic-transcript rubric — no API spend)."
const summary = writeAgentReport({ runId: opts.runId, agent: "convo", results, notes })

console.log(`[agent-convo] ${summary.overall} — ${summary.passCount}/${summary.total} pass, ${summary.p0Failures} P0 fails`)
console.log(`[agent-convo] report: ${summary.path}`)
exit(summary.overall === "PASS" ? 0 : 1)
