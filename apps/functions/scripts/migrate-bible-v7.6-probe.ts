#!/usr/bin/env tsx
/**
 * Stream F3 — Bible v7.6 — adds JOB-PREF PROBE hard rule (P9 / P10).
 *
 * Reads the live `pa-handbooks/claire` doc (currently v4 from Stream D's
 * URL hard-rule update), appends one new entry to `hard_rules`, and writes:
 *
 *   pa-handbooks/claire                          (pointer doc, v5)
 *   pa-handbooks/claire/versions/5              (immutable snapshot)
 *   pa-audit-events/{auto}                      (action handbook.update)
 *
 * The JOB-PREF PROBE rule is purely additive — no other section is mutated.
 *
 * Optimistic concurrency: refuses if live `pa-handbooks/claire.version !== 4`.
 * Idempotency: refuses if `pa-handbooks/claire/versions/5` already exists.
 *
 * Usage:
 *   npx tsx apps/functions/scripts/migrate-bible-v7.6-probe.ts --dry-run
 *   npx tsx apps/functions/scripts/migrate-bible-v7.6-probe.ts --live
 *
 * Auth (live): GOOGLE_APPLICATION_CREDENTIALS pointing at SA JSON.
 */

const HANDBOOKS_COLLECTION = "pa-handbooks"
const HANDBOOK_VERSIONS_SUBCOLLECTION = "versions"
const AUDIT_COLLECTION = "pa-audit-events"
const SEED_ACTOR = "p9-stream-f-probe@wekruit.com"
const SEED_REASON =
  "Stream F3 — Bible v7.6 add JOB-PREF PROBE hard rule (post-CV onboarding probing flow)"

const TARGET_PRIOR_VERSION = 4
const TARGET_NEW_VERSION = 5

/**
 * The JOB-PREF PROBE rule. Designed to slot at the END of hard_rules so
 * the foundational rules (3-SENTENCE CAP / THE ONE RULE / ESCALATION
 * FIREWALL / LINKS) remain at the top of Claire's prompt scope.
 *
 * Roommate-tone wording — explicitly tells Claire to avoid recruiter-intake
 * register. Mention the saveJobProfile tool by name so the agent runtime
 * can match the connector lookup.
 */
export const JOB_PREF_PROBE_RULE = `**JOB-PREF PROBE** (post-CV onboarding — applies after the user has uploaded a resume and you've sent the CV-findings followup). Your next ~4-6 turns should learn 4 preferences, ONE per reply (NEVER pile-on, NEVER bullet-list, NEVER recruiter-intake register):
1. SPONSORSHIP: 需要 H1B / GC sponsorship 吗? (or "remote OK" / "都不需要")
2. LOCATION: 湾区 / NYC / Seattle / remote / 不挑?
3. SIZE: 大厂 / startup (≤200) / 中型 / 都行?
4. INDUSTRY confirm: 我看你 CV 像是 {industryTags[0]}, 想继续这个还是想转到 X? (X = pick from 10-tag enum: tech_software, tech_hardware, fintech_finance, ai_ml, healthcare_biotech, consumer_retail, media_entertainment, manufacturing_industrial, education, other — NEVER free-text)

Tone: still roommate, blend the question into a reaction or anecdote ("我之前那家给 H1B sponsorship 巨慢, 你这家什么情况"). NEVER list questions. NEVER ask 2 in one turn.

Once you have all 4 (industryTags, sponsorshipNeeded, locationPreference, sizePreference; salaryMin optional) — call \`saveJobProfile\` ONCE. Tool returns {ok:true} → next turn show 1 sample preview job from the matching corpus. Tool {ok:false} → apologize naturally and try again 1 turn later.`

type PlaybookSpec = {
  name: string
  trigger: string
  steps: string[]
  exitCondition: string
}

type HandbookSections = {
  identity: string
  hard_rules: string[]
  default_posture: string
  never_5: string[]
  escape_hatch: string
  tone_flavors: Record<string, string>
  human_tells: string[]
  vocab: { allowed: string[]; banned: string[] }
  playbooks: Record<string, PlaybookSpec>
}

/**
 * Pure transformer — exposed for tests. Appends JOB-PREF PROBE if absent;
 * idempotent (calling twice yields the same output).
 */
export function appendProbeHardRule(prior: HandbookSections): HandbookSections {
  const already = prior.hard_rules.some((r) => r.includes("JOB-PREF PROBE"))
  if (already) return prior
  return {
    ...prior,
    hard_rules: [...prior.hard_rules, JOB_PREF_PROBE_RULE],
  }
}

type Args = { dryRun: boolean; live: boolean; slug: string; force: boolean }

export function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, live: false, slug: "claire", force: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--dry-run") out.dryRun = true
    else if (a === "--live") out.live = true
    else if (a === "--force") out.force = true
    else if (a === "--slug") out.slug = argv[++i] ?? "claire"
  }
  if (!out.dryRun && !out.live) out.dryRun = true
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { initializeApp, getApps, applicationDefault } = await import("firebase-admin/app")
  const { getFirestore } = await import("firebase-admin/firestore")
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() })
  }
  const db = getFirestore()

  // Read live pointer doc.
  const ptrSnap = await db.collection(HANDBOOKS_COLLECTION).doc(args.slug).get()
  if (!ptrSnap.exists) {
    console.error(`ABORT: ${HANDBOOKS_COLLECTION}/${args.slug} pointer doc missing.`)
    process.exit(1)
  }
  const ptrData = ptrSnap.data() as { version?: number; sections?: HandbookSections } | undefined
  const liveVersion = ptrData?.version
  const liveSections = ptrData?.sections
  if (!liveSections) {
    console.error(`ABORT: ${HANDBOOKS_COLLECTION}/${args.slug} has no sections.`)
    process.exit(1)
  }
  if (liveVersion !== TARGET_PRIOR_VERSION && !args.force) {
    console.error(
      `ABORT: ${HANDBOOKS_COLLECTION}/${args.slug}.version is ${liveVersion}, expected ${TARGET_PRIOR_VERSION}. ` +
        `Pass --force ONLY if intentional.`
    )
    process.exit(1)
  }

  const newSections = appendProbeHardRule(liveSections)
  const ts = new Date().toISOString()
  const proposedSnapshot = {
    slug: args.slug,
    version: TARGET_NEW_VERSION,
    sections: newSections,
    updatedBy: SEED_ACTOR,
    updatedAt: ts,
    reason: SEED_REASON,
  }

  if (args.dryRun) {
    console.log("=".repeat(70))
    console.log(`Stream F3 — migrate-bible-v7.6-probe DRY RUN`)
    console.log(`  target: ${HANDBOOKS_COLLECTION}/${args.slug}  v${liveVersion} → v${TARGET_NEW_VERSION}`)
    console.log(`  hard_rules count: ${liveSections.hard_rules.length} → ${newSections.hard_rules.length}`)
    console.log(`  + appending JOB-PREF PROBE (idempotent: ${liveSections.hard_rules === newSections.hard_rules ? "ALREADY-PRESENT skip" : "NEW append"})`)
    console.log("=".repeat(70))
    console.log("New rule preview:\n")
    console.log(JOB_PREF_PROBE_RULE)
    console.log("=".repeat(70))
    console.log("(dry-run: NO writes performed)")
    return
  }

  // ---- LIVE ----
  // Idempotency guard #1: refuse if pa-handbooks/{slug}/versions/5 already exists.
  const v5Snap = await db
    .collection(HANDBOOKS_COLLECTION)
    .doc(args.slug)
    .collection(HANDBOOK_VERSIONS_SUBCOLLECTION)
    .doc(String(TARGET_NEW_VERSION))
    .get()
  if (v5Snap.exists) {
    console.error(
      `ABORT: ${HANDBOOKS_COLLECTION}/${args.slug}/${HANDBOOK_VERSIONS_SUBCOLLECTION}/${TARGET_NEW_VERSION} already exists.`
    )
    process.exit(1)
  }

  const handbookRef = db.collection(HANDBOOKS_COLLECTION).doc(args.slug)
  const versionRef = handbookRef
    .collection(HANDBOOK_VERSIONS_SUBCOLLECTION)
    .doc(String(TARGET_NEW_VERSION))
  const auditRef = db.collection(AUDIT_COLLECTION).doc()

  await db.runTransaction(async (tx) => {
    const reCheck = await tx.get(versionRef)
    if (reCheck.exists) throw new Error(`versions/${TARGET_NEW_VERSION} appeared mid-tx`)
    const reCheckPtr = await tx.get(handbookRef)
    const reCheckVersion = reCheckPtr.exists
      ? (reCheckPtr.data() as { version?: number })?.version
      : null
    if (reCheckVersion !== TARGET_PRIOR_VERSION && !args.force) {
      throw new Error(`pointer doc version changed mid-tx to ${reCheckVersion}`)
    }
    tx.set(handbookRef, proposedSnapshot)
    tx.set(versionRef, proposedSnapshot)
    tx.set(auditRef, {
      actor: SEED_ACTOR,
      action: "handbook.update",
      key: args.slug,
      oldValue: { version: liveVersion, sections: liveSections },
      newValue: { version: TARGET_NEW_VERSION, sections: newSections },
      reason: SEED_REASON,
      ts,
    })
  })

  console.log(`✓ Migrated ${HANDBOOKS_COLLECTION}/${args.slug} v${liveVersion} → v${TARGET_NEW_VERSION}`)
  console.log(`✓ Wrote   ${HANDBOOKS_COLLECTION}/${args.slug}/${HANDBOOK_VERSIONS_SUBCOLLECTION}/${TARGET_NEW_VERSION}`)
  console.log(`✓ Audit   ${AUDIT_COLLECTION}/{auto} action=handbook.update`)
}

const invokedAsScript =
  process.argv[1]?.endsWith("migrate-bible-v7.6-probe.ts") ||
  process.argv[1]?.endsWith("migrate-bible-v7.6-probe.js")
if (invokedAsScript) {
  main().catch((err) => {
    console.error("[migrate-bible-v7.6-probe] FATAL", err)
    process.exit(1)
  })
}
