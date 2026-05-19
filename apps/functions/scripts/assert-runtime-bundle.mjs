import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundlePath = resolve(__dirname, "../lib/index.js")
const bundle = readFileSync(bundlePath, "utf8")

// Each entry is a substring that MUST appear in the bundled `lib/index.js`.
// The assertion is a coarse "did the runtime guard survive bundling?" check;
// match what the esbuild output actually emits rather than the source's
// pretty-printed shape. Update both halves of a pair if the source guard
// changes.
const required = [
  "const userAuthoredEvent = !runtimeEvent;",
  // Website-started onboarding is the only SMS intake. Source labels alone
  // must not bypass the shared runtime session gate.
  "const sharedRuntimeSession = isSharedOnboardingActiveUser(onboardingUser);",
  "const onboardingIncomplete = Boolean(userAuthoredEvent && onboardingUser && onboardingUser.onboardingState !== \"complete\" && !sharedRuntimeSession)",
  "if (userAuthoredEvent && await handleLegacySmsOnboardingBlocked(event, store, turnId, onboardingUser, sharedRuntimeSession))",
  "directIntentResult: \"legacy_sms_onboarding_blocked\"",
]

const missing = required.filter((needle) => !bundle.includes(needle))
if (missing.length > 0) {
  console.error("[functions] runtime bundle is missing required runtime/onboarding guards:")
  for (const needle of missing) console.error(`- ${needle}`)
  console.error(`[functions] bundle checked: ${bundlePath}`)
  process.exit(1)
}

console.log("[functions] runtime bundle guard check passed")
