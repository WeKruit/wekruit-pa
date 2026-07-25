import { readFileSync } from "node:fs"
import admin from "firebase-admin"
import { searchEmployeeIdByPhotoAssetId } from "@pa/external-supply"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const apiKey = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^CORESIGNAL_API_KEY=(.*)$/m)?.[1]?.trim()
if (!apiKey) { console.log("NO CORESIGNAL_API_KEY in .env"); process.exit(1) }
const snap = await db.collection("pa-users").where("source","==","yc_startup_school").get()
const since = new Date(Date.now()-24*3600*1000).toISOString()
let n=0
for (const d of snap.docs) {
  const u=d.data(); if (String(u.createdAt??"")<since) continue
  const pic=String(u.linkedinOauthPicture??""); const li=String(u.linkedinUrl??"")
  if (!pic || !li.includes("/oauth-linked/")) continue
  if (n++>=4) break
  // same extraction the prod path uses
  const m = pic.match(/image\/(?:v2\/)?([A-Za-z0-9_-]+)\//)
  const assetId = m?.[1] ?? null
  let res = "SKIPPED(no assetId)"
  if (assetId) { try { res = String(await searchEmployeeIdByPhotoAssetId(assetId, { apiKey })) } catch(e){ res = "ERR "+String(e).slice(0,90) } }
  console.log(`${d.id.slice(0,8)}  assetId=${assetId}  coresignal=${res}`)
  console.log(`   pic=${pic.slice(0,110)}`)
}
process.exit(0)
