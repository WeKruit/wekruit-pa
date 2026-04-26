#!/usr/bin/env node
import { spawnSync } from "node:child_process"

const enabled = process.env.PA_RUN_SCENARIOS === "1"
const hasCredential =
  Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()) ||
  Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim()) ||
  Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) ||
  Boolean(process.env.GOOGLE_CLOUD_PROJECT?.trim()) ||
  Boolean(process.env.GCLOUD_PROJECT?.trim())

if (!enabled) {
  console.log("[scenario-test] skipped (set PA_RUN_SCENARIOS=1 to enable production scenario harness)")
  process.exit(0)
}

if (!hasCredential) {
  console.log("[scenario-test] skipped (no Firebase Admin credentials in env)")
  process.exit(0)
}

const result = spawnSync(
  process.execPath,
  ["tests/scenarios/runner.mjs", "tests/scenarios/scenarios/"],
  { stdio: "inherit" }
)

process.exit(result.status ?? 1)
