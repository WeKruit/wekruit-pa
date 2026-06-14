/**
 * bind-code.ts — single-use, transit-safe phone-binding opener codes
 * (2026-06-13).
 *
 * WHY: the WEBSITE-FIRST candidate (no bound phone yet) opens iMessage with
 * "Hi, WeKruit, my code is <CODE>". There is no phone to resolve from, so the
 * opener token IS the bind mechanism: it must map to pa-users/{candidateId}.
 * The legacy form embedded the raw Firebase push-id uid, which mangles in
 * page→Messages transit (ambiguous glyphs l↔1, I, O↔0, stray `-`) → the inbound
 * resolves to no/wrong account (Noah's two-account case).
 *
 * FIX (mirror of the connect-linkedin token pattern — server-minted +
 * server-resolved):
 *   1. SERVER MINT — the register CF mints a SHORT opaque code in a TRANSIT-SAFE
 *      alphabet (Crockford base32 minus the ambiguous glyphs: no I/L/O/U/0/1)
 *      and stores `pa-bind-codes/<CODE>` → { candidateId, createdAt, expiresAt,
 *      used:false }. The doc id IS the code.
 *   2. OPENER — the website emits "...my verification code is <CODE>" carrying
 *      the CODE, not the uid (wording unchanged for back-compat parsers).
 *   3. INBOUND RESOLVE — the webhook looks up the code → candidateId, binds the
 *      texted phone to that candidate, marks the code used (single-use).
 *   4. GRACEFUL — unknown/expired/used/corrupted code → no match → the webhook
 *      routes to the same graceful notice path (never a silent fail, never a
 *      wrong-account bind: a corrupted code that introduces an ambiguous glyph
 *      simply will not match a minted doc, because the alphabet excludes them).
 *
 * Server-only: pa-bind-codes is deny-all in firestore.rules (Admin SDK only).
 */
import type { Firestore } from "firebase-admin/firestore"
import { randomInt } from "node:crypto"
import { PA_COLLECTIONS } from "@pa/core-types"
import { BIND_CODE_ALPHABET, BIND_CODE_LENGTH, normalizeBindCode, isBindCode } from "@pa/pa-orchestrator"

/** Bind codes are valid for 24h (a link may sit in a text for a bit). */
export const BIND_CODE_TTL_MS = 24 * 60 * 60 * 1000

export interface BindCodeDoc {
  /** The code (== doc id). */
  code: string
  /** pa-users/{uid} the code binds the texted phone to. */
  candidateId: string
  createdAt: string
  expiresAt: string
  used: boolean
  usedAt?: string
  /** E.164 the code was actually consumed by (audit). */
  usedByPhoneE164?: string
}

/** Generate a cryptographically-uniform code over the transit-safe alphabet. */
export function generateBindCode(): string {
  let out = ""
  for (let i = 0; i < BIND_CODE_LENGTH; i++) {
    out += BIND_CODE_ALPHABET[randomInt(0, BIND_CODE_ALPHABET.length)]
  }
  return out
}

/**
 * Mint a fresh single-use bind code for `candidateId`. Returns the code (the
 * caller embeds it in the opener body). Retries on the astronomically-unlikely
 * collision. Best-effort: the doc id IS the code.
 */
export async function issueBindCode(
  db: Firestore,
  candidateId: string,
  now: number = Date.now(),
): Promise<string> {
  const id = candidateId.trim()
  if (!id) throw new Error("issueBindCode: candidateId required")
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateBindCode()
    const ref = db.collection(PA_COLLECTIONS.bindCodes).doc(code)
    const snap = await ref.get()
    if (snap.exists) continue // collision — try again
    const doc: BindCodeDoc = {
      code,
      candidateId: id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + BIND_CODE_TTL_MS).toISOString(),
      used: false,
    }
    await ref.set(doc)
    return code
  }
  throw new Error("issueBindCode: could not mint a unique code")
}

export type ResolveBindCodeResult =
  | { ok: true; candidateId: string }
  | { ok: false; reason: "missing_code" | "bad_shape" | "unknown_code" | "code_expired" | "code_used" }

/**
 * Resolve a bind code → candidateId AND atomically mark it used (single-use).
 * Validates shape (transit-safe alphabet), existence, expiry, and not-already-
 * used in one transaction so two near-simultaneous inbounds can't both consume
 * it. A corrupted code (glyph not in the alphabet) fails `bad_shape` → caller
 * surfaces a graceful notice, never a wrong-account bind.
 */
export async function resolveAndConsumeBindCode(
  db: Firestore,
  rawCode: string | undefined,
  phoneE164?: string,
  now: number = Date.now(),
): Promise<ResolveBindCodeResult> {
  const code = typeof rawCode === "string" ? normalizeBindCode(rawCode) : ""
  if (!code) return { ok: false, reason: "missing_code" }
  if (!isBindCode(code)) return { ok: false, reason: "bad_shape" }
  const ref = db.collection(PA_COLLECTIONS.bindCodes).doc(code)
  return db.runTransaction<ResolveBindCodeResult>(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: false, reason: "unknown_code" }
    const data = snap.data() as BindCodeDoc
    if (data.used) {
      // Idempotent re-text from the SAME phone (retry / coalescer second pass /
      // duplicate inbound) → still resolve to the bound candidate (the bind
      // already succeeded). A DIFFERENT phone re-presenting a consumed code is a
      // genuine single-use violation → code_used (graceful notice, no rebind).
      const consumedBy = typeof data.usedByPhoneE164 === "string" ? data.usedByPhoneE164.trim() : ""
      const presenting = phoneE164 && phoneE164.trim() ? phoneE164.trim() : ""
      if (data.candidateId && consumedBy && presenting && consumedBy === presenting) {
        return { ok: true, candidateId: data.candidateId }
      }
      return { ok: false, reason: "code_used" }
    }
    const expiresAt = Date.parse(data.expiresAt)
    if (Number.isFinite(expiresAt) && now > expiresAt) return { ok: false, reason: "code_expired" }
    if (!data.candidateId) return { ok: false, reason: "unknown_code" }
    tx.set(
      ref,
      {
        used: true,
        usedAt: new Date(now).toISOString(),
        ...(phoneE164 && phoneE164.trim() ? { usedByPhoneE164: phoneE164.trim() } : {}),
      },
      { merge: true },
    )
    return { ok: true, candidateId: data.candidateId }
  })
}
