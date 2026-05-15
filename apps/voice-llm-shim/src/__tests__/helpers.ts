import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../app.js";
import type { ChatCompletionsHandlerDeps } from "../handler.js";

export interface StartedApp {
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startApp(
  deps: ChatCompletionsHandlerDeps,
): Promise<StartedApp> {
  const server = createApp(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    server,
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Consume an SSE response body, returning the parsed chunks (excluding the
 * terminal `[DONE]` marker) and a `done: true` flag if `[DONE]` was seen.
 */
export async function consumeSse(res: Response): Promise<{
  events: any[];
  done: boolean;
  raw: string;
}> {
  if (!res.body) throw new Error("response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: any[] = [];
  let done = false;
  while (true) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buf += decoder.decode(value, { stream: true });
    // SSE events are separated by `\n\n`.
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!chunk.startsWith("data: ")) continue;
      const payload = chunk.slice("data: ".length);
      if (payload === "[DONE]") {
        done = true;
        continue;
      }
      try {
        events.push(JSON.parse(payload));
      } catch {
        // ignore non-JSON (shouldn't happen)
      }
    }
  }
  return { events, done, raw: buf };
}

export function collectContent(events: any[]): string {
  let out = "";
  for (const e of events) {
    const c = e?.choices?.[0]?.delta?.content;
    if (typeof c === "string") out += c;
  }
  return out;
}

export function finalFinishReason(events: any[]): string | null | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const fr = events[i]?.choices?.[0]?.finish_reason;
    if (fr !== null && fr !== undefined) return fr;
  }
  return undefined;
}
