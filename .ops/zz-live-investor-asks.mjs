/**
 * READ-ONLY: live "investor" asks and the person-cards actually delivered for them,
 * with each delivered person's PRIMARY personType. Split BEFORE/AFTER a deploy boundary.
 *
 *   PA_ENV_PATH=$PWD/.env DEPLOY_AT=2026-07-25T17:44:00Z node .ops/zz-live-investor-asks.mjs
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"
let raw = readFileSync(process.env.PA_ENV_PATH, "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const DEPLOY_AT = process.env.DEPLOY_AT ?? "2026-07-25T17:44:00Z"
const SINCE = process.env.SINCE ?? "2026-07-25T13:00:00Z"

// pool by name — cards carry "Name — Title @ Company"
const pool = await db.collection("pa-external-candidate-records").where("enrichment.cohort", "==", "yc_startup_school_2026").get()
const byName = new Map()
for (const d of pool.docs) {
  const x = d.data()
  if (x.name) byName.set(String(x.name).toLowerCase().trim(), x.businessDescriptor?.personType ?? [])
}

const msgs = await db.collection("pa-messages").where("createdAt", ">=", SINCE).get()
const asks = []
for (const d of msgs.docs) {
  const m = d.data()
  const dir = m.direction ?? m.role
  if (dir !== "user" && dir !== "inbound") continue
  const text = String(m.text ?? m.body ?? "")
  if (!/\binvestor|\bvc\b|angel/i.test(text)) continue
  asks.push({ uid: m.userId, at: String(m.createdAt ?? ""), text: text.replace(/\n/g, " ").slice(0, 70) })
}
asks.sort((a, b) => a.at.localeCompare(b.at))

const out = await db.collection("pa-outbound").where("createdAt", ">=", SINCE).get()
const outByUser = new Map()
for (const d of out.docs) {
  const x = d.data()
  if (!outByUser.has(x.userId)) outByUser.set(x.userId, [])
  outByUser.get(x.userId).push(x)
}

const show = (label, list) => {
  console.log(`\n############ ${label} (${list.length} asks) ############`)
  for (const a of list) {
    const cards = (outByUser.get(a.uid) ?? [])
      .filter((r) => String(r.createdAt ?? "") > a.at && String(r.createdAt ?? "") < new Date(Date.parse(a.at) + 100000).toISOString())
      .map((r) => String(r.body ?? ""))
      .filter((b) => / — .+ @ /.test(b) || /^[A-Z][a-zA-Z'\-. ]+ — /.test(b))
    if (cards.length === 0) continue
    console.log(`\n  ${a.at.slice(11, 19)} uid=${a.uid} ask="${a.text}"`)
    let primary = 0
    for (const c of cards) {
      const name = c.split(" — ")[0].trim().toLowerCase()
      const pt = byName.get(name) ?? []
      const isP = pt[0] === "investor"
      if (isP) primary++
      console.log(`     ${isP ? "PRIMARY-INVESTOR" : "                "} ${c.slice(0, 60)}   personType=[${pt.join(",")}]`)
    }
    console.log(`     => ${primary}/${cards.length} primary-investor`)
  }
}

show("BEFORE DEPLOY", asks.filter((a) => a.at < DEPLOY_AT))
show("AFTER DEPLOY", asks.filter((a) => a.at >= DEPLOY_AT))
process.exit(0)
