import type { RunAgentTurnStream } from "./contract.js";
import { createFakeRunAgentTurnStream } from "./fake.js";

export type ResolveLogger = {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
};

const defaultLogger: ResolveLogger = {
  warn: (m, meta) => console.warn(`[voice-llm-shim] ${m}`, meta ?? ""),
  info: (m, meta) => console.log(`[voice-llm-shim] ${m}`, meta ?? ""),
};

/**
 * Resolve the backend `runAgentTurnStream` impl based on env.
 *
 * - `fake` (default) → always use the echo backend.
 * - `orchestrator` → dynamic-import `@pa/pa-orchestrator`. If the export is
 *   missing (S1A hasn't merged yet), log warn and fall back to the fake.
 */
export async function resolveRunAgentTurnStream(opts?: {
  backend?: string;
  logger?: ResolveLogger;
}): Promise<RunAgentTurnStream> {
  const backend = (opts?.backend ?? process.env.WEKRUIT_LLM_SHIM_BACKEND ?? "fake")
    .trim()
    .toLowerCase();
  const log = opts?.logger ?? defaultLogger;

  if (backend === "fake") {
    log.info("backend=fake (echo)");
    return createFakeRunAgentTurnStream();
  }

  if (backend === "orchestrator") {
    try {
      const mod = (await import("@pa/pa-orchestrator")) as Record<string, unknown>;
      const fn = mod.runAgentTurnStream;
      if (typeof fn === "function") {
        log.info("backend=orchestrator (runAgentTurnStream resolved)");
        return fn as RunAgentTurnStream;
      }
      log.warn(
        "backend=orchestrator requested but runAgentTurnStream export is missing; falling back to fake",
      );
    } catch (err) {
      log.warn("failed to import @pa/pa-orchestrator; falling back to fake", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return createFakeRunAgentTurnStream();
  }

  log.warn(`unknown backend "${backend}"; falling back to fake`);
  return createFakeRunAgentTurnStream();
}
