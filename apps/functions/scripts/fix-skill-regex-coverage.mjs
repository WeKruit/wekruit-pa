#!/usr/bin/env node
/**
 * iter30 V2 QA Wave 2 — REGEX COVERAGE FIX.
 *
 * Adds 9 missing regex trigger patterns across 6 skills, found by V2 QA Agent-B
 * matrix run (38 cases). All additions verified collision-free against full
 * 38-case corpus via /Users/adam/.../validate-regex-iter30-coverage.mjs.
 *
 * Skills affected (regex-only delta, no addendum touch):
 *   1. headhunter            +3 EN patterns ("looking for a job", etc.)
 *   2. motivation_nudge      +3 EN patterns ("can't bring myself to")
 *   3. negotiation           +5 mixed patterns (counter-offer EN/ZH)
 *   4. rejection_processing  +3 EN patterns ("got rejected", company+rejected)
 *   5. cv_followup           +3 mixed patterns (read-resume ZH/EN, was empty[])
 *   6. career_pivot          +6 mixed patterns (想从 X 转, pivoting from)
 *
 * Idempotent — re-runs are no-op (set-difference on regexTriggers; only adds
 * novel patterns; if all already present, version still bumps once due to
 * upsertPlaybook contract — but second re-run finds nothing to add and EXITS
 * before the write. See `--apply` flow.
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT_JSON=$(...) \
 *     node apps/functions/scripts/fix-skill-regex-coverage.mjs           # dry-run
 *   FIREBASE_SERVICE_ACCOUNT_JSON=$(...) \
 *     node apps/functions/scripts/fix-skill-regex-coverage.mjs --apply   # commit
 *
 * Audit trail: each touched skill produces a `playbook.update` audit row in
 * pa-audit-events with the diff (oldValue.regexTriggers vs newValue).
 */

import admin from "firebase-admin"

const APPLY = process.argv.includes("--apply")
const ACTOR = "iter30-qa-wave2-regex-coverage@wekruit.com"
const REASON =
  "iter30 V2 QA Wave 2 — regex coverage fix for 9 trigger gaps found by Agent-B matrix"

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error("FIREBASE_SERVICE_ACCOUNT_JSON env var required")
  process.exit(2)
}

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

// ---------------------------------------------------------------------------
// Patterns to add per skill. Strings = stored verbatim in Firestore (compiled
// at runtime via `new RegExp(pattern, 'i')`). Each pattern verified non-empty
// hit on its target case AND non-empty for ZERO unrelated cases (see
// validate-regex-iter30-coverage.mjs full-corpus check above).
// ---------------------------------------------------------------------------
const ADDITIONS = {
  headhunter: [
    "\\b(?:looking|search(?:ing)?)\\s+for\\s+(?:a\\s+)?(?:new\\s+)?(?:job|role|gig|position|opportunity)\\b",
    "\\b(?:job|role|opportunity)\\s+(?:hunt|hunting|search)\\b",
    "\\b(?:on\\s+the\\s+market|getting\\s+back\\s+out\\s+there)\\b",
  ],
  motivation_nudge: [
    "can(?:'t|not)\\s+bring\\s+myself\\s+to",
    "\\b(?:lack|no)\\s+motivation\\b",
    "\\bbring\\s+myself\\s+to\\s+(?:start|begin|do)",
  ],
  negotiation: [
    "\\d+\\s*(?:个)?\\s*offer.{0,15}counter",
    "\\bcounter\\s+(?:the\\s+|my\\s+|a\\s+|an\\s+)?(?:\\w+\\s+)?offer",
    "\\bcompare\\s+(?:these|the|2|two|multiple)\\s+offer",
    "怎么\\s*counter",
    "谈薪|讨价",
  ],
  rejection_processing: [
    "\\bgot\\s+rejected\\b",
    "\\b(?:meta|google|stripe|amazon|coinbase|airbnb|apple|microsoft|netflix|uber)\\s+(?:rejected|declined|passed\\s+on)",
    "\\b(?:rejection|denial)\\s+(?:email|letter|notice)\\b",
  ],
  cv_followup: [
    "(?:你|有)?\\s*看(?:过|了)?\\s*我\\s*简历",
    "\\b(?:did|have)\\s+you\\s+(?:see(?:n)?|read|review(?:ed)?)\\s+my\\s+(?:resume|cv)\\b",
    "\\b(?:thoughts|opinion|feedback)\\s+on\\s+my\\s+(?:resume|cv)\\b",
  ],
  career_pivot: [
    "想从.{1,15}转",
    "从.{1,10}转\\s*(?:PM|EM|IC|管理|design|frontend|backend|product|infra|sales|eng|engineer)",
    "(?:转|换).{0,5}(?:方向|赛道)",
    "\\b(?:think(?:ing)?|considering|consider)\\s+(?:about\\s+)?pivot(?:ing)?\\b",
    "\\bpivot(?:ing)?\\s+from\\s+\\w",
    "\\b(?:switch|move)\\s+(?:from|to)\\s+(?:eng|engineering|pm|product|ic|management|design|frontend|backend)\\b",
  ],
}

function nowIso() {
  return new Date().toISOString()
}

function diff(prev, addPats) {
  const set = new Set(prev || [])
  const novel = []
  const dup = []
  for (const p of addPats) {
    if (set.has(p)) dup.push(p)
    else novel.push(p)
  }
  return { novel, dup }
}

async function loadPlaybook(key) {
  const snap = await db.collection("pa-playbooks").doc(key).get()
  if (!snap.exists) return null
  return { id: key, ...snap.data() }
}

async function applyOne(key, novelPatterns, prevDoc) {
  const prevTriggers = prevDoc.regexTriggers || []
  const prevVersion = typeof prevDoc.version === "number" ? prevDoc.version : 0
  const merged = [...prevTriggers, ...novelPatterns]
  const nextVersion = prevVersion + 1
  const updatedAt = nowIso()

  // Mirror upsertPlaybook write shape — preserves V2 metadata fields, bumps
  // version, writes audit row in same batch.
  const playbookRef = db.collection("pa-playbooks").doc(key)
  const auditRef = db.collection("pa-audit-events").doc()

  const payload = {
    ...prevDoc,
    regexTriggers: merged,
    version: nextVersion,
    updatedAt,
    updatedBy: ACTOR,
    reason: REASON,
  }
  // strip the synthetic id field if it leaked in via load
  delete payload.id

  const auditPayload = {
    actor: ACTOR,
    action: "playbook.update",
    key,
    oldValue: {
      name: prevDoc.name,
      description: prevDoc.description,
      regexTriggers: prevTriggers,
      addendum: prevDoc.addendum,
      enabled: prevDoc.enabled,
    },
    newValue: {
      name: prevDoc.name,
      description: prevDoc.description,
      regexTriggers: merged,
      addendum: prevDoc.addendum,
      enabled: prevDoc.enabled,
    },
    reason: REASON,
    ts: updatedAt,
  }

  const batch = db.batch()
  batch.set(playbookRef, payload, { merge: true })
  batch.set(auditRef, auditPayload)
  await batch.commit()
  return { prevVersion, nextVersion, addedCount: novelPatterns.length }
}

async function main() {
  console.log(`═══ iter30 QA Wave 2 — fix-skill-regex-coverage (${APPLY ? "APPLY" : "DRY-RUN"}) ═══`)
  console.log()

  const plan = []
  for (const [key, pats] of Object.entries(ADDITIONS)) {
    const prev = await loadPlaybook(key)
    if (!prev) {
      console.log(`  [skip ] ${key}: doc not found (cannot patch a non-existent skill)`)
      continue
    }
    if (prev.enabled === false) {
      console.log(`  [warn ] ${key}: enabled=false — patching anyway (admin can re-enable)`)
    }
    const { novel, dup } = diff(prev.regexTriggers, pats)
    plan.push({ key, prev, novel, dup })
    console.log(`  [plan ] ${key}  v${prev.version}  prevCount=${(prev.regexTriggers || []).length}  +${novel.length} new  (${dup.length} already present)`)
    for (const p of novel) console.log(`             + ${p}`)
    for (const p of dup) console.log(`             ≈ (dup) ${p}`)
  }

  const totalNovel = plan.reduce((s, x) => s + x.novel.length, 0)
  console.log()
  console.log(`Plan: ${plan.length} skills touched, ${totalNovel} novel patterns to add.`)

  if (totalNovel === 0) {
    console.log("No-op (all patterns already present). Exit 0.")
    process.exit(0)
  }

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to commit.")
    process.exit(0)
  }

  console.log()
  console.log("APPLY mode. Writing...")
  const log = []
  for (const p of plan) {
    if (p.novel.length === 0) {
      console.log(`  [skip ] ${p.key}: no novel patterns`)
      continue
    }
    const r = await applyOne(p.key, p.novel, p.prev)
    log.push({ key: p.key, ...r })
    console.log(`  [done ] ${p.key}  v${r.prevVersion} -> v${r.nextVersion}  added=${r.addedCount}`)
  }

  console.log()
  console.log("═══ APPLY COMPLETE ═══")
  for (const l of log) {
    console.log(`  ${l.key}: v${l.prevVersion} → v${l.nextVersion}  (+${l.addedCount} patterns)`)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exit(1)
})
