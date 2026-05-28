/**
 * P3 keystone integrity — the scoped prescreen agent must advance the FSM at
 * most ONCE per human turn. The SDK loop (toolChoice:"auto") can emit
 * `record_prescreen_answer` more than once; each call runs the real reducer
 * (scores + advances qOrder), so a 2nd call would skip/fabricate a question.
 * This drives `runAgenticPrescreenTurn` with a fake SDK that calls the record
 * tool twice and asserts the reducer (`runTurn`) fired exactly once.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { runAgenticPrescreenTurn } from "../prescreen-agentic-turn.js"

type RecordTool = { name: string; execute: (a: unknown) => Promise<string> }

test("runAgenticPrescreenTurn: record-once — two record_prescreen_answer calls advance the FSM only once", async () => {
  let runTurnCalls = 0
  const fakeRunTurn = async (_reply: string) => {
    runTurnCalls++
    return { text: "", action: { kind: "advance" }, state: {} as never }
  }

  // Fake SDK: tool() returns the spec verbatim; Agent stores the tools; run()
  // invokes the record tool's execute TWICE (simulates a double tool-call).
  const fakeSdk = {
    setDefaultOpenAIClient() {},
    setOpenAIAPI() {},
    setDefaultOpenAIKey() {},
    tool: (spec: unknown) => spec,
    Agent: class {
      tools: RecordTool[]
      constructor(opts: { tools: RecordTool[] }) {
        this.tools = opts.tools
      }
    },
    run: async (agent: { tools: RecordTool[] }) => {
      const rec = agent.tools.find((t) => t.name === "record_prescreen_answer")
      assert.ok(rec, "record_prescreen_answer tool must be registered")
      const first = await rec.execute({ reply: "yes, 3 years of React" })
      const second = await rec.execute({ reply: "yes, 3 years of React" })
      // The 2nd call must be a no-op echo, not a second reducer advance.
      assert.match(second, /already_recorded_this_turn/u)
      assert.doesNotMatch(first, /already_recorded_this_turn/u)
      return { finalOutput: "" }
    },
  }

  const out = await runAgenticPrescreenTurn({
    replyText: "yes, 3 years of React",
    lang: "en",
    questionPrompt: "Do you have 2+ years of React experience?",
    runTurn: fakeRunTurn,
    __loadSdk: () => fakeSdk as never,
  })

  assert.equal(runTurnCalls, 1, "FSM reducer must advance at most once per human turn")
  assert.equal(out.routed, "answered")
})
