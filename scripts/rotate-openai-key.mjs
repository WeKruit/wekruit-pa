#!/usr/bin/env node
/**
 * rotate-openai-key.mjs — full auto-rotation of the OpenAI key (deliverable #4).
 *
 * Incident: .planning/INCIDENT-2026-06-01-openai-rotation-hardening.md §5.
 *
 * One operator command rotates the key end-to-end with the SAFE ordering
 * (new version → redeploy → revoke OLD last), so no in-flight request ever 401s:
 *
 *   1. Create a NEW service-account key via the OpenAI Admin API
 *        POST /v1/organization/projects/{project}/service_accounts
 *      (project keys cannot be created, but SA keys CAN — and the response
 *      returns a usable secret, so full auto-rotation works).
 *   2. Fan the new key out via scripts/sync-openai-key.mjs --apply
 *      (3 Firebase secrets + 2 GitHub Actions secrets + local .env).
 *   3. Redeploy the functions so the new secret VERSION pins (Firebase pins the
 *      version at deploy time — a new version is inert until referencing fns
 *      redeploy).
 *   4. Revoke / DELETE the OLD service-account key (LAST, after deploy).
 *   5. Run scripts/audit-openai-key-drift.mjs — expect 0 drift.
 *
 * HARD REQUIREMENT: OPENAI_ADMIN_KEY env must be set (Adam-provided org admin
 * key — sk-proj- project keys are NOT sufficient). The script ERRORS CLEARLY and
 * ABORTS if it is unset; it never proceeds without it.
 *
 * SECURITY — the admin key and the freshly-minted key are held only in memory,
 * piped to children via stdin, and never printed/logged. All output is redacted
 * prefix + sha256 only.
 *
 * Usage:
 *   OPENAI_ADMIN_KEY=sk-admin-... node scripts/rotate-openai-key.mjs            # DRY-RUN (default)
 *   OPENAI_ADMIN_KEY=sk-admin-... node scripts/rotate-openai-key.mjs --apply    # really rotate
 *   --project-id proj_abc   (default: read OPENAI_PROJECT_ID env)
 *   --sa-name <name>        (default: wekruit-pa-auto-<yyyymmdd>)
 *   --old-sa-id <id>        the OLD service-account id to delete after deploy
 *   --no-deploy             skip the redeploy step (e.g. deploy manually)
 * Defaults to --dry-run. Pass --apply to mint/rotate/revoke anything.
 */

import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import { sha256Hex, redactKey, looksLikeOpenAiKey, parseFlags } from "./lib/openai-key-drift.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "..")
const OPENAI_BASE = "https://api.openai.com/v1"

const { flags, values } = parseFlags(process.argv.slice(2))
const apply = flags.has("apply")
const dryRun = !apply
const doDeploy = !flags.has("no-deploy")
const projectId = values.get("project-id") || process.env.OPENAI_PROJECT_ID || ""
const oldSaId = values.get("old-sa-id") || process.env.OPENAI_OLD_SA_ID || ""
const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "")
const saName = values.get("sa-name") || `wekruit-pa-auto-${ymd}`

function log(...a) {
  console.log(...a)
}
function abort(msg, code = 2) {
  console.error(`rotate-openai-key: ${msg}`)
  process.exit(code)
}
/** Redact any sk- token before printing child/error output. */
function redactText(text) {
  return String(text).replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-…REDACTED").slice(0, 500)
}

// --- HARD GATE: OPENAI_ADMIN_KEY ------------------------------------------
const ADMIN_KEY = (process.env.OPENAI_ADMIN_KEY ?? "").trim()
if (!ADMIN_KEY) {
  abort(
    "OPENAI_ADMIN_KEY env is REQUIRED and unset. This is Adam-provided (an ORG ADMIN key; " +
      "sk-proj- project keys are not sufficient). Aborting — the script never proceeds without it.\n" +
      "  set it (never in shell history) e.g.:  read -rs OPENAI_ADMIN_KEY; export OPENAI_ADMIN_KEY"
  )
}
if (!/^sk-/.test(ADMIN_KEY)) {
  abort("OPENAI_ADMIN_KEY does not look like an OpenAI key (expected 'sk-...'). Aborting.")
}
if (!projectId) {
  abort(
    "--project-id (or OPENAI_PROJECT_ID env) is required — the OpenAI project to mint the " +
      "service-account key in (e.g. proj_abc). Aborting."
  )
}

async function adminFetch(method, path, body) {
  const res = await fetch(`${OPENAI_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON */
  }
  return { ok: res.ok, status: res.status, json, raw: text }
}

/** Create a new service-account key; returns the new key VALUE + SA id. */
async function createServiceAccountKey() {
  const r = await adminFetch(
    "POST",
    `/organization/projects/${encodeURIComponent(projectId)}/service_accounts`,
    { name: saName }
  )
  if (!r.ok) {
    abort(`OpenAI Admin API create SA failed (HTTP ${r.status}): ${redactText(r.raw)}`, 3)
  }
  const value = r.json?.api_key?.value
  const saId = r.json?.id
  if (!value || !looksLikeOpenAiKey(value)) {
    abort("OpenAI Admin API did not return a usable api_key.value. Aborting before any fan-out.", 3)
  }
  return { value, saId }
}

/** Delete (revoke) the OLD service-account by id — LAST step. */
async function deleteServiceAccount(saId) {
  const r = await adminFetch(
    "DELETE",
    `/organization/projects/${encodeURIComponent(projectId)}/service_accounts/${encodeURIComponent(saId)}`
  )
  return r
}

function runChild(cmd, args, input) {
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    input,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "pipe"],
    timeout: 20 * 60 * 1000,
  })
  return { status: res.status ?? -1, stderr: redactText(res.stderr ?? "") }
}

// --------------------------------------------------------------------------

log("rotate-openai-key")
log("=================")
log(`mode:       ${apply ? "APPLY (rotating)" : "DRY-RUN (default — pass --apply to rotate)"}`)
log(`admin key:  ${redactKey(ADMIN_KEY)}  (org admin — present ✓)`)
log(`project:    ${projectId}`)
log(`sa name:    ${saName}`)
log(`old sa id:  ${oldSaId || "(none provided — will NOT revoke an old key; pass --old-sa-id)"}`)
log("")

async function main() {
  if (dryRun) {
    log("DRY-RUN plan (no API calls, no writes):")
    log(`  1. POST ${OPENAI_BASE}/organization/projects/${projectId}/service_accounts {name:"${saName}"}`)
    log("     → mint a new service-account key (value used in-memory only).")
    log("  2. node scripts/sync-openai-key.mjs --stdin --apply   (pipe the new key)")
    log("     → 3 Firebase secrets + 2 GitHub Actions secrets + local .env.")
    if (doDeploy) {
      log("  3. (cd apps/functions && pnpm run deploy)   → pin new secret version.")
    } else {
      log("  3. [skipped: --no-deploy] redeploy manually so the new version pins.")
    }
    log(
      `  4. DELETE ${OPENAI_BASE}/organization/projects/${projectId}/service_accounts/${oldSaId || "<old-sa-id>"}   (revoke OLD, LAST).`
    )
    log("  5. node scripts/audit-openai-key-drift.mjs   → expect 0 drift.")
    log("")
    log("DRY-RUN complete — nothing was minted, written, deployed, or revoked.")
    log("Re-run with --apply (and OPENAI_ADMIN_KEY set) to execute.")
    process.exit(0)
  }

  // 1. Mint new key.
  log("1. Minting new service-account key via OpenAI Admin API…")
  const { value: NEWKEY, saId: newSaId } = await createServiceAccountKey()
  log(`   ✓ minted ${redactKey(NEWKEY)}  sha256=${sha256Hex(NEWKEY).slice(0, 12)}…  (sa id ${newSaId ?? "?"})`)
  log("")

  // 2. Fan out via the sync script (pipe key on stdin).
  log("2. Fanning out via sync-openai-key.mjs --apply …")
  const sync = runChild(
    "node",
    [resolve(REPO_ROOT, "scripts/sync-openai-key.mjs"), "--stdin", "--apply"],
    NEWKEY
  )
  if (sync.status !== 0) {
    abort(
      `sync-openai-key.mjs exited ${sync.status}. ABORTING before revoking the old key — ` +
        `the new key is live in OpenAI but fan-out is incomplete. Re-run sync, then revoke manually. ` +
        `${sync.stderr}`,
      4
    )
  }
  log("   ✓ fan-out complete")
  log("")

  // 3. Redeploy so the new secret version pins.
  if (doDeploy) {
    log("3. Redeploying functions (pins new secret version)…")
    const deploy = runChild("pnpm", ["--filter", "@pa/functions", "run", "deploy"])
    if (deploy.status !== 0) {
      // Try the apps/functions package script directly as a fallback.
      const deploy2 = runChild("npm", ["--prefix", "apps/functions", "run", "deploy"])
      if (deploy2.status !== 0) {
        abort(
          `redeploy failed (${deploy.status}/${deploy2.status}). New key IS live + synced, but the old ` +
            `version is still pinned in deployed fns. Do NOT revoke the old key yet — redeploy manually ` +
            `(cd apps/functions && pnpm run deploy), then re-run with --old-sa-id to revoke.`,
          5
        )
      }
    }
    log("   ✓ redeploy complete")
    log("")
  } else {
    log("3. [--no-deploy] skipping redeploy — DEPLOY MANUALLY before the new version takes effect.")
    log("")
  }

  // 4. Revoke OLD key LAST.
  if (oldSaId) {
    log("4. Revoking OLD service-account key (LAST)…")
    const del = await deleteServiceAccount(oldSaId)
    if (!del.ok) {
      log(`   ✗ delete failed (HTTP ${del.status}): ${redactText(del.raw)} — revoke manually in the dashboard.`)
    } else {
      log(`   ✓ revoked old sa ${oldSaId}`)
    }
    log("")
  } else {
    log("4. No --old-sa-id given — skipping revoke. Revoke the OLD key manually once live-verified.")
    log("")
  }

  // 5. Drift audit — expect 0.
  log("5. Running drift audit (expect 0 drift)…")
  const audit = runChild("node", [resolve(REPO_ROOT, "scripts/audit-openai-key-drift.mjs")])
  if (audit.status !== 0) {
    abort(
      `drift audit reported drift (exit ${audit.status}) — rotation is PARTIAL. Inspect: ` +
        `node scripts/audit-openai-key-drift.mjs`,
      6
    )
  }
  log("   ✓ no drift")
  log("")
  log("Rotation complete. Manual stores (macmini / Infisical) still need the new key — see")
  log("the sync script's printed paste steps. Verify with: node scripts/audit-openai-key-drift.mjs")
}

main().catch((err) => {
  abort(redactText(String(err?.message ?? err)), 1)
})
