#!/usr/bin/env node
/**
 * 1) Pull Web SDK `VITE_*` via Firebase CLI → `.env.pa-firebase-generated`
 * 2) `npm run deploy:hosting` with PA_DASHBOARD_VITE_ENV_FILE set (predeploy build uses inject script)
 */
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { execSync } from "node:child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..")
const envFile = resolve(repoRoot, "apps/dashboard-web/.env.pa-firebase-generated")

execSync(`node ${join(__dirname, "fetch-pa-dashboard-vite-from-firebase.mjs")}`, {
  stdio: "inherit",
  cwd: repoRoot,
  env: { ...process.env },
})

const env = { ...process.env, PA_DASHBOARD_VITE_ENV_FILE: envFile }
execSync("npm run deploy:hosting", { stdio: "inherit", cwd: repoRoot, env })
