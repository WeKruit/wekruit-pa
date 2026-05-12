#!/usr/bin/env node
/**
 * v1.8 — seed a test job with prescreenConfig so Adam can immediately
 * trigger via SMS: `WeKruit_test-swe-screen-001_<his-userId>_Job`.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import admin from "firebase-admin"

const env = readFileSync("/Users/adam/Desktop/WeKruit/wekruit-pa/.env", "utf8")
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

const jobId = "test-swe-screen-001"
const prescreenConfig = {
  version: 1,
  jobTitle: "Senior Frontend Engineer (Test Job)",
  company: "WeKruit Test Inc",
  threshold: 0.65,
  confidenceThreshold: 0.7,
  maxClarifyRounds: 2,
  voiceMode: "professional_prescreen",
  questions: [
    {
      qId: "q_react_experience",
      type: "MUST_HAVE",
      weight: 2,
      prompt: {
        zh: "请描述你的 React 生产经验 — 项目规模和你的角色",
        en: "Could you describe your React production experience — project scope and your role?",
      },
      clarifyPrompt: {
        zh: "为了准确评估，能否更具体一点 — 项目规模和你的角色?",
        en: "For accurate evaluation, could you be more specific — project scope and your role?",
      },
      keywords: [
        { keyword: "react", weight: 2 },
        { keyword: "production", weight: 1, hint: "shipped to real users, not side projects" },
      ],
    },
    {
      qId: "q_team_collaboration",
      type: "PROBING",
      weight: 1,
      prompt: {
        zh: "你在跨团队协作中扮演过什么角色?",
        en: "Could you describe your role in cross-team collaboration?",
      },
      clarifyPrompt: {
        zh: "请举一个具体例子 — 团队规模和你具体做的事",
        en: "Please give a specific example — team size and what you specifically did",
      },
      keywords: [
        { keyword: "collaboration", weight: 1 },
        { keyword: "leadership", weight: 1, hint: "leading or coordinating across teams" },
      ],
    },
    {
      qId: "q_visa",
      type: "MUST_HAVE",
      weight: 1,
      prompt: {
        zh: "你目前在美国的工作身份是?",
        en: "What is your current US work authorization status?",
      },
      clarifyPrompt: {
        zh: "请说明 — 例如公民/绿卡/OPT/H1B/需要赞助",
        en: "Please clarify — e.g., citizen / green card / OPT / H1B / need sponsorship",
      },
      keywords: [{ keyword: "work_authorization", weight: 1 }],
    },
  ],
  lastEditedBy: "v1.8 seed script",
  lastEditedAt: new Date().toISOString(),
}

await db
  .collection("pa-jobs")
  .doc(jobId)
  .set(
    {
      jobId,
      title: prescreenConfig.jobTitle,
      company: prescreenConfig.company,
      prescreenConfig,
      createdAt: new Date().toISOString(),
      createdBy: "v1.8 test seed",
    },
    { merge: true }
  )
const snap = await db.collection("pa-jobs").doc(jobId).get()
console.log(`✓ seeded pa-jobs/${jobId}`)
console.log(`  jobTitle: ${snap.data().prescreenConfig.jobTitle}`)
console.log(`  threshold: ${snap.data().prescreenConfig.threshold}`)
console.log(`  questions: ${snap.data().prescreenConfig.questions.length}`)
console.log(`    1. q_react_experience (MUST_HAVE weight 2)`)
console.log(`    2. q_team_collaboration (PROBING weight 1)`)
console.log(`    3. q_visa (MUST_HAVE weight 1)`)
console.log(`\nTrigger SMS pattern:`)
console.log(`  WeKruit_${jobId}_<your-userId>_Job`)
console.log(`\nDashboard:`)
console.log(`  https://wekruit-pa.web.app/admin/jobs/${jobId}/prescreen`)
process.exit(0)
