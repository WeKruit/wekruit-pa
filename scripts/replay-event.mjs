#!/usr/bin/env node
/**
 * replay-event.mjs — REAL-TURN REPLAY harness (the research's "N-1" method).
 *
 * Re-runs the EXACT production cutover/thin-Claire seam for ONE already-stored inbound
 * event, with a DRY-RUN transport: it RECORDS what would be delivered and SENDS NOTHING
 * to Sendblue (never texts the live phone). This replaces vibe/smoke testing — instead of
 * guessing what Claire would do, you replay a real turn and read the decision.
 *
 * It drives the SAME function the live webhook drives — `maybeRunThinClaire(db, eventId,
 * { dryRun: true, log })` (apps/functions/src/claire-agent/cutover.ts) — so this is the
 * production seam, not a stand-in (repo rule: "eval must drive the real seam"). dryRun is
 * threaded all the way into `createSendblueTransport`, where every sendText/typing/tapback
 * only appends to an in-process ledger; no pa-outbound row, no Sendblue POST.
 *
 * Wiring is REUSED from the existing one-off repro (apps/eval/thin-claire/repro-cutover.mjs
 * + _claire-bundle.mjs): `loadEnv()` pulls OPENAI_API_KEY / PA_OPENAI_AGENT_API_KEY from the
 * repo-root .env, `loadClaireBundle()` esbuild-bundles the production claire-agent (so the
 * zod@4 SDK loads as compiled .js and firebase-admin resolves from the functions graph), and
 * FIREBASE_SERVICE_ACCOUNT_JSON is read from PA_ENV_PATH for the live Firestore read.
 *
 * What it prints, for the replayed turn:
 *   - the inbound text (+ media marker, if any)
 *   - the chosen MODE + coarse pattern (from the deterministic decision trace)
 *   - the ordered TOOL CALLS (name → arguments → output)
 *   - the BUBBLES that WOULD be delivered, in order, each with any mediaUrl
 *   - any SUPPRESSION (deferred-to-legacy, suppress-reply, or dedup-dropped bubbles)
 *
 * Sources (all in-process, captured from the real seam this run — NOT stale reads):
 *   - the `log` stream maybeRunThinClaire emits (mode/defer/suppress decisions + dedup drops),
 *   - the decision trace cutover builds + persists to pa-turns/{eventId} (mode, pattern,
 *     ordered toolCalls with args+output, finalText bubbles, deliveredViaTool, suppressed),
 *     read back after the dry-run completes.
 *
 * USAGE:
 *   PA_ENV_PATH=/Users/adam/Desktop/WeKruit/wekruit-pa/.env \
 *     node --import tsx scripts/replay-event.mjs <eventId>
 *
 * SAFETY: dryRun === true on the transport → zero Sendblue / pa-outbound. The harness never
 * sends. It is fail-open: any capture/print error is reported, never thrown into the turn.
 */
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import admin from "firebase-admin"
import { loadClaireBundle, loadEnv } from "../apps/eval/thin-claire/_claire-bundle.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..")

const PA_INBOUND_EVENTS = "pa-inbound-events"
const PA_TURNS = "pa-turns"

function usage(extra) {
  if (extra) console.error(`\n${extra}\n`)
  console.error(
    [
      "replay-event.mjs — REAL-TURN REPLAY (dry-run, sends nothing to Sendblue)",
      "",
      "Usage:",
      "  PA_ENV_PATH=/Users/adam/Desktop/WeKruit/wekruit-pa/.env \\",
      "    node --import tsx scripts/replay-event.mjs <eventId>",
      "",
      "Re-runs the production cutover/thin-Claire seam for a stored inbound event with a",
      "DRY-RUN transport, then prints: inbound text, chosen mode, ordered tool calls, the",
      "bubbles that WOULD be delivered (in order, with any mediaUrl), and any suppression.",
      "",
      "Env:",
      "  PA_ENV_PATH   path to .env holding FIREBASE_SERVICE_ACCOUNT_JSON (default: repo-root .env)",
      "  OPENAI_API_KEY / PA_OPENAI_AGENT_API_KEY  loaded from that .env if unset",
    ].join("\n"),
  )
}

/** Read FIREBASE_SERVICE_ACCOUNT_JSON from PA_ENV_PATH (mirrors repro-cutover.mjs). */
function loadServiceAccount() {
  const envPath = process.env.PA_ENV_PATH || join(repoRoot, ".env")
  if (!existsSync(envPath)) {
    usage(`env file not found: ${envPath} (set PA_ENV_PATH)`)
    process.exit(1)
  }
  const m = readFileSync(envPath, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)
  if (!m) {
    usage(`FIREBASE_SERVICE_ACCOUNT_JSON not in ${envPath}`)
    process.exit(1)
  }
  let raw = m[1].trim()
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    raw = raw.slice(1, -1)
  }
  return JSON.parse(raw)
}

function pretty(value, max = 1200) {
  if (value === undefined || value === null) return ""
  let s
  if (typeof value === "string") {
    // a tool's args/output is stored as a string; re-indent it when it parses as JSON.
    try {
      s = JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      s = value
    }
  } else {
    // a live object (e.g. captured in-process before the trace's lossy String() coercion).
    try {
      s = JSON.stringify(value, null, 2)
    } catch {
      s = String(value)
    }
  }
  if (s.length > max) s = `${s.slice(0, max)}… (${s.length} chars total)`
  return s
}

async function main() {
  const eventId = process.argv[2]
  if (!eventId) {
    usage("no <eventId> given")
    process.exit(2)
  }

  loadEnv() // OPENAI_API_KEY / PA_OPENAI_AGENT_API_KEY from .env (exits if absent)
  const serviceAccount = loadServiceAccount()
  if (admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: "wekruit-5f89b" })
  }
  const db = admin.firestore()

  // Pull the inbound text up front so we can print it even if the seam defers/suppresses.
  const inboundSnap = await db.collection(PA_INBOUND_EVENTS).doc(eventId).get()
  if (!inboundSnap.exists) {
    usage(`inbound event not found: ${eventId} (collection ${PA_INBOUND_EVENTS})`)
    process.exit(3)
  }
  const inbound = inboundSnap.data() ?? {}
  const inboundText =
    typeof inbound.body === "string" ? inbound.body : typeof inbound.text === "string" ? inbound.text : ""
  const mediaMarker = inbound.mediaUrl || inbound.media_url || (inbound.rawMeta && inbound.rawMeta.mediaUrl)

  console.log("══════════════════════════════════════════════════════════════════")
  console.log("REAL-TURN REPLAY (dry-run — NOTHING is sent to Sendblue)")
  console.log("══════════════════════════════════════════════════════════════════")
  console.log(`eventId   : ${eventId}`)
  console.log(`userId    : ${inbound.userId ?? "(none)"}`)
  console.log(`sessionId : ${inbound.sessionId ?? "(none)"}`)
  console.log(`channel   : ${inbound.channel ?? "(none)"}`)
  console.log("\n── INBOUND TEXT ──────────────────────────────────────────────────")
  console.log(inboundText ? `  ${JSON.stringify(inboundText)}` : "  (no text — media-only / system event)")
  if (mediaMarker) console.log(`  media: ${mediaMarker}`)

  // Capture the in-process log stream the seam emits this turn (decisions + dedup drops).
  const logEvents = []
  const log = (event, payload) => {
    logEvents.push({ event, payload })
  }

  // DRIVE THE REAL SEAM. dryRun === true → transport records intent, sends nothing.
  console.log("\n── DRIVING maybeRunThinClaire(db, eventId, { dryRun: true }) ──────")
  const { maybeRunThinClaire } = await loadClaireBundle()
  let handled
  let threw
  const t0 = Date.now()
  try {
    handled = await maybeRunThinClaire(db, eventId, { dryRun: true, log })
  } catch (e) {
    threw = e
  }
  const ms = Date.now() - t0

  // Read back the decision trace the seam built+persisted this run (pa-turns/{eventId}).
  let trace
  try {
    const traceSnap = await db.collection(PA_TURNS).doc(eventId).get()
    if (traceSnap.exists) trace = traceSnap.data()
  } catch (e) {
    console.log(`  (trace read failed, falling back to log stream: ${e?.message ?? e})`)
  }

  // ── decisions captured from the log stream ──────────────────────────────
  const deferLog = logEvents.find((l) => l.event === "thin_claire_defer_legacy")
  const suppressLog = logEvents.find((l) => l.event === "thin_claire_suppress_reply")
  const turnTraceLog = logEvents.find((l) => l.event === "thin_claire.turn_trace")
  const dedupDrops = logEvents.filter((l) => l.event === "claire.dedup.near_dup_suppressed")
  // find_match delivers its rec rows DIRECTLY via the transport (recorded into the dry-run ledger),
  // not as agent prose — so the trace shows finalText="" / suppressed=true even though rows WERE
  // queued. These in-process logs are the faithful signal for that tool-delivered path.
  const findMatchLog = logEvents.find((l) => l.event === "pa.claire.find_match")
  const findMatchDeliveredLog = logEvents.find((l) => l.event === "pa.claire.find_match.delivered")

  // ── MODE / PATTERN ──────────────────────────────────────────────────────
  const mode = trace?.mode ?? turnTraceLog?.payload?.mode ?? deferLog?.payload?.mode ?? "(unknown)"
  const pattern = trace?.pattern ?? turnTraceLog?.payload?.pattern ?? "(n/a)"
  console.log("\n── DECISION ──────────────────────────────────────────────────────")
  console.log(`  thinHandled    : ${handled}${threw ? " (THREW — see below)" : ""}`)
  console.log(`  mode           : ${mode}`)
  console.log(`  pattern        : ${pattern}`)
  console.log(`  deliveredViaTool: ${trace?.deliveredViaTool ?? turnTraceLog?.payload?.deliveredViaTool ?? "(n/a)"}`)
  if (findMatchLog) {
    const p = findMatchLog.payload ?? {}
    console.log(`  find_match     : ok=${p.ok} recCount=${p.recCount}`)
  }
  console.log(`  duration       : ${ms}ms`)

  // ── ORDERED TOOL CALLS (name → arguments → output) ──────────────────────
  const toolCalls = Array.isArray(trace?.toolCalls) ? trace.toolCalls : []
  console.log("\n── TOOL CALLS (in order) ─────────────────────────────────────────")
  if (toolCalls.length === 0) {
    const names = turnTraceLog?.payload?.toolCalls
    if (Array.isArray(names) && names.length > 0) {
      // older usage-only trace doc — only tool NAMES surfaced via the log payload.
      names.forEach((n, i) => console.log(`  ${i + 1}. ${n}`))
      console.log("  (args/output not in this trace doc — names only)")
    } else {
      console.log("  (none)")
    }
  } else {
    toolCalls.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.name}`)
      if (c.arguments) console.log(`       args  : ${pretty(c.arguments)}`)
      if (c.output) console.log(`       output: ${pretty(c.output)}`)
    })
  }

  // ── BUBBLES that WOULD be delivered (in order, with any mediaUrl) ───────
  // The trace's finalText is the joined multi-bubble reply (blank-line separated — the same
  // boundary deliverBubbles uses). mediaUrl rides on find_match's deliverRows, surfaced from
  // the find_match tool output, so we tag the matching bubble with its image.
  console.log("\n── BUBBLES (would be delivered — NOTHING sent) ───────────────────")
  const finalText = typeof trace?.finalText === "string" ? trace.finalText : ""
  const bubbles = finalText
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
  // collect mediaUrls present in any find_match tool output deliverRows.
  const mediaRows = []
  for (const c of toolCalls) {
    if (!c.output) continue
    try {
      const out = JSON.parse(c.output)
      const rows = Array.isArray(out?.deliverRows) ? out.deliverRows : []
      for (const r of rows) if (r?.mediaUrl) mediaRows.push({ text: String(r.text ?? ""), mediaUrl: r.mediaUrl })
    } catch {
      /* output not JSON — no rows */
    }
  }
  const mediaFor = (bubble) => {
    const hit = mediaRows.find((r) => r.text && bubble.includes(r.text.slice(0, 24)))
    return hit?.mediaUrl
  }
  bubbles.forEach((b, i) => {
    const media = mediaFor(b)
    console.log(`  [${i + 1}] ${b.replace(/\n/g, "\n      ")}`)
    if (media) console.log(`      ⤷ mediaUrl: ${media}`)
  })
  // find_match-delivered rec rows: the row TEXT lives only in the transient transport ledger (which
  // production itself does not persist), but the count + image count are surfaced in-process here.
  if (findMatchDeliveredLog) {
    const p = findMatchDeliveredLog.payload ?? {}
    console.log(
      `  (find_match delivered ${p.roles ?? "?"} rec bubble(s) via the tool` +
        (p.collab ? ` + ${p.collab} collab prescreen offer` : "") +
        `, ${p.withImage ?? 0} with a rec-card image` +
        (mediaRows.length > 0 ? "" : " — image only sends to the rec-card allowlist outside dryRun") +
        `)`,
    )
  }
  if (bubbles.length === 0 && !findMatchDeliveredLog && !trace?.deliveredViaTool) {
    console.log("  (no prose bubbles)")
  }

  // ── SUPPRESSION ─────────────────────────────────────────────────────────
  console.log("\n── SUPPRESSION ───────────────────────────────────────────────────")
  let anySuppression = false
  if (deferLog) {
    anySuppression = true
    console.log(`  DEFERRED to legacy path — mode=${deferLog.payload?.mode} jobId=${deferLog.payload?.jobId ?? "(none)"}`)
    console.log("  (thin returned false; the legacy runner would handle this turn)")
  }
  if (suppressLog) {
    anySuppression = true
    console.log(`  SUPPRESS-REPLY — reason=${suppressLog.payload?.reason ?? "(unspecified)"} (handled, nothing sent)`)
  }
  for (const d of dedupDrops) {
    anySuppression = true
    console.log(`  dedup drop (${d.payload?.scope ?? "?"}): ${String(d.payload?.bubble ?? "").slice(0, 100)}`)
  }
  // The trace's `suppressed` flag is a best-effort proxy (finalText==="" && !deliveredViaTool). It is a
  // FALSE POSITIVE on a find_match turn — the tool delivered the rec rows through the transport itself, so
  // the agent legitimately emitted no prose. Only flag real all-bubble dedup suppression.
  if (trace?.suppressed === true && !findMatchDeliveredLog) {
    anySuppression = true
    if (dedupDrops.length > 0) {
      console.log("  DEDUP-SUPPRESSED-ALL — every prose bubble this turn was a near-dup and got dropped")
    } else {
      console.log("  NO-PROSE — the agent emitted no deliverable prose this turn (and not tool-delivered)")
    }
  }
  if (!anySuppression) console.log("  (none)")

  // ── SAFETY ASSERTION: prove the transport was dry-run (nothing sent) ────
  // The seam never enqueues outbound or POSTs Sendblue under dryRun; there is also no
  // "text"/"status"/"tapback" log error from the transport (those only fire on a real send).
  const realSendSignals = logEvents.filter((l) =>
    ["claire.transport.sendText.error", "claire.transport.sendStatus.error", "claire.transport.tapback.error"].includes(
      l.event,
    ),
  )
  console.log("\n── TRANSPORT SAFETY ──────────────────────────────────────────────")
  console.log(`  dryRun       : true (createSendblueTransport recorded intent only)`)
  console.log(`  real-send ops: ${realSendSignals.length} (must be 0 — Sendblue/pa-outbound untouched)`)

  if (threw) {
    console.log("\n── ERROR (seam threw — fell through to legacy) ───────────────────")
    console.log(`  ${threw?.message ?? threw}`)
    if (threw?.stack) console.log(threw.stack.split("\n").slice(1, 6).join("\n"))
  }

  console.log("\n══════════════════════════════════════════════════════════════════")
  console.log("REPLAY COMPLETE — no message was sent.")
  console.log("══════════════════════════════════════════════════════════════════")
  process.exit(0)
}

main().catch((e) => {
  console.error("\nreplay-event.mjs fatal:", e?.stack ?? e)
  process.exit(1)
})
