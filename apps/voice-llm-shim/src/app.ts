import { createServer, type Server } from "node:http";
import { createChatCompletionsHandler, type ChatCompletionsHandlerDeps } from "./handler.js";

export interface CreateAppOptions extends ChatCompletionsHandlerDeps {}

/**
 * Build (but do not start) the HTTP server. Exported for tests so they can
 * `.listen(0)` on an ephemeral port without booting the full process.
 */
export function createApp(opts: CreateAppOptions): Server {
  const handleChat = createChatCompletionsHandler(opts);

  return createServer(async (req, res) => {
    try {
      // CORS preflight (dev): allow openai-sdk style clients.
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type",
        );
        res.end();
        return;
      }

      const url = req.url ?? "/";
      // Accept both `/v1/chat/completions` and bare `/chat/completions` to be
      // permissive about whether the caller's base_url includes `/v1`.
      const path = url.split("?")[0];

      if (path === "/healthz" || path === "/") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJsonError(res, 405, {
            message: "Method not allowed.",
            type: "invalid_request_error",
          });
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, service: "voice-llm-shim" }));
        return;
      }

      if (path === "/v1/chat/completions" || path === "/chat/completions") {
        if (req.method !== "POST") {
          sendJsonError(res, 405, {
            message: "Method not allowed.",
            type: "invalid_request_error",
          });
          return;
        }
        await handleChat(req, res);
        return;
      }
      sendJsonError(res, 404, {
        message: `Unknown path: ${path}`,
        type: "invalid_request_error",
      });
    } catch (err) {
      sendJsonError(res, 500, {
        message: err instanceof Error ? err.message : "internal error",
        type: "server_error",
      });
    }
  });
}

function sendJsonError(
  res: import("node:http").ServerResponse,
  status: number,
  error: { message: string; type: string; param?: string; code?: string },
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error }));
}
