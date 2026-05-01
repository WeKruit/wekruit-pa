#!/usr/bin/env node
/**
 * Stream H2 — standalone 10-round CV-driven sim driver.
 *
 * Usage:
 *   SILICONFLOW_API_KEY=... \
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
 *   node tests/scenarios/run-cv-sim-once.mjs [scenario.yaml]
 *
 * Defaults to tests/scenarios/scenarios/eval-cv-onboarding-10round-zh.yaml.
 *
 * Writes:
 *   eval-runs/cv-sim-{ISO-stamp}/transcript.json
 *   eval-runs/cv-sim-{ISO-stamp}/run-meta.json
 *
 * Adam can then read transcript.json and write SELF-AUDIT.md.
 *
 * NOTE: Drives every Claire turn through the LIVE deployed orchestrator
 * (paOnPaInbound) by writing into pa-inbound-events. Polls pa-messages for
 * the assistant reply, exactly like runner.mjs §runTurn. Bypasses the
 * YAML turn loop entirely; no judge calls; no cost-ceiling logic.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { randomUUID } from "node:crypto"
import { parse as parseYaml } from "yaml"
import { initializeApp, getApps, applicationDefault, cert } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

import { simulateCvOnboarding } from "./lib/cv-driven-sim.mjs"

const PA_INBOUND = "pa-inbound-events"
const PA_OUTBOUND = "pa-outbound"
const PA_MESSAGES = "pa-messages"
const PA_USERS = "pa-users"
const PA_AUDIT_EVENTS = "pa-audit-events"

function nowIso() { return new Date().toISOString() }

function normalizeE164(phone) {
  const d = phone.replace(/\D/g, "")
  if (phone.trim().startsWith("+")) return `+${d}`
  return d.length === 10 ? `+1${d}` : `+${d}`
}

function getDb() {
  if (getApps().length === 0) {
    const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (jsonEnv && jsonEnv.trim().length > 0) {
      const sa = JSON.parse(jsonEnv)
      initializeApp({ credential: cert(sa), projectId: sa.project_id })
    } else if (path) {
      const sa = JSON.parse(readFileSync(path, "utf8"))
      initializeApp({ credential: cert(sa), projectId: sa.project_id })
    } else {
      initializeApp({
        credential: applicationDefault(),
        projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
      })
    }
  }
  return getFirestore()
}

async function ensureScenarioTestUser(db, scenario) {
  const normalized = scenario.participant
  const snap = await db.collection(PA_USERS)
    .where("phoneE164", "==", normalized).limit(1).get()
  if (!snap.empty) {
    const id = snap.docs[0].id
    await db.collection(PA_USERS).doc(id).set(
      { testMode: true, updatedAt: nowIso() }, { merge: true })
    return id
  }
  const id = randomUUID()
  await db.collection(PA_USERS).doc(id).set({
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    onboardingStatus: "provisional",
    channels: { imessageHandle: normalized },
    phoneE164: normalized,
    testMode: true,
  })
  return id
}

function brokerEvent({ participant, chatId, text }) {
  const id = `harness_${randomUUID()}`
  return {
    id,
    docData: {
      id,
      status: "pending",
      idempotencyKey: `harness:${id}`,
      createdAt: nowIso(),
      attemptCount: 0,
      maxAttempts: 1,
      channel: "imessage",
      rawPayload: {
        kind: "imessage",
        participant,
        chatId,
        messageRowId: Date.now(),
        text,
        harness: {
          runner: "tests/scenarios/run-cv-sim-once.mjs",
          suppressOutbound: true,
        },
      },
    },
  }
}

async function pollUntil(probe, { timeoutMs, intervalMs = 500, label }) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const out = await probe()
    if (out) return out
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timeout after ${timeoutMs}ms waiting for: ${label}`)
}

async function driveOneTurn(db, scenario, text, turnIdx) {
  const event = brokerEvent({
    participant: scenario.participant,
    chatId: scenario.chatId,
    text,
  })
  const t0 = Date.now()
  await db.collection(PA_INBOUND).doc(event.id).set(event.docData)
  const evRef = db.collection(PA_INBOUND).doc(event.id)
  await pollUntil(async () => {
    const snap = await evRef.get()
    const data = snap.data()
    if (!data) return false
    if (data.status === "succeeded" || data.status === "completed") return data
    if (data.status === "failed" || data.status === "dead_letter") {
      throw new Error(`Inbound failed: ${data.lastError ?? data.error ?? "unknown"}`)
    }
    return false
  }, { timeoutMs: 60000, label: `inbound ${event.id} completed` })

  const reply = await pollUntil(async () => {
    const byMeta = await db.collection(PA_MESSAGES)
      .where("rawMeta.eventId", "==", event.id).limit(5).get()
    if (!byMeta.empty) {
      const a = byMeta.docs.map((d) => d.data())
        .find((d) => d.role === "assistant" && typeof d.body === "string" && d.body.length > 0)
      if (a) return a.body
    }
    return false
  }, { timeoutMs: 120000, label: `reply for ${event.id}` }).catch((err) => {
    console.error(`  [drive] reply poll error: ${err.message}`)
    return null
  })

  const claireMs = Date.now() - t0
  let mem0Calls = 0
  try {
    const snap = await db.collection(PA_AUDIT_EVENTS)
      .where("eventId", "==", event.id).limit(20).get()
    mem0Calls = snap.docs.map((d) => d.data())
      .filter((d) => typeof d.kind === "string" && d.kind.startsWith("mem0")).length
  } catch {}
  return { reply: reply ?? "", claireMs, mem0Calls, eventId: event.id }
}

async function main() {
  const yamlPath = resolve(
    process.argv[2] ??
    "tests/scenarios/scenarios/eval-cv-onboarding-10round-zh.yaml"
  )
  const scenario = parseYaml(readFileSync(yamlPath, "utf8"))
  if (scenario.simulator !== "cv-driven-sim") {
    throw new Error(`scenario.simulator must be cv-driven-sim, got ${scenario.simulator}`)
  }
  scenario.participant = scenario.participant.startsWith("+") ? scenario.participant : normalizeE164(scenario.participant)

  console.error(`[h2] scenario=${scenario.id}`)
  console.error(`[h2] resumeId=${scenario.resumeId} simTurns=${scenario.simTurns} lang=${scenario.simLang}`)

  const db = getDb()
  await db.collection(PA_INBOUND).limit(1).get()  // sanity ping
  const userId = await ensureScenarioTestUser(db, scenario)
  console.error(`[h2] testMode user resolved as ${userId}`)

  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const outDir = resolve("eval-runs", `cv-sim-${stamp}`)
  mkdirSync(outDir, { recursive: true })

  const drive = {
    runTurn(text, turnIdx) { return driveOneTurn(db, scenario, text, turnIdx) },
  }
  const t0 = Date.now()
  const result = await simulateCvOnboarding({
    resumeId: scenario.resumeId,
    userId: scenario.simUserId ?? userId,
    turns: Number(scenario.simTurns ?? 10),
    lang: scenario.simLang ?? "zh",
    db,
    drive,
    onTurn: ({ turnIdx, user, claire, claireMs, mem0Calls }) => {
      const u = (user ?? "").slice(0, 60).replace(/\s+/g, " ")
      const c = (claire ?? "").slice(0, 60).replace(/\s+/g, " ")
      console.error(`  [t${String(turnIdx + 1).padStart(2, "0")}] USER  ${u}`)
      console.error(`         CLAIRE ${c}  (${claireMs}ms, mem0=${mem0Calls})`)
    },
  })
  const totalMs = Date.now() - t0

  const transcriptPath = join(outDir, "transcript.json")
  const metaPath = join(outDir, "run-meta.json")
  writeFileSync(transcriptPath, JSON.stringify(result, null, 2), "utf8")
  writeFileSync(metaPath, JSON.stringify({
    scenarioId: scenario.id,
    yamlPath,
    resumeId: scenario.resumeId,
    simTurns: scenario.simTurns,
    simLang: scenario.simLang,
    participant: scenario.participant,
    userId,
    candidateName: result.candidateName,
    turnsCompleted: result.turns.length,
    totalMs,
    runStamp: stamp,
    outDir,
  }, null, 2), "utf8")

  console.error(`[h2] wrote ${transcriptPath}`)
  console.error(`[h2] wrote ${metaPath}`)
  console.log(JSON.stringify({
    ok: true,
    runStamp: stamp,
    outDir,
    turnsCompleted: result.turns.length,
    totalMs,
  }, null, 2))
}

main().catch((err) => {
  console.error("[h2][fatal]", err)
  process.exit(1)
})
