import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw = raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const uid = "8fEwIduUrzxZsblHHsNz"

console.log("=== pa-messages (full transcript, time-sorted) ===")
const msgs = await db.collection("pa-messages").where("userId","==",uid).get()
msgs.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.createdAt||a.timestamp).localeCompare(String(b.createdAt||b.timestamp)))
  .forEach(x=>console.log(`  ${x.createdAt||x.timestamp} | ${(x.role||x.direction||"?").padEnd(9)} | ${JSON.stringify(String(x.text||x.body||x.content||"").slice(0,72))}`))

console.log("\n=== pa-outbound (all, status) ===")
const out = await db.collection("pa-outbound").where("userId","==",uid).get()
out.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  .forEach(x=>console.log(`  ${x.createdAt} | status=${String(x.status).padEnd(8)} | attempts=${x.attemptCount??x.attempts??"-"} | err=${JSON.stringify(x.lastError||x.error||"-").slice(0,60)} | ${JSON.stringify(String(x.body||"").slice(0,60))}`))

console.log("\n=== inbound events (recent for this user) ===")
const ev = await db.collection("pa-inbound-events").limit(300).get()
ev.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.userId===uid||String(x.from||x.fromNumber||"").includes("4243201960"))
  .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,6)
  .forEach(x=>console.log(`  ${x.createdAt} | status=${x.status} | handledBy=${x.handledBy||"-"} | attempts=${x.attemptCount}/${x.maxAttempts} | err=${x.error||x.lastError||"-"} | ${JSON.stringify(String(x.body||"").slice(0,40))}`))

console.log("\n=== captured canonical tags (loop result) ===")
const u=(await db.collection("pa-users").doc(uid).get()).data()
const t=u.tags||{}
const show=["targetRoleFunction","targetLocations","targetCountry","industrySector","visaStatus","minSalary","companySize","prefersStartup","careerStage","targetJobType"]
for(const k of show) if(t[k]!==undefined) console.log(`  ${k}: ${JSON.stringify(t[k])}`)
console.log("  onboardingState:",u.onboardingState,"| sharedOnboarding.completed:",u.sharedOnboarding?.completed)

console.log("\n=== matching-jobs catalog sanity (for this user's role) ===")
const roles = Array.isArray(t.targetRoleFunction)?t.targetRoleFunction:[]
if (roles.length){
  const mj = await db.collection("matching-jobs").where("status","==","active").where("roleFunction","array-contains-any",roles.slice(0,10)).limit(5).get().catch(e=>({size:-1,_err:e.message}))
  console.log(`  active jobs matching roleFunction ${JSON.stringify(roles)}: ${mj.size}${mj._err?` (ERR ${mj._err})`:""}`)
} else console.log("  (no targetRoleFunction set → matcher has no hard-filter seed)")
process.exit(0)
