/**
 * W4 — esbuild bundler for LiveKit Cloud deploy.
 *
 * Why this exists:
 *   `lk agent deploy` excludes `node_modules` from its tarball upload
 *   (cloudagents/tar.go:98). The Dockerfile must rebuild deps in-container.
 *   But voice-agent's runtime now depends on `@pa/agent-runtime` +
 *   `@pa/core-types` (W1 in-process WekruitLLM swap) which are workspace
 *   packages NOT publishable to npm.
 *
 * Solution: bundle the workspace code into a single CLI entry. The bundle
 *   - INLINES `@pa/agent-runtime`, `@pa/core-types`, and any other workspace
 *     code we touch
 *   - EXTERNALIZES every `node_modules` package (LK SDK, openai, mem0ai,
 *     firebase-admin, etc) so the Docker container can `pnpm install` only
 *     these via a deploy-specific package.json
 *
 * Output:
 *   dist/cli.bundle.js  — production ESM entry, single file
 *   dist/cli.bundle.meta.json — esbuild metafile for analysis / debugging
 */

import { build } from "esbuild"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(__dirname, "..")
const metaFile = resolve(appRoot, "dist", "cli.bundle.meta.json")

if (!existsSync(resolve(appRoot, "dist"))) {
  await mkdir(resolve(appRoot, "dist"), { recursive: true })
}

// Strategy: bundle everything by default, then externalize only true
// node_modules packages (LK SDK, OpenAI, mem0ai, firebase-admin, …). The
// `external` plugin below treats any module-id NOT starting with `.`, `/`,
// `@pa/`, or our workspace prefix as external. This forces `@pa/*` to be
// resolved + inlined (we want their code in the bundle), while keeping all
// npm-registry packages as runtime imports the container's `npm install`
// will resolve.
const externalsPlugin = {
  name: "external-non-workspace",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      // Entry → bundle. Other entry resolutions handled below.
      if (args.kind === "entry-point") return undefined
      // Relative imports — bundle EXCEPT agent.js (must stay external so
      // LK's child IPC can dynamic-import the separate agent.bundle.js).
      if (args.path.startsWith(".") || args.path.startsWith("/")) {
        if (args.path === "./agent.js") {
          return { path: "./agent.bundle.js", external: true }
        }
        return undefined
      }
      // Workspace packages → bundle (resolve via default resolver).
      if (args.path.startsWith("@pa/")) return undefined
      if (args.path.startsWith("@wekruit/")) return undefined
      // node:* builtins → external.
      if (args.path.startsWith("node:")) return { path: args.path, external: true }
      // Everything else (LK SDK, openai, mem0ai, etc) → external.
      return { path: args.path, external: true }
    })
  },
}

const outDir = resolve(appRoot, "dist")
const result = await build({
  entryPoints: [
    resolve(appRoot, "src", "cli.ts"),
    resolve(appRoot, "src", "agent.ts"),
  ],
  entryNames: "[name].bundle",
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  plugins: [externalsPlugin],
  sourcemap: false,
  minify: false,
  metafile: true,
  // ESM-compat shims so CJS-only deps still work when externalized.
  banner: {
    js:
      "import { createRequire as __wekruitCreateRequire } from 'module';\n" +
      "import { fileURLToPath as __wekruitFileURLToPath } from 'url';\n" +
      "import { dirname as __wekruitDirname } from 'path';\n" +
      "const require = __wekruitCreateRequire(import.meta.url);\n" +
      "const __filename = __wekruitFileURLToPath(import.meta.url);\n" +
      "const __dirname = __wekruitDirname(__filename);\n",
  },
  logLevel: "info",
})

await writeFile(metaFile, JSON.stringify(result.metafile, null, 2))

// External imports are stored in metafile.outputs[*].imports with kind=external.
// We walk every output, collect unique external package names.
const externalSet = new Set()
for (const [, info] of Object.entries(result.metafile.outputs)) {
  for (const imp of info.imports ?? []) {
    if (imp.external) {
      const id = imp.path
      if (id.startsWith("node:")) continue
      // Skip relative imports — those are sibling bundles, not npm deps.
      if (id.startsWith(".") || id.startsWith("/")) continue
      // Reduce sub-paths like "@livekit/agents/dist/llm/llm.js" → "@livekit/agents".
      const parts = id.split("/")
      const pkg = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]
      if (pkg) externalSet.add(pkg)
    }
  }
}
const externals = Array.from(externalSet).sort()

console.log("[esbuild-bundle] bundled →", outDir, "(cli.bundle.js + agent.bundle.js)")
console.log("[esbuild-bundle] external packages (need npm install):")
for (const e of externals) console.log("  •", e)

// Emit a deploy-only package.json that lists all externals as flat deps,
// so the slim Dockerfile can `pnpm install --frozen-lockfile` without
// workspace context.
const srcPkg = JSON.parse(
  await readFile(resolve(appRoot, "package.json"), "utf8"),
)
const rootPkg = JSON.parse(
  await readFile(resolve(appRoot, "..", "..", "package.json"), "utf8"),
)
// Pinned versions for transitive deps that voice-agent's own package.json
// doesn't declare directly (sourced from packages/agent-runtime/package.json
// and friends). Update when the workspace upgrades.
const TRANSITIVE_VERSIONS = {
  openai: "^4.80.0",
  "@openai/agents": "^0.8.5",
  zod: "^4.3.6",
  "@anthropic-ai/sdk": "^0.40.1",
  mem0ai: "^3.0.0",
  "firebase-admin": "^12.0.0",
}

const deployDeps = {}
for (const ext of externals) {
  // node:* core modules don't go in deps.
  if (ext.startsWith("node:")) continue
  // Resolution priority: source package.json deps (with caret/exact),
  // then root package.json deps, then a manual snapshot. If none match,
  // fall back to `*` and warn (npm will pull latest — risky but unblocks
  // local iteration).
  const v =
    srcPkg.dependencies?.[ext] ??
    srcPkg.devDependencies?.[ext] ??
    rootPkg.dependencies?.[ext] ??
    rootPkg.devDependencies?.[ext] ??
    TRANSITIVE_VERSIONS[ext]
  if (!v) {
    console.warn(`[esbuild-bundle] WARN: no version for "${ext}", falling back to "*"`)
    deployDeps[ext] = "*"
  } else {
    deployDeps[ext] = v
  }
}

const deployPkg = {
  name: "voice-agent-deploy",
  version: srcPkg.version,
  private: true,
  type: "module",
  main: "dist/cli.bundle.js",
  scripts: { start: "node dist/cli.bundle.js start" },
  dependencies: deployDeps,
  engines: srcPkg.engines,
}

await writeFile(
  resolve(appRoot, "dist", "deploy-package.json"),
  JSON.stringify(deployPkg, null, 2),
)
console.log(
  "[esbuild-bundle] deploy package.json →",
  resolve(appRoot, "dist", "deploy-package.json"),
)
console.log("[esbuild-bundle] done.")
