/**
 * generate-synthetic.ts — Phase 24 / Plan 02
 *
 * Generates synthetic + adversarial eval fixtures via Qwen/Qwen3-8B on SiliconFlow.
 * Output is JSONL on stdout. Each line includes `tags: ["synthetic", "<mode>"]`
 * and `label: "UNLABELED"`.
 *
 * Usage:
 *   export SILICONFLOW_API_KEY=<key>
 *   pnpm tsx apps/eval/voice/scripts/generate-synthetic.ts --mode vent      > apps/eval/voice/fixtures/synthetic-vent.jsonl
 *   pnpm tsx apps/eval/voice/scripts/generate-synthetic.ts --mode cele      > apps/eval/voice/fixtures/synthetic-cele.jsonl
 *   pnpm tsx apps/eval/voice/scripts/generate-synthetic.ts --mode deflect   > apps/eval/voice/fixtures/synthetic-deflect.jsonl
 *   pnpm tsx apps/eval/voice/scripts/generate-synthetic.ts --mode adversarial > apps/eval/voice/fixtures/adversarial-100.jsonl
 *
 * Model: Qwen/Qwen3-8B on SiliconFlow (free tier, confirmed available 2026-04-27)
 * NOTE: Qwen/Qwen3.5-4B is NOT yet in SiliconFlow catalog — use Qwen3-8B. See 24-RESEARCH.md.
 */

import { parseArgs } from "node:util"
import OpenAI from "openai"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    mode: { type: "string", default: "vent" },
    count: { type: "string" },
  },
})

type Mode = "vent" | "cele" | "deflect" | "adversarial"
const MODE = (values.mode ?? "vent") as Mode
const COUNT_DEFAULT: Record<Mode, number> = { vent: 10, cele: 10, deflect: 10, adversarial: 100 }
const COUNT = parseInt(values.count ?? String(COUNT_DEFAULT[MODE] ?? 10), 10)

// ---------------------------------------------------------------------------
// SiliconFlow client (OpenAI-compatible)
// ---------------------------------------------------------------------------
const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY
if (!SILICONFLOW_KEY) {
  process.stderr.write("[generate-synthetic] ERROR: SILICONFLOW_API_KEY not set\n")
  process.exit(1)
}

const sf = new OpenAI({
  apiKey: SILICONFLOW_KEY,
  baseURL: "https://api.siliconflow.cn/v1",
})

const MODEL = "Qwen/Qwen3-8B"

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------
const SYSTEM_CONTEXT = `You are helping generate test cases for a Chinese-English bilingual job companion chatbot named Claire/小柯.
Claire is a Bay Area EM who texts like a friend — short, code-switched zh/en, never coach-mode.
Generate realistic user messages that Claire would receive. One message per line, no numbering, no explanations.`

const MODE_PROMPTS: Record<Mode, string> = {
  vent: `Generate ${COUNT} realistic user messages from Chinese job seekers who are venting frustration, anxiety, or exhaustion.
Mix zh/en. Examples: workplace stress, job hunting rejection, long hours, imposter syndrome.
Topics: 卷/累/焦虑/offer被拒/面试失败/被裁/烦透了/996/想躺平.
One message per line. Be authentic — these should sound like real iMessages, not sanitized examples.`,

  cele: `Generate ${COUNT} realistic user messages from Chinese job seekers celebrating good news.
Mix zh/en. Examples: got offer, passed interview, salary negotiation win, promotion.
Topics: 拿到offer/通过面试/涨薪/晋升/入职/终于搞定了.
One message per line. Vary the enthusiasm level — some excited, some understated.`,

  deflect: `Generate ${COUNT} realistic user messages where the user deflects, is avoidant, or changes subject.
Mix zh/en. Examples: saying they don't want to talk, being vague, pivoting away from the topic.
Topics: 算了/随便/没事了/不聊了/forget it/whatever/懒得想了/管他呢.
One message per line.`,

  adversarial: `Generate ${COUNT} user messages that would tempt an AI to give coach-mode advice.
These are messages where a naive AI would respond with numbered steps, "我建议你", "你应该", or lengthy advice.
Examples: asking for career advice, job search strategy, how to deal with a difficult manager, what to put on resume.
Mix zh/en. Keep messages realistic — real iMessage length, not long paragraphs.
One message per line. No numbering.`,
}

// ---------------------------------------------------------------------------
// Claire production prompt (simplified baseline for assistant turn generation)
// ---------------------------------------------------------------------------
const CLAIRE_SYSTEM = `You are Claire/小柯, a Bay Area engineering manager texting a friend over iMessage.
Rules: ≤2 sentences; no markdown; no numbered steps; no "我建议你/你应该/首先"; code-switch zh/en like user does;
at most 1 emoji 💀>😭>🥲 NEVER 😂; vent→sit-with, celebrate→hype, question→straight answer.`

// ---------------------------------------------------------------------------
// Generate user messages
// ---------------------------------------------------------------------------
async function generateUserMessages(mode: Mode, count: number): Promise<string[]> {
  process.stderr.write(`[generate-synthetic] Generating ${count} ${mode} user messages via ${MODEL}\n`)

  const resp = await sf.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_CONTEXT },
      { role: "user", content: MODE_PROMPTS[mode] },
    ],
    temperature: 0.9,
    max_tokens: count * 80,
  })

  const raw = resp.choices[0]?.message?.content ?? ""
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && !l.match(/^\d+[\.\)]/))
    .slice(0, count)

  if (lines.length < count) {
    process.stderr.write(
      `[generate-synthetic] Warning: only got ${lines.length}/${count} messages\n`
    )
  }

  return lines
}

// ---------------------------------------------------------------------------
// Generate candidate Claire reply for a user message
// ---------------------------------------------------------------------------
async function generateClaireReply(userMsg: string): Promise<string> {
  const resp = await sf.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: CLAIRE_SYSTEM },
      { role: "user", content: userMsg },
    ],
    temperature: 0.7,
    max_tokens: 120,
  })
  return resp.choices[0]?.message?.content?.trim() ?? ""
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const userMessages = await generateUserMessages(MODE, COUNT)
  const today = new Date().toISOString().slice(0, 10)

  for (let i = 0; i < userMessages.length; i++) {
    const userMsg = userMessages[i]
    if (!userMsg) continue

    process.stderr.write(`[generate-synthetic] Generating reply ${i + 1}/${userMessages.length}\r`)

    let assistantMsg = ""
    try {
      assistantMsg = await generateClaireReply(userMsg)
    } catch (err) {
      process.stderr.write(`\n[generate-synthetic] Reply generation failed for msg ${i}: ${err}\n`)
      assistantMsg = ""
    }

    const id = `synthetic-${MODE}-${String(i + 1).padStart(3, "0")}`
    const row = {
      id,
      context: [],
      turns: [
        { role: "user", content: userMsg },
        { role: "assistant", content: assistantMsg },
      ],
      label: "UNLABELED",
      why: "",
      tags: ["synthetic", MODE],
      verified_at: today,
    }
    process.stdout.write(JSON.stringify(row) + "\n")

    // Brief pause to respect rate limits on free tier
    await new Promise((r) => setTimeout(r, 200))
  }

  process.stderr.write("\n[generate-synthetic] Done\n")
}

main().catch((err) => {
  process.stderr.write(`[generate-synthetic] Fatal: ${err}\n`)
  process.exit(1)
})
