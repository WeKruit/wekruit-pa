import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  CONVERSATION_SENTIMENTS,
  CONVERSATION_SENTIMENT_CATEGORIES,
  CONVERSATION_SENTIMENT_JSON_SCHEMA,
  conversationSentimentRank,
  isUnhappySentiment,
  renderConversationForClassifier,
} from "./conversation-sentiment.js"

describe("conversation-sentiment", () => {
  it("ranks very_negative as most severe (lowest) and very_positive least", () => {
    const sorted = [...CONVERSATION_SENTIMENTS].sort(
      (a, b) => conversationSentimentRank(a) - conversationSentimentRank(b),
    )
    assert.equal(sorted[0], "very_negative")
    assert.equal(sorted[sorted.length - 1], "very_positive")
  })

  it("treats negative + very_negative as unhappy, others not", () => {
    assert.equal(isUnhappySentiment("very_negative"), true)
    assert.equal(isUnhappySentiment("negative"), true)
    assert.equal(isUnhappySentiment("neutral"), false)
    assert.equal(isUnhappySentiment("positive"), false)
    assert.equal(isUnhappySentiment("very_positive"), false)
  })

  it("json schema enums match the constant arrays and require every field", () => {
    const props = CONVERSATION_SENTIMENT_JSON_SCHEMA.properties as Record<
      string,
      { enum?: string[] }
    >
    assert.deepEqual(props.sentiment.enum, [...CONVERSATION_SENTIMENTS])
    assert.deepEqual(props.category.enum, [...CONVERSATION_SENTIMENT_CATEGORIES])
    assert.equal(CONVERSATION_SENTIMENT_JSON_SCHEMA.additionalProperties, false)
    assert.deepEqual(CONVERSATION_SENTIMENT_JSON_SCHEMA.required, [
      "sentiment",
      "unhappy",
      "category",
      "evidenceQuote",
      "whatWentWrong",
      "fixIdea",
    ])
  })

  it("renders a transcript with role labels and trims the tail", () => {
    const text = renderConversationForClassifier([
      { role: "assistant", body: "hey i'm claire" },
      { role: "user", body: "these jobs are all wrong" },
    ])
    assert.ok(text.includes("Claire: hey i'm claire"))
    assert.ok(text.includes("Candidate: these jobs are all wrong"))
  })

  it("keeps the most recent messages when over the cap", () => {
    const msgs = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? ("assistant" as const) : ("user" as const),
      body: `m${i}`,
    }))
    const text = renderConversationForClassifier(msgs, { maxMessages: 10 })
    assert.ok(text.includes("m79"))
    assert.ok(!text.includes("m10\n"))
  })
})
