// 2026-05-07 Bug D live verify — composeNuancedReason after gpt-5.4-nano → gpt-4.1-mini fallback ship.
//
// Flow:
//   1. Create test user with onboardingState=complete + statedPreferences set
//   2. Write parsedCandidateResumes with Adam-shape CV (Tesla + skills)
//   3. Send __PA_FIND_MATCH__ trigger
//   4. Wait + check pa-orchestrator-logs for nuanced_reason events
//
// Pass:  see pa.match.nuanced_reason_fallback_succeeded OR no failure logs
// Fail:  pa.match.nuanced_reason_failed with 401
import admin from "firebase-admin"
import { randomUUID } from "node:crypto"
import { assertProductionPaUserCreationAllowed } from "./lib/prod-test-user-guard.mjs"

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
admin.initializeApp({ credential: admin.credential.cert(sa) })
const db = admin.firestore()

const TEST_PHONE = `+199998${String(Math.floor(Math.random() * 90000) + 10000)}`

function nowIso() { return new Date().toISOString() }
function brokerEvent({ participant, chatId, text }) {
  const id = `harness_${randomUUID()}`
  return {
    id,
    docData: {
      id, status: "pending", idempotencyKey: `harness:${id}`,
      createdAt: nowIso(), attemptCount: 0, maxAttempts: 1, channel: "imessage",
      rawPayload: {
        kind: "imessage", participant, chatId, messageRowId: Date.now(), text,
        harness: { runner: "apps/functions/scripts/e2e-bug-d-verify.mjs", suppressOutbound: true },
      },
    },
  }
}

async function pollInbound(eventId) {
  const start = Date.now()
  while (Date.now() - start < 90000) {
    const d = (await db.collection("pa-inbound-events").doc(eventId).get()).data()
    if (d) {
      if (d.status === "succeeded" || d.status === "completed") return d
      if (d.status === "failed" || d.status === "dead_letter") {
        throw new Error(`inbound ${d.status}: ${d.lastError ?? d.error}`)
      }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error("timeout")
}

async function main() {
  console.log("═══ Bug D live verify (post 7419dff) ═══")
  const userId = `e2e-bugd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  assertProductionPaUserCreationAllowed({
    projectId: "wekruit-5f89b",
    scriptName: "apps/functions/scripts/e2e-bug-d-verify.mjs",
    userId,
    phoneE164: TEST_PHONE,
    reason: "legacy bug D verifier creates a fresh pa-users row",
  })

  console.log("[1] seed test user (complete, English) + parsedCandidateResumes")
  await db.collection("pa-users").doc(userId).set({
    id: userId, phoneE164: TEST_PHONE, channels: { imessageHandle: TEST_PHONE },
    onboardingStatus: "active", onboardingState: "complete", testMode: true,
    cvParsed: true,
    statedPreferences: {
      preferredLang: "en",
      role: "software engineer",
      yoe: "5",
      visaStatus: "sponsorship_needed",
      targetLocations: ["sf_bay_area", "remote_us"],
      careerStage: "mid",
    },
    tags: {
      preferredLang: "en",
      targetRoleFunction: ["software_engineering"],
      industrySector: ["technology", "financial_technology"],
      visaStatus: "sponsorship_needed",
      careerStage: "mid",
    },
    resumeAccepted: { at: nowIso(), expiresAt: new Date(Date.now() + 86400000).toISOString(), triggerHash: "test" },
    createdAt: nowIso(), updatedAt: nowIso(),
  })

  await db.collection("parsedCandidateResumes").doc(`pa:${userId}`).set({
    userId, schemaVersion: "v3",
    createdAt: nowIso(), updatedAt: nowIso(),
    careerLevel: "mid",
    workHistory: [
      {
        title: "Software Engineer", company: "Tesla",
        startDate: "2022-06", endDate: "2024-12",
        description: "Built V&C management portal serving 300+ stores. Led Azure backend migration with Node.js + React.",
        bullets: [
          "Architected V&C management portfolio serving 300+ retail stores",
          "Led migration of legacy backend to Azure microservices",
          "Built React-based admin dashboard with real-time inventory sync",
        ],
      },
      {
        title: "SDE Intern", company: "Microsoft",
        startDate: "2021-06", endDate: "2021-09",
        description: "Worked on Azure SQL infrastructure team — wrote TypeScript migrations.",
      },
    ],
    projects: [
      { name: "Crypto Tracker", description: "Real-time price aggregator across 5 exchanges", technologies: ["python", "websocket", "react"] },
    ],
    topSkills: ["python", "typescript", "node.js", "react", "azure", "kubernetes", "docker", "data_structures_algorithms"],
    industryTags: ["software_engineering", "financial_technology"],
    relevantTags: ["backend", "fullstack", "fintech"],
    preferredLang: "en",
  })

  console.log("[2] send __PA_FIND_MATCH__ to trigger generateJobRecs")
  const ev = brokerEvent({ participant: TEST_PHONE, chatId: `iMessage;${TEST_PHONE}`, text: "__PA_FIND_MATCH__" })
  await db.collection("pa-inbound-events").doc(ev.id).set(ev.docData)
  const eventStartTime = nowIso()
  const result = await pollInbound(ev.id)
  console.log(`  inbound status: ${result.status}`)

  console.log("[3] wait 5s for async match pipeline")
  await new Promise((r) => setTimeout(r, 5000))

  console.log("[4] check pa-orchestrator-logs for nuanced_reason events (single-field filter)")
  const logs = await db.collection("pa-orchestrator-logs")
    .where("userId", "==", userId)
    .limit(80).get()
  const arr = logs.docs.map((d) => d.data()).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
  const nuanced = arr.filter((d) => /nuanced/i.test(d.event ?? ""))
  console.log(`  found ${nuanced.length} nuanced_reason event(s):`)
  for (const e of nuanced) {
    console.log(`    [${e.createdAt?.slice?.(11, 23) ?? "?"}] ${e.event} :: ${JSON.stringify({ err: e.err, model: e.model, primary: e.primary, fallback: e.fallback }).slice(0, 200)}`)
  }

  console.log("[5] check assistant message for nuanced reason text")
  const msgs = await db.collection("pa-messages").where("userId", "==", userId).limit(80).get()
  const recAssistant = msgs.docs.map((d) => d.data())
    .filter((d) => d.role === "assistant" && /two roles|对得上的岗位|line up/.test(d.body ?? ""))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0]
  if (recAssistant) {
    console.log(`  rec body (snip): ${(recAssistant.body ?? "").slice(0, 600)}`)
    const hasTesla = /tesla/i.test(recAssistant.body ?? "")
    const hasGenericTemplate = /核心技能对得上|core skills match|skill\s*x\s*\+\s*y/i.test(recAssistant.body ?? "")
    console.log(`  has personalized cite (Tesla): ${hasTesla}`)
    console.log(`  has generic template: ${hasGenericTemplate}`)
  } else {
    console.log("  NO rec body found — pipeline may still be running async")
  }

  console.log("\n═══ VERDICT ═══")
  const failed = nuanced.filter((e) => e.event === "pa.match.nuanced_reason_failed")
  const succeededFallback = nuanced.filter((e) => e.event === "pa.match.nuanced_reason_fallback_succeeded")
  const retried = nuanced.filter((e) => e.event === "pa.match.nuanced_reason_retrying_fallback")
  console.log(`  failed: ${failed.length}, retried: ${retried.length}, fallback_succeeded: ${succeededFallback.length}`)
  for (const f of failed) console.log(`    fail err: ${(f.err ?? "").slice(0, 120)}`)

  // Pass criteria: NO unfailed nuanced_reason_failed (or all failures are unrecoverable non-401)
  // Or fallback succeeded path observed
  const bugDOk = failed.length === 0 || (retried.length > 0 && succeededFallback.length > 0)
  console.log(`  Bug D verdict: ${bugDOk ? "✓ PASS" : "❌ FAIL"}`)
  process.exit(bugDOk ? 0 : 2)
}

main().catch((e) => { console.error(e); process.exit(1) })
