/**
 * SimUser — drives the OnboardingPipeline by responding to its prompts.
 *
 * Two modes:
 *   - "scripted": consumes persona.scriptedReplies in order. Free, fast,
 *     deterministic. Used by default in CI.
 *   - "llm": calls Qwen-7B (SiliconFlow) with persona.llmSystemPrompt as
 *     system + the pipeline's prompt as user. Costs $, non-deterministic,
 *     more realistic. Enabled via env SIM_USER_MODE=llm.
 *
 * Adam directive 2026-05-05: "你的测试应该使用llm对战llm来测试不同的情况
 * 对吗" — yes. LLM mode IS the goal; scripted mode is the cheap fallback.
 *
 * Usage:
 *   import { loadPersona, SimUser } from "./sim-user.mjs"
 *   const persona = loadPersona("happy")
 *   const sim = new SimUser(persona, { mode: "scripted" })
 *   const reply = await sim.respondTo("Q text from pipeline")
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export function loadPersona(id) {
  const path = join(__dirname, "personas", `${id}.json`)
  const raw = readFileSync(path, "utf8")
  return JSON.parse(raw)
}

const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY ?? ""
const SIM_MODEL = process.env.SIM_USER_MODEL ?? "Qwen/Qwen2.5-7B-Instruct"

export class SimUser {
  constructor(persona, opts = {}) {
    this.persona = persona
    this.mode = opts.mode ?? (SILICONFLOW_API_KEY ? "llm" : "scripted")
    this.scriptedIdx = 0
    this.history = [] // { promptText, reply }
  }

  async respondTo(promptText) {
    let reply
    if (this.mode === "scripted") {
      reply = this._scripted()
    } else {
      reply = await this._llm(promptText)
    }
    this.history.push({ promptText, reply })
    return reply
  }

  _scripted() {
    const replies = this.persona.scriptedReplies ?? []
    if (this.scriptedIdx >= replies.length) {
      // Exhausted scripted replies. Return generic fallback so pipeline
      // can continue ticking (will trigger halt eventually for ghost-style).
      return this.persona.scriptedFallback ?? "嗯"
    }
    const reply = replies[this.scriptedIdx]
    this.scriptedIdx++
    return reply
  }

  async _llm(promptText) {
    if (!SILICONFLOW_API_KEY) {
      throw new Error("[sim-user] LLM mode requires SILICONFLOW_API_KEY env var")
    }
    const messages = [
      { role: "system", content: this.persona.llmSystemPrompt },
      ...this.history.flatMap((h) => [
        { role: "user", content: h.promptText },
        { role: "assistant", content: h.reply },
      ]),
      { role: "user", content: promptText },
    ]
    const res = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SILICONFLOW_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SIM_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 64,
      }),
    })
    if (!res.ok) {
      throw new Error(`[sim-user] LLM HTTP ${res.status}`)
    }
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content?.trim() ?? ""
    if (!text) throw new Error("[sim-user] LLM returned empty")
    return text
  }
}
