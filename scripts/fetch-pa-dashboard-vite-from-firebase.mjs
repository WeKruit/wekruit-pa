#!/usr/bin/env node
/**
 * Fetches Firebase **Web** SDK public config and writes
 * `apps/dashboard-web/.env.pa-firebase-generated` (gitignored) in KEY=value form
 * for `inject-pa-dashboard-vite-env.mjs` / Vite.
 *
 * Requires: `npm install` at repo root, `firebase login`, access to the project.
 *
 * If the project has multiple web apps, set exactly one of:
 * - `PA_DASHBOARD_FIREBASE_APP_ID` = full app id (1:...:web:...)
 * - `PA_DASHBOARD_FIREBASE_APP_DISPLAY` = display name substring (default tries `management-dashboard`)
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..")
const outPath = join(repoRoot, "apps/dashboard-web/.env.pa-firebase-generated")
const projectId = (process.env.PA_DASHBOARD_FIREBASE_PROJECT || "wekruit-5f89b").trim()
const appIdFromEnv = (process.env.PA_DASHBOARD_FIREBASE_APP_ID || "").trim()
const displaySubstr = (process.env.PA_DASHBOARD_FIREBASE_APP_DISPLAY || "management-dashboard")
  .trim()
  .toLowerCase()

function firebaseBin() {
  const local = join(repoRoot, "node_modules", "firebase-tools", "lib", "bin", "firebase.js")
  if (existsSync(local)) return { cmd: process.execPath, argsPrefix: [local] }
  return { cmd: "firebase", argsPrefix: [] }
}

function runFirebase(args) {
  const { cmd, argsPrefix } = firebaseBin()
  return execFileSync(cmd, [...argsPrefix, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

/**
 * @returns {Array<{ displayName: string, appId: string }>}
 */
function parseAppsListListOutput(text) {
  const clean = stripAnsi(text)
  const rows = []
  const idRe = /1:\d+:[a-z]+:[a-z0-9]+/i
  for (const line of clean.split("\n")) {
    if (!idRe.test(line) || !/\bWEB\b/i.test(line)) continue
    const m = line.match(idRe)
    if (!m) continue
    const parts = line
      .split("│")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    if (parts.length < 2) continue
    let appId = ""
    let displayName = ""
    for (const p of parts) {
      if (idRe.test(p)) appId = p.match(idRe)[0]
      else if (p !== "WEB" && !/^[-─]+$/.test(p) && p !== "App Display Name") {
        if (!displayName) displayName = p
      }
    }
    if (appId) rows.push({ displayName: displayName || "(unnamed)", appId })
  }
  const byId = new Map()
  for (const r of rows) {
    if (!byId.has(r.appId)) byId.set(r.appId, r)
  }
  if (byId.size > 0) return [...byId.values()]
  const idMatches = stripAnsi(text).match(/1:\d+:\d+:\w+/g) || []
  const unique = [...new Set(idMatches)]
  if (unique.length === 1) return [{ displayName: "(unparsed)", appId: unique[0] }]
  return []
}

function pickAppId(apps) {
  if (appIdFromEnv) {
    const hit = apps.find((a) => a.appId === appIdFromEnv)
    if (!hit) {
      console.error(
        `[fetch-pa-dashboard-vite-from-firebase] No WEB app with id ${appIdFromEnv}. Found:\n` +
          apps.map((a) => `  ${a.appId}  (${a.displayName})`).join("\n"),
      )
      process.exit(1)
    }
    return appIdFromEnv
  }
  const byName = apps.filter((a) => a.displayName.toLowerCase().includes(displaySubstr))
  if (byName.length === 1) return byName[0].appId
  if (apps.length === 1) return apps[0].appId
  if (byName.length > 1) {
    console.error(
      `[fetch-pa-dashboard-vite-from-firebase] Multiple apps match display "${displaySubstr}":\n` +
        byName.map((a) => `  ${a.appId}  (${a.displayName})`).join("\n") +
        "\nSet PA_DASHBOARD_FIREBASE_APP_ID to one of these.",
    )
    process.exit(1)
  }
  console.error(
    "[fetch-pa-dashboard-vite-from-firebase] Could not pick a web app. Found:\n" +
      apps.map((a) => `  ${a.appId}  (${a.displayName})`).join("\n") +
      "\nSet PA_DASHBOARD_FIREBASE_APP_ID or PA_DASHBOARD_FIREBASE_APP_DISPLAY.",
  )
  process.exit(1)
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function toViteMap(raw) {
  const o = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {}
  const nested =
    o.config && typeof o.config === "object"
      ? o.config
      : o.sdkConfig && typeof o.sdkConfig === "object"
        ? o.sdkConfig
        : o
  const n = /** @type {Record<string, unknown>} */ (nested)
  const pick = (k) => (typeof n[k] === "string" ? n[k] : "")

  const apiKey = pick("apiKey")
  const authDomain = pick("authDomain")
  const pid = pick("projectId")
  const storageBucket = pick("storageBucket")
  const msid = n.messagingSenderId
  const messagingSenderId = msid == null ? "" : String(msid)
  const appId = pick("appId")

  const m = {
    VITE_FIREBASE_API_KEY: apiKey,
    VITE_FIREBASE_AUTH_DOMAIN: authDomain,
    VITE_FIREBASE_PROJECT_ID: pid,
    VITE_FIREBASE_STORAGE_BUCKET: storageBucket,
    VITE_FIREBASE_MESSAGING_SENDER_ID: messagingSenderId,
    VITE_FIREBASE_APP_ID: appId,
  }
  return m
}

function main() {
  let listText = ""
  try {
    listText = runFirebase(["apps:list", "WEB", "--project", projectId])
  } catch (e) {
    console.error(
      "[fetch-pa-dashboard-vite-from-firebase] `firebase apps:list WEB` failed. Is `firebase` installed and are you logged in? (`firebase login`)\n",
    )
    throw e
  }
  const apps = parseAppsListListOutput(listText)
  if (apps.length === 0) {
    console.error(
      "[fetch-pa-dashboard-vite-from-firebase] No WEB apps in project. Create one in Firebase Console.",
    )
    process.exit(1)
  }
  const appId = pickAppId(apps)
  const tmp = join(tmpdir(), `pa-firebase-sdk-${randomBytes(8).toString("hex")}.json`)
  try {
    runFirebase(["apps:sdkconfig", "WEB", appId, "--project", projectId, "-o", tmp])
  } catch (e) {
    console.error("[fetch-pa-dashboard-vite-from-firebase] `firebase apps:sdkconfig` failed.\n")
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw e
  }
  let jsonRaw = ""
  try {
    jsonRaw = readFileSync(tmp, "utf8")
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
  const parsed = JSON.parse(jsonRaw)
  const m = toViteMap(parsed)
  const missing = Object.entries(m).filter(([, v]) => !v)
  if (missing.length) {
    console.error(
      "[fetch-pa-dashboard-vite-from-firebase] Config JSON is missing fields:",
      missing.map(([k]) => k).join(", "),
      "\nRaw keys:",
      Object.keys(/** @type {object} */ (parsed) || {}),
    )
    process.exit(1)
  }
  const body =
    Object.entries(m)
      .map(([k, v]) => {
        const s = String(v)
        if (/[\s#"'=]/g.test(s)) return `${k}=${JSON.stringify(s)}`
        return `${k}=${s}`
      })
      .join("\n") + "\n"
  writeFileSync(outPath, body, "utf8")
  const rel = "apps/dashboard-web/.env.pa-firebase-generated"
  console.log(`[fetch-pa-dashboard-vite-from-firebase] wrote ${rel} (from web app ${appId})`)
}

try {
  main()
} catch (err) {
  console.error(err)
  process.exit(1)
}
