import { test } from "node:test"
import assert from "node:assert/strict"
import { humanizeVoiceLine } from "../voice-line-humanizer.js"

const okFetch = (text: string): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text }) } }] }), {
      status: 200,
    })) as unknown as typeof fetch

test("humanizeVoiceLine: rewrites via the model when it returns text", async () => {
  const out = await humanizeVoiceLine({
    text: "Got it - the ownership piece matters here - describe the systems it touched.",
    lang: "en",
    apiKey: "sk-test",
    fetchImpl: okFetch("so — walk me through what you actually owned there?"),
  })
  assert.equal(out, "so — walk me through what you actually owned there?")
})

test("humanizeVoiceLine: fail-open with no api key → returns original", async () => {
  const original = "Got it - tell me more."
  const out = await humanizeVoiceLine({ text: original, lang: "en", apiKey: "" })
  assert.equal(out, original)
})

test("humanizeVoiceLine: fail-open on non-200 → returns original", async () => {
  const original = "tell me about the role."
  const out = await humanizeVoiceLine({
    text: original,
    lang: "en",
    apiKey: "sk-test",
    fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
  })
  assert.equal(out, original)
})

test("humanizeVoiceLine: fail-open when fetch throws (timeout) → returns original", async () => {
  const original = "what did you build?"
  const out = await humanizeVoiceLine({
    text: original,
    lang: "en",
    apiKey: "sk-test",
    fetchImpl: (async () => {
      throw new Error("aborted")
    }) as unknown as typeof fetch,
  })
  assert.equal(out, original)
})

test("humanizeVoiceLine: empty model text → keeps original", async () => {
  const original = "what systems did it touch?"
  const out = await humanizeVoiceLine({
    text: original,
    lang: "en",
    apiKey: "sk-test",
    fetchImpl: okFetch("   "),
  })
  assert.equal(out, original)
})

test("humanizeVoiceLine: blank input passes through", async () => {
  const out = await humanizeVoiceLine({ text: "   ", lang: "en", apiKey: "sk-test" })
  assert.equal(out, "   ")
})
