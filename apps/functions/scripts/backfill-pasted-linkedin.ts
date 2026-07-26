/**
 * Enrich the people who pasted a LinkedIn URL BEFORE the fix (Adam 2026-07-25: "there were some
 * paste before that, check the recent conversations too").
 *
 * CORESIGNAL_API_KEY was never bound to onPaInbound/paMessageCoalescer, so every paste returned
 * `no_key` before touching the network. The binding is deployed now, but enrichment only fires on
 * the paste TURN — these users will never self-heal, they are simply stuck with a
 * `/oauth-linked/<sub>` placeholder and an empty profile.
 *
 * Reuses `enrichFromTypedLinkedinUrl`, the same function the live hook calls, so the result is
 * identical to what they should have got at the time: real background, placeholder replaced, and
 * YC pool membership (gated inside on isYcPeopleUser, so a non-YC user enriches but never pools).
 *
 * TEXTS NOBODY. Data only — the pitch is deliberately NOT re-sent, because a pitch arriving hours
 * late out of nowhere is its own bad experience. They get a correct profile; the next thing they
 * say gets answered properly.
 *
 * Dry run by default; `--apply` to write.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { enrichFromTypedLinkedinUrl, extractLinkedinProfileUrl } from "../src/enrich-from-typed-linkedin.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))),
})
const db = admin.firestore()

function hasBackground(u: Record<string, unknown>): boolean {
  if (Array.isArray(u.experienceHighlights) && u.experienceHighlights.length > 0) return true
  if (typeof u.coresignalEmployeeId === "number") return true
  if (typeof u.recentRoleTitle === "string" && u.recentRoleTitle.trim()) return true
  return false
}

async function main() {
  const apply = process.argv.includes("--apply")
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()

  const msgs = await db.collection("pa-messages").where("createdAt", ">=", since).get()
  // Keep the LAST url each person pasted — if they corrected themselves, the correction wins.
  const pasted = new Map<string, { url: string; at: string }>()
  for (const d of msgs.docs) {
    const x = d.data() as Record<string, unknown>
    if ((x.direction ?? x.role) !== "user") continue
    const url = extractLinkedinProfileUrl(String(x.text ?? x.body ?? ""))
    if (!url) continue
    const at = String(x.createdAt ?? "")
    const prev = pasted.get(String(x.userId))
    if (!prev || at > prev.at) pasted.set(String(x.userId), { url, at })
  }

  const todo: { uid: string; url: string; at: string; phone: string }[] = []
  let already = 0
  for (const [uid, { url, at }] of pasted) {
    const u = (await db.collection("pa-users").doc(uid).get()).data() ?? {}
    if (hasBackground(u)) { already++; continue }
    todo.push({ uid, url, at, phone: String(u.phoneE164 ?? "-") })
  }
  todo.sort((a, b) => a.at.localeCompare(b.at))

  console.log(`pasted a LinkedIn URL (24h): ${pasted.size} | already enriched: ${already} | STUCK: ${todo.length}`)
  for (const t of todo) console.log(`  ${t.at.slice(11, 19)} ${t.phone} → ${t.url}`)
  if (!apply) { console.log("\nDRY RUN — pass --apply"); return }

  let ok = 0, miss = 0
  for (const t of todo) {
    const r = await enrichFromTypedLinkedinUrl({
      db,
      userId: t.uid,
      apiKey: process.env.CORESIGNAL_API_KEY ?? null,
      rawUrl: t.url,
      nowIso: new Date().toISOString(),
    })
    if (r.ok) { ok++; console.log(`  OK   ${t.phone}`) }
    else { miss++; console.log(`  MISS ${t.phone} — ${r.reason}`) }
    await new Promise((res) => setTimeout(res, 250))
  }
  console.log(`\nDONE enriched=${ok} missed=${miss}`)
}

void main().then(() => process.exit(0))
