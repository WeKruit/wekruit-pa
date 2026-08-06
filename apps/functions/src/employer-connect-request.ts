/**
 * employer-connect-request.ts — `paEmployerConnectRequest` public onCall.
 *
 * Makes the three previously-stubbed employer onboarding steps REAL:
 *   - Connect Slack  (kind="slack")
 *   - Connect ATS    (kind="ats")
 *   - Import Pool     (kind="pool")
 *
 * Each of these is a MANAGED-setup request, not a live self-serve integration.
 * The honest product posture ("runs in the background — we connect it for you")
 * is what this callable delivers: it RECORDS the request and EMAILS ops so a
 * human does the actual managed connection. It does NOT perform any OAuth, ATS
 * read-back, Slack install, or pool import.
 *
 * This callable:
 *   1. Validates `kind` (ats | slack | pool).
 *   2. Writes ONE request doc to a NEW top-level collection
 *      `pa-employer-connect-requests/{autoId}` (status:"requested") BEFORE
 *      sending email — the request persists even if email fails (fail-open,
 *      mirrors paEmployerInviteTeam).
 *   3. Sends ONE real ops-notify email via Mailgun to the ops recipients
 *      (mirrors notifyAdminsPayoutDue in refer-program.ts) so the team can do
 *      the managed setup.
 *   4. Optionally sends the requester a short honest "we got it — our team will
 *      set up your <provider>" confirmation if `requesterEmail` is present.
 *
 * `opsNotified` in the return reflects the real Mailgun result: if Mailgun is
 * not configured, the request is still recorded but `opsNotified` is false.
 *
 * AUTH: public — mirrors `paEmployerInviteTeam` / `paEmployerCreatePilotReq`
 * (cors:true, no auth/app-check gate). The firebase-admin app is initialized
 * globally in index.ts before this module is imported.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, FieldValue } from "firebase-admin/firestore"
import { sendMailgun, type MailgunConfig } from "./email/mailgun.js"

// ---- Wire types -------------------------------------------------------------

export type EmployerConnectKind = "ats" | "slack" | "pool"

export type EmployerConnectRequestInput = {
  kind: EmployerConnectKind
  /** ATS provider (ashby, greenhouse, …) or pool source (their_ats, csv, …). */
  provider?: string
  /** Free-text: workspace/channel, notes, anything ops needs to do the setup. */
  details?: string
  orgName?: string
  requesterEmail?: string
}

export type EmployerConnectRequestOutput = {
  ok: true
  requestId: string
  /** True only when the ops-notify email actually sent (res.ok). */
  opsNotified: boolean
}

// ---- Helpers ----------------------------------------------------------------

const OPS_NOTIFY_RECIPIENTS = "admin1@wekruit.com, adam.ylol@wekruit.com, noah.liu@wekruit.com"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const VALID_KINDS = new Set<EmployerConnectKind>(["ats", "slack", "pool"])

const KIND_LABEL: Record<EmployerConnectKind, string> = {
  ats: "Connect ATS",
  slack: "Connect Slack",
  pool: "Import Pool",
}

const KIND_NOUN: Record<EmployerConnectKind, string> = {
  ats: "ATS",
  slack: "Slack workspace",
  pool: "candidate pool",
}

function mailgunConfigFromEnv(): MailgunConfig | null {
  const apiKey = process.env.MAILGUN_API_KEY ?? ""
  const domain = process.env.MAILGUN_DOMAIN ?? ""
  if (!apiKey || !domain) return null
  const from = process.env.MAILGUN_FROM ?? `WeKruit Claire <claire@${domain}>`
  const region = (process.env.MAILGUN_REGION === "eu" ? "eu" : "us") as "us" | "eu"
  return { apiKey, domain, from, region }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// ---- Callable ---------------------------------------------------------------

export const paEmployerConnectRequest = onCall<EmployerConnectRequestInput>(
  {
    region: "us-central1",
    cors: true,
    memory: "512MiB",
    timeoutSeconds: 60,
    secrets: ["MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_FROM", "MAILGUN_REGION"],
  },
  async (req): Promise<EmployerConnectRequestOutput> => {
    const data = req.data ?? ({} as EmployerConnectRequestInput)
    const kind = (typeof data.kind === "string" ? data.kind.trim().toLowerCase() : "") as EmployerConnectKind
    if (!VALID_KINDS.has(kind)) {
      throw new HttpsError("invalid-argument", "kind must be one of: ats, slack, pool")
    }

    const provider = (typeof data.provider === "string" ? data.provider : "").trim()
    const details = (typeof data.details === "string" ? data.details : "").trim().slice(0, 4000)
    const orgName = (typeof data.orgName === "string" ? data.orgName : "").trim()
    const requesterEmail = (typeof data.requesterEmail === "string" ? data.requesterEmail : "")
      .trim()
      .toLowerCase()

    const db = getFirestore()
    const nowIso = new Date().toISOString()
    const cfg = mailgunConfigFromEnv()

    const orgDisplay = orgName || (requesterEmail ? requesterEmail.split("@")[0] : "An employer")
    const providerDisplay = provider || "(unspecified)"

    // Record the request BEFORE sending (fail-open send).
    const ref = db.collection("pa-employer-connect-requests").doc()
    const doc: Record<string, unknown> = {
      kind,
      provider: provider || null,
      details: details || null,
      status: "requested",
      source: "employer_onboarding",
      requestedAt: FieldValue.serverTimestamp(),
      requestedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
      ...(orgName ? { orgName } : {}),
      ...(requesterEmail ? { requesterEmail } : {}),
    }
    await ref.set(doc)

    logger.info("paEmployerConnectRequest.start", {
      requestId: ref.id,
      kind,
      hasProvider: Boolean(provider),
      hasOrg: Boolean(orgName),
      hasRequester: Boolean(requesterEmail),
      mailgunConfigured: Boolean(cfg),
    })

    let opsNotified = false

    if (cfg) {
      // ---- Ops-notify email (the real managed-setup hand-off) -------------
      const subject = `[Onboarding] ${KIND_LABEL[kind]} request from ${orgDisplay}`
      const text = [
        `New managed-setup connect request from the employer onboarding wizard.`,
        ``,
        `Type:       ${KIND_LABEL[kind]} (${kind})`,
        `Provider:   ${providerDisplay}`,
        `Org:        ${orgName || "—"}`,
        `Requester:  ${requesterEmail || "—"}`,
        details ? `Details:    ${details}` : null,
        ``,
        `Request doc: pa-employer-connect-requests/${ref.id}`,
        ``,
        `→ Reach out and do the managed ${KIND_NOUN[kind]} setup for them.`,
      ]
        .filter((x): x is string => x !== null)
        .join("\n")
      const html =
        `<h2 style="font-family:system-ui;margin:0 0 12px">${escapeHtml(KIND_LABEL[kind])} request</h2>` +
        `<p style="font-family:system-ui;font-size:14px;color:#5a4636;margin:0 0 16px">` +
        `Type: <b>${escapeHtml(KIND_LABEL[kind])}</b> (${escapeHtml(kind)})<br>` +
        `Provider: <b>${escapeHtml(providerDisplay)}</b><br>` +
        `Org: <b>${escapeHtml(orgName || "—")}</b><br>` +
        `Requester: ${escapeHtml(requesterEmail || "—")}<br>` +
        (details ? `Details: ${escapeHtml(details)}<br>` : "") +
        `</p>` +
        `<p style="font-family:system-ui;font-size:13px;color:#897462;margin:0 0 12px">` +
        `Request doc: <code>pa-employer-connect-requests/${escapeHtml(ref.id)}</code></p>` +
        `<p style="font-family:system-ui;font-size:14px;color:#2d1a0a;margin:0">` +
        `→ Reach out and do the managed ${escapeHtml(KIND_NOUN[kind])} setup for them.</p>`

      try {
        const res = await sendMailgun(cfg, {
          to: OPS_NOTIFY_RECIPIENTS,
          subject,
          text,
          html,
        })
        opsNotified = res.ok
        if (res.ok) {
          await ref.set(
            {
              opsNotified: true,
              opsMailgunMessageId: res.messageId ?? null,
              opsMailgunStatus: res.status,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          )
        } else {
          logger.warn("paEmployerConnectRequest.ops_mailgun_failed", {
            requestId: ref.id,
            status: res.status,
            rawResponse: res.rawResponse,
          })
          await ref.set(
            {
              opsNotified: false,
              opsMailgunStatus: res.status,
              opsEmailDeliveryFailed: true,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          )
        }
      } catch (err) {
        logger.error("paEmployerConnectRequest.ops_mailgun_threw", {
          requestId: ref.id,
          err: err instanceof Error ? err.message : String(err),
        })
        await ref.set(
          { opsNotified: false, opsEmailDeliveryFailed: true, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        )
      }

      // ---- Optional requester confirmation (honest, managed) --------------
      if (requesterEmail && EMAIL_RE.test(requesterEmail)) {
        const noun = KIND_NOUN[kind]
        const setupNoun = provider ? `${provider} ${noun}` : noun
        const cSubject = `We got your ${KIND_LABEL[kind].toLowerCase()} request`
        const cText = [
          `Hi —`,
          ``,
          `Thanks — we got your request to connect your ${setupNoun}.`,
          ``,
          `Our team handles this setup for you in the background. We'll be in touch ` +
            `as soon as it's connected — nothing else is needed from you right now.`,
          ``,
          `— WeKruit`,
        ].join("\n")
        const cHtml =
          `<p style="font-family:system-ui;font-size:15px;line-height:1.55;color:#2d1a0a;margin:0 0 14px">Hi —</p>` +
          `<p style="font-family:system-ui;font-size:15px;line-height:1.55;color:#2d1a0a;margin:0 0 18px">` +
          `Thanks — we got your request to connect your <strong>${escapeHtml(setupNoun)}</strong>.</p>` +
          `<p style="font-family:system-ui;font-size:14px;line-height:1.6;color:#5a4636;margin:0 0 18px">` +
          `Our team handles this setup for you in the background. We&apos;ll be in touch as soon as ` +
          `it&apos;s connected — nothing else is needed from you right now.</p>` +
          `<p style="font-family:system-ui;font-size:12px;color:#897462;margin:0">— WeKruit</p>`
        try {
          await sendMailgun(cfg, { to: requesterEmail, subject: cSubject, text: cText, html: cHtml })
        } catch (err) {
          logger.warn("paEmployerConnectRequest.requester_confirm_threw", {
            requestId: ref.id,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } else {
      // Mailgun not configured — request recorded, no email sent.
      logger.warn("paEmployerConnectRequest.mailgun_not_configured", { requestId: ref.id, kind })
    }

    logger.info("paEmployerConnectRequest.done", {
      requestId: ref.id,
      kind,
      opsNotified,
    })

    return { ok: true, requestId: ref.id, opsNotified }
  },
)
