#!/usr/bin/env node
/**
 * iter28 — patch handbook Bible: 卧 → 卧槽 (Adam preference, full slang form).
 */
import { readFileSync } from "node:fs"
import { initializeApp, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

function getCreds() {
  const j = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (j) return JSON.parse(j)
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (path) return JSON.parse(readFileSync(path, "utf8"))
  throw new Error("set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS")
}
const sa = getCreds()
initializeApp({ credential: cert(sa), projectId: sa.project_id })
const db = getFirestore()

const ref = db.collection("pa-handbooks").doc("claire")
const doc = await ref.get()
const data = doc.data() || {}
const sections = { ...(data.sections || {}) }

// never_5: replace "卧" example with "卧槽" + add slang-fullness rule
if (typeof sections.never_5 === "string") {
  let body = sections.never_5
  body = body.replace(/"卧"/g, '"卧槽"')
  if (!body.includes("卧 → 卧槽")) {
    body += "\n\n**SLANG FULL-FORM**: 写 \"卧槽\" 不写 \"卧\". 单字 \"卧\" 是省略形, 朋友说话用全词."
  }
  sections.never_5 = body
}

// Scan all string sections for stray standalone "卧"
for (const [k, v] of Object.entries(sections)) {
  if (typeof v === "string" && /(?<![一-鿿])卧(?![一-鿿])/.test(v)) {
    console.log(`section ${k} has standalone 卧 — patching`)
    sections[k] = v.replace(/(?<![一-鿿])卧(?![一-鿿])/g, "卧槽")
  }
}

const now = new Date().toISOString()
await ref.set(
  {
    sections,
    version: (data.version || 0) + 1,
    updatedAt: now,
    updatedBy: "iter28-bible-fix@wekruit.com",
    reason: "iter28 — Adam: 卧 should be 卧槽, full slang form preferred",
  },
  { merge: true }
)

await db.collection("pa-audit-events").add({
  actor: "iter28-bible-fix@wekruit.com",
  action: "handbook.update",
  key: "claire",
  reason: "iter28: 卧→卧槽 in opener examples + slang-full-form rule",
  ts: now,
})
console.log("Bible patched")
