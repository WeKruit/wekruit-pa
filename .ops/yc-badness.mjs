// OFFLINE DIAGNOSTIC ONLY — never shipped, never used for runtime intent classification.
// Ground truth = what the user ACTUALLY received: inbound pa-messages + pa-outbound(sent|delivered).
// User-side signals are STRUCTURAL (consecutive inbounds, near-dup). Phrase lists match OUR OWN
// outbound copy, which we authored — not user prose.
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()
const HOURS = Number(process.env.HOURS ?? 20)
const since = new Date(Date.now()-HOURS*3600*1000).toISOString()

// Internal-state narration: our plumbing described to the user as if it were their world.
const NARRATE = ["on your screen","on their screen","on that same screen","still showing","previous batch",
  "last batch","that batch","another batch","new batch","batch is still","nothing new came through",
  "nothing new can land","nothing new to","i tried to pull","tried to pull","couldn't pull","couldnt pull",
  "can't send another","cant send another","don't want to spam","dont want to spam","spam duplicates",
  "go deeper on","dive deeper","deeper on","on my end","my side yet"]
// Claims about actions we never take.
const FALSE_CLAIM = ["i recommended you","recommended you to","i introduced you","introduced you to",
  "i've introduced","reached out to them","i reached out","i messaged them","added to your contacts",
  "contacts added","treating that as connected","treat that as connected","i'll let them know",
  "let them know you","i've told them","told them about you","i connected you","connected you with",
  "matching on your behalf","i'll intro","i can intro you","i'll pass along","shared your profile with",
  "make the connection","if it's mutual","if its mutual"]
const ASK_LI = ["connect-linkedin","log in with linkedin","paste your linkedin","linkedin profile url",
  "paste the full link","link your linkedin","paste your linkedin link"]
const ASK_INTAKE = ["what are you building","what you're building","what're you building",
  "who do you want to meet","who you want to meet","who would you want to meet","who do you want to talk to"]

const norm=s=>String(s??"").toLowerCase().replace(/https?:\/\/\S+/g," ").replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim()
const sents=s=>String(s??"").split(/(?<=[.!?\n])\s+/).map(norm).filter(x=>x.split(" ").length>=5)
const jac=(a,b)=>{const A=new Set(a.split(" ")),B=new Set(b.split(" "));if(!A.size||!B.size)return 0
  let i=0;for(const x of A)if(B.has(x))i++;return i/(A.size+B.size-i)}
const hit=(t,l)=>l.filter(p=>t.includes(p))

const us=await db.collection("pa-users").where("source","==","yc_startup_school").get()
const U=new Map(us.docs.filter(d=>String(d.data().createdAt??"")>since).map(d=>[d.id,d.data()]))
async function bulk(coll){const out=new Map();let c=since
  for(;;){const s=await db.collection(coll).where("createdAt",">=",c).orderBy("createdAt").limit(5000).get()
    if(s.empty)break;for(const d of s.docs){const x=d.data();if(!U.has(x.userId))continue
      if(!out.has(x.userId))out.set(x.userId,[]);out.get(x.userId).push({_id:d.id,...x})}
    if(s.size<5000)break;c=String(s.docs.at(-1).data().createdAt)}return out}
const MSG=await bulk("pa-messages"), OUT=await bulk("pa-outbound"), TURN=await bulk("pa-turns")

const C={}
const bump=(k,uid,det)=>{ (C[k]??={n:0,th:new Map()}); C[k].n++
  if(!C[k].th.has(uid))C[k].th.set(uid,[]); if(C[k].th.get(uid).length<3)C[k].th.get(uid).push(det) }

let scanned=0, engaged=0, gotPeople=0
const ENG=new Set(), GOT=new Set()
for(const [uid,u] of U){
  const ins=(MSG.get(uid)??[]).filter(m=>m.role==="user").sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const del=(OUT.get(uid)??[]).filter(o=>o.status==="sent"||o.status==="delivered").sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  const turns=(TURN.get(uid)??[]).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))
  if(!ins.length) continue
  scanned++
  const realIns = ins.filter(m=>!String(m.body??"").includes("my code is"))
  if(realIns.length>=1){engaged++;ENG.add(uid)}
  if((u.ycPeopleMatchSent??[]).length>0){gotPeople++;GOT.add(uid)}
  const wire=[...ins.map(x=>({t:x.createdAt,r:"u",b:x.body})),...del.map(x=>({t:x.createdAt,r:"c",b:x.body}))]
    .sort((a,b)=>String(a.t).localeCompare(String(b.t)))

  // A. Claire narrates internal state (delivered copy)
  for(const d of del){const t=String(d.body??"").toLowerCase(),h=hit(t,NARRATE)
    if(h.length)bump("A. Claire narrates our internal state to the user",uid,`${String(d.createdAt).slice(11,19)} [${h.slice(0,3).join("|")}] "${String(d.body).replace(/\n/g," ").slice(0,120)}"`)}

  // B. user asked again with no Claire message in between (structural: we failed to answer)
  for(let i=1;i<wire.length;i++) if(wire[i].r==="u"&&wire[i-1].r==="u"){
    const g=(Date.parse(wire[i].t)-Date.parse(wire[i-1].t))/60000
    if(g>0.4)bump("B. user had to re-ask (no reply delivered in between)",uid,
      `${String(wire[i-1].t).slice(11,19)} "${String(wire[i-1].b).slice(0,50)}" →+${g.toFixed(0)}m→ "${String(wire[i].b).slice(0,50)}"`)}

  // C. user repeated the same ask (near-dup)
  outer: for(let i=1;i<ins.length;i++) for(let j=0;j<i;j++){
    const a=norm(ins[j].body),b=norm(ins[i].body); if(a.split(" ").length<3)continue
    if(jac(a,b)>=0.7){bump("C. user repeated the same ask verbatim-ish",uid,`"${String(ins[j].body).slice(0,45)}" ≈ "${String(ins[i].body).slice(0,45)}"`);break outer}}

  // D. identical Claire message actually DELIVERED 2+ times
  {const seen=new Map()
   for(const d of del){const k=norm(d.body);if(!k)continue
     if(seen.has(k)){bump("D. identical Claire message delivered 2+ times",uid,
       `${String(seen.get(k)).slice(11,19)}→${String(d.createdAt).slice(11,19)} "${String(d.body).replace(/\n/g," ").slice(0,90)}"`);break}
     seen.set(k,d.createdAt)}}

  // E. Claire claims an action we never take
  for(const d of del){const t=String(d.body??"").toLowerCase(),h=hit(t,FALSE_CLAIM)
    if(h.length)bump("E. Claire claims an action we never take",uid,`${String(d.createdAt).slice(11,19)} [${h.join("|")}] "${String(d.body).replace(/\n/g," ").slice(0,110)}"`)}

  // F. turn ran, nothing delivered
  for(const t of turns){ if(t.suppressed)continue
    const ts=Date.parse(t.createdAt)
    if(!del.some(o=>{const dd=Date.parse(o.createdAt)-ts;return dd>=-8000&&dd<=180000}))
      bump("F. turn ran but delivered NOTHING (silence)",uid,
        `${String(t.createdAt).slice(11,19)} tools=[${(t.toolCalls??[]).map(c=>c.name??c).join(",")}] final=${t.finalText?"text":"EMPTY"} viaTool=${t.deliveredViaTool}`)}

  // G. re-asks LinkedIn already given
  const liAt=(()=>{const m=ins.find(x=>/linkedin\.com\/in\//i.test(String(x.body??"")));return m?Date.parse(m.createdAt):null})()
  if(liAt)for(const d of del){if(Date.parse(d.createdAt)<=liAt+3000)continue
    if(hit(String(d.body??"").toLowerCase(),ASK_LI).length)
      bump("G. Claire re-asks for a LinkedIn the user already pasted",uid,`${String(d.createdAt).slice(11,19)} "${String(d.body).replace(/\n/g," ").slice(0,95)}"`)}

  // H. re-asks intake already answered
  const inAt=u.ycIntake?.completedAt?Date.parse(u.ycIntake.completedAt):null
  if(inAt)for(const d of del){if(Date.parse(d.createdAt)<=inAt+3000)continue
    if(hit(String(d.body??"").toLowerCase(),ASK_INTAKE).length)
      bump("H. Claire re-asks intake the user already completed",uid,`${String(d.createdAt).slice(11,19)} "${String(d.body).replace(/\n/g," ").slice(0,95)}"`)}

  // I. unanswered NOW. Tolerance 90s: inbound rows are logged after the reply row is created,
  // so an equal/inverted timestamp on the kickoff pair is an artifact, not a miss.
  {const lastIn=ins.at(-1), lastOut=del.at(-1)
   const isQr = b => String(b??"").includes("my code is")
   if(lastIn && (!lastOut || Date.parse(lastOut.createdAt) < Date.parse(lastIn.createdAt)-90000)){
     const a=(Date.now()-Date.parse(lastIn.createdAt))/60000
     if(a>5) bump(isQr(lastIn.body)
       ? "I2. QR scan never got a kickoff reply"
       : "I1. real user message left unanswered", uid, `${a.toFixed(0)}m ago "${String(lastIn.body).slice(0,65)}"`)}}
}

console.log(`\nYC threads with >=1 inbound, last ${HOURS}h: ${scanned}\n`)
const rank=Object.entries(C).sort((a,b)=>b[1].th.size-a[1].th.size)
console.log(`  of which ENGAGED (said something past the QR code): ${engaged}`)
console.log(`  of which RECEIVED PEOPLE (reached the matcher):    ${gotPeople}\n`)
console.log("CAUSE".padEnd(52),"THRDS".padStart(6),"HITS".padStart(5),"h/th".padStart(5),"%ENGAGED".padStart(9),"%W-PEOPLE".padStart(10))
console.log("-".repeat(90))
for(const [k,v] of rank){
  const inEng=[...v.th.keys()].filter(x=>ENG.has(x)).length
  const inGot=[...v.th.keys()].filter(x=>GOT.has(x)).length
  console.log(k.padEnd(52),String(v.th.size).padStart(6),String(v.n).padStart(5),
    (v.n/v.th.size).toFixed(1).padStart(5),
    ((inEng/engaged*100).toFixed(1)+"%").padStart(9),
    ((inGot/gotPeople*100).toFixed(1)+"%").padStart(10))
}
console.log("\n================ 2 EXAMPLES PER CAUSE ================")
for(const [k,v] of rank){console.log(`\n### ${k}  —  ${v.th.size} threads / ${v.n} hits`)
  let i=0;for(const [uid,det] of v.th){if(i++>=2)break
    console.log(`  ${uid}  ${U.get(uid)?.phoneE164??"-"}`);det.forEach(d=>console.log(`     ${d}`))}}
process.exit(0)
