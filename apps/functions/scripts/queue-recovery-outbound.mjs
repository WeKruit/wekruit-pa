#!/usr/bin/env node
/**
 * queue-recovery-outbound.mjs — DRY-RUN backfill that QUEUES bad-experience
 * recovery drafts into `pa-pending-outbound`. It NEVER sends anything; it only
 * scans, re-enriches, drafts, gates, and (with --apply) writes human-approve-
 * then-send queue rows via `enqueuePendingOutbound`.
 *
 * Pipeline:
 *   1. SCAN pa-outbound (+ pa-messages for context) → identify victims.
 *      Heuristics (founder decision: queue ALL such victims, not just >=3x):
 *        - dup_send        TRUE double-fire: same userId + same body[:80],
 *                          two SENT messages < 60s apart. (>60s re-sends are
 *                          legit and are NOT flagged.)
 *        - chinese_in_prod CJK present in a delivered/sent assistant body.
 *        - bot_error_loop  >=2 canonical bot-error fallback bodies for one user,
 *                          or the same generic error body repeated.
 *        - failed_outbound status failed / dead_letter (delivery never landed).
 *   2. Per victim user: read pa-users.tags/profile as enrichmentSnapshot (NO
 *      mutation), run the suppression gate (opt-out / do-not-contact / paused /
 *      cooldown / global stop control / no reachable handle), and generate a
 *      recovery draftBody — English-only, warm, human, grounded in WHY the
 *      experience was bad + their profile, no over-apology, no model escalation,
 *      one short text. Uses the repo's LLM (OpenAI, then SiliconFlow Qwen) when
 *      a key is present; otherwise a clear templated draft per reasonCode with a
 *      TODO marker.
 *   3. Write each as a pa-pending-outbound doc via enqueuePendingOutbound,
 *      status="pending", kind="recovery", suppressed per the gate. Deterministic
 *      doc id ⇒ idempotent re-runs. DEFAULT DRY-RUN (writes nothing); only
 *      --apply persists. Never sends.
 *
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=$(mktemp)
 *   grep -E "^FIREBASE_SERVICE_ACCOUNT_JSON=" /Users/adam/Desktop/WeKruit/wekruit-pa/.env \
 *     | sed 's/^FIREBASE_SERVICE_ACCOUNT_JSON=//; s/^"//; s/"$//' > "$GOOGLE_APPLICATION_CREDENTIALS"
 *   # run node from apps/functions so firebase-admin + @pa/* resolve:
 *   cd apps/functions
 *   node --import tsx scripts/queue-recovery-outbound.mjs            # DRY-RUN (report)
 *   node --import tsx scripts/queue-recovery-outbound.mjs --apply    # write queue rows
 *
 * Flags:
 *   --apply           actually write pa-pending-outbound rows (default: report only)
 *   --no-llm          skip the LLM and use templated drafts only (deterministic)
 *   --project <id>    Firebase project (default wekruit-5f89b)
 *   --limit <n>       cap victims processed (0 = all)
 *   --dup-window <s>  dup_send window in seconds (default 60)
 */

import { readFileSync } from "node:fs"
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

import { PA_COLLECTIONS } from "@pa/core-types"
import { enqueuePendingOutbound } from "../src/pending-outbound/queue.ts"
// The single authoritative, fail-closed "may we text this candidate?" gate.
import { isSuppressed } from "../src/pending-outbound/suppression.ts"

// ─── Args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const DRY_RUN = !argv.includes("--apply")
const USE_LLM = !argv.includes("--no-llm")
const PROJECT = (() => {
  const i = argv.indexOf("--project")
  return i >= 0 ? argv[i + 1] : "wekruit-5f89b"
})()
const LIMIT = (() => {
  const i = argv.indexOf("--limit")
  return i >= 0 ? Math.max(0, parseInt(argv[i + 1], 10) || 0) : 0
})()
const DUP_WINDOW_MS = (() => {
  const i = argv.indexOf("--dup-window")
  const s = i >= 0 ? parseInt(argv[i + 1], 10) : 60
  return (Number.isFinite(s) ? s : 60) * 1000
})()

const REASON = {
  dupSend: "dup_send",
  chineseInProd: "chinese_in_prod",
  botErrorLoop: "bot_error_loop",
  failedOutbound: "failed_outbound",
}

// ─── Firebase init (mirrors fill-tag-gaps.mjs) ───────────────────────────────
function initFirebase() {
  if (getApps().length > 0) return
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credPath) {
    try {
      const cred = JSON.parse(readFileSync(credPath, "utf8"))
      initializeApp({ credential: cert(cred), projectId: PROJECT })
      return
    } catch {
      /* fall through */
    }
  }
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inlineJson) {
    try {
      initializeApp({ credential: cert(JSON.parse(inlineJson)), projectId: PROJECT })
      return
    } catch {
      /* fall through */
    }
  }
  initializeApp({ projectId: PROJECT })
}

// ─── Field helpers (match real pa-outbound / pa-users shapes) ────────────────
// pa-outbound doc: { userId, toE164, body, role, status, createdAt(ts), sentAt,
//   sendblueStatus, messageHandle, attempts, sessionId, idempotencyKey, ... }
const CJK_DETECT_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿｦ-ﾟ]/

const CJK_GLOBAL_RE = new RegExp(CJK_DETECT_RE.source, "g")

// "Chinese leaked into a prod reply" is a defect. But a candidate's CJK NAME
// embedded in an otherwise-English message (e.g. "Hey <name> (Sunny)!") is NOT
// a bad experience — flagging it would be wrong. Real defects are running
// Chinese sentences: high CJK ratio OR a substantial CJK char count. Verified
// against live data — name false-positives sit at cjk=3-5 chars / ratio
// ~0.006-0.008; real defects at cjk>=11 chars or ratio>=0.066. Thresholds
// (cjkCount>=8 OR ratio>=0.10) cleanly separate the two.
function isChineseInProd(body) {
  if (!body || !CJK_DETECT_RE.test(body)) return false
  const matches = body.match(CJK_GLOBAL_RE)
  const cjkCount = matches ? matches.length : 0
  const ratio = cjkCount / body.length
  return cjkCount >= 8 || ratio >= 0.1
}

// Canonical bot-error fallback bodies emitted by the orchestrator when it
// couldn't produce a real reply. Source: pa-orchestrator/src/index.ts.
const BOT_ERROR_SNIPPETS = [
  "i could not generate a valid reply just now",
  "you’re sending a bit too fast",
  "you're sending a bit too fast",
  "i ran into a problem",
  "something went wrong",
  "i hit a snag",
  "technical issue on my end",
]

function tsToMs(v) {
  if (!v) return 0
  if (typeof v === "string") {
    const p = Date.parse(v)
    return Number.isFinite(p) ? p : 0
  }
  if (typeof v.toDate === "function") return v.toDate().getTime()
  if (typeof v._seconds === "number") return v._seconds * 1000
  if (typeof v.seconds === "number") return v.seconds * 1000
  return 0
}
function tsToIso(v) {
  const ms = tsToMs(v)
  return ms ? new Date(ms).toISOString() : null
}
function bodyOf(d) {
  return typeof d.body === "string" ? d.body : ""
}
function isDeliveredOrSent(d) {
  const s = String(d.status ?? "").toLowerCase()
  const sb = String(d.sendblueStatus ?? "").toUpperCase()
  return s === "sent" || sb === "SENT" || sb === "DELIVERED"
}
function isBotError(body) {
  const lc = body.toLowerCase()
  return BOT_ERROR_SNIPPETS.some((snip) => lc.includes(snip))
}
function shortDate(iso) {
  return iso ? iso.slice(0, 10) : "an earlier date"
}

// Suppression is delegated to the authoritative, fail-closed helper
// `isSuppressed(db, userId, { kind: "recovery" })` from
// src/pending-outbound/suppression.ts — it reads every opt-out signal in the
// system (global stop control, lifecycle, outreach.status, doNotContact,
// outreachPaused, dailyJobRecSubscribe.optedIn, filed-but-unprocessed
// stop_outreach/delete privacy requests, reachability) and fails CLOSED for the
// recovery kind. We do NOT re-implement the gate here.

// ─── Enrichment snapshot (read-only; never mutated) ──────────────────────────
function enrichmentSnapshotOf(user) {
  const tags = user.tags && typeof user.tags === "object" ? user.tags : {}
  const pick = (k) => (tags[k] !== undefined ? tags[k] : undefined)
  const snap = {
    displayName: user.displayName ?? null,
    candidateLifecycleState: user.candidateLifecycleState ?? null,
    signupSource: user.signupSource ?? null,
    targetRoleFunction: pick("targetRoleFunction") ?? null,
    skills: Array.isArray(tags.skills)
      ? tags.skills.slice(0, 8).map((s) => (typeof s === "string" ? s : s?.value ?? s?.name ?? null)).filter(Boolean)
      : null,
    industrySector: pick("industrySector") ?? null,
    targetLocations: pick("targetLocations") ?? null,
    careerStage: pick("careerStage") ?? pick("careerStageRange") ?? null,
    visaStatus: pick("visaStatus") ?? null,
  }
  // Drop undefineds for a clean Record<string,unknown>.
  return Object.fromEntries(Object.entries(snap).filter(([, v]) => v !== undefined))
}

function firstName(user) {
  const n = typeof user.displayName === "string" ? user.displayName.trim() : ""
  if (!n) return null
  return n.split(/\s+/)[0]
}
function profileHook(snap) {
  // A short, grounded phrase about who they are, for the draft.
  const role = Array.isArray(snap.targetRoleFunction) && snap.targetRoleFunction.length
    ? String(snap.targetRoleFunction[0]).replace(/_/g, " ")
    : null
  const skills = Array.isArray(snap.skills) && snap.skills.length ? snap.skills.slice(0, 2).join(" / ") : null
  if (role && skills) return `${role} work (${skills})`
  if (role) return `${role} roles`
  if (skills) return `${skills}`
  return null
}

// ─── Templated drafts (deterministic fallback when LLM off/unavailable) ──────
// English-only, warm, human, grounded, no over-apology, no model escalation,
// one short text. Carries a TODO marker so an operator knows it wasn't LLM-drafted.
function templatedDraft(reasonCode, ctx) {
  const name = ctx.firstName ? `${ctx.firstName}, ` : ""
  const hook = ctx.profileHook ? ` I still have your ${ctx.profileHook} on file` : " I still have your profile on file"
  const TODO = " [TODO: operator review — templated, not LLM-drafted]"
  switch (reasonCode) {
    case REASON.dupSend:
      return `Hey ${name}quick note — you got a couple of duplicate texts from me by mistake. That was on my end, not you.${hook} and want to keep going whenever you're ready. Want me to pick up where we left off?${TODO}`
    case REASON.chineseInProd:
      return `Hi ${name}one of my earlier messages came through garbled (some of it wasn't even in English) — that's a glitch I've fixed.${hook}. Happy to continue in English whenever you'd like — should I send your next matches?${TODO}`
    case REASON.botErrorLoop:
      return `Hey ${name}I dropped the ball on a few replies earlier and left you hanging.${hook} and I'd love to get you back on track. Want to keep going?${TODO}`
    case REASON.failedOutbound:
      return `Hi ${name}looks like a message I sent didn't make it to you a little while back.${hook}. Just checking back in — want me to send your latest matches?${TODO}`
    default:
      return `Hey ${name}checking back in — I'd like to pick things up whenever you're ready.${TODO}`
  }
}

const WHY_HINT = {
  [REASON.dupSend]: "They received duplicate/double-sent texts (a glitch on our side).",
  [REASON.chineseInProd]: "An earlier message leaked non-English (Chinese) text into the conversation — a defect on our side.",
  [REASON.botErrorLoop]: "The bot returned error/fallback replies and effectively left them hanging.",
  [REASON.failedOutbound]: "An outbound message to them failed to deliver.",
}

// ─── LLM draft (OpenAI → SiliconFlow Qwen). Returns null on any failure. ─────
async function llmDraft(reasonCode, ctx) {
  const sys =
    "You are Claire, a warm, human job-search companion texting one candidate to win them back after a bad experience. " +
    "Write ONE short SMS (max ~320 chars), English only, no emojis, casual texting tone. " +
    "Acknowledge the specific issue briefly and own it once — NO over-apology, no groveling, no repeated sorrys. " +
    "Do NOT mention AI models, upgrades, or that you are an AI. Be concrete and forward-looking: invite them to continue. " +
    "Ground it in their profile when given. Output ONLY the message text, nothing else."
  const usr =
    `Reason this candidate had a bad experience: ${WHY_HINT[reasonCode] ?? reasonCode}\n` +
    `Their first name: ${ctx.firstName ?? "(unknown — don't invent one)"}\n` +
    `Profile hook to ground in: ${ctx.profileHook ?? "(none — keep it general)"}\n` +
    `Write the one-text recovery message now.`

  const openaiKey = process.env.OPENAI_API_KEY?.trim()
  if (openaiKey) {
    const out = await callChat({
      url: "https://api.openai.com/v1/chat/completions",
      key: openaiKey,
      model: "gpt-4.1-mini",
      sys,
      usr,
    })
    if (out) return out
  }
  const sfKey = process.env.SILICONFLOW_API_KEY?.trim()
  if (sfKey) {
    const out = await callChat({
      url: "https://api.siliconflow.cn/v1/chat/completions",
      key: sfKey,
      model: "Qwen/Qwen2.5-7B-Instruct",
      sys,
      usr,
    })
    if (out) return out
  }
  return null
}

async function callChat({ url, key, model, sys, usr }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 12000)
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: usr },
        ],
        temperature: 0.6,
        max_tokens: 200,
      }),
      signal: ac.signal,
    })
    if (!resp.ok) return null
    const j = await resp.json()
    let out = String(j?.choices?.[0]?.message?.content ?? "").trim()
    out = out.replace(/^["'`]+|["'`]+$/g, "").trim()
    if (!out) return null
    if (CJK_DETECT_RE.test(out)) return null // never ship non-English
    if (out.length > 480) out = out.slice(0, 480)
    return out
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ─── Scan pa-outbound → victims ───────────────────────────────────────────────
async function scanVictims(db) {
  // Pull all outbound rows (collection is small, ~1.6k). Group by userId.
  const snap = await db.collection(PA_COLLECTIONS.outbound).get()
  const byUser = new Map() // userId -> rows[]
  let scanned = 0
  for (const doc of snap.docs) {
    const d = doc.data() ?? {}
    const userId = typeof d.userId === "string" ? d.userId : null
    if (!userId) continue
    scanned++
    const row = {
      id: doc.id,
      userId,
      body: bodyOf(d),
      status: String(d.status ?? "").toLowerCase(),
      sendblueStatus: String(d.sendblueStatus ?? "").toUpperCase(),
      role: String(d.role ?? ""),
      toE164: typeof d.toE164 === "string" ? d.toE164 : null,
      sessionId: typeof d.sessionId === "string" ? d.sessionId : null,
      createdMs: tsToMs(d.createdAt) || tsToMs(d.sentAt) || tsToMs(d.updatedAt),
      createdIso: tsToIso(d.createdAt) || tsToIso(d.sentAt) || tsToIso(d.updatedAt),
    }
    const arr = byUser.get(userId) ?? []
    arr.push(row)
    byUser.set(userId, arr)
  }

  // Per user, per reasonCode → at most one victim record (with evidence).
  // Keyed by `${userId}::${reasonCode}` so each (user,reason) becomes one queue row.
  const victims = new Map()
  function addVictim(userId, reasonCode, evidence, sampleRow) {
    const key = `${userId}::${reasonCode}`
    const cur = victims.get(key)
    if (cur) {
      cur.count += evidence.count ?? 1
      if (evidence.examples) cur.examples.push(...evidence.examples)
      // keep the most recent representative session/iso
      if ((sampleRow?.createdMs ?? 0) > (cur.latestMs ?? 0)) {
        cur.latestMs = sampleRow.createdMs
        cur.latestIso = sampleRow.createdIso
        cur.sourceSessionId = sampleRow.sessionId ?? cur.sourceSessionId
        cur.toE164 = sampleRow.toE164 ?? cur.toE164
      }
      return
    }
    victims.set(key, {
      userId,
      reasonCode,
      count: evidence.count ?? 1,
      examples: evidence.examples ? [...evidence.examples] : [],
      latestMs: sampleRow?.createdMs ?? 0,
      latestIso: sampleRow?.createdIso ?? null,
      sourceSessionId: sampleRow?.sessionId ?? null,
      toE164: sampleRow?.toE164 ?? null,
    })
  }

  for (const [userId, rowsRaw] of byUser.entries()) {
    const rows = rowsRaw.slice().sort((a, b) => a.createdMs - b.createdMs)

    // (a) dup_send — TRUE double-fire: same body[:80], two SENT < DUP_WINDOW apart.
    const sentRows = rows.filter((r) => isDeliveredOrSent(r) && r.body)
    const byBody = new Map()
    for (const r of sentRows) {
      const k = r.body.slice(0, 80)
      const arr = byBody.get(k) ?? []
      arr.push(r)
      byBody.set(k, arr)
    }
    let dupPairs = 0
    let dupSample = null
    for (const arr of byBody.values()) {
      if (arr.length < 2) continue
      const sorted = arr.slice().sort((a, b) => a.createdMs - b.createdMs)
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i].createdMs - sorted[i - 1].createdMs
        if (sorted[i].createdMs && sorted[i - 1].createdMs && gap >= 0 && gap < DUP_WINDOW_MS) {
          dupPairs++
          if (!dupSample) dupSample = sorted[i]
        }
      }
    }
    if (dupPairs > 0) {
      addVictim(userId, REASON.dupSend, { count: dupPairs, examples: [dupSample?.body?.slice(0, 80) ?? ""] }, dupSample)
    }

    // (b) chinese_in_prod — meaningful Chinese in a delivered/sent body
    // (running CJK, not an incidental CJK name — see isChineseInProd).
    const cjkRows = rows.filter((r) => isDeliveredOrSent(r) && isChineseInProd(r.body))
    if (cjkRows.length > 0) {
      const last = cjkRows[cjkRows.length - 1]
      addVictim(
        userId,
        REASON.chineseInProd,
        { count: cjkRows.length, examples: [last.body.slice(0, 60)] },
        last
      )
    }

    // (c) bot_error_loop — >=2 canonical bot-error bodies for one user.
    const errRows = rows.filter((r) => r.body && isBotError(r.body))
    if (errRows.length >= 2) {
      const last = errRows[errRows.length - 1]
      addVictim(userId, REASON.botErrorLoop, { count: errRows.length, examples: [last.body.slice(0, 60)] }, last)
    }

    // (d) failed_outbound — status failed / dead_letter.
    const failedRows = rows.filter((r) => r.status === "failed" || r.status === "dead_letter")
    if (failedRows.length > 0) {
      const last = failedRows[failedRows.length - 1]
      addVictim(userId, REASON.failedOutbound, { count: failedRows.length, examples: [last.body.slice(0, 60)] }, last)
    }
  }

  return { scanned, totalUsers: byUser.size, victims: [...victims.values()] }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  initFirebase()
  const db = getFirestore()

  console.log(`\n=== queue-recovery-outbound  (${DRY_RUN ? "DRY-RUN — no writes" : "APPLY — WRITING ROWS"}) ===`)
  console.log(`project=${PROJECT}  llm=${USE_LLM ? "on" : "off"}  dupWindow=${DUP_WINDOW_MS / 1000}s  limit=${LIMIT || "all"}\n`)

  const { scanned, totalUsers, victims } = await scanVictims(db)

  console.log(`Scanned ${scanned} pa-outbound rows across ${totalUsers} users.`)

  // Stable order: most recent evidence first.
  victims.sort((a, b) => (b.latestMs ?? 0) - (a.latestMs ?? 0))
  const work = LIMIT ? victims.slice(0, LIMIT) : victims

  const byReason = {}
  let suppressedCount = 0
  let wouldQueue = 0
  let wrote = 0
  let idempotentHits = 0
  const samples = []
  const userCache = new Map()

  for (const v of work) {
    byReason[v.reasonCode] = (byReason[v.reasonCode] ?? 0) + 1

    // Re-enrich (read-only). Cache per user. Profile may be missing — the
    // suppression helper still gates that case (fail-closed for recovery).
    let user = userCache.get(v.userId)
    if (user === undefined) {
      const usnap = await db.collection(PA_COLLECTIONS.users).doc(v.userId).get()
      user = usnap.exists ? { id: v.userId, ...(usnap.data() ?? {}) } : null
      userCache.set(v.userId, user)
    }

    // Authoritative, fail-closed suppression gate (reads opt-out / privacy /
    // reachability / global stop control). Never mutates, never sends.
    const gateResult = await isSuppressed(db, v.userId, { kind: "recovery" })

    const snap = user ? enrichmentSnapshotOf(user) : {}
    const ctx = user
      ? { firstName: firstName(user), profileHook: profileHook(snap) }
      : { firstName: null, profileHook: null }

    // Draft (LLM when on + suppressed===false benefits, but we draft regardless
    // so an operator sees copy even on suppressed rows; suppressed gates the SEND).
    let draft = null
    if (USE_LLM) {
      draft = await llmDraft(v.reasonCode, ctx)
    }
    const draftSource = draft ? "llm" : "template"
    if (!draft) draft = templatedDraft(v.reasonCode, ctx)

    const whyQueued =
      `${v.reasonCode} x${v.count} (latest ${shortDate(v.latestIso)}). ${WHY_HINT[v.reasonCode] ?? ""}`.trim()

    if (gateResult.suppressed) suppressedCount++
    else wouldQueue++

    const enqueueInput = {
      userId: v.userId,
      toE164: v.toE164 ?? (user && typeof user.phoneE164 === "string" ? user.phoneE164 : null),
      channel: "imessage",
      kind: "recovery",
      draftBody: draft,
      whyQueued,
      reasonCode: v.reasonCode,
      sourceSessionId: v.sourceSessionId ?? null,
      enrichmentSnapshot: {
        ...snap,
        _draftSource: draftSource,
        _evidenceExamples: v.examples.slice(0, 2),
        _suppressionSignals: gateResult.signals,
        _suppressionFailedClosed: gateResult.failedClosed,
      },
      status: "pending",
      suppressed: gateResult.suppressed,
      // Schema wants a string reason only when actually suppressed; null otherwise.
      suppressedReason: gateResult.suppressed ? gateResult.reason : null,
    }

    if (samples.length < 3) {
      samples.push({
        userId: v.userId,
        reasonCode: v.reasonCode,
        suppressed: gateResult.suppressed,
        suppressedReason: gateResult.reason,
        draftSource,
        draftBody: draft,
        whyQueued,
      })
    }

    if (!DRY_RUN) {
      const res = await enqueuePendingOutbound(db, enqueueInput)
      wrote++
      if (res.idempotent) idempotentHits++
    }
  }

  // ─── Report ────────────────────────────────────────────────────────────────
  console.log(`\n── Victim count by reasonCode ──`)
  for (const code of [REASON.dupSend, REASON.chineseInProd, REASON.botErrorLoop, REASON.failedOutbound]) {
    console.log(`  ${code.padEnd(16)} ${byReason[code] ?? 0}`)
  }
  console.log(`  ${"TOTAL".padEnd(16)} ${work.length}`)

  console.log(`\n── Send gate ──`)
  console.log(`  would queue (suppressed=false): ${wouldQueue}`)
  console.log(`  suppressed (gate blocks send) : ${suppressedCount}`)

  console.log(`\n── 3 sample drafts ──`)
  samples.forEach((s, i) => {
    console.log(`\n  [${i + 1}] user=${s.userId}  reason=${s.reasonCode}  draftSource=${s.draftSource}  suppressed=${s.suppressed}${s.suppressed ? ` (${s.suppressedReason})` : ""}`)
    console.log(`      whyQueued: ${s.whyQueued}`)
    console.log(`      draftBody: ${s.draftBody}`)
  })

  if (DRY_RUN) {
    console.log(`\nDRY-RUN complete — nothing written, nothing sent. To persist the queue (still NO send):`)
    console.log(`  cd apps/functions && node --import tsx scripts/queue-recovery-outbound.mjs --apply`)
    console.log(`Then review + approve in the dashboard: https://wekruit-pa.web.app/admin/pending-outbound (status="pending").`)
  } else {
    console.log(`\nAPPLY complete — wrote ${wrote} pa-pending-outbound rows (${idempotentHits} overwrote existing / idempotent). NOTHING WAS SENT.`)
    console.log(`Review + approve in the dashboard: https://wekruit-pa.web.app/admin/pending-outbound (status="pending").`)
  }

  process.exit(0)
}

main().catch((err) => {
  console.error("queue-recovery-outbound failed:", err)
  process.exit(1)
})
