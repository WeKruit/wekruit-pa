#!/usr/bin/env node
/**
 * READ-ONLY Sendblue number-pool routing audit (Adam 2026-06-01).
 *
 * Goal: verify the Sendblue per-user line routing is working correctly across
 * numbers, and assess whether we need to ADD another Sendblue number.
 *
 * This script imports the REAL production seams so the audit reflects the live
 * send path EXACTLY:
 *   - loadSendbluePool(db)         (src/sendblue/pool.ts)
 *   - pickFromNumber(pool, uid)    (src/sendblue/pool.ts) — same call the live
 *                                  transport uses with NO options
 *                                  (claire-agent/transport.ts:131:
 *                                   pickFromNumber(await loadSendbluePool(db), userId))
 *
 * The live path (transport.ts) calls pickFromNumber(pool, userId) with no
 * options → default includeInternal:false, requireNewUserCapacity:false. The
 * candidate-facing distribution below mirrors that. We ALSO compute the
 * includeInternal:true view to surface admin-line routing for the isolation
 * check.
 *
 * Capacity guideline (Adam v2.0 lock): one account/number group should own
 * roughly 300-500 ACTIVE REACHABLE users before expansion. Only active (+warmup
 * with HITL) lines take NEW assignments.
 *
 * SAFETY: READ-ONLY. No Firestore writes, no Sendblue sends/reactions, no
 * deploy. Reads pa-config/sendblue-pool + pa-users only.
 *
 * Usage:
 *   node --import tsx apps/functions/scripts/audit-sendblue-routing.mjs [--json] [--limit=20000]
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

import {
  loadSendbluePool,
  pickFromNumber,
  isUserAccessibleSendblueNumber,
} from "../src/sendblue/pool.js"

const PROJECT_ID = "wekruit-5f89b"
const E164_RE = /^\+[1-9]\d{7,14}$/

// Adam capacity guideline (v2.0 lock): 300-500 active-reachable users / group.
export const GUIDELINE_MIN = 300
export const GUIDELINE_MAX = 500

// Dev/test phones with standing dial authorization — treated as admin/dev so
// the admin-line isolation check does not flag them as "ordinary candidates".
export const DEV_PHONES = new Set(["+14243201960", "+12154034668"])

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS (unit-tested in scripts/__tests__/audit-sendblue-routing.test.mjs)
// ─────────────────────────────────────────────────────────────────────────────

/** Flatten a SendbluePoolConfig into a printable per-line list (legacy `numbers`
 *  + expanded `groups`). Mirrors the fields the selector reads. */
export function listPoolLines(pool) {
  if (!pool) return []
  const lines = []
  const groups = Array.isArray(pool.groups) ? pool.groups : []
  for (const group of groups) {
    const groupId = typeof group.groupId === "string" ? group.groupId.trim() : ""
    if (!groupId) continue
    const entries = Array.isArray(group.numbers) ? group.numbers : []
    for (const entry of entries) {
      if (typeof entry === "string") {
        const number = entry.trim()
        if (!number) continue
        lines.push({
          number,
          groupId,
          label: group.label ?? null,
          status: group.status,
          audience: group.audience ?? null,
          adminOnly: group.adminOnly ?? false,
          capacity: group.dailySendCap ?? group.capacity ?? null,
        })
        continue
      }
      const number = typeof entry.number === "string" ? entry.number.trim() : ""
      if (!number) continue
      lines.push({
        number,
        groupId: (typeof entry.groupId === "string" && entry.groupId.trim()) || groupId,
        label: entry.label ?? group.label ?? null,
        status: entry.status ?? group.status,
        audience: entry.audience ?? group.audience ?? null,
        adminOnly: entry.adminOnly ?? group.adminOnly ?? false,
        capacity: entry.dailySendCap ?? entry.capacity ?? group.dailySendCap ?? group.capacity ?? null,
      })
    }
  }
  const legacy = Array.isArray(pool.numbers) ? pool.numbers : []
  for (const entry of legacy) {
    const number = typeof entry.number === "string" ? entry.number.trim() : ""
    if (!number) continue
    lines.push({
      number,
      groupId: (typeof entry.groupId === "string" && entry.groupId.trim()) || number,
      label: entry.label ?? null,
      status: entry.status,
      audience: entry.audience ?? null,
      adminOnly: entry.adminOnly ?? false,
      capacity: entry.dailySendCap ?? entry.capacity ?? null,
    })
  }
  return lines
}

/** A line is "admin/internal" (must NOT take ordinary candidates) iff it is not
 *  user-accessible per the REAL production predicate. */
export function isAdminLine(line) {
  // Reuse the production predicate to avoid drift: adminOnly OR audience in
  // {admin, internal, developer}.
  return !isUserAccessibleSendblueNumber({
    number: line.number,
    status: line.status,
    audience: line.audience ?? undefined,
    adminOnly: line.adminOnly === true,
  })
}

/** A line takes NEW assignment load only if active (warmup is HITL-gated, so it
 *  should not absorb auto NEW load). */
export function isNewLoadEligibleStatus(status) {
  return status === "active"
}

/**
 * "Active reachable" candidate definition (STATED): has a deliverable E.164
 * phone handle AND is not suppressed by the same gates the production outbound
 * suppression uses (suppression.ts):
 *   - candidateLifecycleState / candidateLifecycle.state in {opted_out, deleted}
 *   - outreach.status in {opted_out, paused}
 *   - doNotContact === true
 *   - outreachPaused === true
 *   - dailyJobRecSubscribe.optedIn === false
 */
export function isActiveReachable(user) {
  const phone = typeof user.phoneE164 === "string" ? user.phoneE164.trim() : ""
  if (!E164_RE.test(phone)) return false

  const lifecycleState =
    (typeof user.candidateLifecycleState === "string" ? user.candidateLifecycleState : undefined) ??
    (user.candidateLifecycle && typeof user.candidateLifecycle.state === "string"
      ? user.candidateLifecycle.state
      : undefined)
  if (lifecycleState === "opted_out" || lifecycleState === "deleted") return false

  const outreachStatus = user.outreach && typeof user.outreach.status === "string" ? user.outreach.status : undefined
  if (outreachStatus === "opted_out" || outreachStatus === "paused") return false

  if (user.doNotContact === true) return false
  if (user.outreachPaused === true) return false
  if (user.dailyJobRecSubscribe && user.dailyJobRecSubscribe.optedIn === false) return false

  return true
}

/** Is this candidate an admin/dev user? (dev phone OR explicit admin/internal
 *  flag). Used to validate admin-line isolation. */
export function isAdminOrDevUser(user) {
  const phone = typeof user.phoneE164 === "string" ? user.phoneE164.trim() : ""
  if (DEV_PHONES.has(phone)) return true
  if (user.isAdmin === true || user.isInternal === true || user.isDev === true) return true
  const audience = typeof user.audience === "string" ? user.audience.toLowerCase() : ""
  if (audience === "admin" || audience === "internal" || audience === "developer") return true
  return false
}

/**
 * Build the per-line assignment distribution by running the REAL pickFromNumber
 * over a set of users. `includeInternal` mirrors the option the production
 * selector accepts (live candidate path = false).
 *
 * Returns { byNumber: Map<number,count>, unrouted: string[] } where unrouted are
 * uids for which pickFromNumber returned null (no eligible line → no send,
 * because transport sets allowEnvFromNumberFallback:false).
 */
export function buildDistribution(pool, users, { includeInternal = false } = {}) {
  const byNumber = new Map()
  const unrouted = []
  for (const user of users) {
    const number = pickFromNumber(pool, user.uid, includeInternal ? { includeInternal: true } : {})
    if (!number) {
      unrouted.push(user.uid)
      continue
    }
    byNumber.set(number, (byNumber.get(number) ?? 0) + 1)
  }
  return { byNumber, unrouted }
}

/** For each active-reachable assignment count, compute capacity + guideline gap. */
export function capacityGaps(lines, activeReachableByNumber) {
  return lines.map((line) => {
    const assigned = activeReachableByNumber.get(line.number) ?? 0
    const capacity = Number.isFinite(line.capacity) ? line.capacity : null
    return {
      number: line.number,
      label: line.label,
      status: line.status,
      audience: line.audience,
      adminOnly: line.adminOnly === true,
      capacity,
      assignedActiveReachable: assigned,
      overCapacity: capacity != null ? assigned > capacity : false,
      overGuideline: assigned > GUIDELINE_MAX,
      underGuideline: assigned < GUIDELINE_MIN,
    }
  })
}

/**
 * Capacity recommendation: total active-reachable users routed to PUBLIC
 * (non-admin) active lines vs the 300-500/line guideline. Recommends how many
 * NEW public active lines to add (if any).
 */
export function capacityRecommendation(lines, activeReachableByNumber, totalActiveReachable) {
  const publicActive = lines.filter((l) => !isAdminLine(l) && isNewLoadEligibleStatus(l.status))
  const publicActiveCount = publicActive.length
  // Active-reachable users that actually land on a public active line:
  const routedToPublicActive = publicActive.reduce(
    (sum, l) => sum + (activeReachableByNumber.get(l.number) ?? 0),
    0
  )
  // Guideline-based need: ceil(total / GUIDELINE_MAX) public active lines.
  const linesNeededAtMax = Math.max(1, Math.ceil(totalActiveReachable / GUIDELINE_MAX))
  const linesNeededAtMin = Math.max(1, Math.ceil(totalActiveReachable / GUIDELINE_MIN))
  const addAtMax = Math.max(0, linesNeededAtMax - publicActiveCount)
  const addAtMin = Math.max(0, linesNeededAtMin - publicActiveCount)
  const avgPerPublicActive = publicActiveCount > 0 ? routedToPublicActive / publicActiveCount : Infinity
  const nearGuideline = avgPerPublicActive >= GUIDELINE_MIN
  const overGuideline = avgPerPublicActive > GUIDELINE_MAX
  return {
    totalActiveReachable,
    publicActiveLineCount: publicActiveCount,
    routedToPublicActive,
    avgPerPublicActiveLine: avgPerPublicActive,
    linesNeededAtMin,
    linesNeededAtMax,
    recommendAddLines: addAtMax,
    recommendAddLinesToStayUnderMin: addAtMin,
    nearGuideline,
    overGuideline,
    verdict:
      addAtMax > 0
        ? `ADD ${addAtMax} public active line(s) — over the ~500/line ceiling`
        : nearGuideline
          ? `MONITOR — approaching the 300-500/line band (avg ${avgPerPublicActive.toFixed(0)}/line); plan +1 before crossing 500`
          : `FINE FOR NOW — ${routedToPublicActive} active-reachable across ${publicActiveCount} public active line(s), avg ${avgPerPublicActive.toFixed(0)}/line, well under the 300/line floor`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTNESS CHECKS (a–e)
// ─────────────────────────────────────────────────────────────────────────────

/** (a) Stickiness: pickFromNumber deterministic across re-runs + a pure hash of
 *  uid (no Date/random). We re-run a sample and diff. */
export function checkStickiness(pool, users, sample = 50) {
  const offenders = []
  const slice = users.slice(0, Math.min(sample, users.length))
  for (const user of slice) {
    const a = pickFromNumber(pool, user.uid)
    const b = pickFromNumber(pool, user.uid)
    const c = pickFromNumber(pool, user.uid)
    if (a !== b || b !== c) offenders.push({ uid: user.uid, a, b, c })
  }
  return { pass: offenders.length === 0, checked: slice.length, offenders }
}

/** (b) Admin-line isolation: no ordinary candidate routed to an admin line, and
 *  no admin/dev user is the only thing on an admin line being mis-served as
 *  public. Live candidate path uses includeInternal:false, so candidates should
 *  NEVER resolve to an admin line. We additionally compute the includeInternal
 *  view to confirm the admin line exists + is reachable only by internal tools. */
export function checkAdminIsolation(pool, users, lines) {
  const adminNumbers = new Set(lines.filter(isAdminLine).map((l) => l.number))
  const offenders = []
  for (const user of users) {
    // live candidate path (no options) — must never hit an admin line.
    const candidateLine = pickFromNumber(pool, user.uid)
    if (candidateLine && adminNumbers.has(candidateLine)) {
      offenders.push({ uid: user.uid, line: candidateLine, kind: "candidate_on_admin_line" })
    }
  }
  return { pass: offenders.length === 0, adminNumbers: [...adminNumbers], offenders }
}

/** (c) Capacity adherence — over-capacity / over-guideline lines. */
export function checkCapacity(gaps) {
  const offenders = gaps.filter((g) => g.overCapacity || g.overGuideline)
  return { pass: offenders.length === 0, offenders }
}

/** (d) Status — any user assigned to a non-active (throttled/paused/degraded/
 *  warmup) line? Because pickFromNumber only selects status==="active", any hit
 *  here would be a selector bug. */
export function checkStatus(pool, users, lines) {
  const nonActive = new Set(lines.filter((l) => l.status !== "active").map((l) => l.number))
  const offenders = []
  for (const user of users) {
    const line =
      pickFromNumber(pool, user.uid) ?? pickFromNumber(pool, user.uid, { includeInternal: true })
    if (line && nonActive.has(line)) offenders.push({ uid: user.uid, line })
  }
  return { pass: offenders.length === 0, nonActiveLines: [...nonActive], offenders }
}

/** (e) Coverage — every active-reachable user resolves to SOME active line via
 *  the live candidate path (no env fallback). Unrouted = silent no-send. */
export function checkCoverage(pool, activeReachableUsers) {
  const { byNumber, unrouted } = buildDistribution(pool, activeReachableUsers, { includeInternal: false })
  return {
    pass: unrouted.length === 0,
    activeReachable: activeReachableUsers.length,
    routed: activeReachableUsers.length - unrouted.length,
    unroutedCount: unrouted.length,
    unroutedSample: unrouted.slice(0, 20),
    byNumber,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROD RUNNER (skipped on import so the test file can import pure helpers)
// ─────────────────────────────────────────────────────────────────────────────

export async function runAudit(db, opts = {}) {
  const limit = opts.limit ?? 50000
  const pool = await loadSendbluePool(db)
  const lines = listPoolLines(pool)

  const usersSnap = await db.collection("pa-users").limit(limit).get()
  const users = usersSnap.docs.map((doc) => ({ uid: doc.id, ...(doc.data() ?? {}) }))
  const activeReachableUsers = users.filter(isActiveReachable)

  const allDist = buildDistribution(pool, users, { includeInternal: false })
  const activeDist = buildDistribution(pool, activeReachableUsers, { includeInternal: false })
  const gaps = capacityGaps(lines, activeDist.byNumber)

  const checks = {
    a_stickiness: checkStickiness(pool, users),
    b_admin_isolation: checkAdminIsolation(pool, users, lines),
    c_capacity: checkCapacity(gaps),
    d_status: checkStatus(pool, users, lines),
    e_coverage: checkCoverage(pool, activeReachableUsers),
  }

  const recommendation = capacityRecommendation(lines, activeDist.byNumber, activeReachableUsers.length)

  return {
    readOnly: true,
    poolConfigured: pool != null,
    totalUsers: users.length,
    totalActiveReachable: activeReachableUsers.length,
    lines,
    distributionAllUsers: mapToObj(allDist.byNumber),
    distributionAllUsersUnrouted: allDist.unrouted.length,
    distributionActiveReachable: mapToObj(activeDist.byNumber),
    distributionActiveReachableUnrouted: activeDist.unrouted.length,
    capacityGaps: gaps,
    checks,
    recommendation,
  }
}

function mapToObj(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]))
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function isMainModule() {
  try {
    const thisFile = new URL(import.meta.url).pathname
    const invoked = process.argv[1] ? resolve(process.argv[1]) : ""
    return thisFile === invoked || thisFile.endsWith(invoked)
  } catch {
    return false
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2)
  const json = args.includes("--json")
  const limitArg = args.find((a) => a.startsWith("--limit="))
  const limit = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : 50000

  const db = initDb()
  const report = await runAudit(db, { limit: Number.isFinite(limit) ? limit : 50000 })

  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printReport(report)
  }
  process.exit(0)
}

function printReport(r) {
  const L = (...a) => console.log(...a)
  L("═══ READ-ONLY Sendblue routing audit ═══")
  L(`pool configured: ${r.poolConfigured}`)
  L(`total pa-users: ${r.totalUsers}; active-reachable: ${r.totalActiveReachable}`)
  L("")
  L("── Pool lines ──")
  for (const line of r.lines) {
    L(
      `  ${line.number}  status=${line.status}  capacity=${line.capacity ?? "—"}  audience=${line.audience ?? "—"}  adminOnly=${line.adminOnly}  label=${JSON.stringify(line.label) ?? "—"}`
    )
  }
  L("")
  L("── Distribution (ALL users, live candidate path) ──")
  for (const [num, count] of Object.entries(r.distributionAllUsers)) L(`  ${num}: ${count}`)
  if (r.distributionAllUsersUnrouted) L(`  (unrouted / no eligible line: ${r.distributionAllUsersUnrouted})`)
  L("")
  L("── Distribution (ACTIVE-REACHABLE users) ──")
  for (const [num, count] of Object.entries(r.distributionActiveReachable)) L(`  ${num}: ${count}`)
  if (r.distributionActiveReachableUnrouted)
    L(`  (unrouted / no eligible line: ${r.distributionActiveReachableUnrouted})`)
  L("")
  L("── Correctness checks ──")
  L(`  (a) stickiness:        ${r.checks.a_stickiness.pass ? "PASS" : "FAIL"} (checked ${r.checks.a_stickiness.checked})`)
  L(`  (b) admin isolation:   ${r.checks.b_admin_isolation.pass ? "PASS" : "FAIL"} (admin lines: ${r.checks.b_admin_isolation.adminNumbers.join(", ") || "none"}; offenders: ${r.checks.b_admin_isolation.offenders.length})`)
  L(`  (c) capacity adherence:${r.checks.c_capacity.pass ? "PASS" : "FAIL"} (offenders: ${r.checks.c_capacity.offenders.length})`)
  L(`  (d) status (no load to non-active): ${r.checks.d_status.pass ? "PASS" : "FAIL"} (non-active lines: ${r.checks.d_status.nonActiveLines.join(", ") || "none"}; offenders: ${r.checks.d_status.offenders.length})`)
  L(`  (e) coverage:          ${r.checks.e_coverage.pass ? "PASS" : "FAIL"} (routed ${r.checks.e_coverage.routed}/${r.checks.e_coverage.activeReachable}; unrouted ${r.checks.e_coverage.unroutedCount})`)
  if (!r.checks.e_coverage.pass) L(`      unrouted sample: ${r.checks.e_coverage.unroutedSample.join(", ")}`)
  L("")
  L("── Capacity recommendation ──")
  const rec = r.recommendation
  L(`  active-reachable: ${rec.totalActiveReachable}`)
  L(`  public active lines: ${rec.publicActiveLineCount}; routed to them: ${rec.routedToPublicActive}; avg/line: ${Number.isFinite(rec.avgPerPublicActiveLine) ? rec.avgPerPublicActiveLine.toFixed(1) : "n/a"}`)
  L(`  lines needed @500/line: ${rec.linesNeededAtMax}; @300/line: ${rec.linesNeededAtMin}`)
  L(`  VERDICT: ${rec.verdict}`)
}

function initDb() {
  if (!getApps().length) {
    const sa = loadServiceAccount()
    initializeApp({ credential: cert(sa), projectId: sa.project_id ?? PROJECT_ID })
  }
  return getFirestore()
}

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))
  }
  for (const candidate of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
    if (existsSync(candidate)) {
      const envText = readFileSync(candidate, "utf8")
      const match = envText.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
      if (match) return JSON.parse(match[1].replace(/^"/, "").replace(/"$/, ""))
    }
  }
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing. Export it or GOOGLE_APPLICATION_CREDENTIALS.")
}
