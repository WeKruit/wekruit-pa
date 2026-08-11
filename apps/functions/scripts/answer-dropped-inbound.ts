/**
 * Answer the people whose inbound message NEVER ENTERED THE PIPELINE (2026-07-25).
 *
 * ROOT CAUSE, measured: the Sendblue webhook received 1371 real inbound messages in 26h; 1314
 * became a `pa-messages` row, 3 survive only inside a coalesced `pa-turns.inboundText`, and 54
 * exist NOWHERE — no message row, no turn, no audit skip reason. Those 54 people wrote to us and
 * the pipeline never saw it, so there was never a reply to be silent about. 39 of the 54 land
 * between 17:38 and 19:38 UTC and a large share are pasted LinkedIn URLs — one person sent the
 * same URL six times and every one vanished.
 *
 * This script replays those messages by hand, doing what the live path should have done:
 *   - a pasted LinkedIn URL  -> enrich from Coresignal (`enrichFromTypedLinkedinUrl`, the SAME
 *                              function the live hook calls), then say what we found
 *   - a request for people   -> `runYcPeopleMatch` (limit 5) and send the cards
 *   - anything else          -> nothing. This script never guesses at an answer.
 *
 * SCOPE IS A FIXED LIST derived from the measurement — there is no discovery step at send time, so
 * it cannot widen. Skips doNotContact. Idempotency-keyed per user per hour. Re-reads each user's
 * state IMMEDIATELY before their send and skips anyone already answered since.
 *
 * Dry run by default; `--apply` additionally requires `--yes-adam-said-go`.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import { runYcPeopleMatch, type YcPeopleMatchFilters } from "../src/yc-people-match.js"
import { buildPersonBubble, buildPeopleIntro } from "../src/claire-agent/tools/yc-people-tools.js"
import { enrichFromTypedLinkedinUrl, extractLinkedinProfileUrl } from "../src/enrich-from-typed-linkedin.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
const OpenAI = require("openai")
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))),
})
const db = admin.firestore()
const client = new OpenAI({ apiKey: process.env.PA_OPENAI_AGENT_API_KEY })
const embed = async (t: string) =>
  (await client.embeddings.create({ model: "text-embedding-3-small", input: t.slice(0, 8000) })).data?.[0]?.embedding ?? null

/** The dropped messages, verbatim from `pa-sendblue-webhook-raw`. Fixed list, no discovery. */
const DROPPED: { phone: string; text: string }[] = [
  { phone: "+19142521902", text: "https://www.linkedin.com/in/nishant-jain-863253394" },
  { phone: "+12407430509", text: "https://www.linkedin.com/in/paul-trusov-21a483322/" },
  { phone: "+14126269523", text: "https://www.linkedin.com/in/anish-madan-1443a6135" },
  { phone: "+447542282427", text: "https://uk.linkedin.com/in/rucha-agashe-687888338" },
  { phone: "+18476608856", text: "linkedin.com/in/patelpoojak" },
  { phone: "+16309407529", text: "https://www.linkedin.com/in/soham-batra-851a342b9" },
  { phone: "+17738070088", text: "https://www.linkedin.com/in/vinayak-kapoor-635a5b235" },
  { phone: "+19293876878", text: "https://www.linkedin.com/in/xiayanz" },
  { phone: "+19452176588", text: "Can you give me more people working on SWE/AI at NVIDIA?" },
  { phone: "+14259796861", text: "and ai agent founders" },
  { phone: "+13237398246", text: "founders and investors" },
  { phone: "+19725051505", text: "suggest people given my background" },
  { phone: "+14082047538", text: "give me more profiles" },
  { phone: "+13015299850", text: "is there anyone doing stuff with unreal engine" },
  { phone: "+18577570369", text: "Are there any that do heavy RAG indexing, like Glean?" },
  { phone: "+14129798690", text: "I m at skild ai working on robotics" },
  { phone: "+16509061826", text: "I'm working on an AI agent orchestration project" },
  { phone: "+14479020872", text: "Robotics, Physical AI, teleoperation software" },
  { phone: "+447587460771", text: "Yep, and I'm working on Robotics and Edge ML right now" },
  { phone: "+14243201960", text: "Well anyone actually, but preferably someone building ai agent" },
]

/** Their words ARE the query — no classification, no invented intent. */
const isPeopleAsk = (t: string) =>
  /founder|investor|angel|vc|engineer|people|profile|someone|anyone|robotic|ai |ml|swe|nvidia|rag|unreal|building|working on/i.test(t)

async function answeredSince(uid: string, sinceMs: number): Promise<boolean> {
  const ob = await db.collection("pa-outbound").where("userId", "==", uid).get()
  return ob.docs.some((x: { data: () => Record<string, unknown> }) => {
    const r = x.data()
    if (r.status !== "sent" && r.status !== "delivered") return false
    const c = Date.parse(String(r.createdAt ?? ""))
    return Number.isFinite(c) && c > sinceMs
  })
}

async function main() {
  const apply = process.argv.includes("--apply") && process.argv.includes("--yes-adam-said-go")
  const { enqueueOutbound } = await import("@pa/pa-broker")
  const hour = new Date().toISOString().slice(0, 13)
  const startedMs = Date.now()
  let sent = 0, skipped = 0

  for (const d of DROPPED) {
    const r = await db.collection("pa-users").where("phoneE164", "==", d.phone).get()
    if (r.empty) { console.log(`  ${d.phone} — NO USER`); skipped++; continue }
    const uid = r.docs[0]!.id
    const u = r.docs[0]!.data()
    if (u.doNotContact === true) { console.log(`  ${d.phone} — SKIP (opted out)`); skipped++; continue }
    // JIT: the live agent may have caught up while this was running.
    if (await answeredSince(uid, startedMs)) { console.log(`  ${d.phone} — SKIP (answered since we started)`); skipped++; continue }

    const bubbles: string[] = []
    const url = extractLinkedinProfileUrl(d.text)

    if (url) {
      // Same function the live paste hook calls, so the outcome is what they should have got.
      const res = await enrichFromTypedLinkedinUrl({
        db, userId: uid, apiKey: process.env.CORESIGNAL_API_KEY ?? null, rawUrl: url, nowIso: new Date().toISOString(),
      })
      if (res.ok) {
        const fresh = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
        const role = fresh.tags?.recentRoleTitle ?? fresh.experienceHighlights?.[0]?.title
        const co = fresh.tags?.recentCompany ?? fresh.experienceHighlights?.[0]?.company
        bubbles.push(
          `sorry — your linkedin link never reached me, that was on us 🙏 got it now.`,
          role && co
            ? `reading you as ${role} at ${co}. that's what founders here will see. tell me who you want to meet and i'll start matching.`
            : `pulled your profile. tell me who you'd want to meet at Startup School and i'll start matching.`,
        )
      } else {
        // The honest ask-again path: we could not read it, so we say so and ask once more.
        bubbles.push(
          `sorry — your linkedin link never reached me, that was on us 🙏`,
          `i tried pulling it just now and couldn't read that one. can you send it once more as the plain profile link — linkedin.com/in/yourname?`,
        )
      }
    } else if (isPeopleAsk(d.text)) {
      const already = new Set<string>((u.ycPeopleMatchSent ?? []) as string[])
      const filters: YcPeopleMatchFilters = { query: d.text }
      const out = await runYcPeopleMatch(
        { userId: uid, limit: 5, filters },
        { db, embed, cosine: cosineSimilarity, loadAlreadySent: async () => already },
      )
      if (out.results.length === 0) { console.log(`  ${d.phone} — SKIP (no new people)`); skipped++; continue }
      bubbles.push(`sorry, your message never reached me — that was on us 🙏 picking it up now:`)
      bubbles.push(buildPeopleIntro(out), ...out.results.map(buildPersonBubble))
      if (apply) {
        await db.collection("pa-users").doc(uid).set({
          ycPeopleMatchSent: admin.firestore.FieldValue.arrayUnion(...out.results.map((x) => x.recordId)),
          ycPeopleMatchLastAt: new Date().toISOString(),
        }, { merge: true })
      }
    } else {
      console.log(`  ${d.phone} — SKIP (not a people ask, not a url — leave for a human)`)
      skipped++
      continue
    }

    console.log(`  ${d.phone} — ${apply ? "SENDING" : "would send"} ${bubbles.length}: ${bubbles[0]!.slice(0, 60)}…`)
    if (!apply) { bubbles.forEach((b, i) => console.log(`       [${i}] ${b.replace(/\n/g, " ").slice(0, 96)}`)); continue }
    let seq = 0
    for (const body of bubbles) {
      await enqueueOutbound(db, {
        userId: uid, toE164: d.phone, body,
        idempotencyKey: `yc-dropped-${uid}-${seq}-${hour}`,
        runtimeApproved: true, runtimeSource: "pa_operator_review", seq, paced: true,
      } as never)
      seq++
    }
    sent++
    await new Promise((res) => setTimeout(res, 400))
  }
  console.log(`\n${apply ? "SENT" : "WOULD SEND"}=${sent} skipped=${skipped} of ${DROPPED.length}`)
  if (!apply) console.log("DRY RUN — needs --apply --yes-adam-said-go")
}

void main().then(() => process.exit(0))
