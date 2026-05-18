import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundlePath = resolve(__dirname, "../lib/index.js")
const bundle = readFileSync(bundlePath, "utf8")

const required = [
  "const userAuthoredEvent = !runtimeEvent;",
  "const onboardingIncomplete = Boolean(userAuthoredEvent && onboardingUser && onboardingUser.onboardingState !== \"complete\");",
  "if (userAuthoredEvent && onboardingUser)",
  "pa.onboarding.pipeline.reject_runtime_event",
]

const missing = required.filter((needle) => !bundle.includes(needle))
if (missing.length > 0) {
  console.error("[functions] runtime bundle is missing required runtime/onboarding guards:")
  for (const needle of missing) console.error(`- ${needle}`)
  console.error(`[functions] bundle checked: ${bundlePath}`)
  process.exit(1)
}

console.log("[functions] runtime bundle guard check passed")
