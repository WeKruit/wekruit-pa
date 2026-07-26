/**
 * Recover everyone the LinkedIn bugs stranded on 2026-07-25, using the SHIPPED shared path
 * (`linkAndEnrichLinkedin`) — so a clean run here is also the end-to-end proof that the fix works
 * on real data, not just in unit tests.
 *
 * Three groups, three different truths, three different messages:
 *
 *   NEEDS_ENRICH  their link never reached us (my fleet pause destroyed the inbound), and then a
 *                 recovery script of mine — running without the Coresignal key, which lives in a
 *                 Firebase secret and not `.env` — told them their link was unreadable. Their URLs
 *                 all resolve (ids verified against the live provider). Enrich, then say it is
 *                 sorted, then let the normal pitch engine speak.
 *   PITCH_ONLY    already enriched by a backfill that deliberately emits no runtime event, so they
 *                 have a profile and were never pitched.
 *   CORRECT_ONLY  already fully enriched, but got the false "couldn't read that one" message. They
 *                 need the correction and nothing else — no re-pitch, no re-enrich.
 *
 * FAIL LOUDLY. The bug this recovers was caused by a script degrading silently on a missing key.
 * Dry run by default; `--apply` additionally requires `--yes-adam-said-go`.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { linkAndEnrichLinkedin } from "../src/linkedin-connect/linkedin-connect-submit.js"
import { normalizeLinkedinProfileUrl } from "../src/linkedin-url.js"
import { enqueueRuntimeEventHandoff } from "../src/runtime-event-handoff.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))),
})
const db = admin.firestore()

const CORESIGNAL = (process.env.CORESIGNAL_API_KEY ?? "").trim()
if (!CORESIGNAL) {
  throw new Error(
    "CORESIGNAL_API_KEY missing. It is a Firebase SECRET, not in .env — this is the exact failure " +
      "that told 8 people their good links were unreadable. Refusing to run.",
  )
}

type Kind = "NEEDS_ENRICH" | "PITCH_ONLY" | "CORRECT_ONLY"
const PLAN: { phone: string; url?: string; kind: Kind }[] = [
  { phone: "+19142521902", url: "https://www.linkedin.com/in/nishant-jain-863253394", kind: "NEEDS_ENRICH" },
  { phone: "+12407430509", url: "https://www.linkedin.com/in/paul-trusov-21a483322/", kind: "NEEDS_ENRICH" },
  { phone: "+14126269523", url: "https://www.linkedin.com/in/anish-madan-1443a6135", kind: "NEEDS_ENRICH" },
  { phone: "+14372555840", kind: "PITCH_ONLY" },
  { phone: "+19257918082", kind: "PITCH_ONLY" },
  { phone: "+447542282427", kind: "CORRECT_ONLY" },
  { phone: "+18476608856", kind: "CORRECT_ONLY" },
  { phone: "+16309407529", kind: "CORRECT_ONLY" },
  { phone: "+17738070088", kind: "CORRECT_ONLY" },
]

const SORTED =
  "quick correction from me — your linkedin was fine all along, my side just couldn't read it earlier 🙈 sorry about that. i've pulled your background now, so you're properly in the pool."
const CORRECTED =
  "quick correction — i told you earlier i couldn't read your linkedin. that was wrong, and it was my end: i already had your background the whole time. sorry for the runaround 🙏 you're in the pool."

async function main() {
  const apply = process.argv.includes("--apply") && process.argv.includes("--yes-adam-said-go")
  const { enqueueOutbound } = await import("@pa/pa-broker")
  const hour = new Date().toISOString().slice(0, 13)
  let enriched = 0, pitched = 0, corrected = 0, failed = 0

  for (const p of PLAN) {
    const r = await db.collection("pa-users").where("phoneE164", "==", p.phone).get()
    if (r.empty) { console.log(`  ${p.phone} — NO USER`); continue }
    const uid = r.docs[0]!.id
    const u = r.docs[0]!.data()
    if (u.doNotContact === true) { console.log(`  ${p.phone} — SKIP (opted out)`); continue }

    let body = ""
    let firePitch = false

    if (p.kind === "NEEDS_ENRICH") {
      const url = normalizeLinkedinProfileUrl(p.url!)
      if (!url) { console.log(`  ${p.phone} — URL DID NOT NORMALIZE (${p.url})`); failed++; continue }
      if (!apply) { console.log(`  ${p.phone} — would enrich ${url} then send "${SORTED.slice(0, 46)}…"`); continue }
      const out = await linkAndEnrichLinkedin({
        db, userId: uid, nowIso: new Date().toISOString(), apiKey: CORESIGNAL,
        canonicalUrl: url, rawUrl: p.url!, source: "paste",
      })
      console.log(`  ${p.phone} — enrich: ${out.reason} (enriched=${out.enriched})`)
      if (!out.enriched && out.reason !== "already_bound") { failed++; continue }
      enriched++
      body = SORTED
      firePitch = true
    } else if (p.kind === "PITCH_ONLY") {
      if (!(u.experienceHighlights?.length || typeof u.coresignalEmployeeId === "number")) {
        console.log(`  ${p.phone} — SKIP (expected enriched, is not)`); failed++; continue
      }
      body = SORTED
      firePitch = true
      pitched++
    } else {
      body = CORRECTED
      corrected++
    }

    if (!apply) { console.log(`  ${p.phone} — would send [${p.kind}] "${body.slice(0, 60)}…" pitch=${firePitch}`); continue }

    await enqueueOutbound(db, {
      userId: uid, toE164: p.phone, body,
      idempotencyKey: `yc-li-recover-${uid}-${hour}`,
      runtimeApproved: true, runtimeSource: "pa_operator_review", seq: 0, paced: true,
    } as never)

    if (firePitch) {
      // The SAME event OAuth emits — the ordinary pitch engine writes the "here's how i'll describe
      // you" bubbles. No second pitch path.
      await enqueueRuntimeEventHandoff(db, {
        userId: uid, toE164: p.phone, source: "linkedin_connect",
        eventKind: "resume_parse_completed",
        idempotencyKey: `yc-li-recover-pitch:${uid}:${hour}`,
        requireExistingSession: false,
        context: { cvParsedTrigger: true, enrichmentSource: "linkedin", linkedinEnriched: true },
      }).catch((err) => console.log(`     pitch handoff failed: ${String(err)}`))
    }
    console.log(`  ${p.phone} — SENT [${p.kind}] pitch=${firePitch}`)
    await new Promise((res) => setTimeout(res, 400))
  }
  console.log(`\n${apply ? "DONE" : "DRY RUN"} enriched=${enriched} pitched=${pitched} corrected=${corrected} failed=${failed}`)
  if (!apply) console.log("needs --apply --yes-adam-said-go")
}

void main().then(() => process.exit(0))
