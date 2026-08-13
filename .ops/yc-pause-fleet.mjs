/**
 * FLEET PAUSE (Adam 2026-07-25: "stop the agent for everyone now, we need to fix this first").
 *
 * doNotContact=true makes the deterministic STOP gate in onPaInbound swallow every non-START
 * inbound silently, so Claire cannot reply to anyone. There is no global kill switch in the code,
 * and adding one needs a deploy — this uses the gate that already exists.
 *
 * Every doc we touch gets an `operatorPause` marker, so `--resume` restores EXACTLY the users we
 * paused and never un-opts-out someone who genuinely sent STOP.
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const apply = process.argv.includes("--apply")
const resume = process.argv.includes("--resume")
const nowIso = new Date().toISOString()

const snap = await db.collection("pa-users").get()
const targets = []
for (const d of snap.docs) {
  const u = d.data()
  if (resume) {
    // ONLY ours. A user who really opted out has no operatorPause marker and must stay opted out.
    if (u.operatorPause && u.doNotContact === true) targets.push(d)
    continue
  }
  if (u.doNotContact === true) continue        // already stopped — leave untouched
  if (!u.phoneE164) continue
  const isYc = u.source === "yc_startup_school" || u.ycEventEntryAt || u.firstTouchCampaign === "yc-startup-school"
  if (!isYc) continue
  targets.push(d)
}
console.log(`${resume ? "RESUME" : "PAUSE"} targets: ${targets.length} (of ${snap.size} users)`)
if (!apply) { console.log("DRY RUN — pass --apply"); process.exit(0) }

for (let i = 0; i < targets.length; i += 400) {
  const batch = db.batch()
  for (const d of targets.slice(i, i + 400)) {
    batch.set(d.ref, resume
      ? { doNotContact: false, operatorPause: admin.firestore.FieldValue.delete() }
      : { doNotContact: true, operatorPause: { at: nowIso, by: "adam", reason: "yc event fleet pause — quality, NOT a user opt-out" } },
      { merge: true })
  }
  await batch.commit()
  console.log(`  ${Math.min(i + 400, targets.length)}/${targets.length}`)
}
console.log(`DONE — ${resume ? "resumed" : "paused"} ${targets.length}`)
process.exit(0)
