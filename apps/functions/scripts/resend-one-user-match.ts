/**
 * Re-send a BETTER match to ONE named user (Adam-authorized, per-user).
 * Reuses the production matcher + the production bubble format, and goes through the normal
 * outbox, so it is byte-identical to what the tool would have sent had personType existed then.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import { runYcPeopleMatch, type YcPeopleMatchFilters } from "../src/yc-people-match.js"
import { buildPersonBubble, buildPeopleIntro } from "../src/claire-agent/tools/yc-people-tools.js"
const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
const OpenAI = require("openai")
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))) })
const db = admin.firestore()
const client = new OpenAI({ apiKey: process.env.PA_OPENAI_AGENT_API_KEY })
const embed = async (t: string) => (await client.embeddings.create({ model: "text-embedding-3-small", input: t.slice(0,8000) })).data?.[0]?.embedding ?? null

async function main() {
  const phone = process.argv[2]!
  const apply = process.argv.includes("--apply")
  const r = await db.collection("pa-users").where("phoneE164","==",phone).get()
  const uid = r.docs[0]!.id
  const u = r.docs[0]!.data()
  const sent = new Set<string>((u.ycPeopleMatchSent ?? []) as string[])
  const filters: YcPeopleMatchFilters = {
    query: "cofounders who have actually built and shipped — insurance, AI governance, policy/trust; senior operators, not students",
    personType: ["founder", "executive", "investor"],
  }
  const out = await runYcPeopleMatch({ userId: uid, limit: 5, filters },
    { db, embed, cosine: cosineSimilarity, loadAlreadySent: async () => sent })
  const bubbles = [
    "went back at that — here's a sharper set, founders and operators who've actually shipped 👇",
    ...out.results.map(buildPersonBubble),
  ]
  console.log(`user=${uid} phone=${phone} sender=${u.senderNumber} newPeople=${out.results.length} alreadySent=${sent.size}`)
  bubbles.forEach((b,i)=>console.log(`\n[${i}] ${b}`))
  if (!apply) { console.log("\nDRY — pass --apply to send"); return }
  const { enqueueOutbound } = await import("@pa/pa-broker")
  let seq = 0
  for (const body of bubbles) {
    await enqueueOutbound(db, {
      userId: uid,
      toE164: phone,
      body,
      idempotencyKey: `out-yc-resend-${uid}-${seq}-${new Date().toISOString().slice(0,13)}`,
      runtimeApproved: true,
      runtimeSource: "pa_operator_review",
      seq,
      paced: true,
    } as never)
    seq++
  }
  await db.collection("pa-users").doc(uid).set({
    ycPeopleMatchSent: admin.firestore.FieldValue.arrayUnion(...out.results.map(x=>x.recordId)),
    ycPeopleMatchLastAt: new Date().toISOString(),
  }, { merge: true })
  console.log(`\nSENT ${bubbles.length} bubbles`)
}
void main().then(()=>process.exit(0))
