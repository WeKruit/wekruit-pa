// READ-ONLY. What `limit` does the model actually pass to match_yc_people, fleet-wide?
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(".env","utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))) raw=raw.slice(1,-1)
admin.initializeApp({credential:admin.credential.cert(JSON.parse(raw)),projectId:"wekruit-5f89b"})
const db=admin.firestore()
const sinceIso=new Date(Date.now()-20*3600e3).toISOString()
const turns=await db.collection("pa-turns").where("createdAt",">=",sinceIso).get()
const limitDist={}, perTurnCalls={}
let ycTurns=0, ycCalls=0
for(const d of turns.docs){
  const t=d.data()
  const calls=(Array.isArray(t.toolCalls)?t.toolCalls:[]).filter(c=>String(c.name??c.tool??"").includes("yc_people"))
  if(calls.length===0) continue
  ycTurns++; ycCalls+=calls.length
  perTurnCalls[calls.length]=(perTurnCalls[calls.length]??0)+1
  for(const c of calls){
    let a={}; try{a=JSON.parse(c.arguments??c.args??"{}")}catch{}
    const L=a.limit===null||a.limit===undefined?"null(=5)":String(a.limit)
    limitDist[L]=(limitDist[L]??0)+1
  }
}
console.log(`pa-turns last 20h: ${turns.size}; turns w/ match_yc_people: ${ycTurns}; total tool calls: ${ycCalls}`)
console.log(`LIMIT the model passed: ${JSON.stringify(limitDist)}`)
console.log(`match_yc_people calls per TURN: ${JSON.stringify(perTurnCalls)}`)
process.exit(0)
