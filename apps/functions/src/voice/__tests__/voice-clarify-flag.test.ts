import { test } from "node:test"
import assert from "node:assert/strict"
import { makeProductionClarifyComposer } from "../../prescreen-deps.js"

const stubFetch = (text: string): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text }) } }] }), {
      status: 200,
    })) as unknown as typeof fetch

const baseInput = {
  question: { qId: "tech_depth", prompt: { en: "Tell me about a hard project." }, clarifyPrompt: {} },
  lang: "en" as const,
  reply: "i did backend",
  scored: { perKeyword: [], aggregate: { s: 0.4, c: 0.5, summary: "" } },
  merged: { perKeyword: [], aggregate: { s: 0.4, c: 0.5, summary: "" } },
  clarifyRound: 2,
  reason: "confidence" as const,
  state: { recentClarifyTexts: ["a", "b"], questions: {} },
  fallbackText: "what did you own?",
  log: () => {},
}

test("voice composer does NOT prepend the robotic round opener", async () => {
  const orig = process.env.PA_OPENAI_AGENT_API_KEY
  process.env.PA_OPENAI_AGENT_API_KEY = "sk-test"
  try {
    const g = globalThis as { fetch: typeof fetch }
    const real = g.fetch
    g.fetch = stubFetch("what's the trickiest part you built yourself?")
    const voice = makeProductionClarifyComposer({ voice: true })
    const out = await voice(baseInput as never)
    g.fetch = real
    assert.equal(out, "what's the trickiest part you built yourself?") // verbatim, no "The ownership piece matters here - "
    assert.doesNotMatch(out, /Got it|ownership piece matters|systems detail is the useful/i)
  } finally {
    process.env.PA_OPENAI_AGENT_API_KEY = orig
  }
})

test("voice composer fail-safe: no key → speaks fallback, never throws", async () => {
  const orig = process.env.PA_OPENAI_AGENT_API_KEY
  const orig2 = process.env.OPENAI_API_KEY
  delete process.env.PA_OPENAI_AGENT_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const voice = makeProductionClarifyComposer({ voice: true })
    const out = await voice(baseInput as never)
    assert.equal(out, "what did you own?")
  } finally {
    if (orig !== undefined) process.env.PA_OPENAI_AGENT_API_KEY = orig
    if (orig2 !== undefined) process.env.OPENAI_API_KEY = orig2
  }
})
