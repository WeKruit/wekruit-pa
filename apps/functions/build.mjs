/**
 * Bundle the Cloud Function entrypoint into a self-contained `lib/index.js`.
 *
 * firebase-tools uploads the function's source directory to Cloud Build, which
 * runs `npm install` against the local package.json. Workspace deps like
 * `@pa/pa-orchestrator` are not on npm, so they must be inlined at build time.
 * We mark only `firebase-admin`, `firebase-functions`, and Node built-ins as
 * external; everything else (workspace deps, `mem0ai`, etc.) is bundled.
 */
import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { mkdirSync, writeFileSync, existsSync, rmSync, copyFileSync, readdirSync } from "node:fs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(__dirname, "lib")
const repoRoot = resolve(__dirname, "../..")
const localPaOrchestratorEntry = resolve(
  repoRoot,
  "packages/pa-orchestrator/dist/index.js",
)

const mem0OptionalPeerModules = new Set([
  "@azure/identity",
  "@azure/search-documents",
  "@google/genai",
  "@langchain/core/documents",
  "@langchain/core/messages",
  "@mistralai/mistralai",
  "@qdrant/js-client-rest",
  "@supabase/supabase-js",
  "better-sqlite3",
  "cloudflare",
  "groq-sdk",
  "ollama",
  "pg",
  "redis",
])

const mem0OptionalPeerStub = `
class MissingOptionalMem0Peer {
  constructor() {
    throw new Error("mem0 optional peer provider is not bundled in pa-functions-runtime")
  }
}
export default MissingOptionalMem0Peer
export const Ollama = MissingOptionalMem0Peer
export const Groq = MissingOptionalMem0Peer
export const Mistral = MissingOptionalMem0Peer
export const QdrantClient = MissingOptionalMem0Peer
export const Cloudflare = MissingOptionalMem0Peer
export const GoogleGenAI = MissingOptionalMem0Peer
export const AIMessage = MissingOptionalMem0Peer
export const HumanMessage = MissingOptionalMem0Peer
export const SystemMessage = MissingOptionalMem0Peer
export const Document = MissingOptionalMem0Peer
export const SearchClient = MissingOptionalMem0Peer
export const SearchIndexClient = MissingOptionalMem0Peer
export const AzureKeyCredential = MissingOptionalMem0Peer
export const DefaultAzureCredential = MissingOptionalMem0Peer
export const Pool = MissingOptionalMem0Peer
export function createClient() {
  throw new Error("mem0 optional peer provider is not bundled in pa-functions-runtime")
}
`

const forceLocalWorkspacePackages = {
  name: "force-local-workspace-packages",
  setup(build) {
    build.onResolve({ filter: /^@pa\/pa-orchestrator$/ }, () => ({
      path: localPaOrchestratorEntry,
    }))
  },
}

const stubUnusedMem0OptionalPeers = {
  name: "stub-unused-mem0-optional-peers",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!mem0OptionalPeerModules.has(args.path)) return null
      return { path: args.path, namespace: "mem0-optional-peer-stub" }
    })
    build.onLoad({ filter: /.*/, namespace: "mem0-optional-peer-stub" }, () => ({
      contents: mem0OptionalPeerStub,
      loader: "js",
    }))
  },
}

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [resolve(__dirname, "src/index.ts")],
  outfile: resolve(outDir, "index.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  nodePaths: [resolve(__dirname, "node_modules")],
  banner: {
    // Provide CommonJS shims so bundled deps that use `require`/`__dirname`
    // (e.g. transitive deps of `mem0ai`) keep working in an ESM bundle.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "const require = __createRequire(import.meta.url);",
      // esbuild auto-shims `__dirname` at the bundle root for ESM/node, but
      // some transitive deps (e.g. open) reference `__filename` at module
      // top-level — provide it explicitly to avoid ReferenceError at load.
      "const __filename = __fileURLToPath(import.meta.url);",
    ].join("\n"),
  },
  sourcemap: true,
  // Keep the firebase admin/functions runtimes external so they bind to the
  // Cloud Functions Gen 2 sandbox versions. Everything else (including
  // `mem0ai`) is bundled to avoid relying on workspace resolution.
  external: [
    "firebase-admin",
    "firebase-admin/*",
    "firebase-functions",
    "firebase-functions/*",
    // Stream D — pdf-parse bundles a ~9 MB minified pdfjs copy + test
    // fixtures via its lib path; keep external so Cloud Build npm-installs
    // it at deploy time. Bundle size held under the 16 MB target.
    "pdf-parse",
    "pdf-parse/lib/*",
    // openai v4 generated resources/ tree (~9 MB) — same rationale; use
    // Cloud Build npm install path for the SDK rather than inline.
    "openai",
    "openai/*",
    // v1.5 Stream-D — Cloud Tasks SDK is heavy (gRPC + protos ~10MB);
    // externalize so Cloud Build npm-installs at deploy time. Keeps
    // bundle <16MB.
    "@google-cloud/tasks",
    "@google-cloud/tasks/*",
    // Rec-card renderer (2026-05-30) — @resvg/resvg-wasm ships an
    // `index_bg.wasm` binary that esbuild cannot inline as a JS module; the
    // render path resolves the .wasm at runtime via createRequire. Keep the
    // package external so Cloud Build npm-installs it (and its .wasm) at
    // deploy time, matching the pdf-parse / openai externalization pattern.
    "@resvg/resvg-wasm",
    "@resvg/resvg-wasm/*",
  ],
  legalComments: "none",
  logLevel: "info",
  plugins: [forceLocalWorkspacePackages, stubUnusedMem0OptionalPeers],
})

// Emit a minimal package.json next to the bundle so firebase-tools knows the
// entrypoint and runtime, and so Cloud Build's `npm install` only fetches the
// two externals (everything else is inlined).
const runtimePackage = {
  name: "pa-functions-runtime",
  version: "0.0.1",
  private: true,
  type: "module",
  main: "index.js",
  engines: { node: "24" },
  dependencies: {
    "firebase-admin": "^13.0.0",
    "firebase-functions": "^6.0.0",
    // Stream D — externalized to keep bundle <16 MB; Cloud Build installs
    // at deploy time, identical version contract to the workspace.
    "pdf-parse": "^1.1.1",
    "openai": "^4.74.0",
    // openai 4.x lazy-loads zod from _vendor/zod-to-json-schema even though
    // it's listed as an OPTIONAL peer; Cloud Run instance failed to start
    // 2026-04-30 with ERR_MODULE_NOT_FOUND 'zod'. Pin it explicitly here.
    "zod": "^4.3.6",
    // @pa/agent-runtime uses createRequire("@openai/agents") at turn-time.
    // esbuild cannot inline that dynamic require, so Cloud Run must install
    // the SDK in the deploy bundle's production node_modules.
    "@openai/agents": "^0.8.5",
    // v1.5 Stream-D — Cloud Tasks SDK (externalized for bundle size).
    "@google-cloud/tasks": "^5.5.0",
    // Rec-card renderer (2026-05-30) — externalized .wasm dep; Cloud Build
    // installs it at deploy time. `satori` (pure JS) is bundled, not listed.
    "@resvg/resvg-wasm": "^2.6.2",
  },
}
writeFileSync(
  resolve(outDir, "package.json"),
  JSON.stringify(runtimePackage, null, 2) + "\n",
)
writeFileSync(resolve(outDir, ".npmrc"), "legacy-peer-deps=true\n")

// Copy the agent-registry seed.json alongside the bundle so that
// `loadSeedAgents()` (which resolves it via `dirname(import.meta.url)`) finds
// it when the function cold-starts an empty Firestore.
const seedSrc = resolve(repoRoot, "packages/agent-registry/src/seed.json")
copyFileSync(seedSrc, resolve(outDir, "seed.json"))

// Copy the rec-card font assets into the deploy bundle. render-card.ts
// resolves them relative to its bundled module dir (`lib/`), probing
// `lib/job-rec-card/assets/fonts`. Without this copy, satori has no fonts and
// the card render fails (fail-open → text rec), so we ship them explicitly.
const fontsSrc = resolve(__dirname, "src/job-rec-card/assets/fonts")
if (existsSync(fontsSrc)) {
  const fontsDest = resolve(outDir, "job-rec-card/assets/fonts")
  mkdirSync(fontsDest, { recursive: true })
  for (const f of readdirSync(fontsSrc)) {
    if (f.endsWith(".ttf")) copyFileSync(resolve(fontsSrc, f), resolve(fontsDest, f))
  }
  console.log("[functions] copied rec-card fonts into deploy bundle")
} else {
  console.log("[functions] no rec-card fonts found at", fontsSrc, "(skipping)")
}

// Copy `.env` into the deploy bundle so Firebase Gen2 picks up
// non-secret runtime env vars (PA_ADMIN_USER_IDS, etc). `.env` lives in
// `apps/functions/.env` (gitignored). Copying into `lib/` ensures
// firebase-tools (which uses `source: apps/functions/lib`) loads it.
const envSrc = resolve(__dirname, ".env")
if (existsSync(envSrc)) {
  copyFileSync(envSrc, resolve(outDir, ".env"))
  console.log("[functions] copied .env into deploy bundle")
} else {
  console.log("[functions] no .env file found at", envSrc, "(skipping admin allowlist)")
}

// ALSO copy the project-scoped dotenv `.env.wekruit-5f89b` into the bundle. firebase-tools loads
// BOTH `.env` and `.env.<projectId>` from the functions SOURCE dir (= lib/), with the project file
// overriding. Without this copy, the project-scoped PA_ flags (PA_JOB_REC_CARD_ENABLED,
// PA_TCPA_GATE_ENFORCED, PA_VOICE_PRESCREEN_ENABLED) live ONLY at apps/functions/.env.wekruit-5f89b
// and never reach lib/ → process.env at runtime (the 2026-05-30 missing-rec-card bug: the card flag
// was set but invisible to the deployed function). Copy it so the deploy loads it for this project.
const envProjSrc = resolve(__dirname, ".env.wekruit-5f89b")
if (existsSync(envProjSrc)) {
  copyFileSync(envProjSrc, resolve(outDir, ".env.wekruit-5f89b"))
  console.log("[functions] copied .env.wekruit-5f89b into deploy bundle")
} else {
  console.log("[functions] no .env.wekruit-5f89b found at", envProjSrc, "(skipping project flags)")
}

console.log("[functions] bundled to", outDir)
