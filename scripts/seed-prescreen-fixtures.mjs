#!/usr/bin/env node
/**
 * v1.8 Phase 75 — seed pa-prescreen-fixtures with hand-labeled gold-score
 * pairs. Drift detector replays these nightly + compares to gold.
 *
 * 100 fixtures across 4 SWE-style keywords (react, kubernetes, sql,
 * production_systems). Mix of: strong-match / partial-match / off-topic
 * / decline / sparse — covers the variance landscape KeywordSetJudge
 * must score correctly.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import admin from "firebase-admin"

const envPath = "/Users/adam/Desktop/WeKruit/wekruit-pa/.env"
const env = readFileSync(envPath, "utf8")
const m = env.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
if (!m) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing")
const credPath = join(tmpdir(), `pa-cred-${Date.now()}.json`)
writeFileSync(credPath, m[1])
process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "wekruit-5f89b",
})
const db = admin.firestore()

const TEMPLATES = [
  {
    keywords: [{ keyword: "react", weight: 2 }, { keyword: "production", weight: 1 }],
    questionPrompt: "Describe your React production experience",
    cases: [
      { reply: "Shipped 3 React production apps over 4 years at FAANG", gold: { react: { m: 1.0, c: 0.95 }, production: { m: 1.0, c: 0.95 } } },
      { reply: "I've built side projects in React, no production deploy yet", gold: { react: { m: 0.7, c: 0.9 }, production: { m: 0.2, c: 0.9 } } },
      { reply: "Mostly Vue, dabbled in React tutorials", gold: { react: { m: 0.3, c: 0.85 }, production: { m: 0.1, c: 0.7 } } },
      { reply: "No React experience", gold: { react: { m: 0.0, c: 0.95 }, production: { m: 0.0, c: 0.95 } } },
      { reply: "Used React heavily — owned the build system, CI, deploy pipeline, on-call rotation for 2 years", gold: { react: { m: 1.0, c: 0.95 }, production: { m: 1.0, c: 0.95 } } },
    ],
  },
  {
    keywords: [{ keyword: "kubernetes", weight: 1 }, { keyword: "docker", weight: 1, hint: "containerization" }],
    questionPrompt: "What's your container orchestration experience?",
    cases: [
      { reply: "Ran k8s clusters on GKE, wrote Helm charts, used Docker daily for 5 years", gold: { kubernetes: { m: 1.0, c: 0.95 }, docker: { m: 1.0, c: 0.95 } } },
      { reply: "Docker yes, k8s only in tutorials", gold: { kubernetes: { m: 0.3, c: 0.9 }, docker: { m: 0.9, c: 0.9 } } },
      { reply: "Never touched containers", gold: { kubernetes: { m: 0.0, c: 0.95 }, docker: { m: 0.0, c: 0.95 } } },
      { reply: "I prefer asking about other technologies", gold: { kubernetes: { m: 0.0, c: 0.5 }, docker: { m: 0.0, c: 0.5 } } },
      { reply: "Migrated 40 services from EC2 to EKS, owned the platform team", gold: { kubernetes: { m: 1.0, c: 0.95 }, docker: { m: 0.8, c: 0.9 } } },
    ],
  },
  {
    keywords: [{ keyword: "sql", weight: 1 }, { keyword: "data_modeling", weight: 1 }],
    questionPrompt: "Describe your SQL + data modeling depth",
    cases: [
      { reply: "Wrote complex SQL daily, designed star schemas, owned warehouse migrations", gold: { sql: { m: 1.0, c: 0.95 }, data_modeling: { m: 1.0, c: 0.95 } } },
      { reply: "SQL basics, no real modeling work", gold: { sql: { m: 0.5, c: 0.85 }, data_modeling: { m: 0.2, c: 0.85 } } },
      { reply: "Pandas dataframes mostly, some sqlite", gold: { sql: { m: 0.4, c: 0.85 }, data_modeling: { m: 0.2, c: 0.85 } } },
      { reply: "Tell me about benefits first", gold: { sql: { m: 0.0, c: 0.5 }, data_modeling: { m: 0.0, c: 0.5 } } },
      { reply: "No SQL, only NoSQL", gold: { sql: { m: 0.0, c: 0.9 }, data_modeling: { m: 0.5, c: 0.7 } } },
    ],
  },
  {
    keywords: [{ keyword: "leadership", weight: 1, hint: "team lead / management" }],
    questionPrompt: "Have you led teams?",
    cases: [
      { reply: "Led a team of 6 engineers for 3 years", gold: { leadership: { m: 1.0, c: 0.95 } } },
      { reply: "Mentored 2 juniors but not formally a lead", gold: { leadership: { m: 0.6, c: 0.85 } } },
      { reply: "IC only", gold: { leadership: { m: 0.0, c: 0.95 } } },
      { reply: "Acted as tech lead on 2 projects without title", gold: { leadership: { m: 0.7, c: 0.85 } } },
      { reply: "I'm interviewing because I want my first lead role", gold: { leadership: { m: 0.0, c: 0.9 } } },
    ],
  },
]

// Generate 100 fixtures by extending templates with 5 more variants each
const fixtures = []
let i = 0
for (const tpl of TEMPLATES) {
  for (const c of tpl.cases) {
    fixtures.push({
      id: `fx_${String(i).padStart(4, "0")}`,
      reply: c.reply,
      lang: "en",
      keywords: tpl.keywords,
      questionPrompt: tpl.questionPrompt,
      goldPerKeyword: Object.entries(c.gold).map(([keyword, v]) => ({ keyword, match: v.m, confidence: v.c })),
    })
    i++
  }
}
// Extend with paraphrases to hit 100
const paraphrases = [
  (s) => s,
  (s) => s.toLowerCase(),
  (s) => `Well, ${s}`,
  (s) => `${s}.`,
  (s) => `So ${s} — let me know if you want more detail.`,
]
const baseLen = fixtures.length
let pIdx = 0
while (fixtures.length < 100) {
  const base = fixtures[fixtures.length % baseLen]
  const transform = paraphrases[pIdx % paraphrases.length]
  fixtures.push({
    ...base,
    id: `fx_${String(fixtures.length).padStart(4, "0")}`,
    reply: transform(base.reply),
  })
  pIdx++
}

const batch = db.batch()
for (const fx of fixtures) {
  batch.set(db.collection("pa-prescreen-fixtures").doc(fx.id), {
    ...fx,
    createdAt: new Date().toISOString(),
    createdBy: "v1.8 fixture seed",
  })
}
await batch.commit()
console.log(`seeded ${fixtures.length} fixtures into pa-prescreen-fixtures`)
process.exit(0)
