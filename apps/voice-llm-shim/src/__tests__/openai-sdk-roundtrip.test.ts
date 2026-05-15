import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import OpenAI from "openai";
import { createFakeRunAgentTurnStream } from "../runtime/fake.js";
import { startApp } from "./helpers.js";

/**
 * End-to-end: use the official `openai` npm SDK as the client, point its
 * `baseURL` at our shim, and assert it correctly streams chunks and the
 * collected text matches the fake backend's output.
 *
 * This is the contract the LiveKit `openai.LLM` plugin uses (Python SDK is
 * wire-equivalent — both speak the same SSE format).
 */
describe("openai SDK roundtrip → shim → fake backend", () => {
  it("client.chat.completions.create({stream:true}) yields the runtime's text", async () => {
    const { baseUrl, close } = await startApp({
      runAgentTurnStream: createFakeRunAgentTurnStream({
        prefix: "answer: ",
        chunkSize: 5,
      }),
    });
    try {
      const client = new OpenAI({
        apiKey: "unused-localhost",
        baseURL: `${baseUrl}/v1`,
      });

      const stream = await client.chat.completions.create({
        model: "wekruit-prescreen-v1",
        stream: true,
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "what is your job" },
        ],
      });

      const collected: string[] = [];
      let lastFinish: string | null | undefined;
      let sawAssistantRole = false;
      let chunkCount = 0;
      for await (const part of stream) {
        chunkCount += 1;
        const choice = part.choices[0];
        if (choice?.delta?.role === "assistant") sawAssistantRole = true;
        const c = choice?.delta?.content;
        if (typeof c === "string" && c.length > 0) collected.push(c);
        if (choice?.finish_reason) lastFinish = choice.finish_reason;
      }
      assert.ok(sawAssistantRole, "expected role=assistant on first chunk");
      assert.equal(collected.join(""), "answer: what is your job");
      assert.equal(lastFinish, "stop");
      assert.ok(chunkCount >= 3, `expected ≥3 chunks, got ${chunkCount}`);
    } finally {
      await close();
    }
  });
});
