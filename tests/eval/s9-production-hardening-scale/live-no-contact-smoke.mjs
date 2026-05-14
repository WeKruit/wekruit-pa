#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const projectId = "wekruit-5f89b"
const envFile = process.env.S9_ENV_FILE || "../../../.env"
const artifactPath = process.env.S9_SMOKE_ARTIFACT || ""

function readServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  }
  const raw = readFileSync(envFile, "utf8")
  const match = raw.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
  if (!match) throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON missing from ${envFile}`)
  return JSON.parse(match[1])
}

function initDb() {
  const serviceAccount = readServiceAccount()
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id || projectId })
  }
  return getFirestore()
}

async function countCollection(db, name) {
  const snap = await db.collection(name).count().get()
  return snap.data().count
}

async function counts(db) {
  const names = [
    "pa-outbound",
    "pa-privacy-requests",
    "pa-launch-readiness-snapshots",
    "pa-outreach-stop-controls",
  ]
  const entries = await Promise.all(names.map(async (name) => [name, await countCollection(db, name)]))
  return Object.fromEntries(entries)
}

async function fetchStatus(url, init) {
  const response = await fetch(url, {
    redirect: "manual",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  })
  let body = ""
  try {
    body = await response.text()
  } catch {
    body = ""
  }
  return {
    url,
    status: response.status,
    location: response.headers.get("location") || undefined,
    bodyPrefix: body.slice(0, 160),
  }
}

async function callableGate(name, data) {
  const result = await fetchStatus(`https://us-central1-${projectId}.cloudfunctions.net/${name}`, {
    method: "POST",
    body: JSON.stringify({ data }),
  })
  const body = result.bodyPrefix
  const allowed =
    result.status === 401 ||
    result.status === 403 ||
    /UNAUTHENTICATED|PERMISSION_DENIED|unauthenticated|permission-denied/i.test(body)
  if (!allowed) {
    throw new Error(`${name} did not reject unauthenticated request: ${result.status} ${body}`)
  }
  return result
}

function assertOkRoute(result) {
  if (![200, 301, 302, 307, 308].includes(result.status)) {
    throw new Error(`route smoke failed: ${result.url} -> ${result.status}`)
  }
}

function assertCountsUnchanged(before, after) {
  for (const key of Object.keys(before)) {
    if (before[key] !== after[key]) {
      throw new Error(`${key} changed during no-contact smoke: ${before[key]} -> ${after[key]}`)
    }
  }
}

const db = initDb()
const before = await counts(db)
const routes = [
  await fetchStatus("https://candidate.wekruit.com/"),
  await fetchStatus("https://candidate.wekruit.com/j/s9-smoke-route-only"),
  await fetchStatus("https://candidate.wekruit.com/me/profile"),
  await fetchStatus("https://wekruit-pa.web.app/admin/launch-readiness"),
]
for (const route of routes) assertOkRoute(route)

const callables = [
  await callableGate("paCandidatePrivacyRequest", {
    kind: "privacy_question",
    detailText: "route gate only",
    sourceSurface: "me_profile",
  }),
  await callableGate("paAdminLaunchReadinessSnapshot", {
    limit: 1,
    persistSnapshot: false,
  }),
  await callableGate("paAdminOutreachStopControl", {
    scope: "global",
    paused: true,
    reason: "unauthenticated gate smoke",
  }),
]
const after = await counts(db)
assertCountsUnchanged(before, after)

const report = {
  ok: true,
  checkedAt: new Date().toISOString(),
  noLiveSendApproved: true,
  noDestructivePrivacyApproved: true,
  before,
  after,
  routes,
  callables,
}

if (artifactPath) {
  mkdirSync(path.dirname(artifactPath), { recursive: true })
  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

console.log(JSON.stringify(report, null, 2))
