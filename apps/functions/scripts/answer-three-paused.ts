/**
 * Answer the three people from Adam's screenshot whose messages my fleet pause destroyed
 * (2026-07-25 17:41:06Z–18:12:10Z). Each reply is grounded in what they ACTUALLY said and what we
 * had asked them immediately before — no generic apology, no guessed intent.
 *
 *   +19178615579  we asked "…or should i pull a fresh batch?" → he said "The people you sent are
 *                 not security related", then "Fresh batch" TWICE, then "Hello", then "Thanks!".
 *                 Every one of those was swallowed. He gets the security batch he asked for.
 *   +16027566339  pitched at 16:20, closer asked who he wants to meet → he answered "yes" at 17:57
 *                 and got nothing. Start him off from his own background (AWS/infra) and ask.
 *   +14705301764  answered the intake question honestly — "I'm not building something yet" — and
 *                 got silence. That deserves a human reply, not a card dump.
 *
 * FAIL LOUDLY. The last recovery script read the Coresignal key from `.env` (it is a Firebase
 * secret), got null, and told eight people their good links were unreadable. Anything this script
 * needs, it asserts up front.
 *
 * Dry run by default; `--apply` additionally requires `--yes-adam-said-go`.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import { runYcPeopleMatch, type YcPeopleMatchFilters } from "../src/yc-people-match.js"
import { buildPersonBubble, buildPeopleIntro } from "../src/claire-agent/tools/yc-people-tools.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
const OpenAI = require("openai")
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))),
})
const db = admin.firestore()
if (!process.env.PA_OPENAI_AGENT_API_KEY) throw new Error("PA_OPENAI_AGENT_API_KEY missing — refusing to run half-blind")
const client = new OpenAI({ apiKey: process.env.PA_OPENAI_AGENT_API_KEY })
const embed = async (t: string) =>
  (await client.embeddings.create({ model: "text-embedding-3-small", input: t.slice(0, 8000) })).data?.[0]?.embedding ?? null

type Plan = { phone: string; lead: string; query: string | null; tail?: string }

const PLAN: Plan[] = [
  {
    phone: "+19178615579",
    lead: "sorry — you asked for a fresh batch twice and my side dropped both messages. that was on us, not you 🙏 here's the security-heavy one you actually asked for:",
    query: "security engineering, cybersecurity, application security, infrastructure security, founders building security products",
  },
  {
    phone: "+16027566339",
    lead: "sorry — your reply never reached me, that was on us 🙏 picking it up now. starting from what you've built (AWS infra / CloudFormation / CDK):",
    query: "cloud infrastructure, developer tools, backend and platform engineering, devops",
    tail: "if you'd rather meet a different crowd — investors, a specific space — just say the word and i'll aim there.",
  },
  {
    phone: "+14705301764",
    lead: "sorry, your message never reached me — that was on us 🙏",
    query: null,
    tail: "and honestly, not building anything yet is completely fine here — plenty of people at Startup School are still figuring out what to work on. with your AI-hardware background (the CMOS tape-out work) i can point you at founders in silicon/AI infra, or at people still forming teams. which sounds more useful?",
  },
]

async function main() {
  const apply = process.argv.includes("--apply") && process.argv.includes("--yes-adam-said-go")
  const { enqueueOutbound } = await import("@pa/pa-broker")
  const hour = new Date().toISOString().slice(0, 13)
  const startedMs = Date.now()
  let sent = 0

  for (const p of PLAN) {
    const r = await db.collection("pa-users").where("phoneE164", "==", p.phone).get()
    if (r.empty) { console.log(`  ${p.phone} — NO USER`); continue }
    const uid = r.docs[0]!.id
    const u = r.docs[0]!.data()
    if (u.doNotContact === true) { console.log(`  ${p.phone} — SKIP (opted out)`); continue }
    // JIT re-check: the live agent may have caught up since this script started.
    const ob = await db.collection("pa-outbound").where("userId", "==", uid).get()
    const answered = ob.docs.some((x: { data: () => Record<string, unknown> }) => {
      const d = x.data()
      const c = Date.parse(String(d.createdAt ?? ""))
      return (d.status === "sent" || d.status === "delivered") && Number.isFinite(c) && c > startedMs
    })
    if (answered) { console.log(`  ${p.phone} — SKIP (answered since we started)`); continue }

    const bubbles: string[] = [p.lead]
    if (p.query) {
      const already = new Set<string>((u.ycPeopleMatchSent ?? []) as string[])
      const filters: YcPeopleMatchFilters = { query: p.query }
      const out = await runYcPeopleMatch(
        { userId: uid, limit: 5, filters },
        { db, embed, cosine: cosineSimilarity, loadAlreadySent: async () => already },
      )
      if (out.results.length === 0) {
        bubbles.push("i went back through the pool and there's nobody new who genuinely fits that — i'm not going to pad it with people who don't. more profiles are still landing; i'll text you the moment there's someone worth your time.")
      } else {
        bubbles.push(buildPeopleIntro(out), ...out.results.map(buildPersonBubble))
        if (apply) {
          await db.collection("pa-users").doc(uid).set({
            ycPeopleMatchSent: admin.firestore.FieldValue.arrayUnion(...out.results.map((x) => x.recordId)),
            ycPeopleMatchLastAt: new Date().toISOString(),
          }, { merge: true })
        }
      }
    }
    if (p.tail) bubbles.push(p.tail)

    console.log(`  ${p.phone} — ${apply ? "SENDING" : "would send"} ${bubbles.length} bubble(s)`)
    if (!apply) { bubbles.forEach((b, i) => console.log(`       [${i}] ${b.replace(/\n/g, " ").slice(0, 110)}`)); continue }
    let seq = 0
    for (const body of bubbles) {
      await enqueueOutbound(db, {
        userId: uid, toE164: p.phone, body,
        idempotencyKey: `yc-paused3-${uid}-${seq}-${hour}`,
        runtimeApproved: true, runtimeSource: "pa_operator_review", seq, paced: true,
      } as never)
      seq++
    }
    sent++
    await new Promise((res) => setTimeout(res, 400))
  }
  console.log(`\n${apply ? "SENT" : "WOULD SEND"}=${sent} of ${PLAN.length}`)
  if (!apply) console.log("DRY RUN — needs --apply --yes-adam-said-go")
}

void main().then(() => process.exit(0))
