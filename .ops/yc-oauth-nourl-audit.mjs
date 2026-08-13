// READ-ONLY. Mirrors the SHIPPED gate exactly (mode-selector askLinkedinUrl):
//   isYcEventUser && linkedinOauthLinked === true && !hasRealLinkedinProfileUrl && !hasFetchedBackground
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const str = (v) => (typeof v === "string" ? v.trim() : "")
const isYc = (u) => u.source === "yc_startup_school" || Boolean(u.ycEventEntryAt) || u.firstTouchCampaign === "yc-startup-school"
const hasRealUrl = (u) => str(u.linkedinUrl).length > 0 && !str(u.linkedinUrl).includes("/oauth-linked/")
const hasParsedProfileOnFile = (u) => {
  if (str(u.latestResumeArtifactId)) return true
  const t = u.tags ?? {}
  if (Array.isArray(t.skills) && t.skills.length > 0) return true
  return Boolean(str(t.recentRoleTitle))
}
const hasFetchedBg = (u) =>
  hasParsedProfileOnFile(u) || typeof u.coresignalEmployeeId === "number" ||
  (Array.isArray(u.experienceHighlights) && u.experienceHighlights.length > 0)
const need = (u) => isYc(u) && u.linkedinOauthLinked === true && !hasRealUrl(u) && !hasFetchedBg(u)

const snap = await db.collection("pa-users").get()
const yc = snap.docs.filter((d) => isYc(d.data()))
let oauth = 0, realUrl = 0, realUrlBg = 0, marker = 0, markerBg = 0, ask = 0, badEnriched = 0, badNever = 0, alreadyAsked = 0
for (const d of yc) {
  const u = d.data()
  if (u.linkedinOauthLinked === true) {
    oauth++
    if (hasRealUrl(u)) { realUrl++; if (hasFetchedBg(u)) realUrlBg++ } else { marker++; if (hasFetchedBg(u)) markerBg++ }
  }
  if (need(u)) {
    ask++
    if (hasFetchedBg(u)) badEnriched++
    if (u.linkedinOauthLinked !== true) badNever++
    if (u.ycIntake?.linkedinUrlAskedAt) alreadyAsked++
  }
}
console.log(`YC users                          ${yc.length}`)
console.log(`  OAuth connected                 ${oauth}`)
console.log(`    real URL                      ${realUrl}   with background ${realUrlBg}  (${realUrl ? Math.round(100*realUrlBg/realUrl) : 0}%)`)
console.log(`    placeholder only              ${marker}   with background ${markerBg}  (${marker ? Math.round(100*markerBg/marker) : 0}%)`)
console.log(`  GATE askLinkedinUrl matches     ${ask}`)
console.log(`    of which already enriched     ${badEnriched}   <- MUST be 0`)
console.log(`    of which never connected      ${badNever}   <- MUST be 0`)
console.log(`    already asked (one-shot used) ${alreadyAsked}`)
