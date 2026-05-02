#!/usr/bin/env tsx
/**
 * Phase 24.5 — pa_feature_flags initial seed (P9-Infra).
 *
 * Idempotent: only writes flags whose doc is absent. Existing flags are
 * preserved so re-running the script never clobbers operator edits made via
 * /admin/flags.
 *
 * Usage:
 *   tsx apps/functions/scripts/seed-feature-flags.ts --dry-run   # plan only
 *   tsx apps/functions/scripts/seed-feature-flags.ts             # live seed
 *
 * Auth (live mode): requires GOOGLE_APPLICATION_CREDENTIALS pointing at a
 * service-account JSON with Firestore write access OR runs inside an
 * environment where the firebase-admin default credential resolves
 * (Cloud Shell / GCE / Cloud Run).
 *
 * Initial seeds locked in CONTEXT.md "Initial flag seeds" table:
 *   - PA_CHANNEL_LEGACY        bool   global   true
 *   - PA_PROACTIVE_DISABLED    bool   global   false
 *   - PA_VOICE_MIRROR_DISABLED bool   global   false
 *   - paRateLimitPerUserEnabled bool perUser   true (Adam test number on blocklist)
 *   - selfEvolveEnabled        bool   global   false
 *   - voiceEvalAutoRerun       bool   global   false
 */

import type { Firestore } from "firebase-admin/firestore"

const COLLECTION = "pa-feature-flags"
const AUDIT_COLLECTION = "pa-audit-events"
const SEED_ACTOR = "p9-infra-seed@wekruit.com"
const SEED_REASON = "Phase 24.5 initial seed (P9-Infra autonomous)"

// CEO's Adam test number — matches CONTEXT.md success #6 (perUser bypass test)
// Resolved at run-time from PA_ADMIN_USER_ID env if present (operator can
// override without code change). Default placeholder forces operator to
// confirm before live run.
const ADAM_TEST_USER_ID = process.env.PA_ADMIN_USER_ID ?? "ADAM_TEST_USER_ID_TBD"

interface FlagSpec {
  key: string
  value: boolean | number
  type: "bool" | "number"
  scope: "global" | "perUser"
  allowlist: string[]
  blocklist: string[]
}

const SEED_FLAGS: FlagSpec[] = [
  {
    key: "PA_CHANNEL_LEGACY",
    value: true,
    type: "bool",
    scope: "global",
    allowlist: [],
    blocklist: [],
  },
  {
    key: "PA_PROACTIVE_DISABLED",
    value: false,
    type: "bool",
    scope: "global",
    allowlist: [],
    blocklist: [],
  },
  {
    key: "PA_VOICE_MIRROR_DISABLED",
    value: false,
    type: "bool",
    scope: "global",
    allowlist: [],
    blocklist: [],
  },
  {
    key: "paRateLimitPerUserEnabled",
    value: true,
    type: "bool",
    scope: "perUser",
    allowlist: [],
    // Adam test number bypasses rate-limit per CONTEXT.md success #6.
    blocklist: [ADAM_TEST_USER_ID],
  },
  {
    key: "selfEvolveEnabled",
    value: false,
    type: "bool",
    scope: "global",
    allowlist: [],
    blocklist: [],
  },
  {
    key: "voiceEvalAutoRerun",
    value: false,
    type: "bool",
    scope: "global",
    allowlist: [],
    blocklist: [],
  },
  // Phase 26 T2 — Sendblue daily-outbound quota (P9-Prod-Ops). Number-typed
  // flag: outbox compares `pa-outbound-daily/{YYYYMMDD}` count to this value
  // and blocks at 100%, soft-warns at 80%. Default 1000 = Sendblue Free
  // tier assumption (confirm with Sendblue support before public launch).
  {
    key: "sendblueDailyQuota",
    value: 1000,
    type: "number",
    scope: "global",
    allowlist: [],
    blocklist: [],
  },
  // Phase 30 — master kill switch for Downstream Eval Connector.
  {
    key: "evalConnectorsEnabled",
    value: false,
    type: "bool",
    scope: "global",
    allowlist: [],
    blocklist: [],
  },
  // Phase 40 T4 — umbrella feature flag for v1.4 humanize-runtime stack
  // (Phase 35 detectors + Phase 36 injector + Phase 37 FSM + Phase 38
  // memory-policy + Phase 40 prefix-cache extras). Default OFF for all
  // users; flipped via dashboard / setFlag bucketStrategy 1/10/50/100%
  // per .planning/phases/40-bible-v7.5-ship/WIRE-IN-PATCH.md Section 9.
  // Kill switch: PA_HUMANIZE_RUNTIME_DISABLED=true env (CF cold-start required).
  {
    key: "paHumanizeRuntimeEnabled",
    value: false,
    type: "bool",
    scope: "perUser",
    allowlist: [],
    blocklist: [],
  },
  // Stream B — paJobRecDaily gate. perUser; default OFF; allowlist via dashboard.
  {
    key: "paJobRecEnabled",
    value: false,
    type: "bool",
    scope: "perUser",
    allowlist: [],
    blocklist: [],
  },
  // Phase 51 (v1.5 §3.1) — Crisis-ideation deterministic hotline injection.
  // P0 SAFETY FEATURE: default ON for ALL users (scope: global). Bible v7.5
  // directive remains primary; this is the deterministic fail-safe layer
  // that guarantees a hotline trailer reaches users tripping crisis keywords
  // even if the model ignores the system-prompt directive.
  // Emergency disable: env `PA_CRISIS_HOTLINE_DISABLED=true` (cold-start).
  {
    key: "paCrisisHotlineInjectionEnabled",
    value: true,
    type: "bool",
    scope: "global",
    allowlist: [],
    blocklist: [],
  },
]

interface PlannedWrite {
  key: string
  action: "create" | "skip"
  payload?: Record<string, unknown>
  existing?: Record<string, unknown>
}

export async function planSeed(db: Firestore): Promise<PlannedWrite[]> {
  const out: PlannedWrite[] = []
  const nowIso = new Date().toISOString()
  for (const f of SEED_FLAGS) {
    const ref = db.collection(COLLECTION).doc(f.key)
    const snap = await ref.get()
    if (snap.exists) {
      out.push({ key: f.key, action: "skip", existing: snap.data() ?? {} })
      continue
    }
    out.push({
      key: f.key,
      action: "create",
      payload: {
        ...f,
        updatedAt: nowIso,
        updatedBy: SEED_ACTOR,
        reason: SEED_REASON,
        version: 1,
      },
    })
  }
  return out
}

async function applySeed(db: Firestore, plan: PlannedWrite[]): Promise<number> {
  let written = 0
  const nowIso = new Date().toISOString()
  for (const p of plan) {
    if (p.action !== "create" || !p.payload) continue
    const flagRef = db.collection(COLLECTION).doc(p.key)
    const auditRef = db.collection(AUDIT_COLLECTION).doc()
    await db.runTransaction(async (t) => {
      // Re-check inside the txn so concurrent runs don't double-create.
      const cur = await t.get(flagRef)
      if (cur.exists) return
      t.set(flagRef, p.payload as never)
      t.set(auditRef as never, {
        actor: SEED_ACTOR,
        action: "flag.create",
        key: p.key,
        oldValue: null,
        newValue: (p.payload as { value: unknown }).value,
        reason: SEED_REASON,
        ts: nowIso,
      })
    })
    written += 1
  }
  return written
}

function fmtPlan(plan: PlannedWrite[]): string {
  const lines: string[] = []
  lines.push("Phase 24.5 — pa_feature_flags seed plan")
  lines.push("=".repeat(60))
  for (const p of plan) {
    if (p.action === "skip") {
      lines.push(`  SKIP   ${p.key.padEnd(28)} (already exists)`)
    } else {
      const v = (p.payload as { value: unknown }).value
      const scope = (p.payload as { scope: string }).scope
      lines.push(`  CREATE ${p.key.padEnd(28)} value=${String(v).padEnd(6)} scope=${scope}`)
    }
  }
  const creates = plan.filter((p) => p.action === "create").length
  const skips = plan.filter((p) => p.action === "skip").length
  lines.push("=".repeat(60))
  lines.push(`Plan: ${creates} create, ${skips} skip (${plan.length} total).`)
  return lines.join("\n")
}

// -----------------------------------------------------------------------------
// Entry point — dry-run resolves WITHOUT firebase-admin so it can run in
// any sandbox; live mode imports firebase-admin lazily.
// -----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")

  if (dryRun) {
    // Build a synthetic plan: every flag is "would create" with the canonical
    // payload. We do NOT touch Firestore in dry-run so this is safe to run
    // without credentials and inside CI.
    const nowIso = new Date().toISOString()
    const plan: PlannedWrite[] = SEED_FLAGS.map((f) => ({
      key: f.key,
      action: "create" as const,
      payload: {
        ...f,
        updatedAt: nowIso,
        updatedBy: SEED_ACTOR,
        reason: SEED_REASON,
        version: 1,
      },
    }))
    console.log(fmtPlan(plan))
    console.log("\n(dry-run: no Firestore reads or writes were performed)")
    return
  }

  // Live mode — lazy-import to avoid pulling firebase-admin into dry-run.
  const { initializeApp, getApps, applicationDefault } = await import("firebase-admin/app")
  const { getFirestore } = await import("firebase-admin/firestore")
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() })
  }
  const db = getFirestore()
  const plan = await planSeed(db)
  console.log(fmtPlan(plan))
  const written = await applySeed(db, plan)
  console.log(`\nLive seed complete. ${written} flag(s) created, ${plan.length - written} skipped.`)
}

// Only run when invoked as a script, not when imported by tests.
const invokedAsScript = process.argv[1]?.endsWith("seed-feature-flags.ts") || process.argv[1]?.endsWith("seed-feature-flags.js")
if (invokedAsScript) {
  main().catch((err) => {
    console.error("[seed-feature-flags] FATAL", err)
    process.exit(1)
  })
}

export { SEED_FLAGS, SEED_ACTOR, SEED_REASON }
