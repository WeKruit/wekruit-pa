/**
 * yc-intake-admin.ts — operator queue for the YC Startup School event flow
 * (Adam 2026-07-21, "Claire says 7pm, the team sends").
 *
 * Two admin callables:
 *   - `paAdminYcIntakeToday`: list yc_startup_school users whose event intake
 *     (pa-users.ycIntake) is complete — the "tonight's sends" queue — plus the
 *     incomplete stragglers for visibility. Whole-source scan, in-memory shape
 *     (the yc cohort is event-sized, not fleet-sized).
 *   - `paAdminYcSendMatches`: one-click "send matches now" for one user — fires
 *     the existing `@pa/job-rec` sendImessage runtime handoff (STOP gate, dedup,
 *     sticky number all inherited; Claire composes + delivers with her yc
 *     posture) and stamps `ycEveningMatchSentAt` so nobody is double-sent.
 *
 * Auth mirrors admin-candidate-pool-counts.ts: authorizeAdminCallable (Firebase
 * `admin` claim OR PA_ADMIN_TOKEN secret for scripted callers).
 */
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { z } from "zod"
import { PA_COLLECTIONS, isYcPeopleUser } from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")

const YC_SOURCE = "yc_startup_school"
/** firstTouchCampaign written by the event QR campaign — third canonical YC signal. */
const YC_CAMPAIGN = "yc-startup-school"
// Event cohorts are hundreds at most; cap defends against a runaway scan.
const SCAN_CAP = 5_000

export interface YcIntakeRow {
  userId: string
  displayName: string | null
  phoneTail: string | null
  building: string | null
  wantsToMeet: string | null
  completedAt: string | null
  linkedinEnriched: boolean
  createdAt: string | null
  ycEveningMatchSentAt: string | null
}

export interface YcIntakeTodayResult {
  ok: true
  ready: YcIntakeRow[]
  incomplete: YcIntakeRow[]
  scanned: number
  truncated: boolean
}

function rowFromDoc(id: string, d: Record<string, unknown>): YcIntakeRow {
  const intake = (d.ycIntake ?? {}) as Record<string, unknown>
  const phone = typeof d.phoneE164 === "string" ? d.phoneE164 : null
  return {
    userId: id,
    displayName: typeof d.displayName === "string" ? d.displayName : null,
    phoneTail: phone ? phone.slice(-4) : null,
    building: typeof intake.building === "string" ? intake.building : null,
    wantsToMeet: typeof intake.wantsToMeet === "string" ? intake.wantsToMeet : null,
    completedAt: typeof intake.completedAt === "string" ? intake.completedAt : null,
    linkedinEnriched: Boolean(
      d.latestResumeArtifactId ||
        (Array.isArray(d.experienceHighlights) && d.experienceHighlights.length > 0),
    ),
    createdAt: typeof d.createdAt === "string" ? d.createdAt : null,
    ycEveningMatchSentAt:
      typeof d.ycEveningMatchSentAt === "string" ? d.ycEveningMatchSentAt : null,
  }
}

export async function runYcIntakeToday(deps: { db: Firestore }): Promise<YcIntakeTodayResult> {
  // THREE queries, unioned — the canonical YC predicate is an OR across three fields, and Firestore
  // cannot express that in one query. The old single `source == yc_startup_school` query meant an
  // event-QR entrant (source: qr_imessage / candidate + ycEventEntryAt) NEVER appeared in the
  // operator queue, so they silently never got the people send Claire promised them. Event cohorts
  // are hundreds, so three capped scans + an in-memory de-dupe is the right shape here.
  const [bySource, byEventEntry, byCampaign] = await Promise.all([
    deps.db.collection(PA_COLLECTIONS.users).where("source", "==", YC_SOURCE).limit(SCAN_CAP).get(),
    deps.db
      .collection(PA_COLLECTIONS.users)
      .orderBy("ycEventEntryAt", "desc")
      .limit(SCAN_CAP)
      .get(),
    deps.db
      .collection(PA_COLLECTIONS.users)
      .where("firstTouchCampaign", "==", YC_CAMPAIGN)
      .limit(SCAN_CAP)
      .get(),
  ])
  const docs = new Map<string, Record<string, unknown>>()
  for (const snap of [bySource, byEventEntry, byCampaign]) {
    for (const doc of snap.docs) {
      const d = (doc.data() ?? {}) as Record<string, unknown>
      // orderBy("ycEventEntryAt") returns every doc that HAS the field; re-check the predicate so a
      // non-YC doc carrying a stray value can never enter the queue.
      if (!isYcPeopleUser(d)) continue
      docs.set(doc.id, d)
    }
  }
  const ready: YcIntakeRow[] = []
  const incomplete: YcIntakeRow[] = []
  for (const [id, d] of docs) {
    if (d.testMode === true || d.isDemo === true) continue
    const row = rowFromDoc(id, d)
    if (!row.phoneTail) continue // never surface unreachable rows in a send queue
    if (row.completedAt) ready.push(row)
    else incomplete.push(row)
  }
  ready.sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""))
  incomplete.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
  const scanned = docs.size
  const truncated = [bySource, byEventEntry, byCampaign].some((s) => s.size >= SCAN_CAP)
  return { ok: true, ready, incomplete, scanned, truncated }
}

const SendMatchesInputSchema = z.object({
  userId: z.string().min(1),
  adminToken: z.string().nullish(),
})

export async function runYcSendMatches(
  deps: {
    db: Firestore
    /** @pa/job-rec sendImessage — runtime handoff; trustedOutboundBody delivers verbatim. */
    sendImessage: (
      args: { userId: string; context: Record<string, unknown>; idempotencyKey?: string },
      sendDeps: { db: Firestore; log?: (...args: unknown[]) => void },
    ) => Promise<{ ok: boolean }>
    nowIso?: () => string
  },
  userId: string,
): Promise<{ ok: boolean; reason?: string; recCount?: number }> {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())
  const userRef = deps.db.collection(PA_COLLECTIONS.users).doc(userId)
  const snap = await userRef.get()
  if (!snap.exists) return { ok: false, reason: "user_not_found" }
  const d = (snap.data() ?? {}) as Record<string, unknown>
  // Shared predicate, not `source` alone. The narrow check meant an event-QR entrant
  // (source: qr_imessage/candidate + ycEventEntryAt) returned "not_yc_user" and SILENTLY never got
  // the 7pm people send they were promised — a bug in the YC lane itself, not a job-leak.
  if (!isYcPeopleUser(d)) return { ok: false, reason: "not_yc_user" }
  const intake = (d.ycIntake ?? {}) as Record<string, unknown>
  if (typeof intake.completedAt !== "string") return { ok: false, reason: "intake_incomplete" }
  const day = nowIso().slice(0, 10)
  const sentAt = typeof d.ycEveningMatchSentAt === "string" ? d.ycEveningMatchSentAt : ""
  if (sentAt.slice(0, 10) === day) return { ok: false, reason: "already_sent_today" }

  // PEOPLE matching, NEVER job roles (Adam-LOCKED 2026-07-23: YC users get zero
  // job-recommendation — investors sign up too). The prior V16 job-matcher call
  // texted job openings labeled "founder matches"; removed. This operator send
  // keeps the user in the people-match pool without sharing an attendee list or
  // making a delivery-time promise.
  const body = [
    "got it — you're in the YC Startup School people-match pool 🤝",
    "we're lining up folks worth meeting based on what you shared. i'll text you right here as they land.",
    "reply with anyone you'd especially like to meet, or any context that would make an intro more useful.",
  ]
    .join("\n\n")
    .slice(0, 3900)

  const result = await deps.sendImessage(
    {
      userId,
      context: {
        eventKind: "yc_evening_people_matches",
        source: "yc_intake_admin",
        trustedOutboundBody: body,
      },
      idempotencyKey: `yc-evening-match:${userId}:${day}`,
    },
    { db: deps.db, log: (...args: unknown[]) => logger.info("[yc-send-matches]", ...args) },
  )
  if (result.ok) {
    await userRef.set({ ycEveningMatchSentAt: nowIso(), updatedAt: nowIso() }, { merge: true })
  }
  return result.ok ? { ok: true } : { ok: false, reason: "runtime_handoff_failed" }
}

export const paAdminYcIntakeToday = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 60, secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    return runYcIntakeToday({ db: getFirestore() })
  },
)

export const paAdminYcSendMatches = onCall(
  { region: "us-central1", memory: "1GiB", timeoutSeconds: 300, secrets: [PA_ADMIN_TOKEN] },
  async (req) => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const input = SendMatchesInputSchema.safeParse(req.data ?? {})
    if (!input.success) throw new HttpsError("invalid-argument", "userId required")
    const db = getFirestore()
    const { sendImessage } = await import("@pa/job-rec")
    return runYcSendMatches({ db, sendImessage }, input.data.userId)
  },
)
