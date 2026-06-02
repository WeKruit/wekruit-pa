/**
 * paQrStartRedirect — iMessage-first QR onboarding entry point.
 *
 * GET https://wekruit.com/start?c=<campaign>  (behind a hosting rewrite)
 *
 * Flow (doc §2 / §3):
 *   1. loadSendbluePoolWithCounters() — pool with live new-user counters overlaid.
 *   2. mint scanToken = randomUUID() (the pre-candidate identity; no uid exists yet).
 *   3. pickScanNumber(pool, scanToken, requireNewUserCapacity) — capacity-aware.
 *   4. incrementAssignedNewUsers(groupId) — ATOMIC counter bump at PICK time
 *      (defuses the two-scanners race, doc §3.5 Race A).
 *   5. writeQrScanPending(scanToken, {number, groupId, campaign, status:'pending'}).
 *   6. 302 -> sms:<number>?body=Hello, WeKruit! <scanToken>
 *
 * Fail-open: if the pool read fails / has no capacity, redirect to the single
 * SENDBLUE_FROM_NUMBER fallback (still mint + write scan-pending so the inbound
 * can reconcile). The candidate must NEVER hit a dead `/start`.
 *
 * Modeled on public-cv-ingest.ts / public-open-jobs.ts (onRequest CF). Admin init
 * is owned by index.ts (`initializeApp()` at module load), which re-exports this.
 */
import { randomUUID } from "node:crypto"
import { onRequest } from "firebase-functions/v2/https"
import { getFirestore } from "firebase-admin/firestore"
import * as logger from "firebase-functions/logger"
import { buildHelloWekruitOpenerBody } from "@pa/pa-orchestrator"
import {
  loadSendbluePoolWithCounters,
  pickScanNumber,
  incrementAssignedNewUsers,
} from "../sendblue/pool.js"
import { normalizeCampaignCode, writeQrScanPending } from "./scan.js"

/** Build the iOS `sms:` deep link with a prefilled body. */
export function buildSmsDeepLink(number: string, body: string): string {
  // iOS accepts `sms:<number>?body=<encoded>` (some devices want `&body=`; iOS
  // tolerates the single-param `?body=` form, which is what PublicJob.tsx uses).
  return `sms:${number}?&body=${encodeURIComponent(body)}`
}

/** Build the 302 location for a picked number + scanToken (the prefilled opener). */
export function buildQrStartRedirectLocation(number: string, scanToken: string): string {
  return buildSmsDeepLink(number, buildHelloWekruitOpenerBody(scanToken))
}

export const paQrStartRedirect = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 15,
    cors: false,
    invoker: "public",
  },
  async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).send("method_not_allowed")
      return
    }

    // Campaign code is optional/best-effort attribution. An invalid code is
    // recorded as the literal "unknown" campaign (never blocks the redirect).
    const campaign = normalizeCampaignCode(req.query.c) ?? "unknown"
    const scanToken = randomUUID()
    const now = new Date().toISOString()
    const db = getFirestore()

    const fallbackNumber = process.env.SENDBLUE_FROM_NUMBER?.trim() || ""

    let number = ""
    let groupId = ""
    try {
      const pool = await loadSendbluePoolWithCounters(db)
      const picked = pickScanNumber(pool, scanToken, { requireNewUserCapacity: true })
      if (picked) {
        number = picked.number
        groupId = picked.groupId
      }
    } catch (err) {
      logger.warn("[paQrStartRedirect] pool read failed — falling back to single number", {
        campaign,
        err: err instanceof Error ? err.message : String(err),
      })
    }

    // Fail-open: no capacity-aware pick → single configured number.
    if (!number) {
      number = fallbackNumber
      groupId = fallbackNumber
    }
    if (!number) {
      // No pool AND no fallback configured — cannot route. Surface a clear error
      // rather than a broken sms: link.
      logger.error("[paQrStartRedirect] no Sendblue number available (pool empty + no fallback)", {
        campaign,
      })
      res.status(503).send("no_number_available")
      return
    }

    // Bump the new-user counter for the picked group at PICK time (doc §3.2/§3.5).
    // Best-effort: a counter-write failure must not block the candidate's redirect.
    if (groupId) {
      try {
        await incrementAssignedNewUsers(db, groupId)
      } catch (err) {
        logger.warn("[paQrStartRedirect] assignedNewUsers increment failed (non-fatal)", {
          campaign,
          groupId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Persist the pre-candidate reservation so the first inbound can reconcile the
    // sticky number + claim it. Best-effort: if this write fails the inbound falls
    // back to phone-keyed resolution (no scanToken reconcile), still functional.
    try {
      await writeQrScanPending(db, { scanToken, number, groupId, campaign, now })
    } catch (err) {
      logger.warn("[paQrStartRedirect] scan-pending write failed (non-fatal)", {
        campaign,
        scanToken,
        err: err instanceof Error ? err.message : String(err),
      })
    }

    const location = buildQrStartRedirectLocation(number, scanToken)
    // 302 (not 301) — the sms: target is per-scan, never cacheable.
    res.set("Cache-Control", "no-store")
    res.redirect(302, location)
  }
)
