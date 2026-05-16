#!/usr/bin/env tsx
import fs from "node:fs"
import { cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import {
  CANDIDATE_LIFECYCLE_EVENT_COLLECTION,
  runCandidateLifecycleTrigger,
  type CandidateLifecycleSnapshot,
  type CandidateLifecycleTriggerInput,
} from "../src/candidate-lifecycle-trigger.js"

const PROJECT_ID = "wekruit-5f89b"
const DEFAULT_CANDIDATE_ID = "U7AwKT8nLDRa35DkuBxq"

function loadServiceAccount(): Record<string, unknown> {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) as Record<string, unknown>
  }
  if (fs.existsSync(".env")) {
    const line = fs
      .readFileSync(".env", "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="))
    if (line) {
      return JSON.parse(line.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length)) as Record<string, unknown>
    }
  }
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing")
}

function cleanCandidate(raw: Record<string, unknown>, candidateId: string): CandidateLifecycleSnapshot {
  return {
    candidateId,
    ...(raw as Omit<CandidateLifecycleSnapshot, "candidateId">),
  }
}

function sendableDryRunFixture(candidate: CandidateLifecycleSnapshot): CandidateLifecycleSnapshot {
  return {
    ...candidate,
    workSession: {
      ...(candidate.workSession ?? {}),
      status: "ended",
      boundary: "firestore_smoke_send_fixture",
    },
    outreach: undefined,
    lifecycle: undefined,
  }
}

async function main() {
  const candidateId = process.env.LIFECYCLE_SMOKE_CANDIDATE_ID ?? DEFAULT_CANDIDATE_ID
  if (!getApps().length) {
    initializeApp({ credential: cert(loadServiceAccount()), projectId: PROJECT_ID })
  }
  const db = getFirestore()
  const snap = await db.collection("pa-users").doc(candidateId).get()
  if (!snap.exists) throw new Error(`candidate not found: ${candidateId}`)
  const actualCandidate = cleanCandidate(snap.data() ?? {}, snap.id)
  const now = new Date().toISOString()

  const writeLifecycleEvent = async (eventId: string, row: Record<string, unknown>) => {
    await db.collection(CANDIDATE_LIFECYCLE_EVENT_COLLECTION).doc(eventId).set({
      ...row,
      smoke: {
        kind: "lifecycle-trigger-firestore-smoke",
        createdBy: "script",
      },
    }, { merge: true })
  }

  const baseDeps = {
    writeLifecycleEvent,
    updateLifecycleEvent: async (eventId: string, patch: Record<string, unknown>) => {
      await db.collection(CANDIDATE_LIFECYCLE_EVENT_COLLECTION).doc(eventId).set(patch, { merge: true })
    },
    now: () => now,
  }

  const cases: Array<{
    label: string
    candidate: CandidateLifecycleSnapshot
    request: CandidateLifecycleTriggerInput
    activePrescreen?: boolean
  }> = [
    {
      label: "laid_off_checkin_dry_run_send",
      candidate: sendableDryRunFixture(actualCandidate),
      request: {
        candidateId,
        eventType: "laid_off_checkin",
        eventReason: "dry-run smoke: fresh layoff signal candidate-value check-in",
        dryRun: true,
      },
    },
    {
      label: "match_notification_dry_run_send",
      candidate: sendableDryRunFixture(actualCandidate),
      request: {
        candidateId,
        eventType: "match_notification",
        eventReason: "dry-run smoke: newly relevant role matched candidate profile",
        dryRun: true,
        job: {
          jobId: "rain-software-engineer-fullstack-8849f6ef",
          jobTitle: "Software Engineer - Fullstack",
          companyName: "Rain",
          matchReason: "Your dashboard, SQL, and product-ops ownership are relevant here.",
          matchId: "lifecycle-smoke-match",
        },
      },
    },
    {
      label: "actual_active_session_no_send",
      candidate: actualCandidate,
      request: {
        candidateId,
        eventType: "status_followup",
        eventReason: "dry-run smoke: candidate search status follow-up",
        dryRun: true,
      },
      activePrescreen: false,
    },
  ]

  const results = []
  for (const c of cases) {
    const result = await runCandidateLifecycleTrigger(c.request, {
      ...baseDeps,
      readCandidate: async () => c.candidate,
      hasActivePrescreenSession: async () => Boolean(c.activePrescreen),
    }, "lifecycle-firestore-smoke")
    results.push({
      label: c.label,
      eventId: result.eventId,
      decision: result.decision.decision,
      status: result.decision.status,
      reason: result.decision.reason,
      blockedSignals: result.decision.blockedSignals,
    })
  }

  console.log(JSON.stringify({
    ok: true,
    candidateId,
    now,
    results,
  }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
