import assert from "node:assert/strict"
import test from "node:test"
import {
  deliverChunks,
  isTypingIndicatorEnabled,
  planChunks,
} from "./chunker.js"

const MIN_DELAY = 800
const MAX_DELAY = 1500

function deterministicRandom(seq: number[] = [0.5]): () => number {
  let i = 0
  return () => {
    const v = seq[i % seq.length]
    i += 1
    return v
  }
}

test("planChunks returns single chunk for ≤60-char reply", () => {
  const text = "好的，我记下了。"
  const plan = planChunks(text)
  assert.equal(plan.chunks.length, 1)
  assert.equal(plan.chunks[0], text)
  assert.equal(plan.delaysMs.length, 0)
})

test("planChunks returns single chunk for empty/whitespace reply", () => {
  const plan = planChunks("")
  assert.equal(plan.chunks.length, 1)
  assert.equal(plan.delaysMs.length, 0)
})

test("planChunks splits a long paragraph-separated reply into 2-3 chunks", () => {
  const para1 =
    "首先，我会查询最新的天气信息以确保你出门时不会被淋湿，这一点非常重要。"
  const para2 =
    "其次，我会基于你过去几次出行的偏好，把咖啡馆和公共交通的选项一并列出。"
  const para3 =
    "最后，我建议你提前30分钟出发，避开高峰，到达后再决定是否继续散步。"
  const text = [para1, para2, para3].join("\n\n")
  const plan = planChunks(text, { random: deterministicRandom([0.3, 0.7]) })
  assert.ok(plan.chunks.length >= 2 && plan.chunks.length <= 3, `got ${plan.chunks.length}`)
  assert.equal(plan.delaysMs.length, plan.chunks.length - 1)
  for (const d of plan.delaysMs) {
    assert.ok(d >= MIN_DELAY && d <= MAX_DELAY, `delay ${d} out of range`)
  }
})

test("planChunks falls back to sentence boundary when no paragraphs", () => {
  const text =
    "Today's weather looks great. I checked the morning forecast for you. " +
    "There is a small chance of rain in the afternoon. Bring a light jacket if you head out late. " +
    "Otherwise, the temperature should sit around 22C with low humidity all day long."
  const plan = planChunks(text, { random: deterministicRandom([0.5]) })
  assert.ok(plan.chunks.length >= 2, `expected ≥2 chunks, got ${plan.chunks.length}`)
  assert.ok(plan.chunks.length <= 3)
  assert.equal(plan.delaysMs.length, plan.chunks.length - 1)
  // Reconstructed text should match the original modulo trailing whitespace per chunk.
  const joined = plan.chunks.join(" ").replace(/\s+/g, " ").trim()
  const original = text.replace(/\s+/g, " ").trim()
  assert.equal(joined, original)
})

test("planChunks returns single chunk when no clean split point exists", () => {
  // Long word-stream with no sentence/paragraph boundaries.
  const text = "abc ".repeat(40).trim() // ~159 chars, but no `. ` or `\n\n`.
  const plan = planChunks(text)
  assert.equal(plan.chunks.length, 1)
  assert.equal(plan.delaysMs.length, 0)
})

test("planChunks never splits inside a fenced code block", () => {
  const text =
    "Here is a long preamble that is definitely longer than sixty characters by itself.\n\n" +
    "```python\n" +
    "def hello():\n" +
    "    # this is inside the fence and must not be cut.\n" +
    "    return 'world'\n" +
    "```\n\n" +
    "And here is a closing paragraph after the code, also nice and long for splitting purposes."
  const plan = planChunks(text, { random: deterministicRandom([0.4, 0.6]) })
  // For each chunk, the count of ``` markers must be even (i.e. balanced).
  for (const chunk of plan.chunks) {
    const fences = (chunk.match(/```/g) ?? []).length
    assert.equal(fences % 2, 0, `unbalanced fence in chunk: ${chunk}`)
  }
})

test("planChunks never splits inside a markdown link", () => {
  const text =
    "Look at this resource: [the official Apple developer documentation page](https://developer.apple.com/documentation/long/url/path/that/is/lengthy). " +
    "It explains the lifecycle in great detail. The page has multiple sections you should read carefully. " +
    "After that, you can come back here and we will go over your questions one by one."
  const plan = planChunks(text, { random: deterministicRandom([0.5]) })
  for (const chunk of plan.chunks) {
    const opens = (chunk.match(/\[/g) ?? []).length
    const closes = (chunk.match(/\]/g) ?? []).length
    const lparens = (chunk.match(/\(/g) ?? []).length
    const rparens = (chunk.match(/\)/g) ?? []).length
    // If a link was split, we'd see [ without ] (or () without one side) in some chunk.
    assert.equal(opens, closes, `unbalanced [] in chunk: ${chunk}`)
    assert.equal(lparens, rparens, `unbalanced () in chunk: ${chunk}`)
  }
})

test("planChunks caps at maxChunks", () => {
  const para = "This is a paragraph long enough on its own to be a single chunk by itself.\n\n"
  const text = para.repeat(8) // 8 paragraph candidates → still at most 3 chunks.
  const plan = planChunks(text, { random: deterministicRandom([0.4, 0.6]) })
  assert.ok(plan.chunks.length <= 3, `got ${plan.chunks.length}`)
})

test("planChunks delaysMs length === chunks.length - 1, all values in [800,1500]", () => {
  const text =
    "Paragraph one is sufficiently long to be its own chunk after the splitter runs.\n\n" +
    "Paragraph two also clears the sixty-character floor for chunkability with margin.\n\n" +
    "Paragraph three rounds out the message and gives us a third clean candidate."
  const plan = planChunks(text, { random: deterministicRandom([0, 0.99]) })
  assert.equal(plan.delaysMs.length, plan.chunks.length - 1)
  for (const d of plan.delaysMs) {
    assert.ok(d >= MIN_DELAY, `delay ${d} below floor`)
    assert.ok(d <= MAX_DELAY, `delay ${d} above ceiling`)
  }
})

test("isTypingIndicatorEnabled: unset env → disabled (kill switch armed)", () => {
  assert.equal(isTypingIndicatorEnabled({} as NodeJS.ProcessEnv), false)
})

test("isTypingIndicatorEnabled: PA_TYPING_INDICATOR_DISABLED=true → disabled", () => {
  assert.equal(
    isTypingIndicatorEnabled({ PA_TYPING_INDICATOR_DISABLED: "true" } as NodeJS.ProcessEnv),
    false
  )
})

test("isTypingIndicatorEnabled: PA_TYPING_INDICATOR_DISABLED=false → enabled", () => {
  assert.equal(
    isTypingIndicatorEnabled({ PA_TYPING_INDICATOR_DISABLED: "false" } as NodeJS.ProcessEnv),
    true
  )
})

test("deliverChunks: success path sends every chunk and waits between", async () => {
  const sends: string[] = []
  const sleeps: number[] = []
  const plan = {
    chunks: ["one", "two", "three"],
    delaysMs: [900, 1100],
  }
  const result = await deliverChunks(
    plan,
    async (t) => {
      sends.push(t)
    },
    async (ms) => {
      sleeps.push(ms)
    }
  )
  assert.deepEqual(sends, ["one", "two", "three"])
  assert.deepEqual(sleeps, [900, 1100])
  assert.equal(result.sent, 3)
  assert.equal(result.error, undefined)
})

test("deliverChunks: mid-chunk error halts loop, returns sent count + error", async () => {
  const sends: string[] = []
  const sleeps: number[] = []
  const plan = {
    chunks: ["one", "two", "three"],
    delaysMs: [900, 1100],
  }
  const boom = new Error("send failed")
  const result = await deliverChunks(
    plan,
    async (t) => {
      sends.push(t)
      if (t === "two") throw boom
    },
    async (ms) => {
      sleeps.push(ms)
    }
  )
  assert.deepEqual(sends, ["one", "two"])
  assert.deepEqual(sleeps, [900])
  assert.equal(result.sent, 1) // last successful index = 0; sent = i = 1 (next chunk index that failed)
  assert.equal(result.error?.index, 1)
  assert.equal(result.error?.cause, boom)
})
