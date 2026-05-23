import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundlePath = resolve(__dirname, "../lib/index.js")
const bundle = readFileSync(bundlePath, "utf8")
const bundleRequire = createRequire(bundlePath)

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
  // 2026-05-19 — onboarding refactored from `handleLegacySmsOnboardingBlocked`
  // + `directIntentResult: legacy_sms_onboarding_blocked` to the unified
  // shared-onboarding runtime path (commits ee9f3d7 / 0a388a5 / cb0cbc4).
  // Track the new entry points so the gate still proves the runtime-event +
  // shared-onboarding dispatch survive bundling.
  "if (await handleSharedOnboardingRuntimeEvent(event, store, turnId, onboardingUser)",
  "directIntent: \"shared_onboarding\"",
  // Duplicate greetings or other non-answers must be judged before advancing
  // the shared-onboarding question pointer. This prevents a stale bundle from
  // silently accepting "Hello, WeKruit!" as the answer to Q1.
  "const answerJudge = await judgeSharedOnboardingAnswer({",
  "pa.shared_onboarding.fail_forward",
  "advanced_despite_judge",
]

const missing = required.filter((needle) => !bundle.includes(needle))
if (missing.length > 0) {
  console.error("[functions] runtime bundle is missing required runtime/onboarding guards:")
  for (const needle of missing) console.error(`- ${needle}`)
  console.error(`[functions] bundle checked: ${bundlePath}`)
  process.exit(1)
}

try {
  bundleRequire("@openai/agents")
} catch (err) {
  console.error("[functions] runtime bundle cannot resolve @openai/agents from apps/functions/lib")
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
}

console.log("[functions] runtime bundle guard check passed")
