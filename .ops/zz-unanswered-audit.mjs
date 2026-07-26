/** AUDIT the "unanswered" claim by printing the raw tail of the transcript, instead of trusting a
 *  matching rule. Suspicion: the coalescer batches several user messages into ONE pa-turn, so
 *  `inboundText` is the CONCATENATION and an exact-match against the last single message fails →
 *  false "unanswered". Print both so it is visible either way. */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const since = new Date(Date.now()-24*3600*1000).toISOString()

const users=(await db.collection("pa-users").where("createdAt",">=",since).get()).docs.map(d=>({id:d.id,...d.data()}))
const yc=users.filter(u=>u.ycIntake||String(u.source??"").includes("yc")||String(u.firstTouchCampaign??"").includes("yc"))
const uids=new Set(yc.map(u=>u.id))

const msgs=(await db.collection("pa-messages").where("createdAt",">=",since).get()).docs.map(d=>d.data()).filter(m=>uids.has(String(m.userId)))
const byUser=new Map()
for (const m of msgs){const k=String(m.userId); if(!byUser.has(k))byUser.set(k,[]); byUser.get(k).push(m)}
const turns=(await db.collection("pa-turns").where("createdAt",">=",since).get()).docs.map(d=>d.data()).filter(t=>uids.has(String(t.userId)))
const turnsBy=new Map()
for (const t of turns){const k=String(t.userId); if(!turnsBy.has(k))turnsBy.set(k,[]); turnsBy.get(k).push(t)}

let exactUnanswered=0, substrRescued=0, trulyNothing=0
const truly=[]
for (const u of yc) {
  const list=(byUser.get(u.id)??[]).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  if(!list.length) continue
  const last=list[list.length-1]
  if((last.direction??last.role)!=="user") continue
  const txt=String(last.text??last.body??"").trim()
  const ts=(turnsBy.get(u.id)??[])
  const produced=(t)=>Boolean(String(t.finalText??"").trim())||t.deliveredViaTool===true
  const exact=ts.some(t=>produced(t)&&String(t.inboundText??"").trim()===txt)
  if(exact) continue
  exactUnanswered++
  // SAME message, but the turn batched it with others -> inboundText CONTAINS it.
  const substr=ts.some(t=>produced(t)&&txt&&String(t.inboundText??"").includes(txt))
  if(substr){substrRescued++;continue}
  // Nothing at all: is there ANY turn covering this message, produced or not?
  const anyTurn=ts.find(t=>String(t.inboundText??"").includes(txt))
  trulyNothing++
  if(truly.length<20) truly.push({p:u.phoneE164??u.id,at:String(last.createdAt).slice(11,19),txt:txt.replace(/\n/g," ").slice(0,52),
    turn:anyTurn?`turn exists finalText="${String(anyTurn.finalText??"").slice(0,28)}" tool=${anyTurn.deliveredViaTool} suppressed=${anyTurn.suppressed}`:"NO TURN AT ALL"})
}
console.log(`YC users (24h): ${yc.length}`)
console.log(`last msg is theirs AND no exact-match answered turn : ${exactUnanswered}`)
console.log(`  ...of which the turn BATCHED it (substring match) : ${substrRescued}   <- these WERE answered`)
console.log(`  ...genuinely no produced turn                     : ${trulyNothing}`)
for (const t of truly) console.log(`   ${t.p.padEnd(15)} ${t.at} "${t.txt}"\n        ${t.turn}`)
process.exit(0)
