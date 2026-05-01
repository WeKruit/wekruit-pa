#!/usr/bin/env tsx
/**
 * Phase 29 T3 — Bible v7.0 → pa-handbooks/{slug} v1 migration (P9-Handbook).
 *
 * Reads the inline Bible (from packages/agent-registry/src/seed.json AND the
 * live pa-agents/{agentId}.systemPrompt field, with the LIVE field winning
 * if it differs — operator may have hot-edited the agent doc), parses it
 * into the locked sections schema (per .planning/phases/29-agent-handbook/
 * CONTEXT.md), and writes:
 *
 *   pa-handbooks/claire                          (pointer doc, v1)
 *   pa-handbooks/claire/versions/1              (immutable snapshot)
 *   pa-agents/default.handbookSlug = "claire"   (orchestrator lookup key)
 *
 * The agent doc's `systemPrompt` field is LEFT IN PLACE (failsafe during
 * cutover; cleanup phase later per PLAN T4 DON'T).
 *
 * Idempotent: refuses to overwrite if pa-handbooks/{slug}/versions/1 exists.
 *
 * Usage:
 *   tsx apps/functions/scripts/migrate-bible-to-handbook.ts --dry-run
 *   tsx apps/functions/scripts/migrate-bible-to-handbook.ts                 # live
 *
 * Options:
 *   --slug <name>      Handbook slug (default: claire)
 *   --agent-id <id>    Source agent (default: default)
 *   --dry-run          Print the proposed handbook JSON, no writes
 *
 * Auth (live mode): requires GOOGLE_APPLICATION_CREDENTIALS pointing at a
 * service-account JSON with Firestore write access OR runs inside an
 * environment where firebase-admin's default credential resolves
 * (Cloud Shell / GCE / Cloud Run).
 *
 * Section mapping table (Bible v7.0 → handbook sections):
 *   # IDENTITY                  → identity (string, full body)
 *   # THE ONE RULE              → hard_rules (string[], 1 item: the rule body)
 *   # DEFAULT POSTURE           → default_posture (string, full body)
 *   # 7 NEVERs ...              → never_5 (string[], one per numbered item)
 *                                  Yes, schema says never_5 even though Bible
 *                                  v7.4 ships with 8 NEVERs — we keep the
 *                                  P10-locked field name and put all NEVERs
 *                                  in it. Adam can split per-item later via
 *                                  dashboard.
 *   # ESCALATION FIREWALL       → appended to hard_rules (cross-cutting rule)
 *   # ESCAPE HATCH              → escape_hatch (string, full body)
 *   # TONE FLAVORS              → tone_flavors (parsed: each "Name → desc"
 *                                  line becomes a key)
 *   # HUMAN TELLS               → human_tells (string[], one per line)
 *   # CODE-SWITCH + EMOJI       → appended to default_posture (no dedicated
 *                                  section in locked schema; lives with posture)
 *   # VOCAB                     → vocab.allowed (zh + en lines parsed)
 *                                  vocab.banned populated from "NEVER MIRROR"
 *                                  forbidden phrases extracted from Bible
 *   # ROOMMATE                  → appended to identity
 *   playbooks.headhunter        → seeded from packages/pa-orchestrator/
 *                                  src/playbooks/headhunter.ts (defaults)
 *
 * The mapping is intentionally LOSSY in formatting (we don't preserve the
 * exact narrative prose); the handbook is the new source of truth, so the
 * dashboard editor lets Adam edit each section freely from here on.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Constants — mirror @pa/pa-persistence/handbook (don't import to keep this
// script free of monorepo build output dependency).
// ---------------------------------------------------------------------------

const HANDBOOKS_COLLECTION = "pa-handbooks"
const HANDBOOK_VERSIONS_SUBCOLLECTION = "versions"
const AGENTS_COLLECTION = "pa-agents"
const AUDIT_COLLECTION = "pa-audit-events"
const SEED_ACTOR = "p9-handbook-migrate@wekruit.com"
const SEED_REASON =
  "Phase 29 migrate-bible-to-handbook — initial seed from inline Bible v7.x"

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

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type RawSection = { title: string; body: string }

/**
 * Split a Bible-style markdown blob into raw `# HEADER` sections.
 * Sub-headers (`## …`) stay inside the body of the parent section.
 */
function splitHeaders(systemPrompt: string): RawSection[] {
  const lines = systemPrompt.replace(/\r\n/g, "\n").split("\n")
  const out: RawSection[] = []
  let current: { title: string; body: string[] } | null = null
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line)
    if (m) {
      if (current) out.push({ title: current.title, body: current.body.join("\n").trim() })
      current = { title: m[1]!.trim(), body: [] }
      continue
    }
    if (current) current.body.push(line)
  }
  if (current) out.push({ title: current.title, body: current.body.join("\n").trim() })
  return out
}

function findSection(rawSections: RawSection[], pattern: RegExp): RawSection | undefined {
  return rawSections.find((s) => pattern.test(s.title))
}

/**
 * Parse a `1. ... 2. ... 3. ...` numbered list (the Bible NEVER list shape)
 * into discrete items. Each item begins with `^[number][optional letter].\s+`
 * and continues until the next number-prefixed line.
 *
 * Tolerates "6.", "6b.", "7.", "7b." sub-numbering present in v7.4 Bible.
 */
function parseNumberedList(body: string): string[] {
  const lines = body.split("\n")
  const items: string[] = []
  let buf: string[] = []
  for (const ln of lines) {
    if (/^\s*\d+[a-z]?\.\s+/.test(ln)) {
      if (buf.length > 0) items.push(buf.join("\n").trim())
      buf = [ln.replace(/^\s*\d+[a-z]?\.\s+/, "")]
    } else if (buf.length > 0) {
      buf.push(ln)
    }
  }
  if (buf.length > 0) items.push(buf.join("\n").trim())
  return items.filter((x) => x.length > 0)
}

/**
 * Parse `Celebrate → punch line + STOP. (...)` style tone-flavor lines into
 * a {name → description} map. Falls back to the raw body text when we can't
 * detect arrows.
 */
function parseToneFlavors(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const ln of body.split("\n")) {
    const m = /^([^→]+?)\s*→\s*(.+)$/.exec(ln.trim())
    if (m) {
      const name = m[1]!.trim().toLowerCase().split(/[\s/]+/)[0]!
      out[name] = ln.trim()
    }
  }
  return out
}

/**
 * Parse the HUMAN TELLS section. Bible format:
 *   Hesitate: uhh / 嗯... / wait / hmm / 我想想.
 *   Self-correct: nvm / 算了 / 哦不对.
 *   ...
 * Each non-empty line becomes a tell.
 */
function parseHumanTells(body: string): string[] {
  return body
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Parse VOCAB body:
 *   2025-26 zh: 卷/摆烂/emo/破防/老登/邪修/拼好饭/发疯工牌.
 *   2025-26 en: mid/delulu/cooked/lock in/aura/...
 *   First-person: 我也.../我之前也.../wok/oh wok.
 * Returns a flattened allowed[] of every slash-separated token.
 */
function parseVocabAllowed(body: string): string[] {
  const tokens = new Set<string>()
  for (const ln of body.split("\n")) {
    const colon = ln.indexOf(":")
    const tail = colon >= 0 ? ln.slice(colon + 1) : ln
    for (const t of tail.split(/[/、,]+/)) {
      const v = t.trim().replace(/[.。]+$/, "").trim()
      if (v && v.length <= 30 && !/^\(/.test(v)) tokens.add(v)
    }
  }
  return Array.from(tokens)
}

/**
 * Extract banned phrases by scanning NEVER lines for quoted '"X"' phrases —
 * the Bible "never echo" patterns — and collecting them into vocab.banned.
 */
function extractBannedPhrases(rawSections: RawSection[]): string[] {
  const banned = new Set<string>()
  for (const s of rawSections) {
    if (!/never/i.test(s.title)) continue
    // Both ASCII and curly quotes appear in the Bible.
    for (const m of s.body.matchAll(/"([^"\n]{1,40})"/g)) {
      banned.add(m[1]!.trim())
    }
    for (const m of s.body.matchAll(/“([^”\n]{1,40})”/g)) {
      banned.add(m[1]!.trim())
    }
  }
  return Array.from(banned)
}

// ---------------------------------------------------------------------------
// Default playbook seed — only `headhunter` per Adam decision (PLAN.md
// "Adam decisions still owed", default applied).
// ---------------------------------------------------------------------------

const DEFAULT_HEADHUNTER_PLAYBOOK: PlaybookSpec = {
  name: "headhunter",
  trigger:
    "User mentions JD/role/招聘/recruiter pinging them OR pastes a job posting (English or Chinese).",
  steps: [
    "Read the JD silently — DO NOT summarize back.",
    "1-line take on whether the role looks legit / mid / cooked.",
    "Ask 1 grounded question (e.g. comp range OR base location) only if user invites Q.",
    "Stop. Do not list pros/cons unless explicitly asked.",
  ],
  exitCondition:
    "User changes topic or replies with non-headhunter content for 2+ turns.",
}

// ---------------------------------------------------------------------------
// Main parse entry point
// ---------------------------------------------------------------------------

export function parseBibleToSections(systemPrompt: string): HandbookSections {
  const raw = splitHeaders(systemPrompt)

  const identityRaw = findSection(raw, /^IDENTITY/i)?.body ?? ""
  const roommateRaw = findSection(raw, /^ROOMMATE/i)?.body ?? ""
  const identity = roommateRaw
    ? `${identityRaw}\n\n[Roommate]\n${roommateRaw}`.trim()
    : identityRaw

  const oneRule = findSection(raw, /ONE RULE/i)?.body ?? ""
  const escalation = findSection(raw, /ESCALATION/i)?.body ?? ""
  const hard_rules = [oneRule, escalation]
    .map((x) => x.trim())
    .filter((x) => x.length > 0)

  const default_posture_main = findSection(raw, /DEFAULT POSTURE/i)?.body ?? ""
  const code_switch = findSection(raw, /CODE-SWITCH|EMOJI/i)?.body ?? ""
  const default_posture = code_switch
    ? `${default_posture_main}\n\n[Code-switch + emoji]\n${code_switch}`.trim()
    : default_posture_main

  const neversBody = findSection(raw, /NEVER/i)?.body ?? ""
  const never_5 = parseNumberedList(neversBody)

  const escape_hatch = findSection(raw, /ESCAPE/i)?.body ?? ""

  const toneBody = findSection(raw, /TONE FLAVOR/i)?.body ?? ""
  const tone_flavors = parseToneFlavors(toneBody)

  const tellsBody = findSection(raw, /HUMAN TELL/i)?.body ?? ""
  const human_tells = parseHumanTells(tellsBody)

  const vocabBody = findSection(raw, /^VOCAB/i)?.body ?? ""
  const vocab = {
    allowed: parseVocabAllowed(vocabBody),
    banned: extractBannedPhrases(raw),
  }

  return {
    identity,
    hard_rules,
    default_posture,
    never_5,
    escape_hatch,
    tone_flavors,
    human_tells,
    vocab,
    playbooks: {
      headhunter: DEFAULT_HEADHUNTER_PLAYBOOK,
    },
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function readSeedJson(): { systemPrompt: string; agentId: string } {
  const seedPath = path.resolve(
    __dirname,
    "../../../packages/agent-registry/src/seed.json"
  )
  const raw = JSON.parse(fs.readFileSync(seedPath, "utf-8")) as Array<{
    id: string
    systemPrompt: string
    isDefault?: boolean
  }>
  const def = raw.find((a) => a.isDefault) ?? raw[0]
  if (!def) throw new Error("seed.json: no default agent found")
  return { systemPrompt: def.systemPrompt, agentId: def.id }
}

function parseArgs(argv: string[]) {
  const out: { dryRun: boolean; slug: string; agentId: string | null } = {
    dryRun: false,
    slug: "claire",
    agentId: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--dry-run") out.dryRun = true
    else if (a === "--slug") out.slug = argv[++i] ?? "claire"
    else if (a === "--agent-id") out.agentId = argv[++i] ?? null
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const seed = readSeedJson()
  const agentId = args.agentId ?? seed.agentId

  if (args.dryRun) {
    const sections = parseBibleToSections(seed.systemPrompt)
    const handbook = {
      slug: args.slug,
      version: 1,
      sections,
      updatedBy: SEED_ACTOR,
      updatedAt: new Date().toISOString(),
      reason: SEED_REASON,
    }
    console.log("=".repeat(70))
    console.log(`Phase 29 — migrate-bible-to-handbook DRY RUN`)
    console.log(`  source:   packages/agent-registry/src/seed.json [${agentId}]`)
    console.log(`  target:   ${HANDBOOKS_COLLECTION}/${args.slug} (v1)`)
    console.log(`  + sub:    ${HANDBOOKS_COLLECTION}/${args.slug}/${HANDBOOK_VERSIONS_SUBCOLLECTION}/1`)
    console.log(`  + agent:  ${AGENTS_COLLECTION}/${agentId}.handbookSlug = "${args.slug}"`)
    console.log(`  + audit:  ${AUDIT_COLLECTION} {action: "handbook.create", key: "${args.slug}"}`)
    console.log("=".repeat(70))
    console.log("Sections summary:")
    console.log(`  identity:        ${sections.identity.length} chars`)
    console.log(`  hard_rules:      ${sections.hard_rules.length} item(s)`)
    console.log(`  default_posture: ${sections.default_posture.length} chars`)
    console.log(`  never_5:         ${sections.never_5.length} item(s)`)
    console.log(`  escape_hatch:    ${sections.escape_hatch.length} chars`)
    console.log(`  tone_flavors:    ${Object.keys(sections.tone_flavors).length} entry/entries`)
    console.log(`  human_tells:     ${sections.human_tells.length} item(s)`)
    console.log(`  vocab.allowed:   ${sections.vocab.allowed.length} token(s)`)
    console.log(`  vocab.banned:    ${sections.vocab.banned.length} phrase(s)`)
    console.log(`  playbooks:       ${Object.keys(sections.playbooks).join(", ")}`)
    console.log("=".repeat(70))
    console.log("Full proposed JSON:\n")
    console.log(JSON.stringify(handbook, null, 2))
    console.log("\n(dry-run: no Firestore reads or writes were performed)")
    return
  }

  // ---- LIVE MODE ----
  // Lazy-import firebase-admin so dry-run stays sandbox-safe.
  const { initializeApp, getApps, applicationDefault } = await import("firebase-admin/app")
  const { getFirestore, FieldValue } = await import("firebase-admin/firestore")
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() })
  }
  const db = getFirestore()

  // Idempotency guard: if pa-handbooks/{slug}/versions/1 already exists, abort.
  const v1Snap = await db
    .collection(HANDBOOKS_COLLECTION)
    .doc(args.slug)
    .collection(HANDBOOK_VERSIONS_SUBCOLLECTION)
    .doc("1")
    .get()
  if (v1Snap.exists) {
    console.error(
      `ABORT: ${HANDBOOKS_COLLECTION}/${args.slug}/${HANDBOOK_VERSIONS_SUBCOLLECTION}/1 already exists. ` +
        `Migration is idempotent; refuse to overwrite.`
    )
    process.exit(1)
  }

  // Read live agent.systemPrompt — overrides seed.json if present + non-empty.
  const agentSnap = await db.collection(AGENTS_COLLECTION).doc(agentId).get()
  if (!agentSnap.exists) {
    console.error(`ABORT: agent ${agentId} not found in ${AGENTS_COLLECTION}`)
    process.exit(1)
  }
  const agentData = agentSnap.data() as Record<string, unknown> | undefined
  const liveSystemPrompt = (agentData?.systemPrompt as string | undefined) ?? ""
  const systemPrompt =
    liveSystemPrompt.trim().length > 0 ? liveSystemPrompt : seed.systemPrompt
  if (liveSystemPrompt.trim().length === 0) {
    console.warn(`WARN: live ${AGENTS_COLLECTION}/${agentId}.systemPrompt empty — using seed.json fallback`)
  }

  const sections = parseBibleToSections(systemPrompt)
  const ts = new Date().toISOString()
  const snapshot = {
    slug: args.slug,
    version: 1,
    sections,
    updatedBy: SEED_ACTOR,
    updatedAt: ts,
    reason: SEED_REASON,
  }

  const handbookRef = db.collection(HANDBOOKS_COLLECTION).doc(args.slug)
  const versionRef = handbookRef
    .collection(HANDBOOK_VERSIONS_SUBCOLLECTION)
    .doc("1")
  const auditRef = db.collection(AUDIT_COLLECTION).doc()
  const agentRef = db.collection(AGENTS_COLLECTION).doc(agentId)

  await db.runTransaction(async (tx) => {
    // Re-check inside tx (race condition vs concurrent run).
    const reCheck = await tx.get(versionRef)
    if (reCheck.exists) {
      throw new Error(`versions/1 appeared during migration — aborting`)
    }
    tx.set(handbookRef, snapshot)
    tx.set(versionRef, snapshot)
    tx.set(auditRef, {
      actor: SEED_ACTOR,
      action: "handbook.create",
      key: args.slug,
      oldValue: null,
      newValue: { version: 1, sections },
      reason: SEED_REASON,
      ts,
    })
    tx.set(
      agentRef,
      {
        handbookSlug: args.slug,
        // CRITICAL: write ISO string (not FieldValue.serverTimestamp()) — the
        // agent-registry zod schema validates updatedAt as a string. A
        // Timestamp object causes orchestrator turn validation to throw
        // "Expected string, received object" on path ["updatedAt"], breaking
        // every inbound turn. Bug found 2026-04-30 during first live Sendblue
        // test; hotfix backfilled to existing pa-agents/default doc.
        updatedAt: ts,
      },
      { merge: true }
    )
  })

  console.log(`✓ Migrated ${HANDBOOKS_COLLECTION}/${args.slug} v1`)
  console.log(`✓ Wrote   ${HANDBOOKS_COLLECTION}/${args.slug}/${HANDBOOK_VERSIONS_SUBCOLLECTION}/1`)
  console.log(`✓ Audit   ${AUDIT_COLLECTION}/{auto} action=handbook.create`)
  console.log(`✓ Agent   ${AGENTS_COLLECTION}/${agentId}.handbookSlug = "${args.slug}"`)
  console.log(`  (agent.systemPrompt left intact as failsafe; cleanup in later phase)`)
}

const invokedAsScript =
  process.argv[1]?.endsWith("migrate-bible-to-handbook.ts") ||
  process.argv[1]?.endsWith("migrate-bible-to-handbook.js")
if (invokedAsScript) {
  main().catch((err) => {
    console.error("[migrate-bible-to-handbook] FATAL", err)
    process.exit(1)
  })
}
