#!/usr/bin/env node
// yc-lane-e2e-sim.mjs — REAL end-to-end through the DEPLOYED CFs (broker-inject, suppressOutbound).
// Walks a fresh YC user's whole journey + tries every job-pull the user might attempt.
// Passes only if ZERO job content appears anywhere across the full conversation.
import { randomUUID } from "node:crypto"
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { readFileSync } from "node:fs"
const PROJECT = "wekruit-5f89b"
const PHONE = process.env.SIM_PHONE ?? "+19999990795"
const CHAT = `iMessage;${PHONE}`
if (!getApps().length) initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"))), projectId: PROJECT })
const db = getFirestore()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const transcript = []
async function turn(text) {
  const id = `harness_${randomUUID()}`, t0 = new Date().toISOString()
  await db.collection("pa-inbound-events").doc(id).set({
    id, status: "pending", idempotencyKey: `harness:${id}`, createdAt: t0, attemptCount: 0, maxAttempts: 1, channel: "imessage",
    rawPayload: { kind: "imessage", participant: PHONE, chatId: CHAT, messageRowId: Date.now(), text, harness: { runner: "yc-lane-e2e", suppressOutbound: true } },
  })
  let uid = null
  for (let i=0;i<75;i++){ await sleep(2000); const d=(await db.collection("pa-inbound-events").doc(id).get()).data(); if(["completed","succeeded"].includes(d?.status)){uid=d.userId;break;} if(["failed","dead_letter"].includes(d?.status))throw new Error("inbound failed: "+d.lastError) }
  await sleep(5000)
  const ob = await db.collection("pa-outbound").where("userId","==",uid).get()
  const bubbles = ob.docs.map((d)=>d.data()).filter((r)=>(r.createdAt??"")>=t0).sort((a,b)=>(a.createdAt??"").localeCompare(b.createdAt??"")).map((r)=>r.body)
  transcript.push({ user: text, claire: bubbles }); return { uid, bubbles }
}
// 1. Real QR redirect → opener.
const r = await fetch(`https://us-central1-${PROJECT}.cloudfunctions.net/paQrStartRedirect?c=yc-startup-school`, { redirect: "manual" })
const opener = decodeURIComponent((r.headers.get("location")||"").match(/[?&]&?body=(.+)$/)?.[1] ?? "")
const t1 = await turn(opener)
const uid = t1.uid
await db.collection("pa-users").doc(uid).set({ testMode: true, isDemo: true }, { merge: true })
// 2-5. walk the journey + adversarial job-pull attempts.
await turn("i'm building an AI vet scribe startup")
await turn("i want to meet consumer founders and investors")
await turn("can you show me some jobs or roles that fit me?")
await turn("yes pull roles for me now")
await turn("just give me the job listings")
// report
console.log(JSON.stringify({ uid, transcript }, null, 2))
const all = transcript.flatMap((t)=>t.claire).join("\n")
const JOB_LEAK = /@ [A-Z]|wekruit\.com\/j\/|_Job\b|pull(ing)? (some )?roles|roles that fit|also fits[^\n]*roles|here are (some )?(roles|jobs)|job (openings|listings)/i
console.log("\n=== LEAK SCAN ===")
console.log("job content leaked:", JOB_LEAK.test(all))
console.log("people/7pm framing present:", /7pm|founders?|investors?|operators?|people|meet/i.test(all))
const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
console.log("source:", u.source, "| ycIntake:", JSON.stringify(u.ycIntake ?? null))
