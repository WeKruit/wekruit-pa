/**
 * The one YC reminder to people who never got their background in (Adam-approved 2026-07-26).
 *
 * TWO COHORTS, TWO TRUTHS — the ask is the same, the opening is not:
 *   A  never started the LinkedIn login. No apology owed; acknowledge that the login is slow
 *      (Adam: "mention that we understand linkedin login is quite long.. unfortunately") and give
 *      them the paste option as the low-friction way out.
 *   B  DID log in, and LinkedIn returned no profile URL, so we hold nothing. From their side it
 *      looked like it worked. That one opens with the apology, because it was our end.
 *
 * Both name the `www.linkedin.com/in/...` form — measured against the live provider 2026-07-25,
 * that form resolved 11/12 of the day's real pasted URLs, while `?utm_source=share_via` (the iOS
 * share button) and a locale host (`uk.linkedin.com`) both returned null.
 *
 * SAFETY: skips doNotContact. Every recipient texted US first (they all sent the QR opener), so the
 * inbound-first rule holds by construction. One message per user, idempotency-keyed, so a re-run
 * cannot double-text. `--limit N` to ramp. Dry run by default.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))),
})
const db = admin.firestore()

const CONNECT_BASE = "https://candidate.wekruit.com/connect-linkedin"

const A_MSG = (link: string) => [
  "hey! it's claire from Startup School 👋 you never got to the part where i actually match you with people worth meeting.",
  `heads up, that linkedin login is genuinely slow — sorry, a lot of people bounced off it today 🙈 if you'd rather skip it, just paste your profile link here instead, ideally the plain www.linkedin.com/in/yourname form. that's all i need.\n\nor if you want the login: ${link}`,
]

const B_MSG = [
  "hey! quick one — you connected linkedin earlier and it looked fine on your side, but linkedin never actually passed your profile over to us, so i've been sitting on an empty page 🙈 that's on us, not you.",
  "fastest fix: paste your profile link here — the plain www.linkedin.com/in/yourname form. one message and i'll pull your background and start matching you with Startup School people.",
]

const hasBg = (u: Record<string, unknown>) =>
  (Array.isArray(u.experienceHighlights) && u.experienceHighlights.length > 0) ||
  typeof u.coresignalEmployeeId === "number"
const oauthed = (u: Record<string, unknown>) => u.linkedinOauthLinked === true || Boolean(u.linkedinOauthSub)

async function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes("--apply") && argv.includes("--yes-adam-said-go")
  const li = argv.indexOf("--limit")
  const LIMIT = li > -1 ? Number(argv[li + 1]) : Infinity
  const only = argv.includes("--group-b") ? "B" : argv.includes("--group-a") ? "A" : "AB"

  const since = new Date(Date.now() - 40 * 3600 * 1000).toISOString()
  const snap = await db.collection("pa-users").where("createdAt", ">=", since).get()
  const yc = snap.docs
    .map((d: { id: string; data: () => Record<string, unknown> }) => ({ id: d.id, ...d.data() }))
    .filter((u: Record<string, unknown>) =>
      Boolean(u.ycIntake) || String(u.source ?? "").includes("yc") || String(u.firstTouchCampaign ?? "").includes("yc"))

  const targets: { u: Record<string, unknown>; group: "A" | "B" }[] = []
  for (const u of yc) {
    if (u.doNotContact === true || !u.phoneE164) continue
    if (hasBg(u)) continue
    const group = oauthed(u) ? "B" : "A"
    if (only !== "AB" && only !== group) continue
    targets.push({ u, group })
  }
  // B first: they are the ones we owe an apology to.
  targets.sort((a, b) => (a.group === b.group ? 0 : a.group === "B" ? -1 : 1))
  const batch = targets.slice(0, LIMIT)

  console.log(`YC users ${yc.length} · reminder targets ${targets.length} (A=${targets.filter((t) => t.group === "A").length} B=${targets.filter((t) => t.group === "B").length}) · sending ${batch.length}`)
  if (!apply) {
    for (const t of batch.slice(0, 4)) {
      const msgs = t.group === "B" ? B_MSG : A_MSG(`${CONNECT_BASE}?u=<token>`)
      console.log(`\n  [${t.group}] ${t.u.phoneE164}`)
      msgs.forEach((m, i) => console.log(`      [${i}] ${m.replace(/\n/g, " ⏎ ").slice(0, 150)}`))
    }
    console.log("\nDRY RUN — needs --apply --yes-adam-said-go")
    return
  }

  const { enqueueOutbound } = await import("@pa/pa-broker")
  const day = new Date().toISOString().slice(0, 10)
  let sent = 0, failed = 0
  for (const t of batch) {
    const uid = String(t.u.id)
    const phone = String(t.u.phoneE164)
    const link = `${CONNECT_BASE}?u=${encodeURIComponent(uid)}`
    const msgs = t.group === "B" ? B_MSG : A_MSG(link)
    try {
      let seq = 0
      for (const body of msgs) {
        await enqueueOutbound(db, {
          userId: uid, toE164: phone, body,
          idempotencyKey: `yc-li-reminder-${t.group}-${uid}-${seq}-${day}`,
          runtimeApproved: true, runtimeSource: "pa_operator_review", seq, paced: true,
        } as never)
        seq++
      }
      sent++
      if (sent % 25 === 0) console.log(`  ${sent}/${batch.length} sent`)
    } catch (err) {
      failed++
      console.log(`  FAIL ${phone} — ${String(err).slice(0, 90)}`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  console.log(`\nDONE sent=${sent} failed=${failed} of ${batch.length}`)
}

void main().then(() => process.exit(0))
