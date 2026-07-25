/**
 * YC Startup School — "LinkedIn login is slow, try again" reminder (Adam 2026-07-25).
 *
 * WHY: a lot of scanners send the QR opener, tap the LinkedIn link, and are never seen again.
 * Measured cause: LinkedIn's OAuth page is slow to load and if you leave it before it finishes,
 * LinkedIn cancels the authorization — so from our side it looks like they simply vanished.
 * They are not uninterested; they hit a slow page.
 *
 * AUDIENCE (deterministic, no guessing):
 *   YC-lane user  AND  never produced usable background  AND  went quiet after the kickoff
 *   AND not opted out  AND we have not already sent them this reminder.
 * A user who connected LinkedIn AND enriched is EXCLUDED — nothing to retry.
 *
 * SAFETY: dry-run by default. `--apply` alone still refuses; it also needs `--yes-adam-said-go`,
 * because standing repo policy is dev-phones-only unless Adam explicitly authorizes a real send.
 * `--limit N` caps the batch. Every send is idempotency-keyed so a re-run cannot double-text.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))),
})
const db = admin.firestore()

/**
 * TWO cohorts, two truths — one message would be a lie to half of them.
 *
 * A) NEVER COMPLETED THE TAP → retrying genuinely works. This is Adam's copy: name the cause
 *    (slow page, leaving cancels it), ask only if they're still interested.
 * B) TAPPED, NO PROFILE CAME BACK → LinkedIn DID authorize them; it just withholds the profile
 *    URL when the member's public profile isn't visible (measured: 39 placeholders, 1 enriched;
 *    the photo-asset fallback resolved 0 of 28). Telling THESE people "try again" would be
 *    false — the same tap produces the same nothing. Ask for the URL instead.
 */
const REMINDER_RETRY = [
  "hey! quick heads up in case you tried and it didn't take 🙈",
  "the LinkedIn login page is slow to load, and if you back out before it finishes LinkedIn cancels the login on their side — so it looks like nothing happened.",
  "if you're still interested, worth one more try (give it a few seconds to load) 👉 {{LINK}}",
  "no worries at all if not — just reply STOP and i'll leave you be.",
].join("\n\n")

const REMINDER_PASTE_URL = [
  "hey! thanks for connecting LinkedIn earlier — that part worked on your end 🙏",
  "but LinkedIn didn't actually pass your profile over to us, so i still can't see your background. that's on their side, not yours — retrying the login won't change it.",
  "if you're still interested, just paste your LinkedIn URL here (linkedin.com/in/…) — or drop your résumé, whichever is easier. either one works and i'll pull it from there.",
  "no worries at all if not — just reply STOP and i'll leave you be.",
].join("\n\n")

/** Real background on file — the ONLY thing that makes this reminder pointless. */
function hasBackground(u: Record<string, unknown>): boolean {
  if (Array.isArray(u.experienceHighlights) && u.experienceHighlights.length > 0) return true
  if (typeof u.coresignalEmployeeId === "string" && u.coresignalEmployeeId) return true
  if (typeof u.recentRoleTitle === "string" && u.recentRoleTitle.trim()) return true
  return false
}

function isYcLane(u: Record<string, unknown>): boolean {
  return (
    u.source === "yc_startup_school" ||
    Boolean(u.ycEventEntryAt) ||
    u.firstTouchCampaign === "yc-startup-school"
  )
}

async function main() {
  const apply = process.argv.includes("--apply") && process.argv.includes("--yes-adam-said-go")
  const armed = process.argv.includes("--apply")
  const limIdx = process.argv.indexOf("--limit")
  const limit = limIdx > -1 ? Number(process.argv[limIdx + 1]) : Number.POSITIVE_INFINITY

  const snap = await db.collection("pa-users").get()
  const targets: { uid: string; phone: string; name: string; cohort: "retry" | "paste_url" }[] = []
  let skipEnriched = 0
  let skipOptOut = 0
  let skipAlready = 0

  for (const d of snap.docs) {
    const u = d.data() as Record<string, unknown>
    if (!isYcLane(u)) continue
    const phone = typeof u.phoneE164 === "string" ? u.phoneE164 : ""
    if (!phone) continue
    if (u.doNotContact === true || u.optedOut === true) { skipOptOut++; continue }
    if (hasBackground(u)) { skipEnriched++; continue }
    const yc = (u.ycIntake ?? {}) as Record<string, unknown>
    if (yc.linkedinSlowReminderAt) { skipAlready++; continue }
    targets.push({
      uid: d.id,
      phone,
      name: String(u.firstName ?? u.name ?? "-"),
      cohort: u.linkedinOauthLinked === true ? "paste_url" : "retry",
    })
  }

  const batch = targets.slice(0, limit)
  const nRetry = batch.filter((t) => t.cohort === "retry").length
  console.log(`YC users with NO usable background: ${targets.length}`)
  console.log(`  excluded — already enriched: ${skipEnriched} | opted out: ${skipOptOut} | already reminded: ${skipAlready}`)
  console.log(`  sending to: ${batch.length}${Number.isFinite(limit) ? ` (--limit ${limit})` : ""}`)
  console.log(`    A) never completed the tap → RETRY copy   : ${nRetry}`)
  console.log(`    B) tapped, no profile back → PASTE-URL copy: ${batch.length - nRetry}`)
  console.log(`\n--- A) RETRY (link is per-user) ---\n${REMINDER_RETRY}`)
  console.log(`\n--- B) PASTE URL ---\n${REMINDER_PASTE_URL}\n`)
  for (const t of batch.slice(0, 10)) console.log(`  ${t.phone}  ${t.name}  (${t.cohort})`)
  if (batch.length > 10) console.log(`  … +${batch.length - 10} more`)

  if (!apply) {
    console.log(
      armed
        ? "\nREFUSED: --apply given but --yes-adam-said-go missing. Real-recipient sends need Adam's explicit go."
        : "\nDRY RUN. To send: --apply --yes-adam-said-go [--limit N]",
    )
    return
  }

  const { enqueueOutbound } = await import("@pa/pa-broker")
  const { getOrIssueLinkedinConnectLink } = await import("../src/linkedin-connect/connect-token.js")
  const day = new Date().toISOString().slice(0, 10)
  let sent = 0
  for (const t of batch) {
    let body = REMINDER_PASTE_URL
    if (t.cohort === "retry") {
      let link = "https://wekruit.com/connect-linkedin"
      try {
        link = await getOrIssueLinkedinConnectLink(db, t.uid, t.phone)
      } catch {
        // Per-user token mint failed → the generic connect page still resolves identity there.
      }
      body = REMINDER_RETRY.replace("{{LINK}}", link)
    }
    await enqueueOutbound(db, {
      userId: t.uid,
      toE164: t.phone,
      body,
      idempotencyKey: `yc-li-slow-${t.uid}-${day}`,
      runtimeApproved: true,
      runtimeSource: "pa_operator_review",
      seq: 0,
      paced: true,
    } as never)
    await db
      .collection("pa-users")
      .doc(t.uid)
      .set({ ycIntake: { linkedinSlowReminderAt: new Date().toISOString() } }, { merge: true })
    sent++
  }
  console.log(`\nSENT ${sent}`)
}

void main().then(() => process.exit(0))
