import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH,"utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
// all yc users
const us = await db.collection("pa-users").where("source","==","yc_startup_school").get()
const ycIds = new Set(us.docs.map(d=>d.id))
console.log("yc users:", ycIds.size)
const JOB_TOOLS = new Set(["find_match","match_collab","save_job_profile","set_daily_subscription","find_my_role","begin_collab_prescreen","get_public_role_start","set_matching_preferences","capture_match_feedback","check_prescreen_progress","ask_next_onboarding_question","record_onboarding_answer"])
const turns = await db.collection("pa-turns").where("createdAt",">=","2026-07-25T00:00:00Z").get()
console.log("turns today:", turns.size)
const leaks=[], silents=[]
for (const t of turns.docs) {
  const d = t.data()
  if (!ycIds.has(d.userId)) continue
  const names = (d.toolCalls??[]).map(c=>c.name)
  const jt = names.filter(n=>JOB_TOOLS.has(n))
  if (jt.length) leaks.push({at:d.createdAt, uid:d.userId, tools:jt.join("+"), inb:String(d.inboundText??"").slice(0,50), fin:String(d.finalText??"").slice(0,60), sup:d.suppressed})
  const silent = (!d.finalText || !String(d.finalText).trim()) && d.deliveredViaTool !== true
  if (silent) silents.push({at:d.createdAt, uid:d.userId, tools:names.join(","), inb:String(d.inboundText??"").slice(0,60), sup:d.suppressed})
}
leaks.sort((a,b)=>String(a.at).localeCompare(String(b.at)))
silents.sort((a,b)=>String(a.at).localeCompare(String(b.at)))
console.log(`\n===== JOB-TOOL LEAKS IN YC LANE (${leaks.length}) =====`)
for (const l of leaks) console.log(` ${String(l.at).slice(11,19)} ${l.uid.slice(0,8)} [${l.tools}] sup=${l.sup} in="${l.inb}" out="${l.fin}"`)
console.log(`\n===== SILENT TURNS (no text, not tool-delivered) (${silents.length}) =====`)
for (const s of silents) console.log(` ${String(s.at).slice(11,19)} ${s.uid.slice(0,8)} sup=${s.sup} tools=[${s.tools}] in="${s.inb}"`)
process.exit(0)
