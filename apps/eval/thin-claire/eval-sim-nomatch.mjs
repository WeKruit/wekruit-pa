#!/usr/bin/env node
// Verify the AGENT (not a hardcoded string) asks a clarifying question when find_match returns 0.
// All user-facing text must come from the LLM. Runs the real model N times to gauge reliability.
import { loadClaireBundle, loadEnv } from "./_claire-bundle.mjs"
loadEnv()
const { runClaireTurn, createSendblueTransport } = await loadClaireBundle()
function makeDb(seed={}){const s=new Map(Object.entries(seed));const dr=(c,i)=>({async get(){return{exists:s.has(`${c}/${i}`),id:i,data:()=>s.get(`${c}/${i}`)}},async set(d,o){s.set(`${c}/${i}`,o?.merge?{...(s.get(`${c}/${i}`)||{}),...d}:{...d})}});const q=()=>{const o={where:()=>o,orderBy:()=>o,limit:()=>o,async get(){return{docs:[],empty:true,size:0,forEach(){}}}};return o};return{collection:c=>({doc:i=>dr(c,i),...q(),async add(d){const i=`a${s.size}`;s.set(`${c}/${i}`,d);return{id:i}}})}}
const U="nomatch-uid",SID="nomatch-sess"
// onboarding complete → triage. jobType=internship saved; user will say 100k → conflict the agent should spot.
const db=makeDb({[`pa-users/${U}`]:{onboardingState:"complete",sharedOnboarding:{completed:true},tags:{targetRoleFunction:["software_engineering"],targetJobType:["internship"],careerStage:"junior",industrySector:["artificial_intelligence_and_machine_learning"]}}})
const findMatch=async()=>({ok:true,recCount:0,jobs:[],reason:"no fresh roles fit those constraints",snapshotTags:{targetRoleFunction:["software_engineering"],targetJobType:["internship"],careerStage:"junior"}})
const N=3,results=[]
for(let i=0;i<N;i++){
  const t=createSendblueTransport({db,toE164:"+14243201960",userId:U,sessionId:SID+i,dryRun:true,log:()=>{}})
  await runClaireTurn({userId:U,sessionId:SID+i,text:"find me roles, I need at least 100k",toE164:"+14243201960",lang:"en"},{db,transport:t,findMatch,log:()=>{},mode:"triage"})
  const reply=t.recordedEvents.filter(e=>e.kind==="text").map(e=>String(e.value??"")).join(" ").trim()
  const kinds=t.recordedEvents.map(e=>e.kind)
  const asksClarifier=/full[- ]?time|intern|broaden|widen|open (it |you )?up|other (cities|roles)|relocat|remote|what (kind|type)|did you mean|usually/i.test(reply)
  results.push({i,len:reply.length,asksClarifier,reply:reply.slice(0,150),kinds})
  console.log(`run${i+1}: text=${reply.length>0?"YES":"SILENT"} asksClarifier=${asksClarifier} [${kinds.join(",")}] → ${reply.slice(0,140).replace(/\n/g," ")}`)
}
const replied=results.filter(r=>r.len>0).length, asked=results.filter(r=>r.asksClarifier).length
console.log(`\nreplied ${replied}/${N}, askedClarifier ${asked}/${N}`)
console.log(replied===N&&asked===N?"NO-MATCH ASK: GREEN ✅ — agent always replies + asks a clarifier (no hardcoded text)":"NO-MATCH ASK: needs agentic guarantee (some runs silent/no-ask)")
process.exit(replied===N&&asked===N?0:1)
