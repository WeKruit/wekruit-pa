/**
 * scan.ts — iMessage-first QR onboarding scan reservations + canary gate.
 *
 * The QR redirect CF (`paQrStartRedirect`) reserves a Sendblue number for a
 * pre-candidate `scanToken` here; the first inbound that carries that scanToken
 * reads + claims the reservation here. Keeping the read/claim/gate logic in one
 * place means the redirect CF and the inbound provisioning gate (index.ts) share
 * exactly one definition of "is this a real QR opener" and "is this campaign
 * canary-enabled".
 *
 * CANARY GATE (Adam decision 4): the inbound-first path that AUTO-CREATES a
 * provisional user is enabled ONLY for a designated dev/test campaign — a code
 * that starts `dev-` OR is in CANARY_CAMPAIGNS. A non-canary code still gets a
 * number + redirect + scan-pending row (so the redirect surface is fully
 * testable), but its inbound does NOT auto-provision until Adam ramps. To ramp,
 * widen CANARY_CAMPAIGNS (one place), mirroring claire-agent/canary.ts.
 */
import { FieldValue, type Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { parseHelloWekruitOpener } from "@pa/pa-orchestrator"

/** Designated canary campaign codes (besides the `dev-` prefix). Widen HERE to ramp. */
export const CANARY_CAMPAIGNS: ReadonlySet<string> = new Set<string>([
  "dev-card", // canonical dev/test card
])

/**
 * Dev re-onboard bypass (Adam decision 2026-06-01): these known DEV uids can test
 * the QR FRESH-onboarding flow from their EXISTING phone without deleting their
 * account. When such a uid texts a CANARY QR opener, instead of staying in their
 * normal flow we NON-DESTRUCTIVELY reset their conversational onboarding/prescreen
 * process state so onboarding self-starts fresh (tags / resume / memory KEPT).
 *
 * Mirrors claire-agent/canary.ts CANARY_UIDS / SCHEDULING_DEV_UIDS — one in-code
 * set, widened deliberately. ONLY these uids on a canary campaign re-onboard; a
 * normal known user on a canary QR stays in their normal flow.
 */
export const QR_REONBOARD_DEV_UIDS: ReadonlySet<string> = new Set<string>([
  "8fEwIduUrzxZsblHHsNz", // Adam  +14243201960
  "UKFaKdsMzzfPW2CDl5ve", // Noah  +12154034668
])

/** True when `userId` may use the non-destructive QR re-onboard dev bypass. */
export function isQrReonboardDevUid(userId: string | null | undefined): boolean {
  return typeof userId === "string" && QR_REONBOARD_DEV_UIDS.has(userId)
}

/** Active-prescreen collection (literal mirrors mode-selector.ts PRESCREEN_SESSIONS). */
const PRESCREEN_SESSIONS = "pa-prescreen-sessions"

/** Campaign codes are short, url/printer-safe tokens. */
const CAMPAIGN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/** Normalize a raw `?c=` value to a canonical campaign code, or null if invalid/absent. */
export function normalizeCampaignCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed || !CAMPAIGN_RE.test(trimmed)) return null
  return trimmed
}

/**
 * True when a campaign code may activate the AUTO-PROVISION inbound-first path.
 * `dev-` prefix OR explicit allowlist. A missing/invalid code is NOT canary.
 */
export function isCanaryCampaign(campaign: string | null | undefined): boolean {
  if (typeof campaign !== "string") return false
  const code = campaign.trim().toLowerCase()
  if (!code) return false
  if (code.startsWith("dev-")) return true
  return CANARY_CAMPAIGNS.has(code)
}

export type QrScanStatus = "pending" | "claimed"

export interface QrScanPendingDoc {
  scanToken: string
  number: string
  groupId: string
  campaign: string
  status: QrScanStatus
  createdAt: string
  claimedAt?: string
  claimedUserId?: string
}

/** Write the pre-candidate scan reservation (status:'pending'). Idempotent on scanToken. */
export async function writeQrScanPending(
  db: Firestore,
  args: { scanToken: string; number: string; groupId: string; campaign: string; now: string }
): Promise<void> {
  const doc: QrScanPendingDoc = {
    scanToken: args.scanToken,
    number: args.number,
    groupId: args.groupId,
    campaign: args.campaign,
    status: "pending",
    createdAt: args.now,
  }
  await db.collection(PA_COLLECTIONS.qrScanPending).doc(args.scanToken).set(doc, { merge: true })
}

/** Read a scan reservation by token. Returns null when the token is unknown. */
export async function readQrScanPending(
  db: Firestore,
  scanToken: string
): Promise<QrScanPendingDoc | null> {
  const token = scanToken.trim()
  if (!token) return null
  const snap = await db.collection(PA_COLLECTIONS.qrScanPending).doc(token).get()
  if (!snap.exists) return null
  return { scanToken: token, ...(snap.data() as Omit<QrScanPendingDoc, "scanToken">) }
}

/**
 * Mark a scan reservation claimed by `userId` (idempotency — doc §3 Race C/D). A
 * second scan/webhook-retry for the same scanToken no-ops (already claimed by the
 * same uid). Best-effort: a claim-write failure must never block delivery.
 */
export async function claimQrScanPending(
  db: Firestore,
  scanToken: string,
  userId: string,
  now: string
): Promise<void> {
  const token = scanToken.trim()
  if (!token || !userId) return
  await db
    .collection(PA_COLLECTIONS.qrScanPending)
    .doc(token)
    .set({ status: "claimed", claimedUserId: userId, claimedAt: now }, { merge: true })
}

export type QrOpenerProvisionDecision = {
  /** True when this inbound is a QR opener carrying a known, canary-enabled scan. */
  shouldProvision: boolean
  /** The resolved scan-pending doc (present whenever the opener token matched a doc). */
  scan: QrScanPendingDoc | null
}

/**
 * Inbound provisioning gate for the QR path (doc §4). A `source==='sendblue'`
 * inbound MAY auto-create a provisional user ONLY when its text is a
 * `Hello, WeKruit! <scanToken>` opener AND that scanToken resolves to a
 * `pa-qr-scan-pending` doc AND that scan's campaign is canary-enabled (decision 4).
 *
 * Generic sendblue spam (no opener / unknown token) returns shouldProvision:false
 * → stays blocked. A non-canary QR scan also returns shouldProvision:false (the
 * scan doc is returned so the caller can still observe it) → no auto-create until
 * Adam ramps the campaign.
 */
export async function resolveQrOpenerProvision(
  db: Firestore,
  inboundText: string | undefined
): Promise<QrOpenerProvisionDecision> {
  const text = typeof inboundText === "string" ? inboundText.trim() : ""
  if (!text) return { shouldProvision: false, scan: null }
  const parsed = parseHelloWekruitOpener(text)
  const token = parsed?.candidateId?.trim()
  if (!token) return { shouldProvision: false, scan: null }
  const scan = await readQrScanPending(db, token)
  if (!scan) return { shouldProvision: false, scan: null }
  return { shouldProvision: isCanaryCampaign(scan.campaign), scan }
}

export type QrReonboardDecision = {
  /** True only for a QR_REONBOARD_DEV_UID texting a CANARY QR opener. */
  shouldReonboard: boolean
  /** The resolved scan-pending doc (present whenever the opener token matched a doc). */
  scan: QrScanPendingDoc | null
}

/**
 * Existing-user QR re-onboard gate (dev bypass, 2026-06-01). Distinct from the
 * fresh-create gate: here a user ALREADY resolved from the phone. We re-onboard
 * ONLY when:
 *   - the inbound is a valid QR opener whose scanToken resolves to a scan doc,
 *   - that scan's campaign is canary-enabled, AND
 *   - the resolved uid is in QR_REONBOARD_DEV_UIDS.
 *
 * A normal known user on a canary QR → shouldReonboard:false (stays in normal
 * flow). Generic / non-canary → false. The scan doc is returned for observability
 * + so the caller can reconcile the sticky number and claim it.
 */
export async function resolveQrReonboard(
  db: Firestore,
  inboundText: string | undefined,
  resolvedUserId: string | null | undefined
): Promise<QrReonboardDecision> {
  if (!isQrReonboardDevUid(resolvedUserId)) return { shouldReonboard: false, scan: null }
  const text = typeof inboundText === "string" ? inboundText.trim() : ""
  if (!text) return { shouldReonboard: false, scan: null }
  const parsed = parseHelloWekruitOpener(text)
  const token = parsed?.candidateId?.trim()
  if (!token) return { shouldReonboard: false, scan: null }
  const scan = await readQrScanPending(db, token)
  if (!scan) return { shouldReonboard: false, scan: null }
  return { shouldReonboard: isCanaryCampaign(scan.campaign), scan }
}

/**
 * NON-DESTRUCTIVE re-onboard reset (dev bypass). Clears ONLY the conversational
 * onboarding/prescreen PROCESS state so `selectClaireMode` cold-starts onboarding
 * fresh on the next turn (mirrors the cold-start branch's preconditions):
 *   - pa-users: delete onboardingState / onboardingStatus / sharedOnboarding /
 *     workSession (so isSharedOnboardingActiveUser → false AND not "complete").
 *   - terminalize any non-terminal pa-prescreen-sessions (terminal='RESET') so the
 *     mode-selector's ACTIVE-PRESCREEN branch doesn't intercept the next turn.
 *
 * KEEPS tags, resume, displayName, derivedExperience, mem0/transcript, match data —
 * this is NOT clearUserMemory / reinitializeCandidate (those are the destructive
 * global wipes). Stamps source='qr_imessage' + firstTouchCampaign + the sticky
 * Sendblue number from the scan, mirroring createProvisionalUser's QR stamps.
 *
 * Best-effort + idempotent: each write is independent; a partial failure leaves the
 * user no worse than before. Returns the fields touched for observability.
 */
export async function reonboardExistingUserViaQr(
  db: Firestore,
  userId: string,
  scan: QrScanPendingDoc,
  now: string
): Promise<{ prescreenSessionsReset: number }> {
  // 1. Non-destructively clear onboarding/work-session process state + stamp QR attribution.
  await db
    .collection(PA_COLLECTIONS.users)
    .doc(userId)
    .set(
      {
        onboardingState: FieldValue.delete(),
        onboardingStatus: FieldValue.delete(),
        sharedOnboarding: FieldValue.delete(),
        workSession: FieldValue.delete(),
        source: "qr_imessage",
        firstTouchCampaign: scan.campaign,
        // Reconcile the scan-time sticky number (override-first, same as the fresh path).
        senderNumber: scan.number,
        senderGroupId: scan.groupId,
        senderAssignedAt: now,
        senderAssignedSource: "qr_scan",
        qrReonboardedAt: now,
        updatedAt: now,
      },
      { merge: true },
    )

  // 2. Terminalize any active prescreen so the next turn routes to onboarding, not prescreen.
  let prescreenSessionsReset = 0
  try {
    const snap = await db
      .collection(PRESCREEN_SESSIONS)
      .where("userId", "==", userId)
      .where("terminal", "==", null)
      .limit(10)
      .get()
    for (const docSnap of snap.docs) {
      await docSnap.ref.set(
        { terminal: "RESET", terminalReason: "qr_dev_reonboard", updatedAt: now },
        { merge: true },
      )
      prescreenSessionsReset += 1
    }
  } catch {
    /* best-effort — a prescreen query/write failure must not block the re-onboard */
  }
  return { prescreenSessionsReset }
}

/** Abandoned-scan reservations older than this (still 'pending') are swept. */
export const QR_SCAN_ABANDON_TTL_MS = 6 * 60 * 60 * 1000 // 6h

export type QrScanSweepResult = { scanned: number; decremented: number; errors: number }

/**
 * Sweep abandoned scan reservations (doc §3.5 Race A): a scanner who reserved a
 * number but never sent leaves a `status:'pending'` doc forever, inflating the
 * group's new-user counter. For each pending doc older than QR_SCAN_ABANDON_TTL_MS
 * we decrement that group's counter (returning the slot) and mark the doc
 * 'abandoned' so it is not double-counted on a later sweep.
 *
 * `decrement` is injected so this is unit-testable without Firestore admin writes.
 */
export async function sweepAbandonedQrScans(
  db: Firestore,
  decrement: (groupId: string) => Promise<void>,
  now: number = Date.now(),
  limit = 500
): Promise<QrScanSweepResult> {
  const cutoffIso = new Date(now - QR_SCAN_ABANDON_TTL_MS).toISOString()
  const result: QrScanSweepResult = { scanned: 0, decremented: 0, errors: 0 }
  const snap = await db
    .collection(PA_COLLECTIONS.qrScanPending)
    .where("status", "==", "pending")
    .where("createdAt", "<", cutoffIso)
    .limit(limit)
    .get()
  for (const docSnap of snap.docs) {
    result.scanned += 1
    const data = docSnap.data() as Omit<QrScanPendingDoc, "scanToken">
    try {
      const groupId = typeof data.groupId === "string" ? data.groupId.trim() : ""
      if (groupId) {
        await decrement(groupId)
        result.decremented += 1
      }
      await docSnap.ref.set(
        { status: "abandoned", abandonedAt: new Date(now).toISOString() },
        { merge: true }
      )
    } catch {
      result.errors += 1
    }
  }
  return result
}
