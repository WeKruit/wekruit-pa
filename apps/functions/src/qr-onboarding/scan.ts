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
import type { Firestore } from "firebase-admin/firestore"
import { PA_COLLECTIONS } from "@pa/core-types"
import { parseHelloWekruitOpener } from "@pa/pa-orchestrator"

/** Designated canary campaign codes (besides the `dev-` prefix). Widen HERE to ramp. */
export const CANARY_CAMPAIGNS: ReadonlySet<string> = new Set<string>([
  "dev-card", // canonical dev/test card
])

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
