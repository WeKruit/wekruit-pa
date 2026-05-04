#!/usr/bin/env node
/**
 * iter30 WS4-A — Migrate the 6 existing pa-playbooks docs to V2 metadata.
 *
 * Reads each of the 6 existing pa-playbooks docs, merges metadata via
 * `upsertPlaybook` (which writes the audit row in the same batch). Reason
 * field: "iter30 — V2 schema metadata seed (intentDescription, composability,
 * priority, allowedTools, llmInvokable)".
 *
 * Idempotency: re-running with --apply re-writes the same metadata + bumps
 * version. To revert: run revertPlaybook(db, key) — existing audit walker
 * handles it.
 *
 * Dry-run prints diffs to stdout. Apply requires explicit --apply flag.
 *
 * Usage:
 *   node apps/functions/scripts/migrate-skills-v2.mjs            # dry-run (default)
 *   node apps/functions/scripts/migrate-skills-v2.mjs --apply    # commit
 *
 * Auth (live): GOOGLE_APPLICATION_CREDENTIALS pointing at SA JSON.
 *
 * Project guard: refuses to run unless FIREBASE_PROJECT_ID matches
 *   wekruit-5f89b OR WEKRUIT_ALLOW_NON_PROD=1 set.
 */

import { initializeApp, applicationDefault, cert, getApps } from "firebase-admin/app"
import { getFirestore, FieldValue } from "firebase-admin/firestore"

const APPLY = process.argv.includes("--apply")
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? "wekruit-5f89b"
const ACTOR = "iter30-skills-v2-migrate@wekruit.com"
const REASON =
  "iter30 — V2 schema metadata seed (intentDescription, composability, priority, allowedTools, llmInvokable)"

// Inline copy of EXISTING_6_METADATA from packages/agent-registry/src/skill-defaults.ts
// Keeping this script self-contained (no @pa/agent-registry import) so it runs
// without a build step. If skill-defaults.ts changes, mirror here OR import the
// compiled dist (which requires the workspace package built first).
const EXISTING_6_METADATA = {
  headhunter: {
    intentDescription:
      "Activate when user signals job search / role change / 在看工作 / on the market. NOT for emotional distress; route vent_support if signs of burnout.",
    provides: ["stance:advisor", "tone:friend-roommate", "intent:job_search"],
    requires: [],
    composableWith: [
      "jd_roast",
      "interview_prep",
      "negotiation",
      "cv_followup",
      "referral_request",
    ],
    conflictsWith: ["vent_support"],
    priority: 40,
    allowedTools: [],
    llmInvokable: true,
    paths: [],
  },
  vent_support: {
    intentDescription:
      "Activate when user expresses emotional distress, burnout, breakdown, exhaustion, hopelessness, anxiety (zh+en). Do NOT activate when user is asking a factual question or in upbeat mood.",
    provides: ["stance:companion", "tone:vent", "mode:no_advice"],
    requires: [],
    composableWith: ["motivation_nudge", "silence_anchor", "interview_prep"],
    conflictsWith: ["headhunter", "jd_roast"],
    priority: 80,
    allowedTools: [],
    llmInvokable: true,
    paths: [],
  },
  motivation_nudge: {
    intentDescription:
      "Activate when user signals procrastination, can't start, stuck, no motivation. Distinguish from vent: this is about action-paralysis, not emotional overload.",
    provides: ["stance:companion", "tone:nudge", "mode:smallest_action"],
    requires: [],
    composableWith: ["vent_support", "interview_prep"],
    conflictsWith: [],
    priority: 60,
    allowedTools: [],
    llmInvokable: true,
    paths: [],
  },
  jd_roast: {
    intentDescription:
      "Activate when user shares a job description / asks for thoughts on a role / 帮我看 this JD / should I apply. Do NOT activate for general career chat.",
    provides: ["stance:advisor", "tone:friend-roommate", "mode:jd_review"],
    requires: [],
    composableWith: ["headhunter", "negotiation", "company_research"],
    conflictsWith: ["vent_support"],
    priority: 45,
    allowedTools: [],
    llmInvokable: true,
    paths: [],
  },
  interview_prep: {
    intentDescription:
      "Activate when user mentions an upcoming interview, prep, nervousness about a specific round (system design / coding / behavioral).",
    provides: ["stance:companion", "tone:friend-roommate", "mode:interview_prep"],
    requires: [],
    composableWith: ["headhunter", "vent_support", "motivation_nudge"],
    conflictsWith: [],
    priority: 55,
    allowedTools: [],
    llmInvokable: true,
    paths: [],
  },
  negotiation: {
    intentDescription:
      "Activate when user is comparing offers, asking how much to ask, counter-offer, 谈薪. Do NOT activate for early-stage role consideration.",
    provides: ["stance:advisor", "tone:friend-roommate", "mode:negotiation"],
    requires: [],
    composableWith: ["headhunter", "jd_roast", "post_offer_decision"],
    conflictsWith: ["vent_support"],
    priority: 50,
    allowedTools: [],
    llmInvokable: true,
    paths: [],
  },
}

const PLAYBOOKS_COLLECTION = "pa-playbooks"
const AUDIT_COLLECTION = "pa-audit-events"

// ---------------------------------------------------------------------------

function diffField(key, prev, next) {
  // Produce a one-line summary: "field: <prev> -> <next>"
  const sPrev = JSON.stringify(prev)
  const sNext = JSON.stringify(next)
  if (sPrev === sNext) return null
  return `  ${key}: ${sPrev} -> ${sNext}`
}

async function loadDoc(db, key) {
  const snap = await db.collection(PLAYBOOKS_COLLECTION).doc(key).get()
  return snap.exists ? snap.data() ?? {} : null
}

function planMigration(doc, metadata) {
  // Compute the merged payload (matches upsertPlaybook V2 fields).
  const next = {
    intentDescription: metadata.intentDescription,
    provides: metadata.provides,
    requires: metadata.requires,
    composableWith: metadata.composableWith,
    conflictsWith: metadata.conflictsWith,
    priority: metadata.priority,
    allowedTools: metadata.allowedTools,
    llmInvokable: metadata.llmInvokable,
    paths: metadata.paths ?? [],
  }
  const prev = {
    intentDescription: doc?.intentDescription ?? "",
    provides: doc?.provides ?? [],
    requires: doc?.requires ?? [],
    composableWith: doc?.composableWith ?? [],
    conflictsWith: doc?.conflictsWith ?? [],
    priority: doc?.priority ?? 50,
    allowedTools: doc?.allowedTools ?? [],
    llmInvokable: doc?.llmInvokable ?? true,
    paths: doc?.paths ?? [],
  }
  const diffs = []
  for (const k of Object.keys(next)) {
    const d = diffField(k, prev[k], next[k])
    if (d) diffs.push(d)
  }
  return { prev, next, diffs }
}

async function applyMigration(db, key, doc, metadata) {
  const ts = new Date().toISOString()
  const playbookRef = db.collection(PLAYBOOKS_COLLECTION).doc(key)
  const auditRef = db.collection(AUDIT_COLLECTION).doc()
  const nextVersion = (doc?.version ?? 0) + 1

  // V1 fields preserved as-is from prev doc; V2 fields overlaid.
  const payload = {
    playbookKey: key,
    name: doc?.name ?? key,
    description: doc?.description ?? "",
    regexTriggers: doc?.regexTriggers ?? [],
    addendum: doc?.addendum ?? "",
    enabled: doc?.enabled ?? true,
    routingHint: doc?.routingHint ?? null,
    version: nextVersion,
    updatedAt: ts,
    updatedBy: ACTOR,
    reason: REASON,
    // V2 metadata seed
    intentDescription: metadata.intentDescription,
    provides: metadata.provides,
    requires: metadata.requires,
    composableWith: metadata.composableWith,
    conflictsWith: metadata.conflictsWith,
    priority: metadata.priority,
    allowedTools: metadata.allowedTools,
    llmInvokable: metadata.llmInvokable,
    paths: metadata.paths ?? [],
  }

  const auditPayload = {
    actor: ACTOR,
    action: "playbook.update",
    key,
    oldValue: doc
      ? {
          name: doc.name,
          description: doc.description,
          regexTriggers: doc.regexTriggers,
          addendum: doc.addendum,
          enabled: doc.enabled,
          // V2 fields from prev (likely all defaults pre-iter30)
          intentDescription: doc.intentDescription ?? "",
          provides: doc.provides ?? [],
          composableWith: doc.composableWith ?? [],
          conflictsWith: doc.conflictsWith ?? [],
          priority: doc.priority ?? 50,
          allowedTools: doc.allowedTools ?? [],
          llmInvokable: doc.llmInvokable ?? true,
        }
      : null,
    newValue: {
      name: payload.name,
      description: payload.description,
      regexTriggers: payload.regexTriggers,
      addendum: payload.addendum,
      enabled: payload.enabled,
      intentDescription: payload.intentDescription,
      provides: payload.provides,
      composableWith: payload.composableWith,
      conflictsWith: payload.conflictsWith,
      priority: payload.priority,
      allowedTools: payload.allowedTools,
      llmInvokable: payload.llmInvokable,
    },
    reason: REASON,
    ts,
  }

  const batch = db.batch()
  batch.set(playbookRef, payload, { merge: true })
  batch.set(auditRef, auditPayload)
  await batch.commit()
  return { version: nextVersion, ts }
}

// ---------------------------------------------------------------------------

async function main() {
  // Project guard
  const allowNonProd = process.env.WEKRUIT_ALLOW_NON_PROD === "1"
  if (!allowNonProd && PROJECT_ID !== "wekruit-5f89b") {
    console.error(
      `[migrate-skills-v2] FATAL: refusing to run against project '${PROJECT_ID}'. ` +
        `Set WEKRUIT_ALLOW_NON_PROD=1 to override.`
    )
    process.exit(2)
  }

  // Initialize Firebase Admin
  if (!getApps().length) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (credPath) {
      initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
    } else {
      // Fallback to ADC (gcloud auth application-default login).
      initializeApp({ projectId: PROJECT_ID })
    }
  }
  const db = getFirestore()

  console.log(
    `[migrate-skills-v2] mode=${APPLY ? "APPLY" : "DRY-RUN"} project=${PROJECT_ID} actor=${ACTOR}`
  )

  const keys = Object.keys(EXISTING_6_METADATA)
  let totalDiffs = 0
  const summary = []

  for (const key of keys) {
    const metadata = EXISTING_6_METADATA[key]
    const doc = await loadDoc(db, key)
    if (!doc) {
      console.log(`[${key}] SKIP — Firestore doc not found (expected for unseeded skills).`)
      summary.push({ key, status: "skip-missing" })
      continue
    }
    const { diffs } = planMigration(doc, metadata)
    if (diffs.length === 0) {
      console.log(`[${key}] no-op — V2 metadata already matches.`)
      summary.push({ key, status: "no-op" })
      continue
    }
    console.log(`[${key}] ${APPLY ? "APPLYING" : "WOULD APPLY"} ${diffs.length} field changes:`)
    for (const d of diffs) console.log(d)
    totalDiffs += diffs.length

    if (APPLY) {
      const result = await applyMigration(db, key, doc, metadata)
      console.log(`[${key}] APPLIED — version ${result.version}, ts ${result.ts}`)
      summary.push({ key, status: "applied", version: result.version })
    } else {
      summary.push({ key, status: "dry-run", diffCount: diffs.length })
    }
  }

  console.log("")
  console.log("=== Summary ===")
  for (const s of summary) console.log(JSON.stringify(s))
  console.log(
    `Total field-diffs: ${totalDiffs} across ${summary.length} skills. Mode: ${APPLY ? "APPLIED" : "DRY-RUN"}.`
  )

  // Avoid unused-import warning
  void FieldValue
}

main().catch((err) => {
  console.error("[migrate-skills-v2] FATAL:", err?.stack ?? err)
  process.exit(1)
})
