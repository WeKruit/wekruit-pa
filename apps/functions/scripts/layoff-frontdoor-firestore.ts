/**
 * Production Firestore layoff front-door verification.
 *
 * Exercises the unified layoff path against production Firestore without
 * minting new pa-users rows:
 *   - duplicate phone detection resolves to the existing canonical candidate
 *   - refresh mode writes layoffContext on that same candidate
 *   - web chat turns weak-merge into pa-users layoff evidence
 *   - existing auth/handle docs prove login adopts the same candidate
 *   - employer verification unlocks the live layoff marketplace listing
 *
 * The target pa-users doc, phone index, and handle docs are restored on exit.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { config as loadDotenv } from "dotenv"
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { hashCandidateHandle } from "@pa/pa-persistence"

import {
  phoneIndexId,
  runListLayoffCandidates,
  runRegisterEmployer,
  runRegisterLayoffCandidate,
  runSubmitChatTurn,
} from "../src/openLayoff.js"
import { runEmployerClaimVerification } from "../src/identity/employer-claim-verification.js"
import { acquireProductionTestRunLock, productionTestRunLockId } from "./lib/prod-test-run-lock.mjs"
import { requireExistingPaUserWithAllowedPhoneForProductionTest } from "./lib/prod-test-user-guard.mjs"

const PROJECT_ID = "wekruit-5f89b"
const USER_ID = process.env.LAYOFF_FRONTDOOR_USER_ID ?? "U7AwKT8nLDRa35DkuBxq"
const PHONE = process.env.LAYOFF_FRONTDOOR_PHONE ?? "+14243201960"
const EMAIL = process.env.LAYOFF_FRONTDOOR_EMAIL ?? "indolencorlol@gmail.com"
const ARTIFACT_DIR = path.resolve(".planning/layoff-frontdoor/artifacts")

for (const envPath of [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "apps/functions/.env"),
  path.resolve(process.cwd(), "../..", ".env"),
  path.resolve(process.cwd(), "../..", "apps/functions/.env"),
]) {
  if (existsSync(envPath)) loadDotenv({ path: envPath, override: false })
}

type DocBackup = {
  path: string
  exists: boolean
  data: FirebaseFirestore.DocumentData | null
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function stripFirestoreValues(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof (value as { toDate?: unknown })?.toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString()
  }
  if (Array.isArray(value)) return value.map(stripFirestoreValues)
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested !== undefined) out[key] = stripFirestoreValues(nested)
    }
    return out
  }
  return value
}

async function countUsers(db: Firestore): Promise<number> {
  const snap = await db.collection(PA_COLLECTIONS.users).count().get()
  return snap.data().count
}

async function snapshotDocs(db: Firestore, paths: string[]): Promise<DocBackup[]> {
  return Promise.all(
    paths.map(async (docPath) => {
      const snap = await db.doc(docPath).get()
      return { path: docPath, exists: snap.exists, data: snap.exists ? snap.data() ?? {} : null }
    }),
  )
}

async function restoreDocs(db: Firestore, backup: DocBackup[]) {
  const batch = db.batch()
  for (const item of backup) {
    const ref = db.doc(item.path)
    if (item.exists && item.data) batch.set(ref, item.data, { merge: false })
    else batch.delete(ref)
  }
  await batch.commit()
}

async function deleteIfExists(db: Firestore, pathToDoc: string) {
  await db.doc(pathToDoc).delete().catch(() => undefined)
}

async function assertPhoneAlreadyResolvesToTarget(db: Firestore) {
  const phoneIndexPath = `layoff_phone_index/${phoneIndexId(PHONE)}`
  const phoneHandle = hashCandidateHandle("phone", PHONE)
  const emailHandle = hashCandidateHandle("email", EMAIL)
  const [indexSnap, phoneHandleSnap, emailHandleSnap] = await Promise.all([
    db.doc(phoneIndexPath).get(),
    db.collection(PA_COLLECTIONS.candidateHandles).doc(phoneHandle.handleId).get(),
    db.collection(PA_COLLECTIONS.candidateHandles).doc(emailHandle.handleId).get(),
  ])
  const indexCandidate = indexSnap.data()?.candidateId
  const phoneCandidate = phoneHandleSnap.data()?.candidateId
  const emailCandidate = emailHandleSnap.data()?.candidateId
  if (indexCandidate !== USER_ID && phoneCandidate !== USER_ID) {
    throw new Error(`phone ${PHONE} does not resolve to ${USER_ID} through layoff_phone_index or candidate handle`)
  }
  if (emailCandidate !== USER_ID) {
    throw new Error(`email ${EMAIL} does not resolve to ${USER_ID} through candidate handle`)
  }
  return {
    phoneIndexPath,
    phoneHandlePath: `${PA_COLLECTIONS.candidateHandles}/${phoneHandle.handleId}`,
    emailHandlePath: `${PA_COLLECTIONS.candidateHandles}/${emailHandle.handleId}`,
  }
}

async function main() {
  if (!getApps().length) {
    initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() })
  }
  const db = getFirestore()
  const runId = `layoff-frontdoor-${nowStamp()}`
  const userCountBefore = await countUsers(db)

  const releaseLock = await acquireProductionTestRunLock(db, {
    lockId: productionTestRunLockId({
      scope: "layoff-frontdoor",
      userId: USER_ID,
      jobId: "layoff",
    }),
    runId,
    scriptName: "layoff-frontdoor-firestore.ts",
    projectId: PROJECT_ID,
  })

  let employerPath: string | null = null
  let backup: DocBackup[] = []
  try {
    await requireExistingPaUserWithAllowedPhoneForProductionTest(db, {
      projectId: PROJECT_ID,
      scriptName: "layoff-frontdoor-firestore.ts",
      userId: USER_ID,
      phoneE164: PHONE,
    })
    const identityPaths = await assertPhoneAlreadyResolvesToTarget(db)
    backup = await snapshotDocs(db, [
      `${PA_COLLECTIONS.users}/${USER_ID}`,
      identityPaths.phoneIndexPath,
      identityPaths.phoneHandlePath,
      identityPaths.emailHandlePath,
    ])

    const duplicate = await runRegisterLayoffCandidate(
      {
        firstName: "Shixiang",
        lastName: "Yang",
        email: EMAIL,
        linkedin: "https://www.linkedin.com/in/adam-yang-109",
        lastCompany: "Rain",
        jobTitle: "Software Engineer - Fullstack",
        location: "New York, NY",
        phone: PHONE,
        consent: true,
        resumeFileName: "Adam-Yang-Resume.pdf",
        mode: "auto",
      },
      { db },
    )
    if (duplicate.duplicate !== true || duplicate.candidateId !== USER_ID) {
      throw new Error(`duplicate phone path did not resolve to ${USER_ID}`)
    }

    const refreshed = await runRegisterLayoffCandidate(
      {
        firstName: "Shixiang",
        lastName: "Yang",
        email: EMAIL,
        linkedin: "https://www.linkedin.com/in/adam-yang-109",
        lastCompany: "Rain",
        jobTitle: "Software Engineer - Fullstack",
        location: "New York, NY",
        phone: PHONE,
        consent: true,
        resumeFileName: "Adam-Yang-Resume.pdf",
        mode: "refresh",
      },
      { db },
    )
    if (refreshed.candidateId !== USER_ID) {
      throw new Error(`refresh path wrote to ${String(refreshed.candidateId)}, expected ${USER_ID}`)
    }

    await runSubmitChatTurn(
      {
        candidateId: USER_ID,
        turn: {
          promptId: "next",
          text: "I want full-stack product engineering at an early-stage fintech or infrastructure company.",
          at: new Date().toISOString(),
        },
      },
      { db },
    )
    await runSubmitChatTurn(
      {
        candidateId: USER_ID,
        turn: {
          promptId: "open",
          text: "Open to New York hybrid or remote. No sponsorship needed. Targeting $90k to $140k.",
          at: new Date().toISOString(),
        },
      },
      { db },
    )
    await runSubmitChatTurn(
      {
        candidateId: USER_ID,
        turn: {
          promptId: "pitch",
          text: "Built React and TypeScript dashboards over Node and Postgres to reduce failed-order triage.",
          at: new Date().toISOString(),
        },
      },
      { db },
    )

    const employerEmail = `layoff-smoke+${Date.now()}@example.com`
    const employer = await runRegisterEmployer(
      {
        companyName: "Layoff Smoke Employer",
        companyLinkedin: "https://www.linkedin.com/company/layoff-smoke-employer",
        workEmail: employerEmail,
        stage: "seed",
        roleAtCompany: "Founder",
        rolesHiring: ["Engineer"],
      },
      { db },
      { uid: "layoff-smoke-auth", token: { email: employerEmail, email_verified: true } },
    )
    employerPath = `layoff_employers/${employer.employerId}`

    const verifiedEmployer = await runEmployerClaimVerification(
      { employerId: employer.employerId },
      { uid: "layoff-smoke-auth", token: { email: employerEmail, email_verified: true } },
      { db },
    )

    const listing = await runListLayoffCandidates(
      { withinDays: 365 },
      { uid: "layoff-smoke-auth", token: { email: employerEmail, email_verified: true } },
      { db },
    )

    const refreshedUser = (await db.doc(`${PA_COLLECTIONS.users}/${USER_ID}`).get()).data() ?? {}
    const authSnap = await db
      .collection(PA_COLLECTIONS.candidateAuth)
      .where("candidateId", "==", USER_ID)
      .limit(10)
      .get()
    const resumeArtifactId = typeof refreshedUser.latestResumeArtifactId === "string"
      ? refreshedUser.latestResumeArtifactId
      : null
    const resumeArtifactExists = resumeArtifactId
      ? (await db.collection(PA_COLLECTIONS.resumeArtifacts).doc(resumeArtifactId).get()).exists
      : false

    const listedTarget = listing.data.find((row) => row.id === USER_ID) ?? null
    const failures: string[] = []
    if (!listedTarget) failures.push("verified employer listing did not include the refreshed layoff candidate")
    if ((refreshedUser.layoffContext as Record<string, unknown> | undefined)?.lastCompany !== "Rain") {
      failures.push("layoffContext.lastCompany was not refreshed")
    }
    if (!resumeArtifactExists) failures.push("existing shared resume artifact was not found")
    if (authSnap.empty) failures.push("no candidate auth mapping exists for the target user")

    const userCountAfter = await countUsers(db)
    if (userCountAfter !== userCountBefore) {
      failures.push(`pa-users count changed ${userCountBefore} -> ${userCountAfter}`)
    }

    const artifact = {
      runId,
      projectId: PROJECT_ID,
      userId: USER_ID,
      phone: PHONE,
      email: EMAIL,
      userCountBefore,
      userCountAfter,
      duplicate: stripFirestoreValues(duplicate),
      refreshed: stripFirestoreValues(refreshed),
      verifiedEmployer: stripFirestoreValues(verifiedEmployer),
      listedTarget: stripFirestoreValues(listedTarget),
      authMappings: authSnap.docs.map((d) => ({ firebaseUid: d.id, ...stripFirestoreValues(d.data()) as Record<string, unknown> })),
      resumeArtifactId,
      resumeArtifactExists,
      refreshedUserEvidence: stripFirestoreValues({
        source: refreshedUser.source,
        lastLaidOffAt: refreshedUser.lastLaidOffAt,
        layoffContext: refreshedUser.layoffContext,
        conversationDerivedPreferences: refreshedUser.conversationDerivedPreferences,
        layoffEvidence: refreshedUser.layoffEvidence,
      }),
      failures,
      passed: failures.length === 0,
    }

    mkdirSync(ARTIFACT_DIR, { recursive: true })
    const artifactPath = path.join(ARTIFACT_DIR, `${runId}.json`)
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`)
    console.log(JSON.stringify({ artifactPath, passed: artifact.passed, failures }, null, 2))
    if (!artifact.passed) process.exitCode = 1
  } finally {
    if (backup.length > 0) await restoreDocs(db, backup)
    if (employerPath) await deleteIfExists(db, employerPath)
    await releaseLock()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
