import { setGlobalOptions } from "firebase-functions/v2"

// 256MiB (the gen2 default) is no longer survivable in this codebase. Every
// function here loads the SAME index.js, which statically pulls in @slack/bolt,
// googleapis, openai, @anthropic-ai/sdk, the MCP SDK, satori/resvg, livekit,
// pdf-parse — the module-load baseline crossed 256MiB and instances started
// getting OOM-killed at startup, before any handler ran (2026-08-05: the
// recruiter-board reject button returned `internal` 500 on every click, and
// paAlgoliaSyncRecruiterSubmission / paAlgoliaSyncCandidate were silently
// dropping index writes for the same reason). 512MiB is the floor now; no
// 512MiB/1GiB function OOM'd in the same window.
// ponytail: raising the floor, not shrinking the bundle. The real cut is lazy
// imports so a callable stops paying for Slack + video + LLM SDKs it never
// touches — do that if the baseline ever grows past 512MiB too.
setGlobalOptions({ region: "us-central1", maxInstances: 1, memory: "512MiB" })
