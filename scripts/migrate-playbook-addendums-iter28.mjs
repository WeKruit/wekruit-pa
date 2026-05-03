#!/usr/bin/env node
/**
 * iter28 — re-write Firestore playbook addendums:
 * - Replace "卧" (alone) → "卧槽" (full slang per Adam directive)
 * - Remove "X 还是 Y" AB-framework examples from positive instructions
 * - Add explicit NEVER-AB rule to each playbook
 *
 * Imports addendums + triggers from compiled @pa/agent-registry build.
 */
import { readFileSync } from "node:fs"
import { initializeApp, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

function getCreds() {
  const j = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (j) return JSON.parse(j)
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (path) return JSON.parse(readFileSync(path, "utf8"))
  throw new Error("set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS")
}
const sa = getCreds()
initializeApp({ credential: cert(sa), projectId: sa.project_id })
const db = getFirestore()

const reg = await import("../packages/agent-registry/dist/playbooks.js")
const SPEC = [
  ["headhunter", reg.HEADHUNTER_DEFAULT_ADDENDUM, reg.HEADHUNTER_DEFAULT_TRIGGERS],
  ["vent_support", reg.VENT_SUPPORT_ADDENDUM, reg.VENT_SUPPORT_TRIGGERS],
  ["motivation_nudge", reg.MOTIVATION_NUDGE_ADDENDUM, reg.MOTIVATION_NUDGE_TRIGGERS],
  ["jd_roast", reg.JD_ROAST_ADDENDUM, reg.JD_ROAST_TRIGGERS],
  ["interview_prep", reg.INTERVIEW_PREP_ADDENDUM, reg.INTERVIEW_PREP_TRIGGERS],
  ["negotiation", reg.NEGOTIATION_ADDENDUM, reg.NEGOTIATION_TRIGGERS],
]
const now = new Date().toISOString()
const actor = "iter28-addendum-fix@wekruit.com"
const reason = "iter28 — Adam: 卧→卧槽 + remove AB-framework examples from addendums"

for (const [key, addendum, triggers] of SPEC) {
  const ref = db.collection("pa-playbooks").doc(key)
  const cur = (await ref.get()).data() || {}
  const updates = {
    addendum,
    regexTriggers: [...triggers],
    version: (cur.version || 0) + 1,
    updatedAt: now,
    updatedBy: actor,
    reason,
  }
  await ref.set(updates, { merge: true })
  await db.collection("pa-audit-events").add({
    actor,
    action: "playbook.update",
    key,
    oldValue: { addendumLen: (cur.addendum || "").length, triggers: (cur.regexTriggers || []).length },
    newValue: { addendumLen: addendum.length, triggers: triggers.length },
    reason,
    ts: now,
  })
  console.log(`  ${key}: addendumLen=${addendum.length} triggers=${triggers.length}`)
}
console.log("Done")
