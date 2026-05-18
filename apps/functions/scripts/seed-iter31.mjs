#!/usr/bin/env node
/**
 * iter31 — seed Firestore for biz-test launch:
 *   - pa-remote-config/platform.tosVersion = "v1.0"
 *   - pa-feature-flags/paOnboardingTosGateEnabled = ON (rollout 100% beta-v1)
 *   - pa-feature-flags/paOnboardingEmailVerifyEnabled = ON (rollout 100% beta-v1)
 *
 * Idempotent: safe to re-run.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *     node apps/functions/scripts/seed-iter31.mjs
 *
 * Or with gcloud ADC:
 *   gcloud auth application-default login
 *   node apps/functions/scripts/seed-iter31.mjs
 */
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

const PROJECT_ID = process.env.PA_FIREBASE_PROJECT_ID || "wekruit-5f89b"
const TOS_VERSION = process.env.PA_TOS_VERSION || "v1.0"

if (!getApps().length) {
  initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
}
const db = getFirestore()

async function main() {
  const now = new Date().toISOString()
  // ToS version
  await db.collection("pa-remote-config").doc("platform").set(
    { tosVersion: TOS_VERSION, tosVersionUpdatedAt: now },
    { merge: true }
  )
  console.log(`✓ pa-remote-config/platform.tosVersion = "${TOS_VERSION}"`)

  // Feature flags
  const flags = [
    {
      key: "paOnboardingV33Enabled",
      value: true,
      description:
        "iter33 beta flow — email→verify→ToS reorder + CV " +
        "analysis output + 2-job-rec push. Default true (post-merge). " +
        "Operator may set false (or env PA_ONBOARDING_V33_DISABLED=true) " +
        "to fall back to iter32 sequence in an emergency. Wider rollback " +
        "(reorder revert) needs git revert of iter33 P2 commit.",
    },
    {
      key: "paOnboardingTosGateEnabled",
      value: true,
      description:
        "iter31 — Privacy + ToS acceptance step before role probe. " +
        "When ON, first_mes_sent → ask_q_tos. State advances on user " +
        "reply matching accept regex; decline / unclear stays at q_tos_asked.",
    },
    {
      key: "paOnboardingEmailVerifyEnabled",
      value: true,
      description:
        "iter31 — Mailgun verification step after q_email_asked. When " +
        "ON and user supplied a parseable email, state routes to " +
        "ask_q_email_verify; orchestrator dispatches Mailgun + persists " +
        "sha256 hash. User replies code over SMS to verify.",
    },
  ]
  for (const f of flags) {
    // iter32 deploy-fix 2026-05-04 — write the canonical FlagDoc shape
    // (`value` + `type` + `scope`) that getFlag() actually reads.
    // Previous version wrote `defaultValue` + `rollout`, which getFlag
    // ignored → flag read as `undefined !== true` → returned false →
    // ToS gate + email verify never fired in production despite the
    // seed script reporting "ON".
    await db.collection("pa-feature-flags").doc(f.key).set(
      {
        key: f.key,
        value: f.value,
        type: "bool",
        scope: "global",
        allowlist: [],
        blocklist: [],
        bucketStrategy: null,
        description: f.description,
        updatedAt: now,
        updatedBy: "seed-iter31",
        version: 2,
      },
      { merge: true }
    )
    console.log(`✓ pa-feature-flags/${f.key} = ${f.value}`)
  }
  console.log("\nNext steps:")
  console.log(
    "  1. Set Mailgun secrets: firebase functions:secrets:set MAILGUN_API_KEY MAILGUN_DOMAIN MAILGUN_FROM"
  )
  console.log("  2. Deploy: cd apps/functions && pnpm run deploy")
  console.log("  3. Verify: node apps/functions/scripts/audit-mvp-state.mjs")
}

main().catch((e) => {
  console.error("fatal", e)
  process.exit(1)
})
