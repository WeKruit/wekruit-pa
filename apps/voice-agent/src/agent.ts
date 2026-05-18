/**
 * v2.2 W4 — LK Cloud agent module entrypoint.
 *
 * LiveKit Agents SDK spawns a child IPC process per dispatched job. That
 * child imports this file and reads `module.default` — must be the result
 * of `defineAgent({...})` (or it throws "Missing or invalid default export").
 *
 * Our worker.ts registers the agent on globalThis (test seam pattern). This
 * file is the production binding: import worker → wait for registration →
 * re-export the agent so LK's IPC loader finds it.
 *
 * cli.ts passes this file's bundled path to `new WorkerOptions({ agent })`.
 */

import { startWorker } from "./worker.js"

await startWorker()

const agent = (globalThis as Record<string, unknown>).__voiceAgent
if (!agent) {
  throw new Error("voice-agent/agent.ts: startWorker did not register globalThis.__voiceAgent")
}

export default agent
