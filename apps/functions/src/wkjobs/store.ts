/**
 * wkjobs device-flow storage.
 *
 * Backs `POST /v1/device/code` → `POST /v1/device/token` for the `wkjobs` CLI
 * (docs/WEKRUIT_BACKEND_CONTRACT.md in the wkjobs repo). Two rules drive the
 * shape here:
 *
 *   1. Nothing secret is stored in the clear. The device code and the bearer
 *      token are only ever persisted as SHA-256 digests, so a Firestore read
 *      leak cannot be replayed against this API. The doc id IS the digest,
 *      which also makes every lookup a point read.
 *   2. Approval is single-use. `consumeApprovedDevice` transitions
 *      approved → consumed inside a transaction, so two racing polls cannot
 *      both mint a token from one human approval.
 *
 * Collection names are deliberately local to this module rather than added to
 * PA_COLLECTIONS: the whole wkjobs surface is new and may be withdrawn, and
 * keeping its names here means deleting `src/wkjobs/` removes the feature
 * completely.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { Firestore } from "firebase-admin/firestore"

export const WKJOBS_DEVICE_CODES = "pa-wkjobs-device-codes"
export const WKJOBS_TOKENS = "pa-wkjobs-tokens"

/** Contract: device codes expire within ten minutes. */
export const DEVICE_CODE_TTL_SEC = 600
/** Baseline poll interval handed to the CLI, in seconds. */
export const DEVICE_POLL_INTERVAL_SEC = 5
/** Escalated interval returned with `slow_down` when a client polls too fast. */
export const DEVICE_SLOW_DOWN_INTERVAL_SEC = 10

/**
 * User codes are read aloud and typed by hand, so the alphabet omits every
 * glyph pair people confuse: 0/O, 1/I/L, 2/Z, 5/S, 8/B.
 */
const USER_CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679"
const USER_CODE_LENGTH = 8

export type DeviceStatus = "pending" | "approved" | "denied" | "consumed"

export interface DeviceRecord {
  userCodeHash: string
  status: DeviceStatus
  candidateId?: string
  createdAt: string
  expiresAt: string
  /** Epoch ms of the last poll, used to enforce the poll interval. */
  lastPolledAtMs?: number
  pollCount?: number
  client: string
  provider: string
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Constant-time compare for two hex digests of equal length. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function generateDeviceCode(): string {
  return randomBytes(32).toString("base64url")
}

export function generateUserCode(random: (max: number) => number = randomIndex): string {
  let out = ""
  for (let i = 0; i < USER_CODE_LENGTH; i += 1) {
    out += USER_CODE_ALPHABET[random(USER_CODE_ALPHABET.length)]
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

function randomIndex(max: number): number {
  // Rejection-sample so the alphabet stays uniform (256 % 25 !== 0).
  const limit = Math.floor(256 / max) * max
  for (;;) {
    const byte = randomBytes(1)[0] as number
    if (byte < limit) return byte % max
  }
}

/**
 * Normalizes what a human typed into the approval form: case, whitespace and
 * the cosmetic hyphen are all forgiving, everything else must match.
 */
export function normalizeUserCode(raw: string): string | null {
  const compact = raw.trim().toUpperCase().replace(/[\s-]/g, "")
  if (compact.length !== USER_CODE_LENGTH) return null
  for (const char of compact) {
    if (!USER_CODE_ALPHABET.includes(char)) return null
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}

export interface CreatedDevice {
  deviceCode: string
  userCode: string
  expiresInSec: number
  intervalSec: number
}

export async function createDevice(
  db: Firestore,
  args: { client: string; provider: string; now?: () => number },
): Promise<CreatedDevice> {
  const nowMs = args.now ? args.now() : Date.now()
  const deviceCode = generateDeviceCode()
  const userCode = generateUserCode()
  const record: DeviceRecord = {
    userCodeHash: sha256(userCode),
    status: "pending",
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + DEVICE_CODE_TTL_SEC * 1000).toISOString(),
    client: args.client,
    provider: args.provider,
    pollCount: 0,
  }
  await db.collection(WKJOBS_DEVICE_CODES).doc(sha256(deviceCode)).set(record)
  return {
    deviceCode,
    userCode,
    expiresInSec: DEVICE_CODE_TTL_SEC,
    intervalSec: DEVICE_POLL_INTERVAL_SEC,
  }
}

export type PollOutcome =
  | { status: "authorization_pending" }
  | { status: "slow_down"; intervalSec: number }
  | { status: "access_denied" }
  | { status: "expired_token" }
  | { status: "approved"; candidateId: string }

/**
 * One transaction does the whole poll: expiry check, interval enforcement, and
 * the approved → consumed transition. Doing it transactionally is what makes
 * the approval single-use under concurrent polling.
 */
export async function consumeApprovedDevice(
  db: Firestore,
  deviceCode: string,
  opts: { now?: () => number } = {},
): Promise<PollOutcome> {
  const nowMs = opts.now ? opts.now() : Date.now()
  const ref = db.collection(WKJOBS_DEVICE_CODES).doc(sha256(deviceCode))

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { status: "expired_token" } as const

    const record = snap.data() as DeviceRecord
    if (record.status === "consumed") return { status: "expired_token" } as const
    if (Date.parse(record.expiresAt) <= nowMs) return { status: "expired_token" } as const

    // Poll-rate enforcement precedes any state change so a hot loop cannot
    // burn the approval it is racing toward.
    const since = nowMs - (record.lastPolledAtMs ?? 0)
    if (record.lastPolledAtMs !== undefined && since < DEVICE_POLL_INTERVAL_SEC * 1000) {
      tx.update(ref, { lastPolledAtMs: nowMs, pollCount: (record.pollCount ?? 0) + 1 })
      return { status: "slow_down", intervalSec: DEVICE_SLOW_DOWN_INTERVAL_SEC } as const
    }

    if (record.status === "denied") {
      tx.update(ref, { lastPolledAtMs: nowMs, pollCount: (record.pollCount ?? 0) + 1 })
      return { status: "access_denied" } as const
    }

    if (record.status === "approved" && record.candidateId) {
      tx.update(ref, { status: "consumed", consumedAt: new Date(nowMs).toISOString() })
      return { status: "approved", candidateId: record.candidateId } as const
    }

    tx.update(ref, { lastPolledAtMs: nowMs, pollCount: (record.pollCount ?? 0) + 1 })
    return { status: "authorization_pending" } as const
  })
}

export type ApprovalResult =
  | { ok: true }
  | { ok: false; reason: "unknown_code" | "expired" | "already_decided" }

/**
 * Records a human decision against a user code. The candidate id always comes
 * from the caller's verified session — never from the browser or the CLI.
 */
export async function decideDevice(
  db: Firestore,
  args: {
    userCode: string
    candidateId: string
    approve: boolean
    now?: () => number
  },
): Promise<ApprovalResult> {
  const nowMs = args.now ? args.now() : Date.now()
  const normalized = normalizeUserCode(args.userCode)
  if (!normalized) return { ok: false, reason: "unknown_code" }

  const matches = await db
    .collection(WKJOBS_DEVICE_CODES)
    .where("userCodeHash", "==", sha256(normalized))
    .limit(1)
    .get()
  const doc = matches.docs[0]
  if (!doc) return { ok: false, reason: "unknown_code" }

  const record = doc.data() as DeviceRecord
  if (Date.parse(record.expiresAt) <= nowMs) return { ok: false, reason: "expired" }
  if (record.status !== "pending") return { ok: false, reason: "already_decided" }

  await doc.ref.update({
    status: args.approve ? "approved" : "denied",
    candidateId: args.candidateId,
    decidedAt: new Date(nowMs).toISOString(),
  })
  return { ok: true }
}

export interface TokenRecord {
  candidateId: string
  scopes: string[]
  createdAt: string
  revokedAt?: string
  lastUsedAt?: string
}

/**
 * Mints the opaque, revocable, audience-scoped token the CLI stores. Only its
 * digest is persisted, so the plaintext exists exactly once — in the response.
 */
export async function mintToken(
  db: Firestore,
  args: { candidateId: string; scopes?: string[]; now?: () => number },
): Promise<string> {
  const nowMs = args.now ? args.now() : Date.now()
  const token = `wkj_${randomBytes(32).toString("base64url")}`
  const record: TokenRecord = {
    candidateId: args.candidateId,
    scopes: args.scopes ?? ["resume:write", "profile:read"],
    createdAt: new Date(nowMs).toISOString(),
  }
  await db.collection(WKJOBS_TOKENS).doc(sha256(token)).set(record)
  return token
}

export async function resolveToken(
  db: Firestore,
  token: string,
  opts: { now?: () => number } = {},
): Promise<TokenRecord | null> {
  const nowMs = opts.now ? opts.now() : Date.now()
  const ref = db.collection(WKJOBS_TOKENS).doc(sha256(token))
  const snap = await ref.get()
  if (!snap.exists) return null
  const record = snap.data() as TokenRecord
  if (record.revokedAt) return null
  await ref.update({ lastUsedAt: new Date(nowMs).toISOString() }).catch(() => undefined)
  return record
}
