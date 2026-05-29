/**
 * _claire-bundle.mjs — shared eval harness.
 *
 * Loads the PRODUCTION claire-agent (agent.ts + transport.ts + tool builders + delivery
 * reflexes + sdk.ts) as a single plain-ESM bundle, so the SDK loads as compiled .js (zod@4)
 * with NO tsx intercepting @openai/agents-core's TypeScript against zod@3.
 *
 * This is the canonical eval-harness pattern (mirrors eval-process / eval-canary). Evals that
 * used tsx + a resolve-hook break because sdk.ts loads the SDK via a CJS createRequire that the
 * ESM register() hook can't rewrite → a dual zod instance. The bundle approach sidesteps that:
 * sdk.ts's createRequire(import.meta.url) resolves from THIS dir's node_modules, where @openai +
 * zod are symlinked to agent-runtime's zod@4 build.
 */
import { symlinkSync, existsSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "../../..")
const agentRuntimeNm = join(repoRoot, "packages/agent-runtime/node_modules")
const functionsNm = join(repoRoot, "apps/functions/node_modules")

export function loadEnv() {
  const envPath = join(repoRoot, ".env")
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^(PA_OPENAI_AGENT_API_KEY|OPENAI_API_KEY)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  }
  if (!process.env.OPENAI_API_KEY && process.env.PA_OPENAI_AGENT_API_KEY) {
    process.env.OPENAI_API_KEY = process.env.PA_OPENAI_AGENT_API_KEY
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("no OPENAI_API_KEY / PA_OPENAI_AGENT_API_KEY")
    process.exit(1)
  }
}

/** Bundle + import the production claire-agent exports. Returns the imported module. */
export async function loadClaireBundle() {
  const nm = join(here, "node_modules")
  rmSync(nm, { recursive: true, force: true })
  mkdirSync(nm, { recursive: true })
  const link = (rel, target) => {
    const p = join(nm, rel)
    if (!existsSync(p)) {
      try {
        symlinkSync(target, p)
      } catch (e) {
        console.error(`symlink ${rel} → ${target} failed: ${e?.message ?? e}`)
      }
    }
  }
  // SDK: zod@4 build from agent-runtime (overrides functions zod@3 for sdk.ts's createRequire).
  link("@openai", join(agentRuntimeNm, "@openai"))
  link("zod", join(agentRuntimeNm, "zod"))
  link(".bin", join(agentRuntimeNm, ".bin"))
  // Everything else: the functions graph (whole scopes cover all transitive workspace deps).
  link("@pa", join(functionsNm, "@pa"))
  link("@wekruit", join(functionsNm, "@wekruit"))
  link("firebase-admin", join(functionsNm, "firebase-admin"))
  link("firebase-functions", join(functionsNm, "firebase-functions"))
  link("@google-cloud", join(functionsNm, "@google-cloud"))
  link("openai", join(functionsNm, "openai"))

  const claireDir = join(repoRoot, "apps/functions/src/claire-agent")
  const bundlePath = join(here, ".claire-bundle.bundle.mjs")
  const esbuild = await import(join(functionsNm, "esbuild/lib/main.js"))
  await esbuild.build({
    stdin: {
      contents: [
        `export { runClaireTurn, buildClaireAgent, CLAIRE_MODEL } from ${JSON.stringify(join(claireDir, "agent.ts"))}`,
        `export { createSendblueTransport } from ${JSON.stringify(join(claireDir, "transport.ts"))}`,
        `export { buildMatchingTools, makeV16FindMatch } from ${JSON.stringify(join(claireDir, "tools/matching-tools.ts"))}`,
        `export { buildDeliveryTools } from ${JSON.stringify(join(claireDir, "tools/delivery-tools.ts"))}`,
        `export { buildProcessTools } from ${JSON.stringify(join(claireDir, "tools/process-tools.ts"))}`,
        `export { markReadReflex, wireTypingReflex, deliverFinalText, SLOW_TOOLS } from ${JSON.stringify(join(claireDir, "delivery.ts"))}`,
        `export { buildClaireGuardrails, normalizeReply } from ${JSON.stringify(join(claireDir, "guardrails.ts"))}`,
        `export { Agent, run, tool, z, MemorySession, InputGuardrailTripwireTriggered } from ${JSON.stringify(join(claireDir, "sdk.ts"))}`,
      ].join("\n"),
      resolveDir: here,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: bundlePath,
    logLevel: "silent",
    banner: {
      js: [
        "import { createRequire as __cr } from 'node:module';",
        "import { fileURLToPath as __fp } from 'node:url';",
        "const require = __cr(import.meta.url);",
        "const __filename = __fp(import.meta.url);",
      ].join("\n"),
    },
    external: [
      "@openai/agents", "@openai/agents-core", "zod", "@pa/*", "@wekruit/*",
      "firebase-admin", "firebase-admin/*", "firebase-functions", "firebase-functions/*",
      "@google-cloud/tasks", "@google-cloud/tasks/*", "openai", "node:*",
    ],
  })
  return import(bundlePath)
}
