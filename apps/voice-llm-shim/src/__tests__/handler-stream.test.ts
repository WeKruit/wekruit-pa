import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createFakeRunAgentTurnStream } from "../runtime/fake.js";
import { collectContent, consumeSse, finalFinishReason, startApp } from "./helpers.js";

describe("POST /v1/chat/completions stream=true", () => {
  it("returns OpenAI SSE format and streams the runtime output", async () => {
    const { baseUrl, close } = await startApp({
      runAgentTurnStream: createFakeRunAgentTurnStream({
        prefix: "echo: ",
        chunkSize: 3,
      }),
    });

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "wekruit-prescreen-v1",
          stream: true,
          messages: [
            { role: "system", content: "you are claire" },
            { role: "user", content: "hello there friend" },
          ],
        }),
      });

      assert.equal(res.status, 200);
      const ct = res.headers.get("content-type") ?? "";
      assert.ok(ct.includes("text/event-stream"), `content-type was ${ct}`);

      const { events, done } = await consumeSse(res);
      assert.ok(done, "expected terminal [DONE]");

      // First chunk announces role.
      assert.equal(events[0].choices[0].delta.role, "assistant");
      assert.equal(events[0].object, "chat.completion.chunk");

      // Middle chunks carry content; last chunk has finish_reason=stop.
      const content = collectContent(events);
      assert.equal(content, "echo: hello there friend");
      assert.equal(finalFinishReason(events), "stop");

      // All chunks share the same id + model.
      const id = events[0].id;
      assert.ok(id.startsWith("chatcmpl-"));
      for (const e of events) {
        assert.equal(e.id, id);
        assert.equal(e.model, "wekruit-prescreen-v1");
        assert.equal(e.object, "chat.completion.chunk");
        assert.equal(typeof e.created, "number");
      }
    } finally {
      await close();
    }
  });

  it("also accepts /chat/completions without /v1 prefix", async () => {
    const { baseUrl, close } = await startApp({
      runAgentTurnStream: createFakeRunAgentTurnStream({ prefix: "ok: ", chunkSize: 2 }),
    });
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
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
      assert.equal(collectContent(events), "ok: hi");
    } finally {
      await close();
    }
  });
});
