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
    const zh = AI_AGENT_HOT_SKILLS_2026.zh.join(" | ")
    const en = AI_AGENT_HOT_SKILLS_2026.en.join(" | ")
    assert.match(zh, /RAG/)
    assert.match(zh, /function calling|tool calling/)
    assert.match(zh, /工作流编排/)
    assert.match(zh, /多轮.*?状态/)
    assert.match(zh, /agentic/)
    assert.match(zh, /LangChain/)
    assert.match(zh, /vector database/)
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
    assert.match(PM_HOT_SKILLS_2026.zh.join(" "), /AB 测试|GTM/)
    assert.match(SWE_HOT_SKILLS_2026.en.join(" "), /distributed systems|system design/i)
  })
})

describe("detectJobMarketRole — high-signal role detection", () => {
  it("returns ai_agent on explicit AI agent / RAG / LangChain keywords", () => {
    assert.equal(detectJobMarketRole("AI agent 开发, 哪些你觉得我有"), "ai_agent")
    assert.equal(detectJobMarketRole("looking for an AI agent role"), "ai_agent")
    assert.equal(detectJobMarketRole("I work with RAG and tool calling"), "ai_agent")
    assert.equal(detectJobMarketRole("LangChain LlamaIndex 这块都做过"), "ai_agent")
    assert.equal(detectJobMarketRole("agentic workflow engineer"), "ai_agent")
    assert.equal(detectJobMarketRole("大模型应用工程师"), "ai_agent")
  })

  it("returns pm on explicit PM / 产品经理 keywords", () => {
    assert.equal(detectJobMarketRole("我是产品经理"), "pm")
    assert.equal(detectJobMarketRole("looking for a Product Manager role"), "pm")
    assert.equal(detectJobMarketRole("growth pm role at series B"), "pm")
  })

  it("returns swe on explicit SWE / 软件工程师 keywords", () => {
    assert.equal(detectJobMarketRole("software engineer position"), "swe")
    assert.equal(detectJobMarketRole("我是软件工程师"), "swe")
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
    assert.equal(detectJobMarketRole("今天天气真好"), null)
  })
})

describe("buildHarnessPrompt — rendered section quality", () => {
  it("ai_agent zh block lists the actual hot skills + warns Python ≠ match", () => {
    const block = buildHarnessPrompt("ai_agent", "zh")
    assert.match(block, /## JOB MARKET CONTEXT \(2026\)/)
    assert.match(block, /RAG/)
    assert.match(block, /tool calling/)
    assert.match(block, /工作流编排/)
    assert.match(block, /agentic/)
    // Adam spec: "Python alone is not a match"
    assert.match(block, /Python/)
    assert.match(block, /不算真 match|必要不充分/)
  })

  it("ai_agent en block lists the actual hot skills + warns Python ≠ match", () => {
    const block = buildHarnessPrompt("ai_agent", "en")
    assert.match(block, /JOB MARKET CONTEXT \(2026\)/)
    assert.match(block, /RAG/)
    assert.match(block, /function\/tool calling|tool calling/)
    assert.match(block, /workflow orchestration/)
    assert.match(block, /Python/)
    assert.match(block, /not.*?(real match|sufficient)/i)
  })

  it("pm + swe blocks render distinct labels", () => {
    const pmBlock = buildHarnessPrompt("pm", "zh")
    const sweBlock = buildHarnessPrompt("swe", "zh")
    assert.match(pmBlock, /产品经理|PM/)
    assert.match(sweBlock, /软件工程师|SWE/)
    // Cross-contamination check — pm block should NOT name swe-only keywords.
    assert.doesNotMatch(pmBlock, /distributed systems|on-call/)
    assert.doesNotMatch(sweBlock, /AB 测试|GTM/)
  })
})

describe("appendJobMarketKnowledgeToSystemPrompt — wire-in shape (mirrors appendCvContextToSystemPrompt)", () => {
  const BASE = "You are Claire. Be warm.\n"

  it("user asks 'AI agent 开发, 哪些我有' → system prompt now contains RAG + tool calling", () => {
    const out = appendJobMarketKnowledgeToSystemPrompt(BASE, {
      userMessage: "AI agent 开发, 哪些你觉得我有",
      lang: "zh",
    })
    assert.notEqual(out, BASE, "must inject for explicit AI agent ask")
    assert.match(out, /JOB MARKET CONTEXT/)
    assert.match(out, /RAG/)
    assert.match(out, /tool calling/)
    assert.match(out, /工作流编排/)
    assert.ok(out.startsWith(BASE.trimEnd()), "must preserve original prompt verbatim at head")
  })

  it("user message has no role keyword → system prompt unchanged (clean prompt)", () => {
    const out = appendJobMarketKnowledgeToSystemPrompt(BASE, {
      userMessage: "今天天气真好",
      lang: "zh",
    })
    assert.equal(out, BASE)
  })

  it("statedTargetRoles fallback fires when userMessage is generic", () => {
    const out = appendJobMarketKnowledgeToSystemPrompt(BASE, {
      userMessage: "嗯嗯",
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
