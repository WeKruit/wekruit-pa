import type { RunAgentTurnStream } from "./contract.js";
import { createFakeRunAgentTurnStream } from "./fake.js";
import { createOrchestratorBackend } from "./orchestrator-backend.js";

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
    // v2.1 S2 task #12 — use the S1A↔S1C adapter rather than the raw
    // runAgentTurnStream (signatures don't line up; see
    // orchestrator-backend.ts header).
    try {
      const backendFn = createOrchestratorBackend({ logger: log });
      log.info("backend=orchestrator (S1A adapter wired)");
      return backendFn;
    } catch (err) {
      log.warn("failed to build orchestrator backend; falling back to fake", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return createFakeRunAgentTurnStream();
  }

  log.warn(`unknown backend "${backend}"; falling back to fake`);
  return createFakeRunAgentTurnStream();
}
