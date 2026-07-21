/**
 * employer-invite-team.ts — `paEmployerInviteTeam` public onCall.
 *
 * Makes the "Invite Team" step (step 4) of the customer-facing employer
 * onboarding wizard (apps/pa-landing/.../EmployerOnboarding.tsx) REAL. The
 * step previously rendered a branded "coming soon" placeholder and persisted
 * nothing. This callable:
 *
 *   1. Validates each invitee email (basic regex) — invalid ones are skipped
 *      and reported back so the UI can show them as failed.
 *   2. Writes ONE pending-invite doc per valid email to a NEW top-level
 *      collection `pa-employer-team-invites/{autoId}` (mirrors the per-invitee
 *      `pa-referrals` row pattern in refer-program.ts) BEFORE sending email.
 *   3. Sends a REAL invite email via the existing prod Mailgun transport
 *      (sendMailgun) using the canonical sender (claire@mg.wekruit.com). Send
 *      is fail-open: a Mailgun failure does NOT roll back the recorded invite
 *      (it is logged + reported in `failed`), mirroring paReferInviteSend.
 *
 * HONEST SCOPE: this slice SENDS the invite email + RECORDS the invite. It does
 * NOT build teammate login, RBAC / role-based access, or invite-acceptance.
 * Teammates get an email now; full role-based access lands in a later slice.
 *
 * AUTH: public — mirrors `paEmployerCreatePilotReq` / `paEmployerIntakeJob`
 * (cors:true, no auth/app-check gate). The firebase-admin app is initialized
 * globally in index.ts before this module is imported.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https"
import { logger } from "firebase-functions/v2"
import { getFirestore, FieldValue } from "firebase-admin/firestore"
import { sendMailgun, type MailgunConfig } from "./email/mailgun.js"

// ---- Wire types -------------------------------------------------------------

export type EmployerInviteRole = "admin" | "recruiter" | "hiring_manager" | "reviewer"

export type EmployerInviteTeamInput = {
  invites: Array<{ email: string; role: EmployerInviteRole | string }>
  orgName?: string
  inviterEmail?: string
}

export type EmployerInviteTeamOutput = {
  sent: number
  failed: Array<{ email: string; reason: string }>
  invited: Array<{ email: string; role: string }>
}

// ---- Helpers ----------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const VALID_ROLES = new Set<EmployerInviteRole>([
  "admin",
  "recruiter",
  "hiring_manager",
  "reviewer",
])

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  recruiter: "Recruiter",
  hiring_manager: "Hiring Manager",
  reviewer: "Reviewer",
}

function normalizeRole(role: unknown): EmployerInviteRole {
  const r = typeof role === "string" ? role.trim().toLowerCase() : ""
  return VALID_ROLES.has(r as EmployerInviteRole) ? (r as EmployerInviteRole) : "recruiter"
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

export const paEmployerInviteTeam = onCall<EmployerInviteTeamInput>(
  {
    region: "us-central1",
    cors: true,
    memory: "256MiB",
    timeoutSeconds: 60,
    secrets: ["MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_FROM", "MAILGUN_REGION"],
  },
  async (req): Promise<EmployerInviteTeamOutput> => {
    const data = req.data ?? ({} as EmployerInviteTeamInput)
    const rawInvites = Array.isArray(data.invites) ? data.invites : []
    const orgName = (typeof data.orgName === "string" ? data.orgName : "").trim()
    const inviterEmail = (typeof data.inviterEmail === "string" ? data.inviterEmail : "")
      .trim()
      .toLowerCase()

    if (rawInvites.length === 0) {
      throw new HttpsError("invalid-argument", "At least one invite is required")
    }
    if (rawInvites.length > 50) {
      throw new HttpsError("invalid-argument", "Too many invites in one call (max 50)")
    }

    const failed: Array<{ email: string; reason: string }> = []
    const invited: Array<{ email: string; role: string }> = []

    // Validate + dedup. Skip-and-report invalid emails.
    const seen = new Set<string>()
    const valid: Array<{ email: string; role: EmployerInviteRole }> = []
    for (const raw of rawInvites) {
      const email = String(raw?.email ?? "").trim().toLowerCase()
      const role = normalizeRole(raw?.role)
      if (!email) {
        failed.push({ email: "", reason: "Missing email" })
        continue
      }
      if (!EMAIL_RE.test(email)) {
        failed.push({ email, reason: "Invalid email" })
        continue
      }
      if (seen.has(email)) {
        failed.push({ email, reason: "Duplicate email in this batch" })
        continue
      }
      seen.add(email)
      valid.push({ email, role })
    }

    if (valid.length === 0) {
      logger.info("paEmployerInviteTeam.no_valid_emails", {
        attempted: rawInvites.length,
        failed: failed.length,
      })
      return { sent: 0, failed, invited }
    }

    const db = getFirestore()
    const nowIso = new Date().toISOString()
    const cfg = mailgunConfigFromEnv()

    const inviterDisplay = orgName || (inviterEmail ? inviterEmail.split("@")[0] : "Your team")

    logger.info("paEmployerInviteTeam.start", {
      validCount: valid.length,
      failedCount: failed.length,
      hasOrg: Boolean(orgName),
      mailgunConfigured: Boolean(cfg),
    })

    let sent = 0
    for (const { email, role } of valid) {
      const roleLabel = ROLE_LABEL[role] ?? role
      const inviteRef = db.collection("pa-employer-team-invites").doc()

      // Record the pending invite BEFORE sending (fail-open send).
      const inviteDoc: Record<string, unknown> = {
        email,
        role,
        status: "pending",
        source: "employer_onboarding",
        invitedAt: FieldValue.serverTimestamp(),
        invitedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
        ...(orgName ? { orgName } : {}),
        ...(inviterEmail ? { inviterEmail } : {}),
      }
      await inviteRef.set(inviteDoc)

      // Send the real invite email.
      if (cfg) {
        const subject = `${inviterDisplay} invited you to WeKruit`
        const text = [
          `Hi —`,
          ``,
          `${inviterDisplay} invited you to WeKruit as a ${roleLabel}.`,
          ``,
          `WeKruit is an AI-headhunter platform — Claire screens candidates and books them with hiring managers directly. We'll be in touch shortly to get you set up with access.`,
          ``,
          `Nothing to do right now; just keep an eye out for the next email.`,
          ``,
          `— WeKruit`,
        ].join("\n")
        const html =
          `<p style="font-family:system-ui;font-size:15px;line-height:1.55;color:#2d1a0a;margin:0 0 14px">Hi —</p>` +
          `<p style="font-family:system-ui;font-size:15px;line-height:1.55;color:#2d1a0a;margin:0 0 18px">` +
          `<strong>${escapeHtml(inviterDisplay)}</strong> invited you to <strong>WeKruit</strong> as a <strong>${escapeHtml(
            roleLabel,
          )}</strong>.</p>` +
          `<p style="font-family:system-ui;font-size:14px;line-height:1.6;color:#5a4636;margin:0 0 18px">` +
          `WeKruit is an AI-headhunter platform — Claire screens candidates and books them with hiring managers directly. ` +
          `We&apos;ll be in touch shortly to get you set up with access.</p>` +
          `<p style="font-family:system-ui;font-size:13px;line-height:1.55;color:#897462;margin:0 0 22px">` +
          `Nothing to do right now; just keep an eye out for the next email.</p>` +
          `<p style="font-family:system-ui;font-size:12px;color:#897462;margin:0">— WeKruit</p>`

        try {
          const res = await sendMailgun(cfg, { to: email, subject, text, html })
          if (res.ok) {
            sent++
            invited.push({ email, role })
            await inviteRef.set(
              {
                mailgunMessageId: res.messageId ?? null,
                mailgunStatus: res.status,
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true },
            )
          } else {
            logger.warn("paEmployerInviteTeam.mailgun_failed", {
              email,
              status: res.status,
              rawResponse: res.rawResponse,
            })
            failed.push({ email, reason: `Email delivery failed (status ${res.status})` })
            await inviteRef.set(
              {
                mailgunStatus: res.status,
                emailDeliveryFailed: true,
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true },
            )
          }
        } catch (err) {
          logger.error("paEmployerInviteTeam.mailgun_threw", {
            email,
            err: err instanceof Error ? err.message : String(err),
          })
          failed.push({ email, reason: "Email delivery error" })
          await inviteRef.set(
            { emailDeliveryFailed: true, updatedAt: FieldValue.serverTimestamp() },
            { merge: true },
          )
        }
      } else {
        // Mailgun not configured — the invite is recorded but no email sent.
        logger.warn("paEmployerInviteTeam.mailgun_not_configured", { email })
        failed.push({ email, reason: "Email not configured — invite recorded only" })
      }
    }

    logger.info("paEmployerInviteTeam.done", {
      sent,
      failed: failed.length,
      invited: invited.length,
    })

    return { sent, failed, invited }
  },
)
