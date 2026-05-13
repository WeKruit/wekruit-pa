/**
 * v1.9 Phase 86 — paAtsInboundWebhook HTTP CF.
 *
 * Receives ATS applicant webhook POSTs. Single endpoint, multiple sources
 * — header `X-Wekruit-Ats-Source: handshake|greenhouse|lever|linkedin`
 * selects the adapter. Each source has its own HMAC secret.
 *
 * Per-source HMAC signing (HMAC-SHA256 of raw body, hex):
 *   - handshake  → ATS_HANDSHAKE_HMAC_SECRET (Firebase Secret)
 *   - greenhouse → ATS_GREENHOUSE_HMAC_SECRET (not yet wired)
 *   - lever      → ATS_LEVER_HMAC_SECRET (not yet wired)
 *   - linkedin   → ATS_LINKEDIN_HMAC_SECRET (not yet wired)
 *
 * Returns:
 *   200 {ok, action, userId?, jobIdInternal?}
 *   401 {ok:false, reason} for HMAC mismatch
 *   404 {ok:false, reason:"no_internal_job"} when mapping missing
 *   501 {ok:false, reason:"adapter_not_implemented"} for stub adapters
 *   422 {ok:false, reason:<parse_failure>} for malformed payload
 */

import { onRequest, type HttpsFunction } from "firebase-functions/v2/https"
import { defineSecret } from "firebase-functions/params"
import { logger } from "firebase-functions/v2"
import { getFirestore } from "firebase-admin/firestore"
import { createHmac, timingSafeEqual } from "node:crypto"
import { getAdapter } from "./ats-adapters/index.js"
import { handleAtsInbound } from "./ats-inbound-handler.js"
import { sendImessage } from "./sendblue/sendblue-client.js"

const ATS_HANDSHAKE_HMAC_SECRET = defineSecret("ATS_HANDSHAKE_HMAC_SECRET")

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  } catch {
    return false
  }
}

function verifyHmac(rawBody: string, signature: string, secret: string): boolean {
  if (!secret || !signature) return false
  const computed = createHmac("sha256", secret).update(rawBody).digest("hex")
  return safeEq(computed, signature.toLowerCase().replace(/^sha256=/, ""))
}

export const paAtsInboundWebhook: HttpsFunction = onRequest(
  {
    secrets: [ATS_HANDSHAKE_HMAC_SECRET],
    cors: false,
  },
  async (req, res) => {
    const log = (event: string, payload: Record<string, unknown>) =>
      logger.info(`[ats-inbound] ${event}`, payload)

    if (req.method !== "POST") {
      res.status(405).json({ ok: false, reason: "method_not_allowed" })
      return
    }
    const source = req.get("X-Wekruit-Ats-Source")?.toLowerCase() ?? ""
    const adapter = getAdapter(source)
    if (!adapter) {
      res.status(400).json({ ok: false, reason: "unknown_source" })
      return
    }
    if (!adapter.implemented) {
      res.status(501).json({ ok: false, reason: "adapter_not_implemented", source })
      return
    }

    // ── HMAC verify ────────────────────────────────────────────────────
    const sig = req.get("X-Wekruit-Signature") ?? ""
    let secret = ""
    if (source === "handshake") secret = ATS_HANDSHAKE_HMAC_SECRET.value()
    const rawBody = typeof req.rawBody === "string" ? req.rawBody : req.rawBody?.toString("utf8") ?? ""
    if (!verifyHmac(rawBody, sig, secret)) {
      log("hmac_mismatch", { source })
      res.status(401).json({ ok: false, reason: "hmac_mismatch" })
      return
    }

    // ── Parse via adapter ──────────────────────────────────────────────
    const parsed = adapter.parse(req.body)
    if (!parsed.ok) {
      log("parse_failed", { source, reason: parsed.reason })
      res.status(422).json({ ok: false, reason: parsed.reason })
      return
    }

    const db = getFirestore()

    // ── Resume bind (cv-ingest call) ───────────────────────────────────
    const bindResume = async (args: {
      userId: string
      resumeUrl?: string
      resumeBase64?: string
      source: string
    }): Promise<void> => {
      // Lazy import to avoid pulling cv-ingest into the cold-start path.
      try {
        // v1.9 hotfix 2026-05-12 — default to the deployed paPublicCvIngest CF
        // URL. process.env override preserved for local/staging.
        const cvIngestUrl =
          process.env.PA_CV_INGEST_URL ??
          "https://us-central1-wekruit-5f89b.cloudfunctions.net/paPublicCvIngest"
        if (!cvIngestUrl) {
          log("no_cv_ingest_url", { userId: args.userId })
          return
        }
        await fetch(cvIngestUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userId: args.userId,
            resumeUrl: args.resumeUrl,
            resumeBase64: args.resumeBase64,
            source: args.source,
          }),
        })
      } catch (err) {
        log("cv_ingest_fetch_failed", {
          userId: args.userId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const outcome = await handleAtsInbound(parsed.applicant, {
      db,
      sendInvite: async (a) => {
        try {
          await sendImessage({ to: a.to, content: a.content })
          return { ok: true }
        } catch (err) {
          log("send_invite_failed", {
            userId: a.userId,
            error: err instanceof Error ? err.message : String(err),
          })
          return { ok: false }
        }
      },
      bindResume,
      audit: async (e) => {
        try {
          await db.collection("pa-audit-events").add({
            ...e,
            ts: new Date().toISOString(),
          })
        } catch (err) {
          log("audit_failed", { error: String(err) })
        }
      },
      log,
    })

    if (outcome.kind === "ok") {
      res.status(200).json({
        ok: true,
        action: "invited",
        userId: outcome.userId,
        jobIdInternal: outcome.jobIdInternal,
      })
      return
    }
    if (outcome.kind === "deduped") {
      res.status(200).json({ ok: true, action: "deduped" })
      return
    }
    if (outcome.kind === "no_internal_job") {
      res.status(404).json({
        ok: false,
        reason: "no_internal_job",
        jobIdExternal: outcome.jobIdExternal,
      })
      return
    }
    res.status(202).json({ ok: false, reason: outcome.kind })
  }
)
