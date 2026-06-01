import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  AI_AGENT_HOT_SKILLS_2026,
  PM_HOT_SKILLS_2026,
  SWE_HOT_SKILLS_2026,
  appendJobMarketKnowledgeToSystemPrompt,
  buildHarnessPrompt,
  detectJobMarketRole,
} from "./job-market-knowledge.js"

describe("job-market-knowledge — exported skill banks (Adam spec: indisputable hot skills only)", () => {
  it("AI_AGENT_HOT_SKILLS_2026 contains the indisputable 2026 keywords", () => {
    // Legacy `zh` key mirrors `en` (product is English-only).
    const zh = AI_AGENT_HOT_SKILLS_2026.zh.join(" | ")
    const en = AI_AGENT_HOT_SKILLS_2026.en.join(" | ")
    assert.match(zh, /RAG/)
    assert.match(zh, /tool calling/)
    assert.match(zh, /workflow orchestration/)
    assert.match(zh, /multi-turn state/)
    assert.match(zh, /agentic/)
    assert.match(zh, /LangChain/)
    assert.match(zh, /vector databases/)
    assert.match(en, /RAG/)
    assert.match(en, /function\/tool calling/)
    assert.match(en, /workflow orchestration/)
    assert.match(en, /multi-turn state/)
    assert.match(en, /agentic/)
    assert.match(en, /LangChain/)
  })

  it("PM and SWE hot-skills banks exist + are non-empty", () => {
    assert.ok(PM_HOT_SKILLS_2026.zh.length > 0 && PM_HOT_SKILLS_2026.en.length > 0)
    assert.ok(SWE_HOT_SKILLS_2026.zh.length > 0 && SWE_HOT_SKILLS_2026.en.length > 0)
    assert.match(PM_HOT_SKILLS_2026.en.join(" "), /A\/B testing|GTM/)
    assert.match(SWE_HOT_SKILLS_2026.en.join(" "), /distributed systems|system design/i)
  })
})

describe("detectJobMarketRole — high-signal role detection", () => {
  it("returns ai_agent on explicit AI agent / RAG / LangChain keywords", () => {
    assert.equal(detectJobMarketRole("AI agent dev, which of these do you think I have"), "ai_agent")
    assert.equal(detectJobMarketRole("looking for an AI agent role"), "ai_agent")
    assert.equal(detectJobMarketRole("I work with RAG and tool calling"), "ai_agent")
    assert.equal(detectJobMarketRole("did a lot of LangChain LlamaIndex work"), "ai_agent")
    assert.equal(detectJobMarketRole("agentic workflow engineer"), "ai_agent")
    assert.equal(detectJobMarketRole("llm application engineer"), "ai_agent")
  })

  it("returns pm on explicit Product Manager keywords", () => {
    assert.equal(detectJobMarketRole("I'm a product manager"), "pm")
    assert.equal(detectJobMarketRole("looking for a Product Manager role"), "pm")
    assert.equal(detectJobMarketRole("growth pm role at series B"), "pm")
  })

  it("returns swe on explicit software engineer keywords", () => {
    assert.equal(detectJobMarketRole("software engineer position"), "swe")
    assert.equal(detectJobMarketRole("I'm a backend engineer"), "swe")
    assert.equal(detectJobMarketRole("backend engineer at startup"), "swe")
  })

  it("returns null for ambiguous / casual chat (false-negative friendly)", () => {
    // Generic "engineer" alone — could be civil engineer, mech engineer, etc.
    assert.equal(detectJobMarketRole("I'm an engineer"), null)
    // Bare "AI" — could be small talk about ChatGPT.
    assert.equal(detectJobMarketRole("AI is interesting"), null)
    // Empty / nullish.
    assert.equal(detectJobMarketRole(""), null)
    assert.equal(detectJobMarketRole(null), null)
    assert.equal(detectJobMarketRole(undefined), null)
    // Off-topic chat.
    assert.equal(detectJobMarketRole("the weather is really nice today"), null)
  })
})

describe("buildHarnessPrompt — rendered section quality", () => {
  it("ai_agent block lists the actual hot skills + warns Python ≠ match", () => {
    const block = buildHarnessPrompt("ai_agent", "en")
    assert.match(block, /## JOB MARKET CONTEXT \(2026\)/)
    assert.match(block, /RAG/)
    assert.match(block, /tool calling/)
    assert.match(block, /workflow orchestration/)
    assert.match(block, /agentic/)
    // Adam spec: "Python alone is not a match"
    assert.match(block, /Python/)
    assert.match(block, /not.*?(real match|sufficient)/i)
  })

  it("buildHarnessPrompt renders English even when legacy zh lang passed", () => {
    const block = buildHarnessPrompt("ai_agent", "zh")
    assert.ok(!/[一-鿿]/.test(block), `expected English-only block, got: ${block}`)
    assert.match(block, /JOB MARKET CONTEXT \(2026\)/)
    assert.match(block, /RAG/)
  })

  it("pm + swe blocks render distinct labels", () => {
    const pmBlock = buildHarnessPrompt("pm", "en")
    const sweBlock = buildHarnessPrompt("swe", "en")
    assert.match(pmBlock, /Product Manager|PM/)
    assert.match(sweBlock, /Software Engineer|SWE/)
    // Cross-contamination check — pm block should NOT name swe-only keywords.
    assert.doesNotMatch(pmBlock, /distributed systems|on-call/)
    assert.doesNotMatch(sweBlock, /A\/B testing|GTM/)
  })
})

describe("appendJobMarketKnowledgeToSystemPrompt — wire-in shape (mirrors appendCvContextToSystemPrompt)", () => {
  const BASE = "You are Claire. Be warm.\n"

  it("user asks about AI agent skills → system prompt now contains RAG + tool calling", () => {
    const out = appendJobMarketKnowledgeToSystemPrompt(BASE, {
      userMessage: "AI agent dev, which of these do you think I have",
      lang: "en",
    })
    assert.notEqual(out, BASE, "must inject for explicit AI agent ask")
    assert.match(out, /JOB MARKET CONTEXT/)
    assert.match(out, /RAG/)
    assert.match(out, /tool calling/)
    assert.match(out, /workflow orchestration/)
    assert.ok(out.startsWith(BASE.trimEnd()), "must preserve original prompt verbatim at head")
  })

  it("user message has no role keyword → system prompt unchanged (clean prompt)", () => {
    const out = appendJobMarketKnowledgeToSystemPrompt(BASE, {
      userMessage: "the weather is really nice today",
      lang: "en",
    })
    assert.equal(out, BASE)
  })

  it("statedTargetRoles fallback fires when userMessage is generic", () => {
    const out = appendJobMarketKnowledgeToSystemPrompt(BASE, {
      userMessage: "yeah yeah",
      statedTargetRoles: ["AI agent engineer"],
      lang: "en",
    })
    assert.match(out, /JOB MARKET CONTEXT/)
    assert.match(out, /RAG/)
  })

  it("absent signals → systemPrompt unchanged (defensive)", () => {
    const out = appendJobMarketKnowledgeToSystemPrompt(BASE, {})
    assert.equal(out, BASE)
  })

  it("never throws on weird inputs (defensive)", () => {
    // Should NOT throw and should NOT inject.
    const out = appendJobMarketKnowledgeToSystemPrompt(BASE, {
      userMessage: undefined,
      statedTargetRoles: undefined,
    })
    assert.equal(out, BASE)
  })
})
