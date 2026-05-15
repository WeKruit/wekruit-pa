import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createFakeRunAgentTurnStream } from "../runtime/fake.js";
import { startApp } from "./helpers.js";

describe("POST /v1/chat/completions non-streaming rejection", () => {
  it("stream=false returns 400 OpenAI-shape error", async () => {
    const { baseUrl, close } = await startApp({
      runAgentTurnStream: createFakeRunAgentTurnStream(),
    });
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error.message, "stream=true required");
      assert.equal(body.error.type, "invalid_request_error");
      assert.equal(body.error.param, "stream");
      assert.equal(body.error.code, "unsupported_param");
    } finally {
      await close();
    }
  });

  it("stream omitted returns 400", async () => {
    const { baseUrl, close } = await startApp({
      runAgentTurnStream: createFakeRunAgentTurnStream(),
    });
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error.param, "stream");
    } finally {
      await close();
    }
  });

  it("missing messages returns 400", async () => {
    const { baseUrl, close } = await startApp({
      runAgentTurnStream: createFakeRunAgentTurnStream(),
    });
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stream: true }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error.param, "messages");
    } finally {
      await close();
    }
  });

  it("GET returns 405", async () => {
    const { baseUrl, close } = await startApp({
      runAgentTurnStream: createFakeRunAgentTurnStream(),
    });
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: "GET" });
      assert.equal(res.status, 405);
    } finally {
      await close();
    }
  });
});
