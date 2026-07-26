/** How often does match_yc_people fire on a message that is NOT a request for people?
 *  Measured before building anything: the last guard I added here suppressed genuine asks. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-20*3600*1000).toISOString()
const t = await db.collection("pa-turns").where("createdAt",">=",since).get()
// A "people ask" = names a person-type, a domain, or asks for more/others.
const ASK = /founder|investor|angel|vc|engineer|designer|operator|people|folks|someone|anyone|connect|intro|meet|match|more|else|other|show|find|who|hiring|cofounder|co-founder/i
const QUESTION = /\?$|^(what|why|how|when|where|can you|could you|do you|did you|is (it|there)|are (you|there)|idk|i don'?t know)/i
let fired=0, nonAsk=0
const samples=[]
for (const d of t.docs) {
  const x=d.data()
  const calls = Array.isArray(x.toolCalls)?x.toolCalls:[]
  if (!calls.some(c=>String(c.name??c.tool??"").includes("match_yc_people"))) continue
  fired++
  const txt = String(x.inboundText??"").trim()
  if (!txt) continue
  if (!ASK.test(txt)) { nonAsk++; if (samples.length<20) samples.push(txt.replace(/\n/g," ").slice(0,90)) }
}
console.log(`turns where match_yc_people fired: ${fired}`)
console.log(`  inbound had NO people-ask token: ${nonAsk}  (${fired?Math.round(nonAsk/fired*100):0}%)`)
console.log("samples of the no-ask inbound text:")
for (const s of samples) console.log(`   "${s}"`)
process.exit(0)
