import assert from "node:assert/strict"
import test from "node:test"
import type { AgentDef, ChatMessage } from "@pa/core-types"
import { buildAgentsInput } from "./openai-agents-adapter.js"

const agent: AgentDef = {
  id: "default",
  name: "Default PA",
  status: "published",
  provider: "openai",
  model: "pa-fast",
  temperature: 0.7,
  maxTokens: 500,
  systemPrompt: "Be useful.",
  version: "1",
  memoryMode: "firestore_only",
  toolPolicy: "none",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

test("buildAgentsInput includes memory, transcript, and latest message", () => {
  const history: ChatMessage[] = [
    {
      id: "m1",
      sessionId: "s1",
      userId: "u1",
      role: "user",
      body: "old request",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "m2",
      sessionId: "s1",
      userId: "u1",
      role: "assistant",
      body: "old answer",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ]
  const input = buildAgentsInput({
    agent,
    systemPrompt: agent.systemPrompt,
    memoryBlock: "User likes concise answers.",
    history,
    userMessage: "what is next?",
  })

  assert.match(input, /Memory context:\nUser likes concise answers\./)
  assert.match(input, /Recent transcript:\n\[2026-01-01T00:00:00.000Z\] user: old request\n\[2026-01-01T00:00:01.000Z\] assistant: old answer/)
  assert.match(input, /Latest user message:\nwhat is next\?/)
})
