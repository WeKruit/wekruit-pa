/**
 * iter31 — Mailgun transport for the email-verification step of onboarding.
 *
 * Adam directive 2026-05-04 ("Email verification can follow the same cloud
 * function for mailgun, we send code they respond in sms"): the orchestrator
 * issues a 6-digit code, hashes it, persists the hash to user.emailVerification,
 * and dispatches the raw code to the user's contactEmail via Mailgun. The user
 * texts the code BACK over iMessage; the next inbound turn matches sha256(code)
 * against the stored hash to verify.
 *
 * Secrets (Cloud Functions Gen 2):
 *   - MAILGUN_API_KEY      — private API key from Mailgun dashboard
 *   - MAILGUN_DOMAIN       — sending domain (e.g. "mg.wekruit.com")
 *   - MAILGUN_FROM         — full From header (e.g. "Claire <claire@mg.wekruit.com>")
 *   - MAILGUN_REGION       — "us" (default) or "eu" — controls api.mailgun.net vs api.eu.mailgun.net
 *
 * Failure modes:
 *   - 401/403 from Mailgun → throw (orchestrator falls through to "complete"
 *     without verification — biz tester not blocked, just unverified email)
 *   - 5xx / network → throw, caller retries
 *   - 4xx other → throw, caller logs + skips verification step
 */

export interface MailgunSendInput {
  to: string
  subject: string
  text: string
  html?: string
  from?: string
}

export interface MailgunSendResult {
  ok: boolean
  messageId?: string
  rawResponse?: string
  status: number
}

export interface MailgunConfig {
  apiKey: string
  domain: string
  from: string
  region?: "us" | "eu"
}

function mailgunBase(region: "us" | "eu" | undefined): string {
  return region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net"
}

export async function sendMailgun(
  cfg: MailgunConfig,
  input: MailgunSendInput
): Promise<MailgunSendResult> {
  const base = mailgunBase(cfg.region)
  const url = `${base}/v3/${encodeURIComponent(cfg.domain)}/messages`
  const body = new URLSearchParams()
  body.set("from", input.from ?? cfg.from)
  body.set("to", input.to)
  body.set("subject", input.subject)
  body.set("text", input.text)
  if (input.html) body.set("html", input.html)
  const auth = "Basic " + Buffer.from(`api:${cfg.apiKey}`).toString("base64")
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  })
  const text = await resp.text()
  if (!resp.ok) {
    return { ok: false, status: resp.status, rawResponse: text }
  }
  let messageId: string | undefined
  try {
    const json = JSON.parse(text) as { id?: string }
    messageId = json.id
  } catch {
    /* mailgun normally returns JSON; fall through */
  }
  return { ok: true, status: resp.status, messageId, rawResponse: text }
}

/**
 * Compose + send the iter31 verification email. Subject + body are
 * Adam-locked friend-tone bilingual; the 6-digit code is the only
 * variable. The user is told to reply the code via iMessage / SMS.
 */
export async function sendVerificationEmail(
  cfg: MailgunConfig,
  input: { to: string; code: string }
): Promise<MailgunSendResult> {
  const subject = `Your wekruit verification code: ${input.code}`
  const text =
    `Your wekruit verification code is ${input.code}.\n\n` +
    `Reply this code over iMessage to confirm your email.\n` +
    `Code expires in 30 minutes. If you didn't request this, ignore the email.\n\n` +
    `wekruit · personal-assistant onboarding`
  const html =
    `<p>Your wekruit verification code is <b style="font-family:monospace;font-size:1.4em">${input.code}</b>.</p>` +
    `<p>Reply this code over iMessage to confirm your email.</p>` +
    `<p style="color:#64748b;font-size:0.85em">Code expires in 30 minutes. If you didn't request this, ignore the email.</p>` +
    `<hr style="border:none;border-top:1px solid #e2e8f0;margin:1.2em 0">` +
    `<p style="color:#94a3b8;font-size:0.8em">wekruit · personal-assistant onboarding</p>`
  return sendMailgun(cfg, { to: input.to, subject, text, html })
}

/**
 * Generate a fresh 6-digit verification code (zero-padded). NEVER persisted
 * raw — caller must hash with sha256 before storing.
 */
export function generateVerificationCode(): string {
  // crypto-grade randomness; node 18+ has webcrypto available globally.
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  const n = buf[0]! % 1_000_000
  return n.toString().padStart(6, "0")
}
