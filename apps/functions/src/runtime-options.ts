import { setGlobalOptions } from "firebase-functions/v2"

// 256MiB (the gen2 default) is no longer survivable in this codebase. Every
// function here loads the SAME index.js — one esbuild bundle of 693 of our own
// files (9.2MB of src, up from 50 files / 0.5MB in May) plus @anthropic-ai/sdk,
// zod, xlsx, satori, mem0ai, @slack/bolt, livekit and the MCP SDK, on top of
// the runtime-installed externals (openai, @google-cloud/tasks, pdf-parse,
// resvg). Measured with `node -e 'import("./lib/index.js")'`: +255MB, ~293MB
// RSS. Well past 256MiB, so instances were OOM-killed at startup, before any
// handler ran (2026-08-05: the recruiter-board reject button returned
// `internal` 500 on every click, and paAlgoliaSyncRecruiterSubmission /
// paAlgoliaSyncCandidate were silently dropping index writes for the same
// reason). 512MiB is the floor now; no 512MiB/1GiB function OOM'd.
//
// No single feature did this — dropping the newest heavy exports (Slack agent +
// MCP server) only gets back 21MB, to 272MB, still over. It is the cumulative
// weight of one shared bundle.
//
// ponytail: raising the floor, not shrinking the bundle. The real cut is lazy
// imports (or splitting codebases) so a small callable stops paying for the
// Slack, video and LLM SDKs it never touches — do that if the baseline ever
// grows past 512MiB too.
setGlobalOptions({ region: "us-central1", maxInstances: 1, memory: "512MiB" })
