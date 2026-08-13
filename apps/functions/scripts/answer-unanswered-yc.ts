/**
 * Answer the YC attendees whose last message never got a reply (Adam 2026-07-25: "process their
 * message now").
 *
 * WHY NOT A WEBHOOK REPLAY: `pa-sendblue-webhook-raw` stores `sb-signing-secret` as
 * "<redacted 64 chars>", so the original payloads cannot be re-POSTed. That redaction is a
 * deliberate control and is not worth defeating. Instead this reuses the SAME production matcher
 * and the SAME bubble format the agent tool uses, and goes out through the normal outbox — byte
 * identical to what the live tool would have sent, which is exactly the shape of the already-proven
 * per-user resend (scripts/resend-one-user-match.ts).
 *
 * SCOPE: only people whose unanswered message was a request for PEOPLE. Anything else (a question
 * about their résumé, "Where did the em dashes go") is left for a human — this script must never
 * guess at an answer it cannot ground.
 *
 * SAFETY: dry run by default; `--apply` additionally requires `--yes-adam-said-go`. Skips
 * doNotContact. Idempotency-keyed per user per hour so a re-run cannot double-text. `--limit N`.
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

async function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes("--apply") && argv.includes("--yes-adam-said-go")
  const armed = argv.includes("--apply")
  const li = argv.indexOf("--limit")
  const limit = li > -1 ? Number(argv[li + 1]) : Number.POSITIVE_INFINITY
  const since = new Date(Date.now() - 8 * 3600 * 1000).toISOString()

  const msgs = await db.collection("pa-messages").where("createdAt", ">=", since).get()
  const byUser = new Map<string, Record<string, unknown>[]>()
  for (const d of msgs.docs) {
    const x = d.data() as Record<string, unknown>
    const uid = String(x.userId)
    if (!byUser.has(uid)) byUser.set(uid, [])
    byUser.get(uid)!.push(x)
  }

  const targets: { uid: string; phone: string; text: string; at: string }[] = []
  for (const [uid, list] of byUser) {
    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const last = list[list.length - 1]!
    if ((last.direction ?? last.role) !== "user") continue
    // DELIVERED-ONLY, 2s tolerance. Two things made an earlier version report 1 unanswered when the
    // truth was 38: it counted rows that never left (`duplicate_skipped`), and a 90s back-tolerance
    // credited the PREVIOUS turn's closing message as a reply to the NEXT question. The tolerance
    // exists only because pa-outbound rows are written a beat before pa-messages rows; that
    // inversion is ~1-2s, never 90.
    const lastMs = Date.parse(String(last.createdAt))
    const ob = await db.collection("pa-outbound").where("userId", "==", uid).get()
    const answered = ob.docs.some((x: { data: () => Record<string, unknown> }) => {
      const r = x.data()
      if (r.status !== "sent" && r.status !== "delivered") return false
      const c = Date.parse(String(r.createdAt ?? ""))
      return Number.isFinite(c) && c > lastMs - 2000
    })
    if (answered) continue
    const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
    if (u.doNotContact === true || !u.phoneE164) continue
    targets.push({ uid, phone: String(u.phoneE164), text: String(last.text ?? last.body ?? ""), at: String(last.createdAt) })
  }
  targets.sort((a, b) => a.at.localeCompare(b.at))

  const batch = targets.slice(0, limit)
  console.log(`unanswered: ${targets.length} | processing: ${batch.length}`)
  if (!apply) {
    for (const t of batch.slice(0, 15)) console.log(`  ${t.at.slice(11, 19)} ${t.phone} "${t.text.replace(/\n/g, " ").slice(0, 56)}"`)
    console.log(armed ? "\nREFUSED: --apply needs --yes-adam-said-go." : "\nDRY RUN. To send: --apply --yes-adam-said-go [--limit N]")
    return
  }

  const { enqueueOutbound } = await import("@pa/pa-broker")
  const hour = new Date().toISOString().slice(0, 13)
  let sent = 0, skipped = 0
  for (const t of batch) {
    // Their own words ARE the query. No classification, no guessing — if the matcher finds nobody
    // worth sending, we send nothing rather than invent an answer.
    const filters: YcPeopleMatchFilters = { query: t.text.slice(0, 300) }
    const sentIds = new Set<string>(((await db.collection("pa-users").doc(t.uid).get()).data()?.ycPeopleMatchSent ?? []) as string[])
    const out = await runYcPeopleMatch(
      { userId: t.uid, limit: 5, filters },
      { db, embed, cosine: cosineSimilarity, loadAlreadySent: async () => sentIds },
    )
    if (out.results.length === 0) { skipped++; console.log(`  skip ${t.phone} — no new people`); continue }
    const bubbles = [buildPeopleIntro(out), ...out.results.map(buildPersonBubble)]
    let seq = 0
    for (const body of bubbles) {
      await enqueueOutbound(db, {
        userId: t.uid,
        toE164: t.phone,
        body,
        idempotencyKey: `yc-recover-${t.uid}-${seq}-${hour}`,
        runtimeApproved: true,
        runtimeSource: "pa_operator_review",
        seq,
        paced: true,
      } as never)
      seq++
    }
    await db.collection("pa-users").doc(t.uid).set({
      ycPeopleMatchSent: admin.firestore.FieldValue.arrayUnion(...out.results.map((r) => r.recordId)),
      ycPeopleMatchLastAt: new Date().toISOString(),
    }, { merge: true })
    sent++
    console.log(`  sent ${t.phone} — ${out.results.length} people`)
    await new Promise((r) => setTimeout(r, 300))
  }
  console.log(`\nDONE sent=${sent} skipped=${skipped}`)
}

void main().then(() => process.exit(0))
