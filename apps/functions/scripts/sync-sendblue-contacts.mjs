#!/usr/bin/env node
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { pathToFileURL } from "node:url"

const PROJECT = "wekruit-5f89b"
const USERS_COLLECTION = "pa-users"
const CANDIDATE_AUTH_COLLECTION = "pa-candidate-auth"
const SENDBLUE_CONTACTS_URL = "https://api.sendblue.com/api/v2/contacts"

export function parseArgs(argv) {
  const out = {
    apply: false,
    dryRun: false,
    limit: undefined,
    candidateId: undefined,
    phone: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const [key, inlineValue] = arg.split("=", 2)
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue
      i += 1
      if (i >= argv.length || argv[i].startsWith("--")) {
        throw new Error(`${arg} requires a value`)
      }
      return argv[i]
    }
    if (arg === "--apply") out.apply = true
    else if (arg === "--dry-run") out.dryRun = true
    else if (key === "--limit") {
      const raw = readValue()
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1) throw new Error("--limit must be a positive integer")
      out.limit = n
    } else if (key === "--candidate-id") {
      out.candidateId = readValue().trim()
    } else if (key === "--phone") {
      out.phone = normalizePhone(readValue())
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (out.apply && out.dryRun) throw new Error("Use only one of --apply or --dry-run")
  if (!out.apply) out.dryRun = true
  return out
}

export function normalizePhone(value) {
  const trimmed = String(value ?? "").trim()
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  if (trimmed.startsWith("+") && digits.length >= 8) return `+${digits}`
  throw new Error(`Phone must be E.164 or a 10/11 digit US number: ${value}`)
}

export function isValidE164Phone(value) {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value)
}

export function isDemoPreviewProfile(candidate) {
  const id = String(candidate.id ?? "").toLowerCase()
  const phone = candidate.phoneE164 ?? ""
  return candidate.isDemo === true ||
    Boolean(candidate.demoSourcePool) ||
    id.startsWith("demo_layoff_") ||
    phone.startsWith("+1555")
}

export function isSyntheticTestProfile(candidate) {
  const id = String(candidate.id ?? "").toLowerCase()
  const phone = candidate.phoneE164 ?? ""
  const email = candidate.email?.toLowerCase() ?? ""
  return candidate.testMode === true ||
    id.startsWith("e2e-") ||
    id.startsWith("p9-") ||
    id.startsWith("qa") ||
    id.startsWith("recheck-") ||
    id.startsWith("synthetic") ||
    id.startsWith("verify-") ||
    id.includes("reset") ||
    id.includes("smoke") ||
    id.includes("test") ||
    phone.startsWith("+19999") ||
    phone.startsWith("+1888") ||
    phone.includes("@") ||
    email.includes("test") ||
    email.endsWith("@example.com") ||
    email.endsWith("@local")
}

export function isInternalOperatorProfile(candidate) {
  const email = candidate.email?.trim().toLowerCase() ?? ""
  return email.endsWith("@wekruit.com")
}

export function splitDisplayName(displayName) {
  const tokens = String(displayName ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0) return { firstName: "Candidate", lastName: "" }
  const [firstName, ...rest] = tokens
  return { firstName, lastName: rest.join(" ") }
}

export function buildContactPayload(candidate) {
  const { firstName, lastName } = splitDisplayName(candidate.displayName)
  return {
    number: candidate.phoneE164,
    first_name: firstName,
    last_name: lastName,
    update_if_exists: true,
  }
}

export function candidateSkipReason(candidate, registeredCandidateIds) {
  if (isDemoPreviewProfile(candidate)) return "demo_preview"
  if (isSyntheticTestProfile(candidate)) return "synthetic_test"
  if (isInternalOperatorProfile(candidate)) return "internal_operator"
  if (!registeredCandidateIds.has(candidate.id)) return "not_registered"
  if (!isValidE164Phone(candidate.phoneE164)) return "missing_valid_phone"
  return null
}

export function buildSyncPlan(candidates, registeredCandidateIds, options = {}) {
  const skipped = new Map()
  const eligible = []
  for (const candidate of candidates) {
    const reason = candidateSkipReason(candidate, registeredCandidateIds)
    if (reason) {
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1)
      continue
    }
    eligible.push({
      candidateId: candidate.id,
      displayName: candidate.displayName ?? null,
      phoneE164: candidate.phoneE164,
      payload: buildContactPayload(candidate),
    })
    if (options.limit && eligible.length >= options.limit) break
  }
  return {
    scanned: candidates.length,
    eligible,
    skipped: Object.fromEntries([...skipped.entries()].sort(([a], [b]) => a.localeCompare(b))),
  }
}

function initFirebase() {
  if (getApps().length) return
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inline) {
    initializeApp({ credential: cert(JSON.parse(inline)), projectId: PROJECT })
    return
  }
  initializeApp({ credential: applicationDefault(), projectId: PROJECT })
}

async function loadRegisteredCandidateIds(db) {
  const out = new Set()
  const snap = await db.collection(CANDIDATE_AUTH_COLLECTION).limit(5000).get()
  for (const doc of snap.docs) {
    const candidateId = doc.get("candidateId")
    if (typeof candidateId === "string" && candidateId.trim()) out.add(candidateId.trim())
  }
  return out
}

async function loadCandidates(db, options) {
  if (options.candidateId) {
    const doc = await db.collection(USERS_COLLECTION).doc(options.candidateId).get()
    return doc.exists ? [{ id: doc.id, ...doc.data() }] : []
  }
  if (options.phone) {
    const snap = await db.collection(USERS_COLLECTION).where("phoneE164", "==", options.phone).limit(20).get()
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  }
  const snap = await db.collection(USERS_COLLECTION).orderBy("createdAt", "desc").limit(2000).get()
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
}

async function readJson(resp) {
  const text = await resp.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

export async function syncContactToSendblue(payload, env = process.env, fetchImpl = fetch) {
  const apiKeyId = env.SENDBLUE_API_KEY_ID?.trim()
  const apiSecretKey = env.SENDBLUE_API_SECRET_KEY?.trim()
  if (!apiKeyId || !apiSecretKey) {
    throw new Error("Sendblue credentials missing: SENDBLUE_API_KEY_ID / SENDBLUE_API_SECRET_KEY")
  }
  const resp = await fetchImpl(SENDBLUE_CONTACTS_URL, {
    method: "POST",
    headers: {
      "sb-api-key-id": apiKeyId,
      "sb-api-secret-key": apiSecretKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })
  const body = await readJson(resp)
  if (!resp.ok) {
    throw new Error(`Sendblue Contacts API HTTP ${resp.status}: ${JSON.stringify(body)}`)
  }
  return body
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  initFirebase()
  const db = getFirestore()
  const [registeredCandidateIds, candidates] = await Promise.all([
    loadRegisteredCandidateIds(db),
    loadCandidates(db, options),
  ])
  const plan = buildSyncPlan(candidates, registeredCandidateIds, { limit: options.limit })
  const result = {
    mode: options.apply ? "apply" : "dry-run",
    scanned: plan.scanned,
    eligible: plan.eligible.length,
    skipped: plan.skipped,
    contacts: plan.eligible,
    applied: [],
  }
  if (options.apply) {
    for (const item of plan.eligible) {
      const response = await syncContactToSendblue(item.payload)
      result.applied.push({ candidateId: item.candidateId, phoneE164: item.phoneE164, response })
    }
  }
  console.log(JSON.stringify(result, null, 2))
  return result
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
