/**
 * Generic Mailgun transport for admin alerts and external-supply email.
 *
 * Secrets (Cloud Functions Gen 2):
 *   - MAILGUN_API_KEY      — private API key from Mailgun dashboard
 *   - MAILGUN_DOMAIN       — sending domain (e.g. "mg.wekruit.com")
 *   - MAILGUN_FROM         — full From header (e.g. "Claire <claire@mg.wekruit.com>")
 *   - MAILGUN_REGION       — "us" (default) or "eu" — controls api.mailgun.net vs api.eu.mailgun.net
 *
 * This module does not participate in SMS onboarding.
 */

export interface MailgunSendInput {
  to: string
  subject: string
  text: string
  html?: string
  from?: string
  /**
   * Reply-To address. Emitted as the Mailgun form field `h:Reply-To` (the
   * `h:` prefix injects an arbitrary header). Used for VERP two-way threading
   * so candidate replies land on the inbound route as `reply+<token>@...`.
   * Additive + backward-compatible — omit it and behaviour is unchanged.
   */
  replyTo?: string
  /**
   * Arbitrary extra headers, emitted as `h:<Header-Name>` form fields.
   * E.g. `{ "In-Reply-To": "<msgid>", "References": "<msgid>" }` for threading.
   */
  headers?: Record<string, string>
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
  if (input.replyTo) body.set("h:Reply-To", input.replyTo)
  if (input.headers) {
    for (const [name, value] of Object.entries(input.headers)) {
      if (value) body.set(`h:${name}`, value)
    }
  }
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
