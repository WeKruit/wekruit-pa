/**
 * Admin bootstrap CF — admin-token-protected seeds + fixture replays.
 *
 * Spawned 2026-04-28 to bypass local-laptop GCP ADC auth issues
 * (`invalid_grant`) blocking seed-feature-flags.ts from a workstation.
 * CF runs with default credentials inside Cloud Run = Firestore writes work.
 *
 * Endpoints:
 *   POST /paAdminBootstrap  body={action: "seedFlags"}    Header x-admin-token
 *   POST /paAdminBootstrap  body={action: "ping"}          (sanity check)
 *
 * All actions require x-admin-token === PA_ADMIN_TOKEN secret.
 */

import { onRequest } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { getFirestore, FieldValue } from "firebase-admin/firestore"
import { getApps, initializeApp } from "firebase-admin/app"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const FLAGS_COLLECTION = "pa_feature_flags"
const AUDIT_COLLECTION = "pa_audit_events"
const SEED_ACTOR = "p9-infra-seed@wekruit.com"
const SEED_REASON = "Phase 24.5 initial seed via paAdminBootstrap CF"

interface FlagSpec {
  key: string
  value: boolean | number
  type: "bool" | "number"
  scope: "global" | "perUser"
  allowlist: string[]
  blocklist: string[]
}

const SEED_FLAGS: FlagSpec[] = [
  { key: "PA_CHANNEL_LEGACY", value: false, type: "bool", scope: "global", allowlist: [], blocklist: [] },
  { key: "PA_PROACTIVE_DISABLED", value: false, type: "bool", scope: "global", allowlist: [], blocklist: [] },
  { key: "PA_VOICE_MIRROR_DISABLED", value: false, type: "bool", scope: "global", allowlist: [], blocklist: [] },
  { key: "paRateLimitPerUserEnabled", value: true, type: "bool", scope: "perUser", allowlist: [], blocklist: [] },
  { key: "selfEvolveEnabled", value: false, type: "bool", scope: "global", allowlist: [], blocklist: [] },
  { key: "voiceEvalAutoRerun", value: false, type: "bool", scope: "global", allowlist: [], blocklist: [] },
  { key: "sendblueDailyQuota", value: 1000, type: "number", scope: "global", allowlist: [], blocklist: [] },
]

function checkAdminToken(provided: string | undefined): { ok: boolean; status: number; error?: string } {
  // Firebase Secret Manager preserves trailing newlines from the original
  // input — we trim both sides defensively so token compare is robust.
  const expectedRaw = process.env.PA_ADMIN_TOKEN
  const expected = expectedRaw ? expectedRaw.trim() : ""
  if (!expected) return { ok: false, status: 503, error: "admin token not configured" }
  const provTrim = (provided ?? "").trim()
  if (!provTrim) return { ok: false, status: 401, error: "missing x-admin-token header" }
  if (provTrim !== expected) return { ok: false, status: 401, error: "invalid admin token" }
  return { ok: true, status: 200 }
}

async function seedFlags(): Promise<{ created: string[]; skipped: string[] }> {
  if (!getApps().length) initializeApp()
  const db = getFirestore()
  const created: string[] = []
  const skipped: string[] = []

  for (const f of SEED_FLAGS) {
    const ref = db.collection(FLAGS_COLLECTION).doc(f.key)
    const snap = await ref.get()
    if (snap.exists) {
      skipped.push(f.key)
      continue
    }

    const batch = db.batch()
    batch.set(ref, {
      key: f.key,
      value: f.value,
      type: f.type,
      scope: f.scope,
      allowlist: f.allowlist,
      blocklist: f.blocklist,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: SEED_ACTOR,
      reason: SEED_REASON,
      version: 1,
    })

    const auditRef = db.collection(AUDIT_COLLECTION).doc()
    batch.set(auditRef, {
      actor: SEED_ACTOR,
      action: "flag.create",
      key: f.key,
      oldValue: null,
      newValue: f.value,
      reason: SEED_REASON,
      ts: FieldValue.serverTimestamp(),
    })
    await batch.commit()
    created.push(f.key)
  }
  return { created, skipped }
}

export const paAdminBootstrap = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 60,
    cors: false,
    secrets: [PA_ADMIN_TOKEN],
  },
  async (req, res) => {
    const auth = checkAdminToken(req.header("x-admin-token") ?? undefined)
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error })
      return
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" })
      return
    }

    const action = (req.body && typeof req.body === "object" && (req.body as { action?: string }).action) || ""

    try {
      if (action === "ping") {
        res.json({ ok: true, action, ts: new Date().toISOString() })
        return
      }
      if (action === "seedFlags") {
        const result = await seedFlags()
        res.json({ ok: true, action, ...result })
        return
      }
      res.status(400).json({ error: "unknown_action", supported: ["ping", "seedFlags"] })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      res.status(500).json({ error: "internal", message: msg })
    }
  }
)
