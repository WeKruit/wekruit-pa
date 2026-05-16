/**
 * v2.1 S2 — voice-agent CLI entrypoint.
 *
 * LiveKit Cloud agent hosting (L12) invokes this binary inside the managed
 * runtime. Locally (dev) it boots a worker process listening for room
 * dispatch.
 *
 * Subcommands:
 *   --help                          show usage and exit 0
 *   --version                       print version and exit
 *   start                           start the LiveKit Agent worker (default)
 *   dev                             alias for `start` — kept for parity with
 *                                   `@livekit/agents` CLI conventions
 *
 * Env required to actually start the worker:
 *   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
 *   DEEPGRAM_API_KEY
 *   WEKRUIT_LLM_SHIM_URL
 *
 * `--help` works without any of the above (we never import the LiveKit SDK
 * until the worker actually starts).
 */

const PKG_VERSION = "0.0.1"

const USAGE = `voice-agent ${PKG_VERSION} — WeKruit v2.1 voice prescreen bridge

Usage:
  voice-agent [command] [options]

Commands:
  start                     Start the LiveKit Agents worker (default)
  dev                       Alias for "start"
  --help, -h                Show this message and exit
  --version                 Print version and exit

Environment (required at start-time):
  LIVEKIT_URL               LiveKit Cloud project URL
  LIVEKIT_API_KEY           LiveKit API key
  LIVEKIT_API_SECRET        LiveKit API secret
  DEEPGRAM_API_KEY          Deepgram Nova-3 STT + Aura-2 TTS
  WEKRUIT_LLM_SHIM_URL      base URL of voice-llm-shim (S1C)

Environment (optional):
  WEKRUIT_VOICE_RECORDINGS_BUCKET   default: wekruit-voice-recordings (L8)
  PA_AGENT_RUNTIME_STREAM_ENABLED   set to "true" (S1A flag flip)

Deploy:
  LiveKit Cloud managed agent hosting — see apps/voice-agent/livekit.toml.
`

export interface RunCliOpts {
  argv?: string[]
  /** Test seam — exits the process. Default: process.exit. */
  exit?: (code: number) => never
  /** Test seam — stdout writer. Default: console.log. */
  out?: (msg: string) => void
  /** Test seam — start-worker entrypoint. Default: imports lazily. */
  startWorker?: () => Promise<void>
}

export async function runCli(opts: RunCliOpts = {}): Promise<number> {
  const argv = opts.argv ?? process.argv.slice(2)
  const out = opts.out ?? ((m: string) => console.log(m))
  const exit = opts.exit ?? ((code: number) => process.exit(code) as never)

  // --help / -h / no args / `help` — show usage and exit
  if (
    argv.length === 0 ||
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv[0] === "help"
  ) {
    out(USAGE)
    return 0
  }

  if (argv.includes("--version")) {
    out(PKG_VERSION)
    return 0
  }

  const cmd = argv[0] ?? "start"
  if (cmd !== "start" && cmd !== "dev") {
    out(`Unknown command: ${cmd}\n\n${USAGE}`)
    exit(2)
    return 2
  }

  // Lazy-load the LiveKit-bound worker so `--help` is fast + crash-free.
  // After startWorker() defines the agent, register with LK Cloud via
  // `cli.runApp(new WorkerOptions(...))` so the process accepts dispatched
  // jobs (L12 — managed agent hosting). Tests inject `opts.startWorker`
  // to short-circuit before the network-bound runApp call.
  const start = opts.startWorker ?? (async () => {
    const { startWorker } = await import("./worker.js")
    await startWorker()
    const { cli: lkCli, WorkerOptions } = await import("@livekit/agents")
    const { fileURLToPath } = await import("node:url")
    lkCli.runApp(
      new WorkerOptions({
        agent: fileURLToPath(new URL("./worker.js", import.meta.url)),
      }),
    )
  })
  await start()
  return 0
}

// When invoked directly (node dist/cli.js / tsx src/cli.ts), run.
const invokedAsMain =
  // ESM: import.meta.url ends in this file's path
  typeof import.meta.url === "string" &&
  /\/cli\.(t|m?j)s$/.test(import.meta.url) &&
  process.argv[1]?.endsWith(new URL(import.meta.url).pathname.split("/").pop() ?? "")

if (invokedAsMain || process.env.VOICE_AGENT_RUN_MAIN === "1") {
  runCli().catch((err) => {
    console.error("[voice-agent] fatal", err)
    process.exit(1)
  })
}
