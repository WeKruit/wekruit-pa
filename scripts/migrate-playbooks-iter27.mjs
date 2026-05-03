#!/usr/bin/env node
/**
 * iter27 — migrate Firestore pa-playbooks: add routingHint + broaden vent regex.
 *
 * Required env: FIREBASE_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS).
 * Run from repo root:
 *   FIREBASE_SERVICE_ACCOUNT_JSON=$(grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" .env | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//') \
 *     node scripts/migrate-playbooks-iter27.mjs
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

const VENT_TRIGGERS_BROADENED = [
  // zh — original
  "烦死", "烦透", "崩溃", "崩了", "累死", "想哭", "我裂开",
  "受不了", "压力大", "破防", "emo", "丧",
  // zh — iter24/27 broadened (real-user observed)
  "焦虑", "睡不着", "睡不好", "撑不住", "翻车",
  "喘不过气", "喘不上气", "自我怀疑", "心慌", "心烦",
  "心情不好", "麻了", "不行了", "要疯了", "垮了",
  "(感觉|觉得).{0,5}(不行|没用|没希望|没意思|累|空|废|loser|失败)",
  // en — original
  "I'm so done", "I can'?t", "fed up", "burnt out", "burned out",
  "breaking down", "I'?m losing it", "going to lose it",
  "exhausted", "drained",
  // en — iter27 broadened
  "anxious", "anxiety", "can'?t sleep", "panicking", "overwhelmed",
  "hopeless", "spiraling", "self[-\\s]?doubt", "doubting myself",
  "imposter", "worthless",
  "tanked (my|the) interview", "bombed (my|the) interview",
]

const ROUTING_HINTS = {
  vent_support: "no_chain",
  motivation_nudge: "no_chain",
  interview_prep: "no_chain",
  negotiation: "no_chain",
  jd_roast: "role_chain",
  headhunter: "role_chain",
}

const now = new Date().toISOString()
const actor = "iter27-migrate@wekruit.com"
const reason = "iter27 — single source of truth: Firestore playbook regex + routingHint replaces onboarding-intent.ts duplication"

async function main() {
  const snap = await db.collection("pa-playbooks").get()
  console.log(`Found ${snap.size} playbooks`)

  for (const doc of snap.docs) {
    const data = doc.data()
    const key = doc.id
    const updates = {}
    let changed = false

    // 1. Add routingHint if missing
    const desired = ROUTING_HINTS[key]
    if (desired && data.routingHint !== desired) {
      updates.routingHint = desired
      changed = true
    }

    // 2. Broaden vent_support regex
    if (key === "vent_support") {
      const current = JSON.stringify(data.regexTriggers ?? [])
      const next = JSON.stringify(VENT_TRIGGERS_BROADENED)
      if (current !== next) {
        updates.regexTriggers = VENT_TRIGGERS_BROADENED
        changed = true
      }
    }

    if (!changed) {
      console.log(`  ${key}: no changes (routingHint=${data.routingHint ?? "null"}, ${(data.regexTriggers ?? []).length} regex)`)
      continue
    }

    updates.version = (data.version ?? 0) + 1
    updates.updatedAt = now
    updates.updatedBy = actor
    updates.reason = reason

    await doc.ref.set(updates, { merge: true })

    // Audit row
    await db.collection("pa-audit-events").add({
      actor,
      action: "playbook.update",
      key,
      oldValue: {
        routingHint: data.routingHint ?? null,
        regexTriggersCount: (data.regexTriggers ?? []).length,
      },
      newValue: {
        routingHint: updates.routingHint ?? data.routingHint ?? null,
        regexTriggersCount: (updates.regexTriggers ?? data.regexTriggers ?? []).length,
      },
      reason,
      ts: now,
    })

    console.log(`  ${key}: UPDATED → routingHint=${updates.routingHint ?? data.routingHint}, regex=${(updates.regexTriggers ?? data.regexTriggers).length}`)
  }
  console.log("Migration complete")
}
main().catch((e) => { console.error(e); process.exit(1) })
