import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  encodeSseEvent,
  makeContentChunk,
  makeFinishChunk,
  makeRoleChunk,
  newChatCompletionId,
  SSE_DONE,
} from "../sse.js";

describe("sse encoder", () => {
  const ctx = { id: "chatcmpl-test", created: 1700000000, model: "wekruit-test" };

  it("role chunk: delta.role=assistant, finish_reason=null", () => {
    const c = makeRoleChunk(ctx);
    assert.equal(c.object, "chat.completion.chunk");
    assert.equal(c.id, "chatcmpl-test");
    assert.equal(c.model, "wekruit-test");
    assert.equal(c.choices.length, 1);
    assert.equal(c.choices[0].delta.role, "assistant");
    assert.equal(c.choices[0].delta.content, undefined);
    assert.equal(c.choices[0].finish_reason, null);
  });

  it("content chunk carries delta.content", () => {
    const c = makeContentChunk(ctx, "hello");
    assert.equal(c.choices[0].delta.content, "hello");
    assert.equal(c.choices[0].delta.role, undefined);
    assert.equal(c.choices[0].finish_reason, null);
  });

  it("finish chunk sets finish_reason and empty delta", () => {
    const c = makeFinishChunk(ctx, "stop");
    assert.deepEqual(c.choices[0].delta, {});
    assert.equal(c.choices[0].finish_reason, "stop");
  });

  it("finish chunk maps null → stop", () => {
    const c = makeFinishChunk(ctx, null);
    assert.equal(c.choices[0].finish_reason, "stop");
  });

  it("encodeSseEvent wraps JSON in `data: ...\\n\\n` per OpenAI 2024 SSE", () => {
    const c = makeContentChunk(ctx, "x");
    const s = encodeSseEvent(c);
    assert.ok(s.startsWith("data: "));
    assert.ok(s.endsWith("\n\n"));
    const inner = s.slice("data: ".length, -2);
    const parsed = JSON.parse(inner);
    assert.equal(parsed.choices[0].delta.content, "x");
  });

  it("SSE_DONE matches OpenAI terminator exactly", () => {
    assert.equal(SSE_DONE, "data: [DONE]\n\n");
  });

  it("newChatCompletionId produces chatcmpl-prefixed string", () => {
    const id = newChatCompletionId();
    assert.ok(id.startsWith("chatcmpl-"));
    assert.ok(id.length > "chatcmpl-".length);
  });
});
