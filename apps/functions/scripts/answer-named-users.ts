/**
 * Answer a HAND-PICKED list of users whose question we dropped (Adam 2026-07-25, from his
 * screenshots). Explicitly NOT a sweep — the sweep version reached 13 users before I killed it, and
 * Adam's instruction is "no other users allowed, only from the screenshot".
 *
 * The list is hardcoded. There is no discovery step, so it cannot widen.
 *
 * JUST-IN-TIME RE-CHECK: the live agent is running and answering people as we go, so a snapshot
 * taken minutes ago is stale. Each user's state is re-read IMMEDIATELY before their send, and
 * anyone who has been answered since is skipped. That is the check that stops the spam.
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
const client = new OpenAI({ apiKey: process.env.PA_OPENAI_AGENT_API_KEY })
const embed = async (t: string) =>
  (await client.embeddings.create({ model: "text-embedding-3-small", input: t.slice(0, 8000) })).data?.[0]?.embedding ?? null

/** phone → the ask to match on. `null` = do NOT match, send the given line only. */
const PLAN: { phone: string; query: string | null; note?: string }[] = [
  { phone: "+16152432573", query: "quant recruiters, quantitative finance and trading" },
  { phone: "+18577570369", query: "founders and investors" },
  { phone: "+19725051505", query: "later stage founders" },
  // DROPPED: their message was "The first one" — a reply to a question we asked, not an ask of
  // their own. Any query here would be me inventing their intent, and a guessed match sent to an
  // already-annoyed person is worse than nothing. Left for the live agent, which has the thread.
  { phone: "+14082047538", query: "people working on interdisciplinary fields" },
  { phone: "+16473289032", query: "agentic AI, LLM evaluation and full-stack infrastructure builders" },
  { phone: "+19178615579", query: "cybersecurity and security engineering founders" },
  // A joke, not a match ask. Cards here would be the same tin-eared bot behaviour Adam is angry
  // about, so this one gets a human sentence and nothing else.
  { phone: "+16178318159", query: null, note: "i retired them 😄 what are you looking for at startup school — founders, investors, or people building near you?" },
]

async function answeredSince(uid: string, lastMs: number): Promise<boolean> {
  const ob = await db.collection("pa-outbound").where("userId", "==", uid).get()
  return ob.docs.some((x: { data: () => Record<string, unknown> }) => {
    const r = x.data()
    if (r.status !== "sent" && r.status !== "delivered") return false
    const c = Date.parse(String(r.createdAt ?? ""))
    return Number.isFinite(c) && c > lastMs - 2000
  })
}

async function main() {
  const apply = process.argv.includes("--apply") && process.argv.includes("--yes-adam-said-go")
  const { enqueueOutbound } = await import("@pa/pa-broker")
  const hour = new Date().toISOString().slice(0, 13)
  let sent = 0, skipped = 0

  for (const p of PLAN) {
    const r = await db.collection("pa-users").where("phoneE164", "==", p.phone).get()
    if (r.empty) { console.log(`  ${p.phone} — NO USER`); continue }
    const uid = r.docs[0]!.id
    const u = r.docs[0]!.data()
    if (u.doNotContact === true) { console.log(`  ${p.phone} — SKIP (opted out / paused)`); skipped++; continue }

    const msgs = await db.collection("pa-messages").where("userId", "==", uid).get()
    const list = msgs.docs.map((d: { data: () => Record<string, unknown> }) => d.data())
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const lastUser = [...list].reverse().find((x) => (x.direction ?? x.role) === "user")
    const lastMs = Date.parse(String(lastUser?.createdAt ?? 0))

    // THE CHECK. Re-read right now, not from a stale list.
    if (await answeredSince(uid, lastMs)) {
      console.log(`  ${p.phone} — SKIP (already answered since)`)
      skipped++
      continue
    }

    let bubbles: string[]
    if (p.query === null) {
      bubbles = [p.note!]
    } else {
      const already = new Set<string>((u.ycPeopleMatchSent ?? []) as string[])
      const filters: YcPeopleMatchFilters = { query: p.query }
      const out = await runYcPeopleMatch(
        { userId: uid, limit: 5, filters },
        { db, embed, cosine: cosineSimilarity, loadAlreadySent: async () => already },
      )
      if (out.results.length === 0) { console.log(`  ${p.phone} — SKIP (no new people)`); skipped++; continue }
      bubbles = [buildPeopleIntro(out), ...out.results.map(buildPersonBubble)]
      if (apply) {
        await db.collection("pa-users").doc(uid).set({
          ycPeopleMatchSent: admin.firestore.FieldValue.arrayUnion(...out.results.map((x) => x.recordId)),
          ycPeopleMatchLastAt: new Date().toISOString(),
        }, { merge: true })
      }
    }

    console.log(`  ${p.phone} — ${apply ? "SENDING" : "would send"} ${bubbles.length} bubble(s)`)
    if (!apply) { bubbles.forEach((b, i) => console.log(`      [${i}] ${b.replace(/\n/g, " | ").slice(0, 100)}`)); continue }
    let seq = 0
    for (const body of bubbles) {
      await enqueueOutbound(db, {
        userId: uid,
        toE164: p.phone,
        body,
        idempotencyKey: `yc-named-${uid}-${seq}-${hour}`,
        runtimeApproved: true,
        runtimeSource: "pa_operator_review",
        seq,
        paced: true,
      } as never)
      seq++
    }
    sent++
    await new Promise((res) => setTimeout(res, 500))
  }
  console.log(`\n${apply ? "SENT" : "WOULD SEND"}=${sent} skipped=${skipped} (list is fixed at ${PLAN.length})`)
  if (!apply) console.log("DRY RUN — needs --apply --yes-adam-said-go")
}

void main().then(() => process.exit(0))
