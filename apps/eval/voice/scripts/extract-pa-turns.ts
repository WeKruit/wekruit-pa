/**
 * extract-pa-turns.ts — Phase 24 / Plan 02
 *
 * Exports the last N user→assistant turn pairs from Firestore `pa-messages`
 * (falling back to `pa-turns` if messages are sparse) and emits JSONL on stdout
 * matching the golden-50 schema. Labels are "UNLABELED" — Adam picks 50 from
 * the output and hand-labels them per HITL-LABELING-GUIDE.md.
 *
 * Usage:
 *   pnpm tsx apps/eval/voice/scripts/extract-pa-turns.ts --limit 200 > apps/eval/voice/fixtures/_extracted-raw.jsonl
 *
 * Env vars:
 *   GOOGLE_APPLICATION_CREDENTIALS — path to service-account JSON
 *   FIREBASE_SERVICE_ACCOUNT_PATH  — alternative path (same as GOOGLE_APPLICATION_CREDENTIALS)
 *   FIREBASE_SERVICE_ACCOUNT_JSON  — raw JSON string (CI/secret injection)
 *   PA_FIRESTORE_PROJECT_ID        — project ID (e.g. wekruit-pa-prod)
 */

import { parseArgs } from "node:util"
import { getFirebaseApp, getFirestore } from "@pa/firebase-admin"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    limit: { type: "string", default: "200" },
    collection: { type: "string", default: "pa-messages" },
  },
})

const LIMIT = parseInt(values.limit ?? "200", 10)
const COLLECTION = values.collection ?? "pa-messages"

// ---------------------------------------------------------------------------
// Simple tag heuristics
// ---------------------------------------------------------------------------
function inferTags(userMsg: string, assistantMsg: string): string[] {
  const tags: string[] = []
  const text = userMsg + " " + assistantMsg

  // Language detection by CJK character ratio
  const totalChars = text.replace(/\s/g, "").length
  const cjkChars = (text.match(/[一-鿿　-〿＀-￯]/g) || []).length
  const ratio = totalChars > 0 ? cjkChars / totalChars : 0
  if (ratio > 0.3) tags.push("zh")
  else if (ratio < 0.05) tags.push("en")
  else tags.push("mixed")

  // Scenario detection from user message
  const u = userMsg.toLowerCase()
  if (/焦虑|烦|累|难受|沮丧|崩溃|失眠|emo|vent|stressed|anxious|burned/.test(u)) tags.push("vent")
  if (/offer|拿到|录用|通过|恭喜|成功|celebrate|got (the|a) job|accepted/.test(u)) tags.push("celebrate")
  if (/[?？]|怎么|如何|should i|how to|what to|can i|能不能|要不要/.test(u)) tags.push("question")
  if (/投了|简历|面试|hr|jd|岗位|applied|resume|interview/.test(u)) tags.push("job-search")
  if (/算了|不管了|懒得|随便|whatever|forget it|never mind/.test(u)) tags.push("deflect")

  return tags
}

// ---------------------------------------------------------------------------
// Firestore query
// ---------------------------------------------------------------------------
interface FirestoreMessage {
  role?: string
  content?: string
  text?: string
  userId?: string
  sessionId?: string
  createdAt?: string | { toDate(): Date }
  sender?: string
  body?: string
}

async function fetchPairs(
  collection: string,
  limit: number
): Promise<Array<{ userId: string; sessionId: string; userMsg: string; assistantMsg: string; timestamp: string }>> {
  getFirebaseApp()
  const db = getFirestore()

  // Query last `limit*2` messages ordered by createdAt desc (we need pairs)
  const snap = await db
    .collection(collection)
    .orderBy("createdAt", "desc")
    .limit(limit * 2)
    .get()

  if (snap.empty) {
    process.stderr.write(`[extract-pa-turns] No documents found in ${collection}\n`)
    return []
  }

  // Group messages by sessionId and pair consecutive user→assistant turns
  const bySession: Record<string, Array<FirestoreMessage & { id: string }>> = {}

  for (const doc of snap.docs) {
    const d = doc.data() as FirestoreMessage
    const sid: string = (d.sessionId as string) || doc.id.replace(/-\d+$/, "")
    if (!bySession[sid]) bySession[sid] = []
    bySession[sid].push({ ...d, id: doc.id })
  }

  const pairs: Array<{
    userId: string
    sessionId: string
    userMsg: string
    assistantMsg: string
    timestamp: string
  }> = []

  for (const [sid, msgs] of Object.entries(bySession)) {
    // Sort ascending by createdAt
    msgs.sort((a, b) => {
      const aTime = a.createdAt instanceof Object
        ? (a.createdAt as { toDate(): Date }).toDate().getTime()
        : new Date(a.createdAt as string || 0).getTime()
      const bTime = b.createdAt instanceof Object
        ? (b.createdAt as { toDate(): Date }).toDate().getTime()
        : new Date(b.createdAt as string || 0).getTime()
      return aTime - bTime
    })

    for (let i = 0; i < msgs.length - 1; i++) {
      const cur = msgs[i]
      const next = msgs[i + 1]
      const curRole = cur.role || cur.sender || "unknown"
      const nextRole = next.role || next.sender || "unknown"

      if (/^user$/i.test(curRole) && /^assistant|model|ai|claire/i.test(nextRole)) {
        const userMsg = cur.content || cur.text || cur.body || ""
        const assistantMsg = next.content || next.text || next.body || ""
        if (userMsg.trim().length < 3 || assistantMsg.trim().length < 3) continue

        const rawTs = cur.createdAt
        const ts = rawTs instanceof Object
          ? (rawTs as { toDate(): Date }).toDate().toISOString()
          : (rawTs as string) || new Date().toISOString()

        pairs.push({
          userId: (cur.userId as string) || "unknown",
          sessionId: sid,
          userMsg,
          assistantMsg,
          timestamp: ts,
        })

        if (pairs.length >= limit) break
      }
    }
    if (pairs.length >= limit) break
  }

  return pairs
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  process.stderr.write(`[extract-pa-turns] Extracting up to ${LIMIT} pairs from ${COLLECTION}\n`)

  let pairs = await fetchPairs(COLLECTION, LIMIT)

  // Fallback to pa_turns if pa_messages returned nothing
  if (pairs.length === 0 && COLLECTION === "pa-messages") {
    process.stderr.write("[extract-pa-turns] Falling back to pa_turns collection\n")
    pairs = await fetchPairs("pa-turns", LIMIT)
  }

  process.stderr.write(`[extract-pa-turns] Extracted ${pairs.length} pairs\n`)

  pairs.forEach((p, i) => {
    const id = `extracted-${String(i + 1).padStart(3, "0")}`
    const tags = inferTags(p.userMsg, p.assistantMsg)
    const row = {
      id,
      context: [],
      turns: [
        { role: "user", content: p.userMsg },
        { role: "assistant", content: p.assistantMsg },
      ],
      label: "UNLABELED",
      why: "",
      tags,
      userId: p.userId,
      sessionId: p.sessionId,
      verified_at: p.timestamp.slice(0, 10),
    }
    process.stdout.write(JSON.stringify(row) + "\n")
  })
}

main().catch((err) => {
  process.stderr.write(`[extract-pa-turns] Fatal: ${err}\n`)
  process.exit(1)
})
