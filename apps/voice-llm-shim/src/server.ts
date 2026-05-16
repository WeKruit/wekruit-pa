import { createApp } from "./app.js";
import { resolveRunAgentTurnStream } from "./runtime/resolve.js";

async function main(): Promise<void> {
  const host = process.env.WEKRUIT_LLM_SHIM_HOST ?? "127.0.0.1";
  const port = Number(process.env.WEKRUIT_LLM_SHIM_PORT ?? 8787);
  const model = process.env.WEKRUIT_LLM_SHIM_MODEL ?? "wekruit-prescreen-v1";

  const runAgentTurnStream = await resolveRunAgentTurnStream();
  const server = createApp({ runAgentTurnStream, defaultModel: model });

  server.listen(port, host, () => {
    console.log(`[voice-llm-shim] listening on http://${host}:${port}`);
    console.log(`[voice-llm-shim] OpenAI base_url: http://${host}:${port}/v1`);
  });

  const shutdown = (signal: string) => {
    console.log(`[voice-llm-shim] ${signal} → shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[voice-llm-shim] fatal", err);
  process.exit(1);
});
