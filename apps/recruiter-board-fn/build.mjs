/**
 * Bundle the recruiter-board codebase entrypoint into `lib/index.js`.
 *
 * Multi-codebase deploy: this is the `recruiter-board` codebase. It contains
 * only `paCollabJobsList`, `paRecruiterSubmission`, and `paCollabJobsListSchema`.
 * Cold start <1s, memory floor 128MiB.
 *
 * firebase-tools uploads the function's `lib/` directory to Cloud Build, which
 * runs `npm install` against the local package.json. There are no workspace
 * deps here (intentional — the whole point of this codebase is to avoid the
 * pa-orchestrator bundle), so the externals list is small.
 */
import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { mkdirSync, writeFileSync, existsSync, rmSync, copyFileSync } from "node:fs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(__dirname, "lib")

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [resolve(__dirname, "src/index.ts")],
  outfile: resolve(outDir, "index.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
    ].join("\n"),
  },
  sourcemap: true,
  // Keep firebase-admin/functions external (they bind to the Cloud Functions
  // Gen 2 sandbox versions). `googleapis` is also externalized — it ships
  // ~50MB of generated API surface that would bloat the bundle.
  external: [
    "firebase-admin",
    "firebase-admin/*",
    "firebase-functions",
    "firebase-functions/*",
    "googleapis",
    "googleapis/*",
  ],
  legalComments: "none",
  logLevel: "info",
})

// Minimal runtime package.json next to the bundle so Cloud Build's
// `npm install` only fetches the three externalized deps.
const runtimePackage = {
  name: "recruiter-board-runtime",
  version: "0.0.1",
  private: true,
  type: "module",
  main: "index.js",
  engines: { node: "24" },
  dependencies: {
    "firebase-admin": "^13.0.0",
    "firebase-functions": "^6.0.0",
    "googleapis": "^144.0.0",
  },
}
writeFileSync(
  resolve(outDir, "package.json"),
  JSON.stringify(runtimePackage, null, 2) + "\n",
)
writeFileSync(resolve(outDir, ".npmrc"), "legacy-peer-deps=true\n")

// Forward .env (if present) so Gen2 picks up RECRUITER_BOARD_SHEET_ID and
// other non-secret runtime env vars. Mirrors `apps/functions/build.mjs`.
const envSrc = resolve(__dirname, ".env")
if (existsSync(envSrc)) {
  copyFileSync(envSrc, resolve(outDir, ".env"))
  console.log("[recruiter-board-fn] copied .env into deploy bundle")
} else {
  console.log("[recruiter-board-fn] no .env file found at", envSrc, "(skipping)")
}

console.log("[recruiter-board-fn] bundled to", outDir)
