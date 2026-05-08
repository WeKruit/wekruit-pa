/**
 * Probe pa-orchestrator-logs for the latest q_yoe judge invocations.
 * Goal: see what the LLM judge returned for "1-2years" / "2years" replies
 * so we know if the LLM is being called at all and what shape it returned.
 */
import admin from "firebase-admin"

admin.initializeApp()
const db = admin.firestore()

const HOURS = Number(process.env.HOURS ?? "12")
const since = new Date(Date.now() - HOURS * 60 * 60 * 1000)

console.log(`=== PA-ORCHESTRATOR-LOGS — q_yoe related events (last ${HOURS}h) ===`)
const evPrefixes = [
  "pa.onboarding.judge.guided_open",
  "pa.onboarding.pipeline.q_yoe",
  "pa.onboarding.judge.confirmable_tag",
]
const snap = await db
  .collection("pa-orchestrator-logs")
  .orderBy("ts", "desc")
  .limit(3000)
  .get()
let hits = 0
for (const d of snap.docs) {
  const data = d.data()
  const name = data.eventName ?? ""
  if (!evPrefixes.some((p) => name.startsWith(p))) continue
  hits++
  if (hits > 80) break
  const ts = data.ts?._seconds ? new Date(data.ts._seconds * 1000).toISOString() : data.ts
  console.log(
    `${ts}  ${name}  uid=${data.userId ?? data.payload?.userId ?? "?"}  payload=${JSON.stringify(
      data.payload ?? {}
    ).slice(0, 600)}`
  )
}
console.log(`yoe-judge-related events: ${hits} (scanned ${snap.size})`)

console.log(`\n=== PA-INBOUND yoe-shaped replies (last ${HOURS}h) ===`)
const inb = await db
  .collection("pa-inbound")
  .where("createdAt", ">=", since)
  .orderBy("createdAt", "desc")
  .limit(200)
  .get()
let yoeShaped = 0
for (const d of inb.docs) {
  const data = d.data()
  const body = (data.body ?? "").trim()
  if (!body) continue
  if (
    /\b\d+\s*[-–—]\s*\d+\s*y/i.test(body) ||
    /^\d+\s*y/i.test(body) ||
    /\bfresh\b/i.test(body) ||
    /^\d+\s*$/.test(body) ||
    /year/i.test(body) ||
    /应届|刚毕业/i.test(body)
  ) {
    yoeShaped++
    const ts = data.createdAt?._seconds
      ? new Date(data.createdAt._seconds * 1000).toISOString()
      : data.createdAt
    console.log(`${ts}  uid=${data.userId}  body="${body}"  id=${d.id}`)
  }
  if (yoeShaped >= 30) break
}
console.log(`yoeShaped: ${yoeShaped}`)

console.log(`\n=== PA-OUTBOUND last 30 ack/rephrase that mention years ===`)
const out = await db
  .collection("pa-outbound")
  .where("createdAt", ">=", since)
  .orderBy("createdAt", "desc")
  .limit(150)
  .get()
let outYoe = 0
for (const d of out.docs) {
  const data = d.data()
  const body = (data.body ?? "").trim()
  if (
    /years?|year/i.test(body) ||
    /几年|应届/i.test(body) ||
    /ballpark/i.test(body) ||
    /fresh/i.test(body)
  ) {
    outYoe++
    if (outYoe > 30) break
    const ts = data.createdAt?._seconds
      ? new Date(data.createdAt._seconds * 1000).toISOString()
      : data.createdAt
    console.log(`${ts}  uid=${data.userId}  body="${body.slice(0, 240)}"`)
  }
}
