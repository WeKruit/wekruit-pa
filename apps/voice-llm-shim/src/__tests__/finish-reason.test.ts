import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createScriptedRunAgentTurnStream } from "../runtime/fake.js";
import { consumeSse, finalFinishReason, startApp } from "./helpers.js";

describe("finish_reason propagation from runAgentTurnStream", () => {
  it("maps finishReason='stop' from runtime to OpenAI finish_reason='stop'", async () => {
    const { baseUrl, close } = await startApp({
      runAgentTurnStream: createScriptedRunAgentTurnStream([
        { delta: "hi" },
        { delta: " there", finishReason: "stop" },
      ]),
    });
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      assert.equal(res.status, 200);
      const { events, done } = await consumeSse(res);
      assert.ok(done);
      assert.equal(finalFinishReason(events), "stop");
    } finally {
      await close();
    }
  });

  it("maps finishReason='length' from runtime to OpenAI finish_reason='length'", async () => {
    const { baseUrl, close } = await startApp({
      runAgentTurnStream: createScriptedRunAgentTurnStream([
        { delta: "a long answer that hits cap" },
        { delta: "", finishReason: "length" },
      ]),
    });
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: "go" }],
        }),
      });
      const { events, done } = await consumeSse(res);
      assert.ok(done);
      assert.equal(finalFinishReason(events), "length");
    } finally {
      await close();
    }
  });

  it("defaults to 'stop' when runtime emits no finishReason", async () => {
    const { baseUrl, close } = await startApp({
      runAgentTurnStream: createScriptedRunAgentTurnStream([
        { delta: "no terminal reason" },
      ]),
    });
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: "go" }],
        }),
      });
      const { events, done } = await consumeSse(res);
      assert.ok(done);
      assert.equal(finalFinishReason(events), "stop");
    } finally {
      await close();
    }
  });
});
